//! The `agent_lost_task` resume outcome.
//!
//! A paused A2A task lives in the agent's own memory. When the agent restarts, or the human's
//! answer reaches a replica that never saw the task, the agent replies with A2A
//! `TaskNotFoundError` instead of continuing. The resume dispatcher
//! (`oss/server/src/hitl/mod.rs`) must record that as the terminal `agent_lost_task` outcome,
//! not as a delivered answer (`completed`) and not as a retryable failure.
//!
//! Agents report "no such task" two ways, and both are covered here:
//!   * a JSON-RPC `error` with code -32001, in an SSE frame or a JSON body, at HTTP 200
//!     (what the Python a2a-sdk sends), and
//!   * HTTP 404 (the status the Rust a2a-server maps `TaskNotFoundError` to,
//!     `oss/docs/A2A_PROTOCOL.md`, "HTTP Status Code Mapping").
//!
//! `just infra` then
//! `cargo test -p nasiko-server --test hitl_agent_lost_task -- --test-threads=1`

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use serde_json::{Value, json};
use serial_test::serial;
use uuid::Uuid;

// ─── The fake agent ──────────────────────────────────────────────────────────

/// How the fake agent answers the call that resumes the paused task.
#[derive(Clone, Copy)]
enum ResumeReply {
    /// JSON-RPC `TaskNotFoundError` as an SSE frame at HTTP 200 (Python a2a-sdk, `message/stream`).
    TaskNotFoundFrame,
    /// The same error as a JSON body at HTTP 200 (a non-streaming agent).
    TaskNotFoundJsonBody,
    /// The same error with HTTP 404 (Rust a2a-server).
    TaskNotFoundHttp404,
    /// A JSON-RPC error that is not "task not found": must keep today's handling.
    OtherJsonRpcError,
}

#[derive(Clone)]
struct FakeAgent {
    resume_reply: ResumeReply,
    calls: Arc<AtomicUsize>,
}

fn task_not_found_error(request_id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": { "code": -32001, "message": "Task not found" },
    })
}

fn sse_response(data: &Value) -> Response {
    Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from(format!("data: {data}\n\n")))
        .unwrap()
}

fn json_response(status: u16, data: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(data.to_string()))
        .unwrap()
}

async fn fake_agent_handler(State(agent): State<FakeAgent>, body: Bytes) -> Response {
    agent.calls.fetch_add(1, Ordering::SeqCst);
    let request: Value = serde_json::from_slice(&body).unwrap_or_default();
    let request_id = &request["id"];
    match agent.resume_reply {
        ResumeReply::TaskNotFoundFrame => sse_response(&task_not_found_error(request_id)),
        ResumeReply::TaskNotFoundJsonBody => json_response(200, &task_not_found_error(request_id)),
        ResumeReply::TaskNotFoundHttp404 => json_response(404, &task_not_found_error(request_id)),
        ResumeReply::OtherJsonRpcError => sse_response(&json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": { "code": -32603, "message": "Internal error" },
        })),
    }
}

/// Starts the fake agent and returns its URL and a counter of the requests it has served.
async fn start_fake_agent(resume_reply: ResumeReply) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route("/", post(fake_agent_handler))
        .with_state(FakeAgent {
            resume_reply,
            calls: calls.clone(),
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), calls)
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

fn auth(rb: reqwest::RequestBuilder, user_id: Uuid) -> reqwest::RequestBuilder {
    let user_id_str = user_id.to_string();
    common::as_member(rb, &user_id_str, &format!("user_{}", &user_id_str[..8]))
}

async fn seed_user(server: &common::TestServer) -> Uuid {
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(format!("user_{}", &user_id.to_string()[..8]))
        .bind(format!("user_{}@test.example", &user_id.to_string()[..8]))
        .execute(&server.db)
        .await
        .expect("seed_user");
    user_id
}

async fn seed_running_agent(server: &common::TestServer, owner_id: Uuid, url: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO agents (name, owner_id, url, status) VALUES ($1, $2, $3, 'running') RETURNING id",
    )
    .bind(format!("lost-task-agent-{}", Uuid::new_v4()))
    .bind(owner_id)
    .bind(url)
    .fetch_one(&server.db)
    .await
    .expect("seed_running_agent")
}

