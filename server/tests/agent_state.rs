//! `/api/agent-state/*`: per-agent durable tasks and key-value state.
//!
//! The routes sit outside the session auth. A deployed agent presents the credential the MCP
//! gateway issued it (`MCP_GATEWAY_TOKEN`), every row is scoped by the agent behind that
//! credential, writes carry optimistic versions, rows expire, and what is stored is ciphertext.
//! These tests drive the real HTTP surface and look at the raw tables where the claim is about
//! storage.
//!
//! Needs infra up (Postgres, Redis, S3):
//!   TEST_PG_URL=... TEST_REDIS_URL=... TEST_S3_ENDPOINT=... \
//!     cargo test -p nasiko-server --test agent_state -- --test-threads=1

mod common;

use std::time::Duration;

use chrono::{DateTime, Utc};
use common::TestServer;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Method, RequestBuilder, Response};
use serde_json::{Value, json};
use serial_test::serial;
use sqlx::PgPool;
use uuid::Uuid;

// ─── Fixtures ───────────────────────────────────────────────────────────────

struct Agent {
    id: Uuid,
    token: String,
}

async fn seed_user(server: &TestServer, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id")
        .bind(name)
        .bind(format!("{name}@test.local"))
        .fetch_one(&server.db)
        .await
        .expect("seed user")
}

async fn seed_agent_row(server: &TestServer, owner_id: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO agents (name, owner_id, image, status) \
         VALUES ($1, $2, 'nasiko/echo:1.0.0', 'running') RETURNING id",
    )
    .bind(name)
    .bind(owner_id)
    .fetch_one(&server.db)
    .await
    .expect("seed agent")
}

/// An agent with its own owner and a freshly minted credential.
async fn new_agent(server: &TestServer, name: &str) -> Agent {
    let owner = seed_user(server, &format!("{name}-owner")).await;
    let id = seed_agent_row(server, owner, name).await;
    let token = common::mint_gateway_token(&server.db, id).await;
    Agent { id, token }
}

fn url(server: &TestServer, path: &str) -> String {
    server.url(&format!("/api/agent-state{path}"))
}

fn call(server: &TestServer, agent: &Agent, method: Method, path: &str) -> RequestBuilder {
    server
        .client
        .request(method, url(server, path))
        .bearer_auth(&agent.token)
}

/// A path segment as a client must send it: every byte that is not alphanumeric escaped.
fn enc(segment: &str) -> String {
    utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string()
}

async fn put_task_in(
    server: &TestServer,
    agent: &Agent,
    task_id: &str,
    context_id: Option<&str>,
    state: &str,
    body: Value,
) -> Response {
    call(
        server,
        agent,
        Method::PUT,
        &format!("/tasks/{}", enc(task_id)),
    )
    .json(&json!({"context_id": context_id, "state": state, "body": body}))
    .send()
    .await
    .unwrap()
}

async fn put_task(server: &TestServer, agent: &Agent, task_id: &str, body: Value) -> Response {
    put_task_in(server, agent, task_id, None, "working", body).await
}

async fn get_task(server: &TestServer, agent: &Agent, task_id: &str) -> Response {
    call(
        server,
        agent,
        Method::GET,
        &format!("/tasks/{}", enc(task_id)),
    )
    .send()
    .await
    .unwrap()
}

async fn delete_task(server: &TestServer, agent: &Agent, task_id: &str) -> Response {
    call(
        server,
        agent,
        Method::DELETE,
        &format!("/tasks/{}", enc(task_id)),
    )
    .send()
    .await
    .unwrap()
}

async fn put_kv(server: &TestServer, agent: &Agent, key: &str, value: Value) -> Response {
    call(server, agent, Method::PUT, &format!("/kv/{}", enc(key)))
        .json(&json!({ "value": value }))
        .send()
        .await
        .unwrap()
}

async fn get_kv(server: &TestServer, agent: &Agent, key: &str) -> Response {
    call(server, agent, Method::GET, &format!("/kv/{}", enc(key)))
        .send()
        .await
        .unwrap()
}

async fn delete_kv(server: &TestServer, agent: &Agent, key: &str) -> Response {
    call(server, agent, Method::DELETE, &format!("/kv/{}", enc(key)))
        .send()
        .await
        .unwrap()
}

/// A listing request that must succeed; returns the page.
async fn list(server: &TestServer, agent: &Agent, path_and_query: &str) -> Value {
    let res = call(server, agent, Method::GET, path_and_query)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "GET {path_and_query}");
    res.json().await.unwrap()
}

/// The ids (or keys) of a listing's items, in order.
fn names(page: &Value, field: &str) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("items is an array")
        .iter()
        .map(|item| {
            item[field]
                .as_str()
                .expect("item names its row")
                .to_string()
        })
        .collect()
}

/// Asserts an error response's status and its stable `code`, and returns the body.
async fn expect_error(res: Response, status: u16, code: &str) -> Value {
    assert_eq!(res.status(), status, "status");
    let body: Value = res.json().await.expect("error bodies are JSON");
    assert_eq!(body["code"], code, "code in {body}");
    assert!(body["error"].is_string(), "error message in {body}");
    body
}

fn timestamp(body: &Value, field: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(body[field].as_str().expect("timestamp is a string"))
        .expect("timestamp is RFC 3339")
        .with_timezone(&Utc)
}

async fn expire_task(server: &TestServer, agent: &Agent, task_id: &str) {
    sqlx::query(
        "UPDATE agent_tasks SET expires_at = now() - interval '1 second' \
         WHERE agent_id = $1 AND task_id = $2",
    )
    .bind(agent.id)
    .bind(task_id)
    .execute(&server.db)
    .await
    .unwrap();
}

async fn expire_kv(server: &TestServer, agent: &Agent, key: &str) {
    sqlx::query(
        "UPDATE agent_kv SET expires_at = now() - interval '1 second' \
         WHERE agent_id = $1 AND key = $2",
    )
    .bind(agent.id)
    .bind(key)
    .execute(&server.db)
    .await
    .unwrap();
}

async fn count_rows(server: &TestServer, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&server.db)
        .await
        .unwrap()
}

/// A second pool onto the test's database. The server's own pool is a single connection, so a
/// test that needs to hold a lock the way a concurrent writer would has to bring its own.
async fn peer_pool(server: &TestServer) -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_with((*server.db.connect_options()).clone())
        .await
        .expect("connect peer pool")
}

/// A document shaped like a serialized A2A task, with the awkward corners of JSON in it.
fn sample_task_body() -> Value {
    json!({
        "id": "task-1",
        "status": {"state": "input-required", "timestamp": "2026-10-07T09:00:00Z"},
        "history": [
            {"role": "user", "parts": [{"kind": "text", "text": "héllo ✓ \u{1F600} \"quoted\" \\ slash"}]},
            {"role": "agent", "parts": [{"kind": "data", "data": {"n": 1, "f": 1.5, "big": 9007199254740993_i64}}]}
        ],
        "metadata": {"nil": null, "flag": false, "nested": {"deep": [1, [2, [3, {}]]]}},
        "empty_object": {},
        "empty_array": []
    })
}

// ─── Authentication ─────────────────────────────────────────────────────────

/// Every route and method the API serves, as `(method, path)`.
fn every_route() -> Vec<(Method, &'static str)> {
    vec![
        (Method::POST, "/register"),
        (Method::GET, "/tasks"),
        (Method::PUT, "/tasks/t1"),
        (Method::GET, "/tasks/t1"),
        (Method::DELETE, "/tasks/t1"),
        (Method::GET, "/kv"),
        (Method::PUT, "/kv/k1"),
        (Method::GET, "/kv/k1"),
        (Method::DELETE, "/kv/k1"),
    ]
}

