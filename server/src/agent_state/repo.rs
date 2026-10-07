//! SQL for agent state.
//!
//! Every statement filters on `agent_id`, which callers take from the authenticated credential
//! and from nowhere else: that filter is the whole isolation story, so another agent's row is
//! not forbidden, it is simply never selected.
//!
//! Reads ignore a row once `expires_at` has passed, whether or not the sweeper has dealt with it
//! yet, and ignore a tombstone always. Writes to one entry are serialised by an advisory lock and
//! run read, check, write inside one transaction, which is what makes a version number mean
//! something under concurrency.
//!
//! Versions never restart. A delete does not remove the row: it empties it into a tombstone
//! (`deleted_at` set, payload gone) that keeps the version, and the sweeper does the same to a row
//! that expires. The next write of that entry continues from the kept version, so an `If-Match`
//! taken before the delete or expiry can never match the new row by accident. A tombstone is
//! kept for one TTL, then forgotten; a version older than that is beyond any precondition this
//! API promises to honour.

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

    /// The assignments that empty a row into a tombstone: everything the agent wrote except the
    /// name and the version. (A task's `state` stays; it is a protocol word, not content.)
    pub(super) fn emptied_columns(self) -> &'static str {
        match self {
            Self::Tasks => "body = NULL, context_id = NULL",
            Self::Kv => "value = NULL",
        }
    }

    fn versions_sql(self) -> String {
        let (table, name) = (self.table(), self.name_column());
        format!(
            "SELECT version, deleted_at IS NULL AND expires_at > now() AS live
             FROM {table} WHERE agent_id = $1 AND {name} = $2"
        )
    }

    /// Empties the entry into a tombstone kept for `$3` days.
    fn tombstone_sql(self) -> String {
        let (table, name, emptied) = (self.table(), self.name_column(), self.emptied_columns());
        format!(
            "UPDATE {table}
             SET {emptied},
                 deleted_at = clock_timestamp(),
                 expires_at = clock_timestamp() + make_interval(days => $3)
             WHERE agent_id = $1 AND {name} = $2"
        )
    }
}

/// What a writer of one entry needs to know of it before it writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct EntryVersions {
    /// Version of the live row, or 0 when there is none (absent, expired or a tombstone). This is
    /// what a precondition is checked against.
    current: i64,
    /// Highest version the entry has had, live or not, or 0 when nothing of it is kept.
    latest: i64,
}

impl EntryVersions {
    fn from_row(row: Option<(i64, bool)>) -> Self {
        match row {
            None => Self::default(),
            Some((version, live)) => Self {
                current: if live { version } else { 0 },
                latest: version,
            },
        }
    }

