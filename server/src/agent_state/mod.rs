//! Per-agent durable state: A2A task snapshots and a small key-value store.
//!
//! An agent that keeps its task state in memory loses paused work on a restart, or when a resume
//! lands on another replica. This module gives every agent a platform-held store, reached with
//! the credential it already carries (`MCP_GATEWAY_TOKEN`), for an SDK-side store to write
//! through to. Registering a task store marks the agent durable (`agents.state_mode`).
//!
//! # Routes, under `/api/agent-state`
//!
//! | Route | Purpose |
//! | --- | --- |
//! | `POST /register` | Declare capabilities (`tasks`, `kv`); `tasks` sets `state_mode = 'durable'` |
//! | `PUT/GET/DELETE /tasks/{task_id}` | One task: `{context_id, state, body}`, `body` opaque JSON |
//! | `GET /tasks` | List tasks, filtered by `context_id` and `state`, newest first |
//! | `PUT/GET/DELETE /kv/{key}` | One entry: `{value}`, opaque JSON |
//! | `GET /kv` | List entries by `prefix`, in key order |
//!
//! Listings take `limit` (1 to 100, default 50) and an opaque `cursor`, and answer
//! `{items, next_cursor}`. A key containing `/` must be percent-encoded in the path.
//!
//! # What every route guarantees
//!
//! - **Authenticated outside the session auth.** Callers are deployed agents, so the router checks
//!   the bearer credential itself (`auth`) the way the MCP gateway does, and refuses a missing,
//!   unknown or revoked one with 401.
//! - **Scoped to the caller.** The agent id comes from the credential and nowhere else, and every
//!   query filters on it. Another agent's row does not exist as far as the caller can tell: 404,
//!   never 403.
//! - **Versioned.** Each row carries a `version`, 1 when created and one higher per write. A write
//!   or delete with `If-Match: <version>` applies only if that is the current version (412 and
//!   the current version otherwise); a missing row is version 0. Without the header it is
//!   unconditional. Writers of one entry take turns (`repo`), so each sees the version the one
//!   before it committed and two writers never both claim the same version.
//! - **Expiring.** Every write sets `expires_at` to now plus `AGENT_STATE_TTL_DAYS`. An expired
//!   row reads as absent at once, and the [`sweeper`] deletes it later, as it does every row of
//!   an agent that has been deleted.
//! - **Opaque.** A task body or value is stored and returned byte for byte as the agent sent it,
//!   never parsed into a JSON tree and re-encoded (`payload`).
//! - **Bounded.** A value over `AGENT_STATE_MAX_BODY_BYTES` as sent is a 413, and an agent
//!   making more than `AGENT_STATE_RATE_LIMIT_PER_MINUTE` requests a minute gets a 429.
//! - **Encrypted at rest.** Task bodies and values are stored as AES-256-GCM ciphertext under the
//!   agent's own derived key (`payload`); the database never holds them in the clear.

mod auth;
mod cursor;
mod error;
mod page;
mod payload;
mod precondition;
mod repo;
mod request;
mod routes;
pub mod sweeper;
mod validation;
mod wire;

pub use routes::router;
