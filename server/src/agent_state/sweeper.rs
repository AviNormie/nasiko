//! Reclaims the storage of expired agent state.
//!
//! Expired rows already read as absent (the repository filters on `expires_at`), so a sweep
//! changes no answer; it only stops them accumulating. Every server process runs one and they do
//! not coordinate: each statement locks the rows it deletes with `SKIP LOCKED`, so a row that a
//! peer sweeper or a writer holds is left for the next pass instead of being waited on.

use std::time::Duration;

use sqlx::PgPool;
use tokio::time::MissedTickBehavior;

/// How often the sweeper wakes.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Rows removed per statement, so no single statement holds locks on an unbounded number of rows.
const BATCH_SIZE: i64 = 1000;

/// What one [`sweep_expired`] pass removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub tasks: u64,
    pub kv: u64,
}

const SWEEP_TASKS: &str = "DELETE FROM agent_tasks
    WHERE (agent_id, task_id) IN (
        SELECT agent_id, task_id FROM agent_tasks
        WHERE expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    )";

const SWEEP_KV: &str = "DELETE FROM agent_kv
    WHERE (agent_id, key) IN (
        SELECT agent_id, key FROM agent_kv
        WHERE expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    )";

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
        match sweep_expired(&db).await {
            Ok(swept) if swept == Swept::default() => {
                tracing::debug!("agent state sweep: nothing expired");
            }
            Ok(swept) => tracing::info!(
                tasks = swept.tasks,
                kv = swept.kv,
                "agent state sweep removed expired rows"
            ),
            Err(e) => {
                tracing::warn!(error = %e, "agent state sweep failed, retrying next interval")
            }
        }
    }
}

/// Deletes every expired task and key-value row that no one else is holding, a batch at a time.
pub async fn sweep_expired(db: &PgPool) -> Result<Swept, sqlx::Error> {
    Ok(Swept {
        tasks: drain(db, SWEEP_TASKS).await?,
        kv: drain(db, SWEEP_KV).await?,
    })
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