#[tokio::test]
#[serial]
async fn no_route_serves_a_request_without_a_credential() {
    let server = TestServer::start().await;
    for (method, path) in every_route() {
        let res = server
            .client
            .request(method.clone(), url(&server, path))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        expect_error(res, 401, "unauthorized").await;
    }
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn only_a_live_agent_credential_authenticates() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "auth-agent").await;

    for bad in ["", "not-a-token", "ngt_deadbeef", &"A".repeat(5000)] {
        let res = server
            .client
            .get(url(&server, "/tasks"))
            .bearer_auth(bad)
            .send()
            .await
            .unwrap();
        expect_error(res, 401, "unauthorized").await;
    }

    // The right secret under the wrong scheme is no credential at all.
    let basic = server
        .client
        .get(url(&server, "/tasks"))
        .basic_auth("agent", Some(&agent.token))
        .send()
        .await
        .unwrap();
    expect_error(basic, 401, "unauthorized").await;

    let ok = call(&server, &agent, Method::GET, "/tasks")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_user_session_token_is_not_an_agent_credential() {
    let server = TestServer::start().await;
    let owner = seed_user(&server, "session-owner").await;
    let res = common::as_superuser(
        server.client.get(url(&server, "/tasks")),
        &owner.to_string(),
        "admin",
    )
    .send()
    .await
    .unwrap();
    expect_error(res, 401, "unauthorized").await;
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_revoked_credential_stops_authenticating() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "revoked-agent").await;
    let ok = call(&server, &agent, Method::GET, "/tasks")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);

    nasiko_mcp_gateway::agent_tokens::revoke(&server.db, agent.id)
        .await
        .unwrap();

    let res = call(&server, &agent, Method::GET, "/tasks")
        .send()
        .await
        .unwrap();
    expect_error(res, 401, "unauthorized").await;
    server.cleanup().await;
}

// ─── Isolation between agents ───────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn an_agent_cannot_see_or_touch_another_agents_tasks() {
    let server = TestServer::start().await;
    let alice = new_agent(&server, "alice").await;
    let bob = new_agent(&server, "bob").await;
    let alice_body = json!({"owner": "alice"});
    assert_eq!(
        put_task(&server, &alice, "shared-id", alice_body.clone())
            .await
            .status(),
        200
    );

    // Bob asks for Alice's task by its exact id: absent, not forbidden.
    expect_error(get_task(&server, &bob, "shared-id").await, 404, "not_found").await;
    expect_error(
        delete_task(&server, &bob, "shared-id").await,
        404,
        "not_found",
    )
    .await;
    assert!(names(&list(&server, &bob, "/tasks").await, "task_id").is_empty());

    // Bob writing the same id makes his own row; it neither replaces nor versions hers.
    let bobs = put_task(&server, &bob, "shared-id", json!({"owner": "bob"})).await;
    assert_eq!(bobs.status(), 200);
    assert_eq!(bobs.json::<Value>().await.unwrap()["version"], 1);

    let hers: Value = get_task(&server, &alice, "shared-id")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(hers["body"], alice_body);
    assert_eq!(hers["version"], 1);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn an_agent_cannot_see_or_touch_another_agents_kv_entries() {
    let server = TestServer::start().await;
    let alice = new_agent(&server, "alice-kv").await;
    let bob = new_agent(&server, "bob-kv").await;
    put_kv(&server, &alice, "shared-key", json!("alice")).await;

    expect_error(get_kv(&server, &bob, "shared-key").await, 404, "not_found").await;
    expect_error(
        delete_kv(&server, &bob, "shared-key").await,
        404,
        "not_found",
    )
    .await;
    assert!(names(&list(&server, &bob, "/kv").await, "key").is_empty());

    let bobs = put_kv(&server, &bob, "shared-key", json!("bob")).await;
    assert_eq!(bobs.json::<Value>().await.unwrap()["version"], 1);
    let hers: Value = get_kv(&server, &alice, "shared-key")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(hers["value"], "alice");

    server.cleanup().await;
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn a_task_is_created_replaced_read_back_and_deleted() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "task-agent").await;
    let body = sample_task_body();

    let created = put_task_in(
        &server,
        &agent,
        "task-1",
        Some("ctx-1"),
        "working",
        body.clone(),
    )
    .await;
    assert_eq!(created.status(), 200);
    let created: Value = created.json().await.unwrap();
    assert_eq!(created["task_id"], "task-1");
    assert_eq!(created["version"], 1);
    let mut put_fields: Vec<&str> = created
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    put_fields.sort_unstable();
    assert_eq!(
        put_fields,
        ["expires_at", "task_id", "updated_at", "version"]
    );

    // What is read back is exactly what was written.
    let read: Value = get_task(&server, &agent, "task-1")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["body"], body);
    assert_eq!(read["context_id"], "ctx-1");
    assert_eq!(read["state"], "working");
    assert_eq!(read["version"], 1);
    assert_eq!(read["updated_at"], created["updated_at"]);
    assert_eq!(read["expires_at"], created["expires_at"]);
    let mut get_fields: Vec<&str> = read
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    get_fields.sort_unstable();
    assert_eq!(
        get_fields,
        [
            "body",
            "context_id",
            "expires_at",
            "state",
            "task_id",
            "updated_at",
            "version"
        ]
    );

    // A second write replaces the first, one version up, with no merging.
    let replacement = json!({"id": "task-1", "status": {"state": "completed"}});
    let replaced = put_task_in(
        &server,
        &agent,
        "task-1",
        None,
        "completed",
        replacement.clone(),
    )
    .await;
    let replaced: Value = replaced.json().await.unwrap();
    assert_eq!(replaced["version"], 2);
    assert!(timestamp(&replaced, "updated_at") >= timestamp(&created, "updated_at"));
    let read: Value = get_task(&server, &agent, "task-1")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["body"], replacement);
    assert_eq!(read["state"], "completed");
    assert_eq!(read["context_id"], Value::Null);
    assert_eq!(read["version"], 2);

    assert_eq!(delete_task(&server, &agent, "task-1").await.status(), 204);
    expect_error(get_task(&server, &agent, "task-1").await, 404, "not_found").await;
    expect_error(
        delete_task(&server, &agent, "task-1").await,
        404,
        "not_found",
    )
    .await;

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_null_body_is_a_value_like_any_other() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "null-body-agent").await;
    assert_eq!(
        put_task(&server, &agent, "t", Value::Null).await.status(),
        200
    );
    let read: Value = get_task(&server, &agent, "t").await.json().await.unwrap();
    assert_eq!(read["body"], Value::Null);
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn tasks_list_newest_first_and_page_by_cursor() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "list-agent").await;
    for (id, context, state) in [
        ("p1", "ctx-a", "working"),
        ("p2", "ctx-a", "working"),
        ("p3", "ctx-a", "completed"),
        ("p4", "ctx-a", "working"),
        ("p5", "ctx-a", "working"),
        ("q1", "ctx-b", "working"),
        ("q2", "ctx-b", "working"),
    ] {
        let res = put_task_in(&server, &agent, id, Some(context), state, json!({"id": id})).await;
        assert_eq!(res.status(), 200);
    }

    let all = list(&server, &agent, "/tasks").await;
    assert_eq!(
        names(&all, "task_id"),
        ["q2", "q1", "p5", "p4", "p3", "p2", "p1"],
        "newest write first"
    );
    assert_eq!(all["next_cursor"], Value::Null);
    assert_eq!(
        all["items"][0]["body"],
        json!({"id": "q2"}),
        "items carry their body"
    );

    // Three pages of the context, two rows at a time.
    let page1 = list(&server, &agent, "/tasks?context_id=ctx-a&limit=2").await;
    assert_eq!(names(&page1, "task_id"), ["p5", "p4"]);
    let cursor1 = page1["next_cursor"]
        .as_str()
        .expect("more follow")
        .to_string();
    let page2 = list(
        &server,
        &agent,
        &format!("/tasks?context_id=ctx-a&limit=2&cursor={cursor1}"),
    )
    .await;
    assert_eq!(names(&page2, "task_id"), ["p3", "p2"]);
    let cursor2 = page2["next_cursor"]
        .as_str()
        .expect("one more follows")
        .to_string();
    let page3 = list(
        &server,
        &agent,
        &format!("/tasks?context_id=ctx-a&limit=2&cursor={cursor2}"),
    )
    .await;
    assert_eq!(names(&page3, "task_id"), ["p1"]);
    assert_eq!(page3["next_cursor"], Value::Null, "the last page says so");

    // A context that fits the page exactly has no empty page after it.
    let exact = list(&server, &agent, "/tasks?context_id=ctx-b&limit=2").await;
    assert_eq!(names(&exact, "task_id"), ["q2", "q1"]);
    assert_eq!(exact["next_cursor"], Value::Null);

    // Filters combine, and paging works through them.
    let working = list(
        &server,
        &agent,
        "/tasks?context_id=ctx-a&state=working&limit=3",
    )
    .await;
    assert_eq!(names(&working, "task_id"), ["p5", "p4", "p2"]);
    let cursor = working["next_cursor"]
        .as_str()
        .expect("p1 follows")
        .to_string();
    let rest = list(
        &server,
        &agent,
        &format!("/tasks?context_id=ctx-a&state=working&limit=3&cursor={cursor}"),
    )
    .await;
    assert_eq!(names(&rest, "task_id"), ["p1"]);
    let completed = list(&server, &agent, "/tasks?state=completed").await;
    assert_eq!(names(&completed, "task_id"), ["p3"]);
    assert!(
        names(
            &list(&server, &agent, "/tasks?context_id=nobody").await,
            "task_id"
        )
        .is_empty()
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn rewriting_a_task_moves_it_to_the_front() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "reorder-agent").await;
    for id in ["a", "b", "c"] {
        put_task(&server, &agent, id, json!(id)).await;
    }
    put_task(&server, &agent, "a", json!("again")).await;
    let page = list(&server, &agent, "/tasks").await;
    assert_eq!(names(&page, "task_id"), ["a", "c", "b"]);
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn tasks_stamped_in_the_same_instant_page_in_id_order_without_gaps_or_repeats() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "tie-agent").await;
    for id in ["t-c", "t-a", "t-b", "t-e", "t-d"] {
        put_task(&server, &agent, id, json!(id)).await;
    }
    sqlx::query("UPDATE agent_tasks SET updated_at = '2026-01-01T00:00:00Z' WHERE agent_id = $1")
        .bind(agent.id)
        .execute(&server.db)
        .await
        .unwrap();
    put_task(&server, &agent, "t-newest", json!("n")).await;

    let mut seen = Vec::new();
    let mut path = "/tasks?limit=2".to_string();
    loop {
        let page = list(&server, &agent, &path).await;
        seen.extend(names(&page, "task_id"));
        match page["next_cursor"].as_str() {
            Some(cursor) => path = format!("/tasks?limit=2&cursor={cursor}"),
            None => break,
        }
    }
    assert_eq!(seen, ["t-newest", "t-a", "t-b", "t-c", "t-d", "t-e"]);
    server.cleanup().await;
}

