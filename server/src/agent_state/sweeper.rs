//! Reclaims the storage of agent state no one can read any more.
//!
//! Two kinds of row qualify. An expired row already reads as absent (the repository filters on
//! `expires_at`), so removing it changes no answer. A row of a deleted agent is unreachable too:
//! the catalog's delete is a soft delete (`agents.deleted_at`), which never fires the foreign
//! key's cascade, and the agent's credential stops authenticating the moment it is set. Without
//! this pass such rows would linger until they expired.
//!
//! Every server process runs one sweeper and they do not coordinate: each statement locks the
//! rows it removes with `SKIP LOCKED`, so a row that a peer sweeper or a writer holds is left for
//! the next pass instead of being waited on.

use std::time::Duration;

use sqlx::PgPool;
use tokio::time::MissedTickBehavior;

use super::repo::Store;

/// How often the sweeper wakes.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Rows removed per statement, so no single statement holds locks on an unbounded number of rows.
const BATCH_SIZE: i64 = 1000;

/// Rows one pass removed from each store.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StoreCounts {
    pub tasks: u64,
    pub kv: u64,
}

impl StoreCounts {
    fn record(&mut self, store: Store, removed: u64) {
        match store {
            Store::Tasks => self.tasks += removed,
            Store::Kv => self.kv += removed,
        }
    }
}

/// What one [`sweep`] pass removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// Rows whose `expires_at` had passed.
    pub expired: StoreCounts,
    /// Rows of agents that have been deleted, whatever their expiry.
    pub orphaned: StoreCounts,
}

/// Background loop: sweep once per [`SWEEP_INTERVAL`], forever.
///
/// Spawned from `AppState::from_config_with_db` like the server's other periodic workers; it
/// never exits on its own and stops when the runtime is dropped. A failed pass is logged and
/// retried at the next tick.
pub async fn run(db: PgPool) {
    let mut tick = tokio::time::interval(SWEEP_INTERVAL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // The first tick fires at once; nothing is worth sweeping at boot, as for the other workers.
    tick.tick().await;
    loop {
        tick.tick().await;
        match sweep(&db).await {
            Ok(swept) if swept == Swept::default() => {
                tracing::debug!("agent state sweep: nothing to reclaim");
            }
            Ok(swept) => tracing::info!(?swept, "agent state sweep reclaimed rows"),
            Err(e) => {
                tracing::warn!(error = %e, "agent state sweep failed, retrying next interval")
            }
        }
    }
}

/// Removes every expired row, and every row of a deleted agent, that no one else is holding, a
/// batch at a time.
pub async fn sweep(db: &PgPool) -> Result<Swept, sqlx::Error> {
    let mut swept = Swept::default();
    for store in Store::ALL {
        swept
            .expired
            .record(store, drain(db, &delete_expired_sql(store)).await?);
        swept
            .orphaned
            .record(store, drain(db, &delete_orphaned_sql(store)).await?);
    }
    Ok(swept)
}

fn delete_expired_sql(store: Store) -> String {
    let (table, name) = (store.table(), store.name_column());
    format!(
        "DELETE FROM {table}
         WHERE (agent_id, {name}) IN (
             SELECT agent_id, {name} FROM {table}
             WHERE expires_at <= now()
             ORDER BY expires_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
         )"
    )
}

fn delete_orphaned_sql(store: Store) -> String {
    let (table, name) = (store.table(), store.name_column());
    format!(
        "DELETE FROM {table}
         WHERE (agent_id, {name}) IN (
             SELECT s.agent_id, s.{name} FROM {table} s
             JOIN agents a ON a.id = s.agent_id
             WHERE a.deleted_at IS NOT NULL
             LIMIT $1
             FOR UPDATE OF s SKIP LOCKED
         )"
    )
}

/// Runs a batched delete until a batch removes nothing, and returns the total removed.
async fn drain(db: &PgPool, delete_batch: &str) -> Result<u64, sqlx::Error> {
    let mut removed = 0;
    loop {
        let batch = sqlx::query(delete_batch)
            .bind(BATCH_SIZE)
            .execute(db)
            .await?
            .rows_affected();
        if batch == 0 {
            return Ok(removed);
        }
        removed += batch;
    }
}
