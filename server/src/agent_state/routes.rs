//! The agent state routes. A handler takes its inputs already validated, makes one repository
//! call, and shapes the result; the rules live in the extractors and the repository.

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router, middleware};

use super::auth::{AgentAuth, AuthenticatedAgent, authenticate};
use super::cursor::{KeyCursor, TaskCursor};
use super::error::StateError;
use super::payload::{BoundedPayload, PayloadCipher};
use super::precondition::Precondition;
use super::repo::{
    self, DeleteOutcome, KvQuery, KvRow, NewEntry, NewTask, PutOutcome, Rows, Stamp, Store,
    TaskQuery, TaskRow,
};
use super::request::{KvKey, StateJson, StateQuery, TaskId};
use super::wire::{
    KvStamp, KvView, ListKvQuery, ListTasksQuery, Page, PutKvRequest, PutTaskRequest,
    RegisterRequest, TaskStamp, TaskView,
};
use crate::state::AppState;

/// Room the transport-level body limit leaves beyond the value cap for the JSON around the value
/// (field names, `state`, `context_id`). The cap on the value itself is exact and enforced once
/// the request is read (`BoundedPayload`); this only bounds how much of a request is buffered
/// before that can be checked.
const ENVELOPE_ALLOWANCE_BYTES: usize = 16 * 1024;

/// The agent state API, to be nested under `/api`.
///
/// Mounted outside the session auth, like the MCP gateway: callers are deployed agents holding
/// their own credential, which the router authenticates and rate-limits itself.
pub fn router(state: &AppState) -> Router<AppState> {
    let auth = AgentAuth::new(
        state.db.clone(),
        state.config.agent_state_rate_limit_per_minute,
    );
    let transport_limit = state
        .config
        .agent_state_max_body_bytes
        .saturating_add(ENVELOPE_ALLOWANCE_BYTES);
    Router::new()
        .route("/agent-state/register", post(register))
        .route("/agent-state/tasks", get(list_tasks))
        .route(
            "/agent-state/tasks/{task_id}",
            put(put_task).get(get_task).delete(delete_task),
        )
        .route("/agent-state/kv", get(list_kv))
        .route(
            "/agent-state/kv/{key}",
            put(put_kv).get(get_kv).delete(delete_kv),
        )
        .layer(DefaultBodyLimit::max(transport_limit))
        .layer(middleware::from_fn_with_state(auth, authenticate))
}

// ─── Registration ───────────────────────────────────────────────────────────