// ─── Key-value ──────────────────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn a_kv_entry_is_created_replaced_read_back_and_deleted() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "kv-agent").await;
    let value = sample_task_body();

    let created = put_kv(&server, &agent, "config", value.clone()).await;
    assert_eq!(created.status(), 200);
    let created: Value = created.json().await.unwrap();
    assert_eq!(created["key"], "config");
    assert_eq!(created["version"], 1);
    let mut put_fields: Vec<&str> = created
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    put_fields.sort_unstable();
    assert_eq!(put_fields, ["expires_at", "key", "updated_at", "version"]);

    let read: Value = get_kv(&server, &agent, "config")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["value"], value);
    assert_eq!(read["version"], 1);
    let mut get_fields: Vec<&str> = read
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    get_fields.sort_unstable();
    assert_eq!(
        get_fields,
        ["expires_at", "key", "updated_at", "value", "version"]
    );

    let replaced: Value = put_kv(&server, &agent, "config", json!(42))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(replaced["version"], 2);
    let read: Value = get_kv(&server, &agent, "config")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["value"], 42);

    assert_eq!(delete_kv(&server, &agent, "config").await.status(), 204);
    expect_error(get_kv(&server, &agent, "config").await, 404, "not_found").await;
    expect_error(delete_kv(&server, &agent, "config").await, 404, "not_found").await;

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn any_json_value_can_be_a_kv_value() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "kv-json-agent").await;
    for (key, value) in [
        ("null", Value::Null),
        ("bool", json!(true)),
        ("int", json!(-7)),
        ("float", json!(2.5)),
        ("string", json!("text")),
        ("array", json!([1, "two", null])),
        ("object", json!({"a": {"b": []}})),
    ] {
        assert_eq!(
            put_kv(&server, &agent, key, value.clone()).await.status(),
            200
        );
        let read: Value = get_kv(&server, &agent, key).await.json().await.unwrap();
        assert_eq!(read["value"], value, "key {key}");
    }
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn kv_entries_list_in_key_order_filter_by_prefix_and_page() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "kv-list-agent").await;
    for key in ["app/d", "other/x", "app/a", "app/c", "app/b"] {
        put_kv(&server, &agent, key, json!(key)).await;
    }

    let all = list(&server, &agent, "/kv").await;
    assert_eq!(
        names(&all, "key"),
        ["app/a", "app/b", "app/c", "app/d", "other/x"]
    );
    assert_eq!(all["items"][0]["value"], "app/a", "items carry their value");

    let page1 = list(
        &server,
        &agent,
        &format!("/kv?prefix={}&limit=3", enc("app/")),
    )
    .await;
    assert_eq!(names(&page1, "key"), ["app/a", "app/b", "app/c"]);
    let cursor = page1["next_cursor"]
        .as_str()
        .expect("app/d follows")
        .to_string();
    let page2 = list(
        &server,
        &agent,
        &format!("/kv?prefix={}&limit=3&cursor={cursor}", enc("app/")),
    )
    .await;
    assert_eq!(names(&page2, "key"), ["app/d"]);
    assert_eq!(page2["next_cursor"], Value::Null);

    assert!(names(&list(&server, &agent, "/kv?prefix=missing").await, "key").is_empty());
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_prefix_is_literal_so_like_wildcards_in_it_match_only_themselves() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "kv-wildcard-agent").await;
    for key in ["100%_done", "1000 done", "100xxdone", "a\\b", "aXb"] {
        put_kv(&server, &agent, key, json!(1)).await;
    }
    let percent = list(&server, &agent, &format!("/kv?prefix={}", enc("100%_"))).await;
    assert_eq!(names(&percent, "key"), ["100%_done"]);
    let backslash = list(&server, &agent, &format!("/kv?prefix={}", enc("a\\"))).await;
    assert_eq!(names(&backslash, "key"), ["a\\b"]);
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn keys_and_task_ids_with_reserved_characters_round_trip_when_percent_encoded() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "encoding-agent").await;
    let awkward = "a/b c?d#e%f+g&h=i é日本";
    assert_eq!(
        put_kv(&server, &agent, awkward, json!("v")).await.status(),
        200
    );
    let read: Value = get_kv(&server, &agent, awkward).await.json().await.unwrap();
    assert_eq!(read["key"], awkward);
    assert_eq!(names(&list(&server, &agent, "/kv").await, "key"), [awkward]);
    assert_eq!(delete_kv(&server, &agent, awkward).await.status(), 204);

    assert_eq!(
        put_task(&server, &agent, awkward, json!(1)).await.status(),
        200
    );
    let read: Value = get_task(&server, &agent, awkward)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["task_id"], awkward);
    server.cleanup().await;
}

// ─── Optimistic concurrency (If-Match) ──────────────────────────────────────

fn put_task_if_match(
    server: &TestServer,
    agent: &Agent,
    task_id: &str,
    if_match: &str,
    body: Value,
) -> RequestBuilder {
    call(
        server,
        agent,
        Method::PUT,
        &format!("/tasks/{}", enc(task_id)),
    )
    .header("If-Match", if_match)
    .json(&json!({"context_id": null, "state": "working", "body": body}))
}

fn put_kv_if_match(
    server: &TestServer,
    agent: &Agent,
    key: &str,
    if_match: &str,
    value: Value,
) -> RequestBuilder {
    call(server, agent, Method::PUT, &format!("/kv/{}", enc(key)))
        .header("If-Match", if_match)
        .json(&json!({ "value": value }))
}