/// A `pending` `input_required` row on a direct chat, as `persist_direct_chat_pause` writes it,
/// for the tests that do not need to exercise pause detection.
async fn seed_pending_request(server: &common::TestServer, agent_id: Uuid, owner_id: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO hitl_requests
            (kind, origin, agent_id, owner_user_id, task_id, context_id, question, expires_at)
         VALUES ('input_required', 'direct_chat', $1, $2, $3, $4, $5, now() + interval '1 day')
         RETURNING id",
    )
    .bind(agent_id)
    .bind(owner_id)
    .bind(format!("task-{}", Uuid::new_v4()))
    .bind(format!("ctx-{}", Uuid::new_v4()))
    .bind(json!({"message": "Which region?"}))
    .fetch_one(&server.db)
    .await
    .expect("seed_pending_request")
}

async fn answer(server: &common::TestServer, user_id: Uuid, hitl_id: Uuid) {
    let response = auth(
        server
            .client
            .post(server.url(&format!("/api/hitl/{hitl_id}/resolve")))
            .json(&json!({"answer": "eu-west-1"})),
        user_id,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
}

struct ResumeRow {
    resume_status: String,
    resume_last_error: Option<String>,
    resume_dispatch_attempts: i32,
    leased: bool,
}

/// Polls until the dispatcher has recorded a terminal outcome (`resume_status` leaves
/// `not_started`), or panics. Budget: a retryable failure runs out its five attempts in about
/// ten seconds (each retry waits for the dispatcher's two second tick).
async fn wait_for_terminal_resume(server: &common::TestServer, id: Uuid) -> ResumeRow {
    for _ in 0..200 {
        let row = fetch_resume_row(server, id).await;
        if row.resume_status != "not_started" {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    panic!("hitl request {id} never left resume_status = not_started");
}

async fn fetch_resume_row(server: &common::TestServer, id: Uuid) -> ResumeRow {
    let (resume_status, resume_last_error, resume_dispatch_attempts, leased): (
        String,
        Option<String>,
        i32,
        bool,
    ) = sqlx::query_as(
        "SELECT resume_status, resume_last_error, resume_dispatch_attempts,
                resume_claimed_at IS NOT NULL
           FROM hitl_requests WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    ResumeRow {
        resume_status,
        resume_last_error,
        resume_dispatch_attempts,
        leased,
    }
}

/// Seeds a paused direct-chat task, answers it, and returns the terminal row the dispatcher
/// recorded for the given way of answering the resume.
async fn resume_with(
    reply: ResumeReply,
) -> (ResumeRow, Uuid, Arc<AtomicUsize>, common::TestServer) {
    let server = common::TestServer::start().await;
    let user_id = seed_user(&server).await;
    let (agent_url, calls) = start_fake_agent(reply).await;
    let agent_id = seed_running_agent(&server, user_id, &agent_url).await;
    let hitl_id = seed_pending_request(&server, agent_id, user_id).await;

    answer(&server, user_id, hitl_id).await;
    let row = wait_for_terminal_resume(&server, hitl_id).await;
    (row, hitl_id, calls, server)
}

// ─── The outcome ─────────────────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn a_task_not_found_stream_frame_is_recorded_as_agent_lost_task() {
    let (row, _, _, server) = resume_with(ResumeReply::TaskNotFoundFrame).await;

    assert_eq!(row.resume_status, "agent_lost_task");
    assert!(!row.leased, "a terminal row must not keep its lease");
    assert!(
        row.resume_last_error
            .as_deref()
            .is_some_and(|e| e.contains("-32001")),
        "the signal that classified the row should be recorded: {:?}",
        row.resume_last_error
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_task_not_found_json_body_is_recorded_as_agent_lost_task() {
    let (row, _, _, server) = resume_with(ResumeReply::TaskNotFoundJsonBody).await;

    assert_eq!(row.resume_status, "agent_lost_task");
    assert!(!row.leased);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn an_http_404_is_recorded_as_agent_lost_task_and_never_retried() {
    let (row, hitl_id, calls, server) = resume_with(ResumeReply::TaskNotFoundHttp404).await;

    assert_eq!(row.resume_status, "agent_lost_task");
    assert!(!row.leased);
    assert_eq!(
        row.resume_dispatch_attempts, 1,
        "the answer reached no task, so there is nothing to retry"
    );
    assert!(
        row.resume_last_error
            .as_deref()
            .is_some_and(|e| e.contains("404")),
        "the signal that classified the row should be recorded: {:?}",
        row.resume_last_error
    );

    // Let the dispatcher tick past where a retry would have happened: the row stays put and the
    // agent is not asked again.
    let calls_at_terminal = calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(5)).await;
    let later = fetch_resume_row(&server, hitl_id).await;
    assert_eq!(later.resume_status, "agent_lost_task");
    assert_eq!(later.resume_dispatch_attempts, 1);
    assert_eq!(calls.load(Ordering::SeqCst), calls_at_terminal);

    server.cleanup().await;
}

/// What `orchestrator_stream` leaves behind when a delegated agent pauses, seeded directly: the
/// chat session, the paused turn's flow and its step stuck at `awaiting_human`, and the
/// orchestrator-origin request. Returns `(request id, chat session id, flow step id)`.
async fn seed_paused_orchestrator_turn(
    server: &common::TestServer,
    user_id: Uuid,
    agent_id: Uuid,
) -> (Uuid, String, Uuid) {
    let agent_name: String = sqlx::query_scalar("SELECT name FROM agents WHERE id = $1")
        .bind(agent_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    let session_id = format!("ses_{}", Uuid::new_v4().simple());
    let flow_id = Uuid::new_v4().simple().to_string();

    sqlx::query(
        "INSERT INTO chat_sessions (session_id, user_id, agent_id, agent_url, title) \
         VALUES ($1, $2, NULL, '/api/orchestrator/a2a', 'lost task')",
    )
    .bind(&session_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .expect("seed chat_sessions");
    sqlx::query(
        "INSERT INTO flows (flow_id, user_id, root_agent_name, title, status) \
         VALUES ($1, $2, 'orchestrator', 'paused turn', 'paused')",
    )
    .bind(&flow_id)
    .bind(user_id)
    .execute(&server.db)
    .await
    .expect("seed flows");
    sqlx::query(
        "INSERT INTO session_traces (session_id, trace_id, agent_id, agent_name) \
         VALUES ($1, $2, NULL, 'orchestrator')",
    )
    .bind(&session_id)
    .bind(&flow_id)
    .execute(&server.db)
    .await
    .expect("seed session_traces");
    let step_id: Uuid = sqlx::query_scalar(
        "INSERT INTO flow_steps \
            (flow_id, step_order, depth, agent_name, caller_agent_name, input_summary, status) \
         VALUES ($1, 1, 1, $2, 'orchestrator', 'what is the weather?', 'awaiting_human') \
         RETURNING id",
    )
    .bind(&flow_id)
    .bind(nasiko_react_agent::A2aTool::agent_display_name(&agent_name))
    .fetch_one(&server.db)
    .await
    .expect("seed flow_steps");
    let hitl_id: Uuid = sqlx::query_scalar(
        "INSERT INTO hitl_requests \
            (kind, origin, agent_id, owner_user_id, task_id, context_id, chat_session_id, \
             question, expires_at) \
         VALUES ('input_required', 'orchestrator', $1, $2, $3, $4, $5, $6, now() + interval '1 day') \
         RETURNING id",
    )
    .bind(agent_id)
    .bind(user_id)
    .bind(format!("task-{}", Uuid::new_v4()))
    .bind(format!("agent-ctx-{}", Uuid::new_v4()))
    .bind(&session_id)
    .bind(json!({"message": "Which region?"}))
    .fetch_one(&server.db)
    .await
    .expect("seed hitl_requests");

    (hitl_id, session_id, step_id)
}

/// A completed resume of an orchestrator-origin request hands the agent's reply back to the
/// orchestrator for a follow-up turn, seeded with a note the user never typed ("the agent has
/// already completed the step"). When the agent lost the task there is no reply and the step did
/// not happen, so that turn must not run; the paused step still must not be left waiting on a
/// human who has answered.
#[tokio::test]
#[serial]
async fn an_orchestrator_resume_that_lost_its_task_starts_no_follow_up_turn() {
    let server = common::TestServer::start().await;
    let user_id = seed_user(&server).await;
    let (agent_url, _) = start_fake_agent(ResumeReply::TaskNotFoundFrame).await;
    let agent_id = seed_running_agent(&server, user_id, &agent_url).await;
    let (hitl_id, session_id, step_id) =
        seed_paused_orchestrator_turn(&server, user_id, agent_id).await;

    answer(&server, user_id, hitl_id).await;
    let row = wait_for_terminal_resume(&server, hitl_id).await;
    assert_eq!(row.resume_status, "agent_lost_task");

    let step_status = async || -> String {
        sqlx::query_scalar("SELECT status FROM flow_steps WHERE id = $1")
            .bind(step_id)
            .fetch_one(&server.db)
            .await
            .unwrap()
    };
    for _ in 0..100 {
        if step_status().await != "awaiting_human" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(step_status().await, "resumed");

    // The only transcript row is the human's own answer, which `resolve` saves. A follow-up turn
    // would have added its note (role `system`) before doing anything else.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let roles: Vec<String> = sqlx::query_scalar(
        "SELECT role FROM chat_messages WHERE session_id = $1 ORDER BY timestamp",
    )
    .bind(&session_id)
    .fetch_all(&server.db)
    .await
    .unwrap();
    assert_eq!(roles, ["user"]);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_json_rpc_error_that_is_not_task_not_found_is_still_recorded_as_delivered() {
    let (row, _, _, server) = resume_with(ResumeReply::OtherJsonRpcError).await;

    assert_eq!(
        row.resume_status, "completed",
        "only a lost task gets the new outcome; any other agent error keeps its handling"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn the_hitl_api_reports_the_outcome() {
    let (row, hitl_id, _, server) = resume_with(ResumeReply::TaskNotFoundFrame).await;
    assert_eq!(row.resume_status, "agent_lost_task");
    let user_id: Uuid = sqlx::query_scalar("SELECT owner_user_id FROM hitl_requests WHERE id = $1")
        .bind(hitl_id)
        .fetch_one(&server.db)
        .await
        .unwrap();

    let body: Value = auth(
        server
            .client
            .get(server.url(&format!("/api/hitl/{hitl_id}"))),
        user_id,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();

    assert_eq!(body["status"], "resolved");
    assert_eq!(body["resume_status"], "agent_lost_task");

    server.cleanup().await;
}

/// `GET /api/hitl/{id}/stream` closes once the row reaches a terminal state. A status the stream
/// does not know is terminal would leave every client that reconnects to a lost task waiting
/// forever.
#[tokio::test]
#[serial]
async fn the_hitl_stream_closes_on_a_lost_task() {
    let server = common::TestServer::start().await;
    let user_id = seed_user(&server).await;
    let agent_id = seed_running_agent(&server, user_id, "http://127.0.0.1:1").await;
    let hitl_id = seed_pending_request(&server, agent_id, user_id).await;
    sqlx::query(
        "UPDATE hitl_requests
            SET status = 'resolved', resolved_at = now(), resume_status = 'agent_lost_task'
          WHERE id = $1",
    )
    .bind(hitl_id)
    .execute(&server.db)
    .await
    .unwrap();

    let body = tokio::time::timeout(
        Duration::from_secs(10),
        auth(
            server
                .client
                .get(server.url(&format!("/api/hitl/{hitl_id}/stream"))),
            user_id,
        )
        .send()
        .await
        .unwrap()
        .text(),
    )
    .await
    .expect("the stream must end on its own once the row is terminal")
    .unwrap();

    assert!(
        body.contains("\"resume_status\":\"agent_lost_task\""),
        "the stream should have reported the outcome before closing: {body}"
    );

    server.cleanup().await;
}
