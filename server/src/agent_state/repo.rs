//! SQL for agent state.
//!
//! Every statement filters on `agent_id`, which callers take from the authenticated credential
//! and from nowhere else: that filter is the whole isolation story, so another agent's row is
//! not forbidden, it is simply never selected.
//!
//! Reads ignore a row once `expires_at` has passed, whether or not the sweeper has removed it
//! yet. Writes to one entry are serialised by an advisory lock and run read, check, write inside
//! one transaction, which is what makes a version number mean something under concurrency.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::cursor::{KeyCursor, TaskCursor};
use super::precondition::Precondition;

/// Advisory-lock class for entry write locks. Postgres advisory locks are one shared integer key
/// space with no namespacing of its own, so every user of it picks a class of its own.
const ENTRY_LOCK_CLASS: i32 = 0x0A9E_517A;

/// The two stores, which share every version, expiry and locking rule.
#[derive(Clone, Copy, Debug)]
pub(super) enum Store {
    Tasks,
    Kv,
}

impl Store {
    pub(super) const ALL: [Self; 2] = [Self::Tasks, Self::Kv];

    /// The table that holds the store's rows.
    pub(super) fn table(self) -> &'static str {
        match self {
            Self::Tasks => "agent_tasks",
            Self::Kv => "agent_kv",
        }
    }

    /// The column that names a row within one agent's share of the store.
    pub(super) fn name_column(self) -> &'static str {
        match self {
            Self::Tasks => "task_id",
            Self::Kv => "key",
        }
    }

    /// Names the store inside a row's lock key and its ciphertext's associated data, so a task and
    /// a key of the same name never contend and never open as each other. Part of the stored
    /// format: changing it makes every stored row unreadable.
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Tasks => "task",
            Self::Kv => "kv",
        }
    }

    fn live_version_sql(self) -> &'static str {
        match self {
            Self::Tasks => {
                "SELECT version FROM agent_tasks
                 WHERE agent_id = $1 AND task_id = $2 AND expires_at > now()"
            }
            Self::Kv => {
                "SELECT version FROM agent_kv
                 WHERE agent_id = $1 AND key = $2 AND expires_at > now()"
            }
        }
    }

    fn delete_sql(self) -> &'static str {
        match self {
            Self::Tasks => "DELETE FROM agent_tasks WHERE agent_id = $1 AND task_id = $2",
            Self::Kv => "DELETE FROM agent_kv WHERE agent_id = $1 AND key = $2",
        }
    }
}