#[tokio::test]
#[serial]
async fn a_task_write_at_a_stale_version_is_refused_and_changes_nothing() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "stale-agent").await;
    put_task(&server, &agent, "t", json!({"n": 1})).await;

    // The version it is at: accepted, and the next one is 2.
    let matching = put_task_if_match(&server, &agent, "t", "1", json!({"n": 2}))
        .send()
        .await
        .unwrap();
    assert_eq!(matching.status(), 200);
    assert_eq!(matching.json::<Value>().await.unwrap()["version"], 2);

    // A writer that still believes it is at 1 loses, and is told where the row really is.
    let stale = put_task_if_match(&server, &agent, "t", "1", json!({"n": "lost"}))
        .send()
        .await
        .unwrap();
    let conflict = expect_error(stale, 412, "version_conflict").await;
    assert_eq!(conflict["error"], "version_conflict");
    assert_eq!(conflict["current_version"], 2);

    let read: Value = get_task(&server, &agent, "t").await.json().await.unwrap();
    assert_eq!(
        read["body"],
        json!({"n": 2}),
        "the refused write must not land"
    );
    assert_eq!(read["version"], 2);

    // The quoted form of the same version is the same precondition.
    let quoted = put_task_if_match(&server, &agent, "t", "\"2\"", json!({"n": 3}))
        .send()
        .await
        .unwrap();
    assert_eq!(quoted.status(), 200);

    // Without the header the write is unconditional, whatever version the row is at.
    let unconditional = put_task(&server, &agent, "t", json!({"n": 4})).await;
    assert_eq!(unconditional.json::<Value>().await.unwrap()["version"], 4);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn version_zero_means_only_if_absent_and_a_missing_row_fails_any_other_version() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "absent-agent").await;

    // Expecting a version of a row that is not there fails, and creates nothing.
    let phantom = put_task_if_match(&server, &agent, "t", "3", json!(1))
        .send()
        .await
        .unwrap();
    let conflict = expect_error(phantom, 412, "version_conflict").await;
    assert_eq!(conflict["current_version"], 0);
    expect_error(get_task(&server, &agent, "t").await, 404, "not_found").await;

    // Expecting absence creates it, once.
    let first = put_task_if_match(&server, &agent, "t", "0", json!("first"))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    assert_eq!(first.json::<Value>().await.unwrap()["version"], 1);
    let second = put_task_if_match(&server, &agent, "t", "0", json!("second"))
        .send()
        .await
        .unwrap();
    let conflict = expect_error(second, 412, "version_conflict").await;
    assert_eq!(conflict["current_version"], 1);
    let read: Value = get_task(&server, &agent, "t").await.json().await.unwrap();
    assert_eq!(read["body"], "first");

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_task_delete_at_a_stale_version_is_refused_and_removes_nothing() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "delete-stale-agent").await;
    put_task(&server, &agent, "t", json!(1)).await;
    put_task(&server, &agent, "t", json!(2)).await;

    let stale = call(&server, &agent, Method::DELETE, "/tasks/t")
        .header("If-Match", "1")
        .send()
        .await
        .unwrap();
    let conflict = expect_error(stale, 412, "version_conflict").await;
    assert_eq!(conflict["current_version"], 2);
    assert_eq!(
        get_task(&server, &agent, "t").await.status(),
        200,
        "the row must survive"
    );

    let matching = call(&server, &agent, Method::DELETE, "/tasks/t")
        .header("If-Match", "2")
        .send()
        .await
        .unwrap();
    assert_eq!(matching.status(), 204);

    // Nothing left to delete: absent is a 404, whatever version was expected.
    let gone = call(&server, &agent, Method::DELETE, "/tasks/t")
        .header("If-Match", "2")
        .send()
        .await
        .unwrap();
    expect_error(gone, 404, "not_found").await;

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn kv_writes_and_deletes_honour_if_match_the_same_way() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "kv-match-agent").await;
    put_kv(&server, &agent, "k", json!(1)).await;

    let matching = put_kv_if_match(&server, &agent, "k", "1", json!(2))
        .send()
        .await
        .unwrap();
    assert_eq!(matching.json::<Value>().await.unwrap()["version"], 2);

    let stale = put_kv_if_match(&server, &agent, "k", "1", json!("lost"))
        .send()
        .await
        .unwrap();
    let conflict = expect_error(stale, 412, "version_conflict").await;
    assert_eq!(conflict["current_version"], 2);
    let read: Value = get_kv(&server, &agent, "k").await.json().await.unwrap();
    assert_eq!(read["value"], 2);

    let phantom = put_kv_if_match(&server, &agent, "other", "5", json!(1))
        .send()
        .await
        .unwrap();
    assert_eq!(
        expect_error(phantom, 412, "version_conflict").await["current_version"],
        0
    );
    let created = put_kv_if_match(&server, &agent, "other", "0", json!(1))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);

    let stale_delete = call(&server, &agent, Method::DELETE, "/kv/k")
        .header("If-Match", "1")
        .send()
        .await
        .unwrap();
    expect_error(stale_delete, 412, "version_conflict").await;
    assert_eq!(get_kv(&server, &agent, "k").await.status(), 200);
    let delete = call(&server, &agent, Method::DELETE, "/kv/k")
        .header("If-Match", "2")
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), 204);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_malformed_if_match_is_a_bad_request_and_the_write_does_not_happen() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "bad-match-agent").await;
    put_task(&server, &agent, "t", json!("kept")).await;

    for bad in ["abc", "-1", "*", "W/\"1\"", "1, 2", "1.5"] {
        let put = put_task_if_match(&server, &agent, "t", bad, json!("overwritten"))
            .send()
            .await
            .unwrap();
        expect_error(put, 400, "invalid_request").await;
        let delete = call(&server, &agent, Method::DELETE, "/tasks/t")
            .header("If-Match", bad)
            .send()
            .await
            .unwrap();
        expect_error(delete, 400, "invalid_request").await;
    }
    let read: Value = get_task(&server, &agent, "t").await.json().await.unwrap();
    assert_eq!(read["body"], "kept");
    assert_eq!(read["version"], 1);

    server.cleanup().await;
}