    /// The version the next write gets: one past every version the entry has had.
    fn next(self) -> i64 {
        self.latest + 1
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
    WHERE agent_id = $1 AND task_id = $2 AND deleted_at IS NULL AND expires_at > now()";

/// Newest first, then by id. `task_id` is a `COLLATE "C"` column, so the tie-break is byte order
/// whatever the database's locale, and `idx_agent_tasks_listing` serves this order and the
/// cursor's range without a sort.
const LIST_TASKS: &str =
    "SELECT task_id, context_id, state, body AS sealed_body, version, updated_at, expires_at
    FROM agent_tasks
    WHERE agent_id = $1
      AND deleted_at IS NULL
      AND expires_at > now()
      AND ($2::text IS NULL OR context_id = $2)
      AND ($3::text IS NULL OR state = $3)
      AND ($4::timestamptz IS NULL
           OR updated_at < $4
           OR (updated_at = $4 AND task_id > $5))
    ORDER BY updated_at DESC, task_id ASC
    LIMIT $6";

/// Stamps with `clock_timestamp()`, not `now()`: `now()` is when the transaction began, which can
/// predate the moment this writer won the entry's lock, and a later version must never carry an
/// earlier `updated_at` than the one before it. The `created_at` expression is the exception, and
/// deliberately uses `now()` so it agrees with the liveness check made earlier in the same
/// transaction: it restarts a row that had expired or been deleted and keeps a live one's.
const UPSERT_TASK: &str = "INSERT INTO agent_tasks AS t
        (agent_id, task_id, context_id, state, body, version, updated_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp() + make_interval(days => $7))
    ON CONFLICT (agent_id, task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state      = EXCLUDED.state,
        body       = EXCLUDED.body,
        version    = EXCLUDED.version,
        created_at = CASE WHEN t.deleted_at IS NULL AND t.expires_at > now()
                          THEN t.created_at ELSE now() END,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at,
        deleted_at = NULL
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
    let versions = entry_versions(&mut tx, Store::Tasks, agent_id, task.task_id).await?;
    if !precondition.holds_for(versions.current) {
        tx.rollback().await?;
        return Ok(PutOutcome::VersionConflict {
            current_version: versions.current,
        });
    }
    let stamp = sqlx::query_as(UPSERT_TASK)
        .bind(agent_id)
        .bind(task.task_id)
        .bind(task.context_id)
        .bind(task.state)
        .bind(task.sealed_body)
        .bind(versions.next())
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
    WHERE agent_id = $1 AND key = $2 AND deleted_at IS NULL AND expires_at > now()";

/// `starts_with`, not `LIKE`: a prefix is a literal, and `%` or `_` in it must not act as
/// wildcards. `key` is a `COLLATE "C"` column, so the order is bytes, as in `LIST_TASKS`, and the
/// primary key serves the order, the cursor's range and the prefix (Postgres can use a btree for
/// `starts_with` only under the C collation).
const LIST_KV: &str = "SELECT key, value AS sealed_value, version, updated_at, expires_at
    FROM agent_kv
    WHERE agent_id = $1
      AND deleted_at IS NULL
      AND expires_at > now()
      AND ($2::text IS NULL OR starts_with(key, $2))
      AND ($3::text IS NULL OR key > $3)
    ORDER BY key ASC
    LIMIT $4";

/// Stamps as `UPSERT_TASK` does, for the same reasons.
const UPSERT_KV: &str = "INSERT INTO agent_kv AS e
        (agent_id, key, value, version, updated_at, expires_at)
    VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + make_interval(days => $5))
    ON CONFLICT (agent_id, key) DO UPDATE SET
        value      = EXCLUDED.value,
        version    = EXCLUDED.version,
        created_at = CASE WHEN e.deleted_at IS NULL AND e.expires_at > now()
                          THEN e.created_at ELSE now() END,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at,
        deleted_at = NULL
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
    let versions = entry_versions(&mut tx, Store::Kv, agent_id, entry.key).await?;
    if !precondition.holds_for(versions.current) {
        tx.rollback().await?;
        return Ok(PutOutcome::VersionConflict {
            current_version: versions.current,
        });
    }
    let stamp = sqlx::query_as(UPSERT_KV)
        .bind(agent_id)
        .bind(entry.key)
        .bind(entry.sealed_value)
        .bind(versions.next())
        .bind(ttl_days)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(PutOutcome::Stored(stamp))
}

// ─── Shared by both stores ──────────────────────────────────────────────────

/// Empties a live row into a tombstone kept for `ttl_days`, so the entry's next write continues
/// its version. An absent, expired or already deleted one is `NotFound`, whatever the
/// precondition says.
pub(super) async fn delete(
    db: &PgPool,
    agent_id: Uuid,
    store: Store,
    name: &str,
    precondition: Precondition,
    ttl_days: i32,
) -> Result<DeleteOutcome, sqlx::Error> {
    let mut tx = begin_locked(db, agent_id, store, name).await?;
    let current_version = entry_versions(&mut tx, store, agent_id, name)
        .await?
        .current;
    if current_version == 0 {
        tx.rollback().await?;
        return Ok(DeleteOutcome::NotFound);
    }
    if !precondition.holds_for(current_version) {
        tx.rollback().await?;
        return Ok(DeleteOutcome::VersionConflict { current_version });
    }
    sqlx::query(&store.tombstone_sql())
        .bind(agent_id)
        .bind(name)
        .bind(ttl_days)
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
///
/// The transaction is READ COMMITTED, said explicitly because a database or role default can say
/// otherwise. Taking turns only helps if each statement sees what the writer before committed:
/// under REPEATABLE READ or SERIALIZABLE the snapshot is fixed when the lock statement starts,
/// before the wait, so a writer that waited would read the version from before it and then fail
/// to serialize on write.
async fn begin_locked(
    db: &PgPool,
    agent_id: Uuid,
    store: Store,
    name: &str,
) -> Result<Transaction<'static, Postgres>, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))")
        .bind(ENTRY_LOCK_CLASS)
        .bind(format!("{agent_id}/{}/{name}", store.label()))
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

async fn entry_versions(
    conn: &mut PgConnection,
    store: Store,
    agent_id: Uuid,
    name: &str,
) -> Result<EntryVersions, sqlx::Error> {
    let row = sqlx::query_as(&store.versions_sql())
        .bind(agent_id)
        .bind(name)
        .fetch_optional(conn)
        .await?;
    Ok(EntryVersions::from_row(row))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_never_written_starts_at_version_one() {
        let versions = EntryVersions::from_row(None);
        assert_eq!(versions.current, 0);
        assert_eq!(versions.next(), 1);
    }

    #[test]
    fn a_live_row_is_current_and_the_next_write_follows_it() {
        let versions = EntryVersions::from_row(Some((4, true)));
        assert_eq!(versions.current, 4);
        assert_eq!(versions.next(), 5);
    }

    #[test]
    fn a_tombstone_or_expired_row_is_absent_but_its_version_carries_on() {
        let versions = EntryVersions::from_row(Some((4, false)));
        assert_eq!(versions.current, 0, "a precondition sees no row");
        assert_eq!(versions.next(), 5, "the next write does not restart at 1");
    }

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