async fn register(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    StateJson(request): StateJson<RegisterRequest>,
) -> Result<StatusCode, StateError> {
    request.check()?;
    if request.stores_tasks() {
        repo::mark_durable(&state.db, agent_id).await?;
    }
    tracing::info!(
        %agent_id,
        client = ?request.client,
        capabilities = ?request.capabilities,
        "agent state store registered"
    );
    Ok(StatusCode::NO_CONTENT)
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

async fn put_task(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    task_id: TaskId,
    precondition: Precondition,
    StateJson(request): StateJson<PutTaskRequest>,
) -> Result<Json<TaskStamp>, StateError> {
    request.check()?;
    let payload = BoundedPayload::new(&request.body, state.config.agent_state_max_body_bytes)?;
    let sealed_body = PayloadCipher::for_agent(agent_id)?.seal(&payload);
    let task = NewTask {
        task_id: task_id.as_str(),
        context_id: request.context_id.as_deref(),
        state: &request.state,
        sealed_body: &sealed_body,
    };
    let outcome = repo::put_task(
        &state.db,
        agent_id,
        &task,
        precondition,
        state.config.agent_state_ttl_days,
    )
    .await?;
    Ok(Json(TaskStamp::new(
        task_id.into_string(),
        stored(outcome)?,
    )))
}

async fn get_task(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    task_id: TaskId,
) -> Result<Json<TaskView>, StateError> {
    let row = repo::get_task(&state.db, agent_id, task_id.as_str())
        .await?
        .ok_or(StateError::NotFound { what: "task" })?;
    let cipher = PayloadCipher::for_agent(agent_id)?;
    Ok(Json(TaskView::open(row, &cipher)?))
}

async fn delete_task(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    task_id: TaskId,
    precondition: Precondition,
) -> Result<StatusCode, StateError> {
    let outcome = repo::delete(
        &state.db,
        agent_id,
        Store::Tasks,
        task_id.as_str(),
        precondition,
    )
    .await?;
    deleted(outcome, "task")
}

async fn list_tasks(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    StateQuery(query): StateQuery<ListTasksQuery>,
) -> Result<Json<Page<TaskView>>, StateError> {
    let query = TaskQuery::try_from(query)?;
    let rows = repo::list_tasks(&state.db, agent_id, &query).await?;
    let cipher = PayloadCipher::for_agent(agent_id)?;
    Ok(Json(task_page(rows, &cipher)?))
}

fn task_page(rows: Rows<TaskRow>, cipher: &PayloadCipher) -> Result<Page<TaskView>, StateError> {
    let next_cursor = next_task_cursor(&rows);
    let items = rows
        .rows
        .into_iter()
        .map(|row| TaskView::open(row, cipher))
        .collect::<Result<_, _>>()?;
    Ok(Page { items, next_cursor })
}

/// Where the next page of tasks starts: just after this page's last row, if another page exists.
fn next_task_cursor(rows: &Rows<TaskRow>) -> Option<String> {
    let last = rows.has_more.then(|| rows.rows.last()).flatten()?;
    Some(
        TaskCursor {
            updated_at: last.updated_at,
            task_id: last.task_id.clone(),
        }
        .encode(),
    )
}

// ─── Key-value ──────────────────────────────────────────────────────────────

async fn put_kv(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    key: KvKey,
    precondition: Precondition,
    StateJson(request): StateJson<PutKvRequest>,
) -> Result<Json<KvStamp>, StateError> {
    let payload = BoundedPayload::new(&request.value, state.config.agent_state_max_body_bytes)?;
    let sealed_value = PayloadCipher::for_agent(agent_id)?.seal(&payload);
    let entry = NewEntry {
        key: key.as_str(),
        sealed_value: &sealed_value,
    };
    let outcome = repo::put_kv(
        &state.db,
        agent_id,
        &entry,
        precondition,
        state.config.agent_state_ttl_days,
    )
    .await?;
    Ok(Json(KvStamp::new(key.into_string(), stored(outcome)?)))
}

async fn get_kv(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    key: KvKey,
) -> Result<Json<KvView>, StateError> {
    let row = repo::get_kv(&state.db, agent_id, key.as_str())
        .await?
        .ok_or(StateError::NotFound { what: "key" })?;
    let cipher = PayloadCipher::for_agent(agent_id)?;
    Ok(Json(KvView::open(row, &cipher)?))
}

async fn delete_kv(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    key: KvKey,
    precondition: Precondition,
) -> Result<StatusCode, StateError> {
    let outcome = repo::delete(&state.db, agent_id, Store::Kv, key.as_str(), precondition).await?;
    deleted(outcome, "key")
}

async fn list_kv(
    State(state): State<AppState>,
    AuthenticatedAgent(agent_id): AuthenticatedAgent,
    StateQuery(query): StateQuery<ListKvQuery>,
) -> Result<Json<Page<KvView>>, StateError> {
    let query = KvQuery::try_from(query)?;
    let rows = repo::list_kv(&state.db, agent_id, &query).await?;
    let cipher = PayloadCipher::for_agent(agent_id)?;
    Ok(Json(kv_page(rows, &cipher)?))
}

fn kv_page(rows: Rows<KvRow>, cipher: &PayloadCipher) -> Result<Page<KvView>, StateError> {
    let next_cursor = next_kv_cursor(&rows);
    let items = rows
        .rows
        .into_iter()
        .map(|row| KvView::open(row, cipher))
        .collect::<Result<_, _>>()?;
    Ok(Page { items, next_cursor })
}

/// Where the next page of entries starts: just after this page's last row, if another exists.
fn next_kv_cursor(rows: &Rows<KvRow>) -> Option<String> {
    let last = rows.has_more.then(|| rows.rows.last()).flatten()?;
    Some(
        KeyCursor {
            key: last.key.clone(),
        }
        .encode(),
    )
}

// ─── Outcomes to responses ──────────────────────────────────────────────────

fn stored(outcome: PutOutcome) -> Result<Stamp, StateError> {
    match outcome {
        PutOutcome::Stored(stamp) => Ok(stamp),
        PutOutcome::VersionConflict { current_version } => {
            Err(StateError::VersionConflict { current_version })
        }
    }
}

fn deleted(outcome: DeleteOutcome, what: &'static str) -> Result<StatusCode, StateError> {
    match outcome {
        DeleteOutcome::Deleted => Ok(StatusCode::NO_CONTENT),
        DeleteOutcome::NotFound => Err(StateError::NotFound { what }),
        DeleteOutcome::VersionConflict { current_version } => {
            Err(StateError::VersionConflict { current_version })
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};

    use super::*;

    fn at(micros: i64) -> DateTime<Utc> {
        DateTime::from_timestamp_micros(micros).unwrap()
    }

    fn task_row(task_id: &str, updated_at_micros: i64) -> TaskRow {
        TaskRow {
            task_id: task_id.into(),
            context_id: None,
            state: "working".into(),
            sealed_body: String::new(),
            version: 1,
            updated_at: at(updated_at_micros),
            expires_at: at(updated_at_micros + 1),
        }
    }

    #[test]
    fn a_put_that_stored_is_its_stamp_and_a_conflict_carries_the_current_version() {
        let stamp = Stamp {
            version: 3,
            updated_at: at(1),
            expires_at: at(2),
        };
        assert_eq!(stored(PutOutcome::Stored(stamp)).unwrap().version, 3);
        assert!(matches!(
            stored(PutOutcome::VersionConflict { current_version: 9 }),
            Err(StateError::VersionConflict { current_version: 9 })
        ));
    }

    #[test]
    fn each_delete_outcome_maps_to_its_status() {
        assert_eq!(
            deleted(DeleteOutcome::Deleted, "task").unwrap(),
            StatusCode::NO_CONTENT
        );
        assert!(matches!(
            deleted(DeleteOutcome::NotFound, "task"),
            Err(StateError::NotFound { what: "task" })
        ));
        assert!(matches!(
            deleted(
                DeleteOutcome::VersionConflict { current_version: 2 },
                "task"
            ),
            Err(StateError::VersionConflict { current_version: 2 })
        ));
    }

    fn kv_row(key: &str) -> KvRow {
        KvRow {
            key: key.into(),
            sealed_value: String::new(),
            version: 1,
            updated_at: at(1),
            expires_at: at(2),
        }
    }

    #[test]
    fn a_page_with_more_after_it_resumes_just_past_its_last_task() {
        let rows = Rows {
            rows: vec![task_row("a", 20), task_row("b", 10)],
            has_more: true,
        };
        let cursor = next_task_cursor(&rows).expect("another page follows");
        assert_eq!(
            TaskCursor::decode(&cursor).unwrap(),
            TaskCursor {
                updated_at: at(10),
                task_id: "b".into()
            }
        );
    }

    #[test]
    fn the_last_page_of_tasks_has_no_next_cursor() {
        let rows = Rows {
            rows: vec![task_row("a", 20)],
            has_more: false,
        };
        assert_eq!(next_task_cursor(&rows), None);
        let empty = Rows::<TaskRow> {
            rows: vec![],
            has_more: false,
        };
        assert_eq!(next_task_cursor(&empty), None);
    }

    #[test]
    fn a_page_with_more_after_it_resumes_just_past_its_last_key() {
        let rows = Rows {
            rows: vec![kv_row("a"), kv_row("b")],
            has_more: true,
        };
        let cursor = next_kv_cursor(&rows).expect("another page follows");
        assert_eq!(
            KeyCursor::decode(&cursor).unwrap(),
            KeyCursor { key: "b".into() }
        );
    }

    #[test]
    fn the_last_page_of_entries_has_no_next_cursor() {
        let rows = Rows {
            rows: vec![kv_row("a")],
            has_more: false,
        };
        assert_eq!(next_kv_cursor(&rows), None);
    }
}