// ─── Size and rate limits ───────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn a_task_body_over_the_cap_is_refused_and_one_at_the_cap_is_kept() {
    let server = TestServer::start_with(|c| c.agent_state_max_body_bytes = 1024).await;
    let agent = new_agent(&server, "cap-agent").await;

    // A JSON string of n characters encodes to n + 2 bytes.
    let at_cap = put_task(&server, &agent, "fits", json!("x".repeat(1022))).await;
    assert_eq!(at_cap.status(), 200);
    let over_cap = put_task(&server, &agent, "too-big", json!("x".repeat(1023))).await;
    expect_error(over_cap, 413, "payload_too_large").await;
    expect_error(get_task(&server, &agent, "too-big").await, 404, "not_found").await;

    // A request far over the cap is stopped before its body is parsed, in the same shape.
    let huge = put_task(&server, &agent, "huge", json!("x".repeat(200_000))).await;
    expect_error(huge, 413, "payload_too_large").await;
    expect_error(get_task(&server, &agent, "huge").await, 404, "not_found").await;

    // A refused replacement leaves the earlier version in place.
    let refused = put_task(&server, &agent, "fits", json!("y".repeat(5000))).await;
    expect_error(refused, 413, "payload_too_large").await;
    let read: Value = get_task(&server, &agent, "fits")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["version"], 1);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_cap_above_the_frameworks_default_body_limit_is_honoured() {
    // axum buffers at most 2 MiB of a body unless told otherwise; the cap is the operator's to
    // raise, so a legal write under it must not be stopped by that default.
    const MIB: usize = 1024 * 1024;
    let server = TestServer::start_with(|c| c.agent_state_max_body_bytes = 4 * MIB).await;
    let agent = new_agent(&server, "big-cap-agent").await;

    let large = put_task(&server, &agent, "large", json!("x".repeat(3 * MIB))).await;
    assert_eq!(large.status(), 200);
    let read: Value = get_task(&server, &agent, "large")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["body"].as_str().unwrap().len(), 3 * MIB);

    let too_large = put_kv(&server, &agent, "too-large", json!("x".repeat(4 * MIB))).await;
    expect_error(too_large, 413, "payload_too_large").await;

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn the_cap_applies_to_the_encoding_not_to_the_clients_whitespace() {
    let server = TestServer::start_with(|c| c.agent_state_max_body_bytes = 64).await;
    let agent = new_agent(&server, "whitespace-agent").await;
    // Compactly `{"a":1,"b":[1,2]}` (17 bytes); sent with a good deal of padding around it.
    let padded = "{\"context_id\": null, \"state\": \"s\", \"body\": {\n    \"a\": 1,\n    \"b\": [ 1 ,\n 2 ]\n  }\n}";
    let res = call(&server, &agent, Method::PUT, "/tasks/t")
        .header("Content-Type", "application/json")
        .body(padded)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_kv_value_over_the_cap_is_refused_and_one_at_the_cap_is_kept() {
    let server = TestServer::start_with(|c| c.agent_state_max_body_bytes = 1024).await;
    let agent = new_agent(&server, "kv-cap-agent").await;
    assert_eq!(
        put_kv(&server, &agent, "fits", json!("x".repeat(1022)))
            .await
            .status(),
        200
    );
    expect_error(
        put_kv(&server, &agent, "big", json!("x".repeat(1023))).await,
        413,
        "payload_too_large",
    )
    .await;
    expect_error(
        put_kv(&server, &agent, "huge", json!("x".repeat(200_000))).await,
        413,
        "payload_too_large",
    )
    .await;
    expect_error(get_kv(&server, &agent, "big").await, 404, "not_found").await;
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn an_agent_over_its_per_minute_budget_is_told_to_slow_down() {
    let server = TestServer::start_with(|c| c.agent_state_rate_limit_per_minute = 5).await;
    let busy = new_agent(&server, "busy-agent").await;
    let quiet = new_agent(&server, "quiet-agent").await;

    for attempt in 1..=5 {
        let res = call(&server, &busy, Method::GET, "/tasks")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "request {attempt} is within the budget");
    }
    let over = call(&server, &busy, Method::GET, "/tasks")
        .send()
        .await
        .unwrap();
    assert_eq!(over.headers()["retry-after"], "60");
    expect_error(over, 429, "rate_limited").await;

    // The budget is per agent: the same traffic from another agent is unaffected.
    let other = call(&server, &quiet, Method::GET, "/tasks")
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 200);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn refused_credentials_do_not_spend_an_agents_budget() {
    let server = TestServer::start_with(|c| c.agent_state_rate_limit_per_minute = 3).await;
    let agent = new_agent(&server, "budget-agent").await;

    // Presenting someone's token and failing is not that agent's traffic.
    for _ in 0..10 {
        let res = server
            .client
            .get(url(&server, "/tasks"))
            .bearer_auth("ngt_wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
    }
    for _ in 0..3 {
        let res = call(&server, &agent, Method::GET, "/tasks")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }
    let over = call(&server, &agent, Method::GET, "/tasks")
        .send()
        .await
        .unwrap();
    assert_eq!(over.status(), 429);

    server.cleanup().await;
}

// ─── Expiry ─────────────────────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn every_write_sets_the_expiry_from_the_configured_ttl() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "ttl-agent").await;
    let seven_days = chrono::Duration::days(7);

    let task: Value = put_task(&server, &agent, "t", json!(1))
        .await
        .json()
        .await
        .unwrap();
    let span = timestamp(&task, "expires_at") - timestamp(&task, "updated_at");
    assert!(
        span >= seven_days && span < seven_days + chrono::Duration::seconds(1),
        "span {span}"
    );
    let entry: Value = put_kv(&server, &agent, "k", json!(1))
        .await
        .json()
        .await
        .unwrap();
    let span = timestamp(&entry, "expires_at") - timestamp(&entry, "updated_at");
    assert!(
        span >= seven_days && span < seven_days + chrono::Duration::seconds(1),
        "span {span}"
    );

    // Reading does not extend it.
    let read: Value = get_task(&server, &agent, "t").await.json().await.unwrap();
    assert_eq!(read["expires_at"], task["expires_at"]);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn the_ttl_comes_from_configuration() {
    let server = TestServer::start_with(|c| c.agent_state_ttl_days = 2).await;
    let agent = new_agent(&server, "short-ttl-agent").await;
    let two_days = chrono::Duration::days(2);
    let task: Value = put_task(&server, &agent, "t", json!(1))
        .await
        .json()
        .await
        .unwrap();
    let span = timestamp(&task, "expires_at") - timestamp(&task, "updated_at");
    assert!(
        span >= two_days && span < two_days + chrono::Duration::seconds(1),
        "span {span}"
    );
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn an_expired_row_reads_as_absent_everywhere_before_it_is_swept() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "expired-agent").await;
    put_task(&server, &agent, "old", json!(1)).await;
    put_task(&server, &agent, "fresh", json!(1)).await;
    put_kv(&server, &agent, "old", json!(1)).await;
    put_kv(&server, &agent, "fresh", json!(1)).await;
    expire_task(&server, &agent, "old").await;
    expire_kv(&server, &agent, "old").await;

    expect_error(get_task(&server, &agent, "old").await, 404, "not_found").await;
    expect_error(delete_task(&server, &agent, "old").await, 404, "not_found").await;
    expect_error(get_kv(&server, &agent, "old").await, 404, "not_found").await;
    expect_error(delete_kv(&server, &agent, "old").await, 404, "not_found").await;
    assert_eq!(
        names(&list(&server, &agent, "/tasks").await, "task_id"),
        ["fresh"]
    );
    assert_eq!(names(&list(&server, &agent, "/kv").await, "key"), ["fresh"]);
    assert_eq!(
        count_rows(&server, "agent_tasks").await,
        2,
        "the sweeper has not run"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn writing_over_an_expired_row_starts_it_again_at_version_one() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "revive-agent").await;
    for _ in 0..3 {
        put_task(&server, &agent, "t", json!("old")).await;
        put_kv(&server, &agent, "k", json!("old")).await;
    }
    for table in ["agent_tasks", "agent_kv"] {
        sqlx::query(&format!(
            "UPDATE {table} SET expires_at = now() - interval '1 hour', created_at = now() - interval '30 days'"
        ))
        .execute(&server.db)
        .await
        .unwrap();
    }

    // The row is gone as far as the API is concerned, so a precondition on it sees version 0.
    let phantom = put_task_if_match(&server, &agent, "t", "3", json!("x"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        expect_error(phantom, 412, "version_conflict").await["current_version"],
        0
    );

    let revived: Value = put_task(&server, &agent, "t", json!("new"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(revived["version"], 1);
    let revived: Value = put_kv(&server, &agent, "k", json!("new"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(revived["version"], 1);

    // A revived row is a new row: its creation time restarts.
    for (table, column) in [("agent_tasks", "task_id"), ("agent_kv", "key")] {
        let recent: bool = sqlx::query_scalar(&format!(
            "SELECT created_at > now() - interval '1 minute' FROM {table} WHERE {column} IN ('t', 'k')"
        ))
        .fetch_one(&server.db)
        .await
        .unwrap();
        assert!(
            recent,
            "{table}.created_at must restart when an expired row is revived"
        );
    }

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn rewriting_a_live_row_keeps_its_creation_time() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "keep-created-agent").await;
    put_task(&server, &agent, "t", json!(1)).await;
    put_kv(&server, &agent, "k", json!(1)).await;
    for table in ["agent_tasks", "agent_kv"] {
        sqlx::query(&format!(
            "UPDATE {table} SET created_at = now() - interval '30 days'"
        ))
        .execute(&server.db)
        .await
        .unwrap();
    }
    put_task(&server, &agent, "t", json!(2)).await;
    put_kv(&server, &agent, "k", json!(2)).await;
    for table in ["agent_tasks", "agent_kv"] {
        let kept: bool = sqlx::query_scalar(&format!(
            "SELECT created_at < now() - interval '29 days' FROM {table}"
        ))
        .fetch_one(&server.db)
        .await
        .unwrap();
        assert!(kept, "{table}.created_at must survive a rewrite");
    }
    server.cleanup().await;
}

// ─── The sweeper ────────────────────────────────────────────────────────────

use nasiko_server::agent_state::sweeper::{Swept, sweep_expired};

#[tokio::test]
#[serial]
async fn the_sweeper_removes_expired_rows_of_every_agent_and_nothing_live() {
    let server = TestServer::start().await;
    let alice = new_agent(&server, "sweep-alice").await;
    let bob = new_agent(&server, "sweep-bob").await;
    for agent in [&alice, &bob] {
        put_task(&server, agent, "expired", json!(1)).await;
        put_task(&server, agent, "live", json!(1)).await;
        put_kv(&server, agent, "expired", json!(1)).await;
        put_kv(&server, agent, "live", json!(1)).await;
        expire_task(&server, agent, "expired").await;
        expire_kv(&server, agent, "expired").await;
    }

    let swept = sweep_expired(&server.db).await.unwrap();
    assert_eq!(swept, Swept { tasks: 2, kv: 2 });

    for agent in [&alice, &bob] {
        assert_eq!(get_task(&server, agent, "live").await.status(), 200);
        assert_eq!(get_kv(&server, agent, "live").await.status(), 200);
    }
    assert_eq!(count_rows(&server, "agent_tasks").await, 2);
    assert_eq!(count_rows(&server, "agent_kv").await, 2);
    assert_eq!(
        sweep_expired(&server.db).await.unwrap(),
        Swept::default(),
        "nothing is left to sweep"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn the_sweeper_keeps_going_past_one_batch() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "bulk-agent").await;
    // More than one batch of each (the batch is 1000), plus rows that must survive.
    sqlx::query(
        "INSERT INTO agent_tasks (agent_id, task_id, state, body, version, expires_at)
         SELECT $1, 'expired-' || g, 'working', 'x', 1, now() - interval '1 hour'
         FROM generate_series(1, 2300) g",
    )
    .bind(agent.id)
    .execute(&server.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_kv (agent_id, key, value, version, expires_at)
         SELECT $1, 'expired-' || g, 'x', 1, now() - interval '1 hour'
         FROM generate_series(1, 1200) g",
    )
    .bind(agent.id)
    .execute(&server.db)
    .await
    .unwrap();
    put_task(&server, &agent, "live", json!(1)).await;
    put_kv(&server, &agent, "live", json!(1)).await;

    let swept = sweep_expired(&server.db).await.unwrap();
    assert_eq!(
        swept,
        Swept {
            tasks: 2300,
            kv: 1200
        }
    );
    assert_eq!(count_rows(&server, "agent_tasks").await, 1);
    assert_eq!(count_rows(&server, "agent_kv").await, 1);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn the_sweeper_leaves_rows_a_writer_holds_instead_of_waiting_for_them() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "locked-agent").await;
    put_task(&server, &agent, "held", json!(1)).await;
    put_task(&server, &agent, "free", json!(1)).await;
    expire_task(&server, &agent, "held").await;
    expire_task(&server, &agent, "free").await;

    // A writer in the middle of its transaction holds the row it is about to rewrite.
    let peer = peer_pool(&server).await;
    let mut writer = peer.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM agent_tasks WHERE task_id = 'held' FOR UPDATE")
        .execute(&mut *writer)
        .await
        .unwrap();

    // The pass must come back, not queue behind the writer, and take only what is free.
    let swept = tokio::time::timeout(Duration::from_secs(10), sweep_expired(&server.db))
        .await
        .expect("the sweeper must not wait on a row another transaction holds")
        .unwrap();
    assert_eq!(swept, Swept { tasks: 1, kv: 0 });
    assert_eq!(count_rows(&server, "agent_tasks").await, 1);

    // Once the writer lets go, the next pass collects it.
    writer.rollback().await.unwrap();
    assert_eq!(
        sweep_expired(&server.db).await.unwrap(),
        Swept { tasks: 1, kv: 0 }
    );
    assert_eq!(count_rows(&server, "agent_tasks").await, 0);

    peer.close().await;
    server.cleanup().await;
}

// ─── Writers of one entry take turns ────────────────────────────────────────

/// The advisory-lock class `repo.rs` takes entry locks under. Mirrored here because the test has
/// to hold the same lock a concurrent writer would; if the two drift, the tests below fail at
/// their first assertion (nothing waits), not silently.
const ENTRY_LOCK_CLASS: i32 = 0x0A9E_517A;

/// Blocks until some backend is waiting on an advisory lock in this test's database.
async fn wait_for_a_blocked_writer(peer: &PgPool) {
    for _ in 0..100 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_locks
             WHERE locktype = 'advisory' AND NOT granted
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        )
        .fetch_one(peer)
        .await
        .unwrap();
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no writer ever waited on the entry lock: the write did not take it");
}

/// Holds `lock_key`'s entry lock the way a writer mid-transaction would, starts `request`, and
/// checks that the request waits for the lock and then completes once it is released.
///
/// Firing two writes at once cannot show this: each is a short transaction and the first commits
/// before the second looks, so the test would pass with or without the lock.
async fn assert_write_waits_for_the_entry_lock(
    server: &TestServer,
    lock_key: String,
    request: RequestBuilder,
) {
    let peer = peer_pool(server).await;
    let mut holder = peer.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))")
        .bind(ENTRY_LOCK_CLASS)
        .bind(&lock_key)
        .execute(&mut *holder)
        .await
        .unwrap();

    let write = tokio::spawn(async move { request.send().await.unwrap() });
    wait_for_a_blocked_writer(&peer).await;
    assert!(
        !write.is_finished(),
        "the write must wait while the entry is locked"
    );

    holder.rollback().await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(10), write)
        .await
        .expect("the write must proceed once the lock is released")
        .unwrap();
    assert_eq!(res.status(), 200);

    peer.close().await;
}