/// When a write landed: the row's new version and its timestamps.
#[derive(Debug, sqlx::FromRow)]
pub(super) struct Stamp {
    pub(super) version: i64,
    pub(super) updated_at: DateTime<Utc>,
    pub(super) expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub(super) enum PutOutcome {
    Stored(Stamp),
    /// The precondition failed; nothing was written. 0 means the row is absent.
    VersionConflict {
        current_version: i64,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DeleteOutcome {
    Deleted,
    NotFound,
    VersionConflict { current_version: i64 },
}

/// One page of rows, and whether another follows it.
#[derive(Debug)]
pub(super) struct Rows<T> {
    pub(super) rows: Vec<T>,
    pub(super) has_more: bool,
}

impl<T> Rows<T> {
    /// Drops the one extra row a listing fetches beyond the page size to learn whether more exist.
    fn trimmed(mut rows: Vec<T>, page_size: i64) -> Self {
        let keep = usize::try_from(page_size).unwrap_or_default();
        let has_more = rows.len() > keep;
        rows.truncate(keep);
        Self { rows, has_more }
    }
}

// ─── Registration ───────────────────────────────────────────────────────────

/// Records that the agent keeps its tasks durably. Idempotent, and a no-op for an agent that
/// already is, so an SDK registering at every start does not rewrite the agent row each time.
pub(super) async fn mark_durable(db: &PgPool, agent_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE agents SET state_mode = 'durable' WHERE id = $1 AND state_mode <> 'durable'",
    )
    .bind(agent_id)
    .execute(db)
    .await?;
    Ok(())
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

/// A task as an agent wants it stored. `sealed_body` is already ciphertext.
pub(super) struct NewTask<'a> {
    pub(super) task_id: &'a str,
    pub(super) context_id: Option<&'a str>,
    pub(super) state: &'a str,
    pub(super) sealed_body: &'a str,
}

#[derive(Debug, sqlx::FromRow)]
pub(super) struct TaskRow {
    pub(super) task_id: String,
    pub(super) context_id: Option<String>,
    pub(super) state: String,
    pub(super) sealed_body: String,
    pub(super) version: i64,
    pub(super) updated_at: DateTime<Utc>,
    pub(super) expires_at: DateTime<Utc>,
}

/// Which tasks to list and where to start. Built from a validated request (`wire`).
#[derive(Debug)]
pub(super) struct TaskQuery {
    pub(super) context_id: Option<String>,
    pub(super) state: Option<String>,
    pub(super) after: Option<TaskCursor>,
    pub(super) page_size: i64,
}

const GET_TASK: &str =
    "SELECT task_id, context_id, state, body AS sealed_body, version, updated_at, expires_at
    FROM agent_tasks
    WHERE agent_id = $1 AND task_id = $2 AND expires_at > now()";

/// Newest first. The `COLLATE "C"` on the id makes the tie-break byte order, so the sequence a
/// caller pages through does not depend on the database's locale.
const LIST_TASKS: &str =
    "SELECT task_id, context_id, state, body AS sealed_body, version, updated_at, expires_at
    FROM agent_tasks
    WHERE agent_id = $1
      AND expires_at > now()
      AND ($2::text IS NULL OR context_id = $2)
      AND ($3::text IS NULL OR state = $3)
      AND ($4::timestamptz IS NULL
           OR updated_at < $4
           OR (updated_at = $4 AND task_id COLLATE \"C\" > $5))
    ORDER BY updated_at DESC, task_id COLLATE \"C\" ASC
    LIMIT $6";

/// Stamps with `clock_timestamp()`, not `now()`: `now()` is when the transaction began, which can
/// predate the moment this writer won the entry's lock, and a later version must never carry an
/// earlier `updated_at` than the one before it. The `created_at` expression is the exception, and
/// deliberately uses `now()` so it agrees with the liveness check made earlier in the same
/// transaction: it restarts a row that had expired and keeps a live one's original value.
const UPSERT_TASK: &str = "INSERT INTO agent_tasks AS t
        (agent_id, task_id, context_id, state, body, version, updated_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp() + make_interval(days => $7))
    ON CONFLICT (agent_id, task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state      = EXCLUDED.state,
        body       = EXCLUDED.body,
        version    = EXCLUDED.version,
        created_at = CASE WHEN t.expires_at > now() THEN t.created_at ELSE now() END,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at
    RETURNING version, updated_at, expires_at";

pub(super) async fn get_task(
    db: &PgPool,
    agent_id: Uuid,
    task_id: &str,
) -> Result<Option<TaskRow>, sqlx::Error> {
    sqlx::query_as(GET_TASK)
        .bind(agent_id)
        .bind(task_id)
        .fetch_optional(db)
        .await
}

pub(super) async fn list_tasks(
    db: &PgPool,
    agent_id: Uuid,
    query: &TaskQuery,
) -> Result<Rows<TaskRow>, sqlx::Error> {
    let rows = sqlx::query_as(LIST_TASKS)
        .bind(agent_id)
        .bind(query.context_id.as_deref())
        .bind(query.state.as_deref())
        .bind(query.after.as_ref().map(|cursor| cursor.updated_at))
        .bind(query.after.as_ref().map(|cursor| cursor.task_id.as_str()))
        .bind(query.page_size + 1)
        .fetch_all(db)
        .await?;
    Ok(Rows::trimmed(rows, query.page_size))
}

/// Creates or replaces a task, at version 1 for a new one and one above the current otherwise.
pub(super) async fn put_task(
    db: &PgPool,
    agent_id: Uuid,
    task: &NewTask<'_>,
    precondition: Precondition,
    ttl_days: i32,
) -> Result<PutOutcome, sqlx::Error> {
    let mut tx = begin_locked(db, agent_id, Store::Tasks, task.task_id).await?;
    let current_version = live_version(&mut tx, Store::Tasks, agent_id, task.task_id)
        .await?
        .unwrap_or(0);
    if !precondition.holds_for(current_version) {
        tx.rollback().await?;
        return Ok(PutOutcome::VersionConflict { current_version });
    }
    let stamp = sqlx::query_as(UPSERT_TASK)
        .bind(agent_id)
        .bind(task.task_id)
        .bind(task.context_id)
        .bind(task.state)
        .bind(task.sealed_body)
        .bind(current_version + 1)
        .bind(ttl_days)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(PutOutcome::Stored(stamp))
}

// ─── Key-value ──────────────────────────────────────────────────────────────

/// An entry as an agent wants it stored. `sealed_value` is already ciphertext.
pub(super) struct NewEntry<'a> {
    pub(super) key: &'a str,
    pub(super) sealed_value: &'a str,
}

#[derive(Debug, sqlx::FromRow)]
pub(super) struct KvRow {
    pub(super) key: String,
    pub(super) sealed_value: String,
    pub(super) version: i64,
    pub(super) updated_at: DateTime<Utc>,
    pub(super) expires_at: DateTime<Utc>,
}

/// Which entries to list and where to start. Built from a validated request (`wire`).
#[derive(Debug)]
pub(super) struct KvQuery {
    pub(super) prefix: Option<String>,
    pub(super) after: Option<KeyCursor>,
    pub(super) page_size: i64,
}

const GET_KV: &str = "SELECT key, value AS sealed_value, version, updated_at, expires_at
    FROM agent_kv
    WHERE agent_id = $1 AND key = $2 AND expires_at > now()";

/// `starts_with`, not `LIKE`: a prefix is a literal, and `%` or `_` in it must not act as
/// wildcards. Byte-order collation for the same reason as `LIST_TASKS`.
const LIST_KV: &str = "SELECT key, value AS sealed_value, version, updated_at, expires_at
    FROM agent_kv
    WHERE agent_id = $1
      AND expires_at > now()
      AND ($2::text IS NULL OR starts_with(key, $2))
      AND ($3::text IS NULL OR key COLLATE \"C\" > $3)
    ORDER BY key COLLATE \"C\" ASC
    LIMIT $4";

/// Stamps as `UPSERT_TASK` does, for the same reasons.
const UPSERT_KV: &str = "INSERT INTO agent_kv AS e
        (agent_id, key, value, version, updated_at, expires_at)
    VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + make_interval(days => $5))
    ON CONFLICT (agent_id, key) DO UPDATE SET
        value      = EXCLUDED.value,
        version    = EXCLUDED.version,
        created_at = CASE WHEN e.expires_at > now() THEN e.created_at ELSE now() END,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at
    RETURNING version, updated_at, expires_at";

pub(super) async fn get_kv(
    db: &PgPool,
    agent_id: Uuid,
    key: &str,
) -> Result<Option<KvRow>, sqlx::Error> {
    sqlx::query_as(GET_KV)
        .bind(agent_id)
        .bind(key)
        .fetch_optional(db)
        .await
}

pub(super) async fn list_kv(
    db: &PgPool,
    agent_id: Uuid,
    query: &KvQuery,
) -> Result<Rows<KvRow>, sqlx::Error> {
    let rows = sqlx::query_as(LIST_KV)
        .bind(agent_id)
        .bind(query.prefix.as_deref())
        .bind(query.after.as_ref().map(|cursor| cursor.key.as_str()))
        .bind(query.page_size + 1)
        .fetch_all(db)
        .await?;
    Ok(Rows::trimmed(rows, query.page_size))
}

/// Creates or replaces an entry, at version 1 for a new one and one above the current otherwise.
pub(super) async fn put_kv(
    db: &PgPool,
    agent_id: Uuid,
    entry: &NewEntry<'_>,
    precondition: Precondition,
    ttl_days: i32,
) -> Result<PutOutcome, sqlx::Error> {
    let mut tx = begin_locked(db, agent_id, Store::Kv, entry.key).await?;
    let current_version = live_version(&mut tx, Store::Kv, agent_id, entry.key)
        .await?
        .unwrap_or(0);
    if !precondition.holds_for(current_version) {
        tx.rollback().await?;
        return Ok(PutOutcome::VersionConflict { current_version });
    }
    let stamp = sqlx::query_as(UPSERT_KV)
        .bind(agent_id)
        .bind(entry.key)
        .bind(entry.sealed_value)
        .bind(current_version + 1)
        .bind(ttl_days)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(PutOutcome::Stored(stamp))
}

// ─── Shared by both stores ──────────────────────────────────────────────────

/// Removes a live row. An absent or expired one is `NotFound`, whatever the precondition says.
pub(super) async fn delete(
    db: &PgPool,
    agent_id: Uuid,
    store: Store,
    name: &str,
    precondition: Precondition,
) -> Result<DeleteOutcome, sqlx::Error> {
    let mut tx = begin_locked(db, agent_id, store, name).await?;
    let Some(current_version) = live_version(&mut tx, store, agent_id, name).await? else {
        tx.rollback().await?;
        return Ok(DeleteOutcome::NotFound);
    };
    if !precondition.holds_for(current_version) {
        tx.rollback().await?;
        return Ok(DeleteOutcome::VersionConflict { current_version });
    }
    sqlx::query(store.delete_sql())
        .bind(agent_id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(DeleteOutcome::Deleted)
}

/// Opens a transaction that holds the write lock for one entry until it ends, so concurrent
/// writers of that entry take turns and each reads the version the one before it committed.
///
/// A row lock cannot do this: when the entry does not exist yet there is no row to lock, and two
/// creators would both conclude they are first. The lock is per entry, so unrelated entries never
/// wait on each other; a hash collision only makes two entries share one, which costs a little
/// serialisation and breaks nothing.
async fn begin_locked(
    db: &PgPool,
    agent_id: Uuid,
    store: Store,
    name: &str,
) -> Result<Transaction<'static, Postgres>, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))")
        .bind(ENTRY_LOCK_CLASS)
        .bind(format!("{agent_id}/{}/{name}", store.label()))
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// Version of the entry's live row, or `None` when it is absent or has expired.
async fn live_version(
    conn: &mut PgConnection,
    store: Store,
    agent_id: Uuid,
    name: &str,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(store.live_version_sql())
        .bind(agent_id)
        .bind(name)
        .fetch_optional(conn)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_page_with_a_probe_row_reports_more_and_drops_the_probe() {
        let page = Rows::trimmed(vec![1, 2, 3], 2);
        assert_eq!(page.rows, [1, 2]);
        assert!(page.has_more);
    }

    #[test]
    fn a_page_without_a_probe_row_is_the_last() {
        let exact = Rows::trimmed(vec![1, 2], 2);
        assert_eq!(exact.rows, [1, 2]);
        assert!(!exact.has_more);

        let short = Rows::trimmed(vec![1], 2);
        assert_eq!(short.rows, [1]);
        assert!(!short.has_more);

        let empty = Rows::<i32>::trimmed(vec![], 2);
        assert!(empty.rows.is_empty());
        assert!(!empty.has_more);
    }
}