#[tokio::test]
#[serial]
async fn a_task_write_waits_for_a_concurrent_writer_of_the_same_task() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "lock-task-agent").await;
    let request = call(&server, &agent, Method::PUT, "/tasks/contended")
        .json(&json!({"context_id": null, "state": "working", "body": 1}));
    let lock_key = format!("{}/task/contended", agent.id);
    assert_write_waits_for_the_entry_lock(&server, lock_key, request).await;

    // It then wrote at version 1: the lock holder never wrote anything.
    let read: Value = get_task(&server, &agent, "contended")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["version"], 1);
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_kv_write_waits_for_a_concurrent_writer_of_the_same_key() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "lock-kv-agent").await;
    let request = call(&server, &agent, Method::PUT, "/kv/contended").json(&json!({"value": 1}));
    let lock_key = format!("{}/kv/contended", agent.id);
    assert_write_waits_for_the_entry_lock(&server, lock_key, request).await;
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_delete_waits_for_a_concurrent_writer_of_the_same_entry() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "lock-delete-agent").await;
    put_task(&server, &agent, "contended", json!(1)).await;
    let peer = peer_pool(&server).await;
    let mut holder = peer.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))")
        .bind(ENTRY_LOCK_CLASS)
        .bind(format!("{}/task/contended", agent.id))
        .execute(&mut *holder)
        .await
        .unwrap();

    let request = call(&server, &agent, Method::DELETE, "/tasks/contended");
    let delete = tokio::spawn(async move { request.send().await.unwrap() });
    wait_for_a_blocked_writer(&peer).await;
    assert!(
        !delete.is_finished(),
        "the delete must wait while the entry is locked"
    );

    holder.rollback().await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(10), delete)
        .await
        .expect("the delete must proceed once the lock is released")
        .unwrap();
    assert_eq!(res.status(), 204);

    peer.close().await;
    server.cleanup().await;
}

// ─── When an agent goes away ────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn removing_an_agent_row_removes_its_state_and_only_its_state() {
    let server = TestServer::start().await;
    let doomed = new_agent(&server, "doomed-agent").await;
    let bystander = new_agent(&server, "bystander-agent").await;
    for agent in [&doomed, &bystander] {
        put_task(&server, agent, "t", json!(1)).await;
        put_kv(&server, agent, "k", json!(1)).await;
    }
    assert_eq!(count_rows(&server, "agent_tasks").await, 2);
    assert_eq!(count_rows(&server, "agent_kv").await, 2);

    // A hard delete, as `agents::utils::delete_agent_or_mark_failed` performs for a build that
    // never succeeded: the foreign keys do the cleanup, there is no explicit delete to forget.
    sqlx::query("DELETE FROM agents WHERE id = $1")
        .bind(doomed.id)
        .execute(&server.db)
        .await
        .unwrap();

    assert_eq!(count_rows(&server, "agent_tasks").await, 1);
    assert_eq!(count_rows(&server, "agent_kv").await, 1);
    assert_eq!(get_task(&server, &bystander, "t").await.status(), 200);
    assert_eq!(get_kv(&server, &bystander, "k").await.status(), 200);

    server.cleanup().await;
}

/// `DELETE /api/agents/{id}` soft-deletes: the row stays, so the foreign keys never fire and the
/// agent's state is not removed on the spot. What protects it meanwhile is that the credential
/// stops working, and the sweeper reclaims it once it expires.
#[tokio::test]
#[serial]
async fn a_soft_deleted_agent_loses_access_to_its_state_which_expiry_then_reclaims() {
    let server = TestServer::start().await;
    let admin: Value = server
        .client
        .post(server.url("/api/auth/initialize-admin"))
        .json(&json!({"username": "admin", "email": "admin@test.local"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let admin_id: Uuid = admin["user_id"].as_str().unwrap().parse().unwrap();
    let id = seed_agent_row(&server, admin_id, "soft-deleted-agent").await;
    let token = common::mint_gateway_token(&server.db, id).await;
    let agent = Agent { id, token };
    put_task(&server, &agent, "t", json!(1)).await;
    put_kv(&server, &agent, "k", json!(1)).await;

    let deleted = common::as_superuser(
        server
            .client
            .delete(server.url(&format!("/api/agents/{id}"))),
        &admin_id.to_string(),
        "admin",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(deleted.status(), 200);

    expect_error(get_task(&server, &agent, "t").await, 401, "unauthorized").await;
    expect_error(get_kv(&server, &agent, "k").await, 401, "unauthorized").await;
    expect_error(
        put_task(&server, &agent, "t", json!(2)).await,
        401,
        "unauthorized",
    )
    .await;
    assert_eq!(
        count_rows(&server, "agent_tasks").await,
        1,
        "the rows wait for expiry"
    );

    sqlx::query("UPDATE agent_tasks SET expires_at = now() - interval '1 second'")
        .execute(&server.db)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_kv SET expires_at = now() - interval '1 second'")
        .execute(&server.db)
        .await
        .unwrap();
    assert_eq!(
        sweep_expired(&server.db).await.unwrap(),
        Swept { tasks: 1, kv: 1 }
    );

    server.cleanup().await;
}

// ─── Registration ───────────────────────────────────────────────────────────

async fn register(server: &TestServer, agent: &Agent, body: Value) -> Response {
    call(server, agent, Method::POST, "/register")
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn state_mode(server: &TestServer, agent: &Agent) -> String {
    sqlx::query_scalar("SELECT state_mode FROM agents WHERE id = $1")
        .bind(agent.id)
        .fetch_one(&server.db)
        .await
        .unwrap()
}

#[tokio::test]
#[serial]
async fn an_agent_starts_out_keeping_its_state_in_memory() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "fresh-agent").await;
    assert_eq!(state_mode(&server, &agent).await, "memory");
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn registering_a_task_store_marks_the_agent_durable() {
    let server = TestServer::start().await;
    let tasks_only = new_agent(&server, "tasks-agent").await;
    let both = new_agent(&server, "both-agent").await;
    let bystander = new_agent(&server, "other-agent").await;

    let res = register(
        &server,
        &tasks_only,
        json!({"capabilities": ["tasks"], "client": "nasiko-sdk/1.2.3"}),
    )
    .await;
    assert_eq!(res.status(), 204);
    assert!(res.text().await.unwrap().is_empty(), "204 carries no body");
    assert_eq!(state_mode(&server, &tasks_only).await, "durable");

    let res = register(
        &server,
        &both,
        json!({"capabilities": ["tasks", "kv"], "client": "sdk"}),
    )
    .await;
    assert_eq!(res.status(), 204);
    assert_eq!(state_mode(&server, &both).await, "durable");

    assert_eq!(
        state_mode(&server, &bystander).await,
        "memory",
        "registration is per agent"
    );
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn registering_only_a_kv_store_leaves_the_agent_in_memory_mode() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "kv-only-agent").await;
    let res = register(
        &server,
        &agent,
        json!({"capabilities": ["kv"], "client": "sdk"}),
    )
    .await;
    assert_eq!(res.status(), 204);
    assert_eq!(state_mode(&server, &agent).await, "memory");
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn registration_is_idempotent_and_never_steps_an_agent_back_down() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "repeat-agent").await;
    assert_eq!(
        register(&server, &agent, json!({"capabilities": ["tasks"]}))
            .await
            .status(),
        204
    );
    let updated_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT updated_at FROM agents WHERE id = $1")
            .bind(agent.id)
            .fetch_one(&server.db)
            .await
            .unwrap();

    // An SDK registers at every start: doing it again must neither fail nor touch the agent row.
    assert_eq!(
        register(&server, &agent, json!({"capabilities": ["tasks"]}))
            .await
            .status(),
        204
    );
    let after: DateTime<Utc> = sqlx::query_scalar("SELECT updated_at FROM agents WHERE id = $1")
        .bind(agent.id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(
        after, updated_at,
        "an already-durable agent's row must not be rewritten"
    );

    // A later KV-only registration does not undo it.
    assert_eq!(
        register(&server, &agent, json!({"capabilities": ["kv"]}))
            .await
            .status(),
        204
    );
    assert_eq!(state_mode(&server, &agent).await, "durable");
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_malformed_registration_is_refused_and_changes_nothing() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "malformed-agent").await;
    for bad in [
        json!({"capabilities": []}),
        json!({"capabilities": ["blobs"]}),
        json!({"capabilities": ["tasks", "blobs"]}),
        json!({"capabilities": "tasks"}),
        json!({"client": "sdk"}),
        json!({"capabilities": ["tasks"], "extra": true}),
        json!({"capabilities": ["tasks"], "client": ""}),
        json!({"capabilities": ["tasks"], "client": "x".repeat(129)}),
        json!({"capabilities": ["tasks"], "client": "line\nbreak"}),
    ] {
        let res = register(&server, &agent, bad.clone()).await;
        expect_error(res, 400, "invalid_request").await;
    }
    assert_eq!(state_mode(&server, &agent).await, "memory");
    server.cleanup().await;
}

// ─── Encryption at rest ─────────────────────────────────────────────────────

#[tokio::test]
#[serial]
async fn a_task_body_is_stored_as_ciphertext_under_the_agents_own_key() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "sealed-task-agent").await;
    let stranger = new_agent(&server, "sealed-task-stranger").await;
    let body = json!({"secret": "PLAINTEXT-MARKER-4821", "n": [1, 2, 3]});
    put_task(&server, &agent, "t", body.clone()).await;

    let stored: String =
        sqlx::query_scalar("SELECT body FROM agent_tasks WHERE agent_id = $1 AND task_id = 't'")
            .bind(agent.id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert!(
        !stored.contains("PLAINTEXT-MARKER"),
        "the secret is in the database in the clear"
    );
    assert!(
        serde_json::from_str::<Value>(&stored).is_err(),
        "the column holds JSON, not ciphertext"
    );

    // It opens with this agent's key, to exactly the JSON text that was written...
    let opened = nasiko_secrets::SecretsCrypto::for_agent(agent.id)
        .decrypt(&stored)
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&opened).unwrap(), body);
    // ...and not with another agent's.
    assert!(
        nasiko_secrets::SecretsCrypto::for_agent(stranger.id)
            .decrypt(&stored)
            .is_err()
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_kv_value_is_stored_as_ciphertext_under_the_agents_own_key() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "sealed-kv-agent").await;
    let stranger = new_agent(&server, "sealed-kv-stranger").await;
    let value = json!("PLAINTEXT-MARKER-9034");
    put_kv(&server, &agent, "k", value.clone()).await;

    let stored: String =
        sqlx::query_scalar("SELECT value FROM agent_kv WHERE agent_id = $1 AND key = 'k'")
            .bind(agent.id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert!(!stored.contains("PLAINTEXT-MARKER"));
    let opened = nasiko_secrets::SecretsCrypto::for_agent(agent.id)
        .decrypt(&stored)
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&opened).unwrap(), value);
    assert!(
        nasiko_secrets::SecretsCrypto::for_agent(stranger.id)
            .decrypt(&stored)
            .is_err()
    );

    server.cleanup().await;
}

// ─── What the API refuses to accept ─────────────────────────────────────────

#[tokio::test]
#[serial]
async fn a_name_the_store_cannot_hold_is_a_bad_request_never_a_server_error() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "names-agent").await;

    // NUL cannot be stored in Postgres text, so it would be a 500 if it got that far.
    for bad in [
        "a\0b",
        "line\nbreak",
        "tab\there",
        "bell\u{7}",
        &"k".repeat(513),
        &"é".repeat(257),
    ] {
        expect_error(
            put_kv(&server, &agent, bad, json!(1)).await,
            400,
            "invalid_request",
        )
        .await;
        expect_error(get_kv(&server, &agent, bad).await, 400, "invalid_request").await;
        expect_error(
            delete_kv(&server, &agent, bad).await,
            400,
            "invalid_request",
        )
        .await;
    }
    for bad in ["a\0b", "line\nbreak", &"t".repeat(257), &"é".repeat(129)] {
        expect_error(
            put_task(&server, &agent, bad, json!(1)).await,
            400,
            "invalid_request",
        )
        .await;
        expect_error(get_task(&server, &agent, bad).await, 400, "invalid_request").await;
        expect_error(
            delete_task(&server, &agent, bad).await,
            400,
            "invalid_request",
        )
        .await;
    }

    // The longest names allowed are accepted.
    assert_eq!(
        put_kv(&server, &agent, &"k".repeat(512), json!(1))
            .await
            .status(),
        200
    );
    assert_eq!(
        put_kv(&server, &agent, &"é".repeat(256), json!(1))
            .await
            .status(),
        200
    );
    assert_eq!(
        put_task(&server, &agent, &"t".repeat(256), json!(1))
            .await
            .status(),
        200
    );
    assert_eq!(
        put_task(&server, &agent, &"é".repeat(128), json!(1))
            .await
            .status(),
        200
    );
    assert_eq!(count_rows(&server, "agent_kv").await, 2);
    assert_eq!(count_rows(&server, "agent_tasks").await, 2);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_body_the_api_does_not_understand_is_a_bad_request() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "bodies-agent").await;
    let long_context = "c".repeat(257);
    let long_state = "s".repeat(129);

    let task_bodies = [
        json!({"state": "working", "body": 1, "extra": true}),
        json!({"body": 1}),
        json!({"state": "working"}),
        json!({"state": "", "body": 1}),
        json!({"state": long_state, "body": 1}),
        json!({"state": "line\nbreak", "body": 1}),
        json!({"context_id": "", "state": "working", "body": 1}),
        json!({"context_id": long_context, "state": "working", "body": 1}),
        json!({"context_id": "a\0b", "state": "working", "body": 1}),
        json!({"context_id": 7, "state": "working", "body": 1}),
        json!({"state": 7, "body": 1}),
    ];
    for bad in task_bodies {
        let res = call(&server, &agent, Method::PUT, "/tasks/t")
            .json(&bad)
            .send()
            .await
            .unwrap();
        expect_error(res, 400, "invalid_request").await;
    }
    for bad in [
        json!({}),
        json!({"value": 1, "extra": 1}),
        json!({"val": 1}),
    ] {
        let res = call(&server, &agent, Method::PUT, "/kv/k")
            .json(&bad)
            .send()
            .await
            .unwrap();
        expect_error(res, 400, "invalid_request").await;
    }
    assert_eq!(count_rows(&server, "agent_tasks").await, 0);
    assert_eq!(count_rows(&server, "agent_kv").await, 0);

    // Not JSON at all, no body, and the wrong content type are the same kind of mistake.
    let garbage = call(&server, &agent, Method::PUT, "/kv/k")
        .header("Content-Type", "application/json")
        .body("{not json")
        .send()
        .await
        .unwrap();
    expect_error(garbage, 400, "invalid_request").await;
    let empty = call(&server, &agent, Method::PUT, "/kv/k")
        .header("Content-Type", "application/json")
        .send()
        .await
        .unwrap();
    expect_error(empty, 400, "invalid_request").await;
    let wrong_type = call(&server, &agent, Method::PUT, "/kv/k")
        .header("Content-Type", "text/plain")
        .body("{\"value\": 1}")
        .send()
        .await
        .unwrap();
    expect_error(wrong_type, 400, "invalid_request").await;

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn listing_parameters_outside_the_contract_are_a_bad_request() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "params-agent").await;
    for path in [
        "/tasks?limit=0",
        "/tasks?limit=101",
        "/tasks?limit=-5",
        "/tasks?limit=many",
        "/tasks?bogus=1",
        "/tasks?context_id=a%00b",
        "/tasks?state=a%0Ab",
        "/kv?limit=0",
        "/kv?limit=101",
        "/kv?order=desc",
        "/kv?prefix=a%00b",
    ] {
        let res = call(&server, &agent, Method::GET, path)
            .send()
            .await
            .unwrap();
        expect_error(res, 400, "invalid_request").await;
    }
    for path in [
        "/tasks?cursor=garbage",
        "/kv?cursor=garbage",
        "/tasks?cursor=e30",
        "/kv?cursor=e30",
    ] {
        let res = call(&server, &agent, Method::GET, path)
            .send()
            .await
            .unwrap();
        expect_error(res, 400, "invalid_cursor").await;
    }
    // The extremes of the allowed range are fine.
    for path in [
        "/tasks?limit=1",
        "/tasks?limit=100",
        "/kv?limit=1",
        "/kv?limit=100",
    ] {
        assert_eq!(list(&server, &agent, path).await["items"], json!([]));
    }
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_query_value_left_empty_is_the_same_as_leaving_it_out() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "empty-params-agent").await;
    put_task_in(&server, &agent, "t", Some("ctx"), "working", json!(1)).await;
    put_kv(&server, &agent, "k", json!(1)).await;
    let tasks = list(&server, &agent, "/tasks?context_id=&state=&limit=&cursor=").await;
    assert_eq!(names(&tasks, "task_id"), ["t"]);
    let entries = list(&server, &agent, "/kv?prefix=&limit=&cursor=").await;
    assert_eq!(names(&entries, "key"), ["k"]);
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn a_cursor_from_one_agents_listing_cannot_widen_another_agents_view() {
    let server = TestServer::start().await;
    let alice = new_agent(&server, "cursor-alice").await;
    let bob = new_agent(&server, "cursor-bob").await;
    for id in ["a1", "a2", "a3"] {
        put_task(&server, &alice, id, json!("alice")).await;
    }
    put_task(&server, &bob, "b1", json!("bob")).await;
    let page = list(&server, &alice, "/tasks?limit=1").await;
    let alices_cursor = page["next_cursor"].as_str().unwrap().to_string();

    // The cursor is only a position. Bob still sees nothing but his own rows.
    let bobs = list(&server, &bob, &format!("/tasks?cursor={alices_cursor}")).await;
    for item in bobs["items"].as_array().unwrap() {
        assert_eq!(item["body"], "bob");
    }
    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn the_two_listings_do_not_accept_each_others_cursors() {
    let server = TestServer::start().await;
    let agent = new_agent(&server, "cross-cursor-agent").await;
    for id in ["a", "b"] {
        put_task(&server, &agent, id, json!(1)).await;
        put_kv(&server, &agent, id, json!(1)).await;
    }
    let task_cursor = list(&server, &agent, "/tasks?limit=1").await["next_cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let kv_cursor = list(&server, &agent, "/kv?limit=1").await["next_cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let res = call(
        &server,
        &agent,
        Method::GET,
        &format!("/kv?cursor={task_cursor}"),
    )
    .send()
    .await
    .unwrap();
    expect_error(res, 400, "invalid_cursor").await;
    let res = call(
        &server,
        &agent,
        Method::GET,
        &format!("/tasks?cursor={kv_cursor}"),
    )
    .send()
    .await
    .unwrap();
    expect_error(res, 400, "invalid_cursor").await;
    server.cleanup().await;
}
