use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCard {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub skills: Vec<String>,
    pub tags: Vec<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FilePart {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct RouteRequest {
    pub query: String,
    pub session_id: String,
    pub user_id: Uuid,
    pub file_parts: Vec<FilePart>,
    /// Agent ids the caller reaches through an org-hierarchy grant (`org_unit`/`organization`),
    /// as resolved by `AuthService::org_granted_agent_ids` — the same method
    /// `oss/server/src/catalog/routes.rs::listing_scope` already uses to keep agent *listings* in
    /// sync with `can_access_agent`. Always empty for direct callers (OSS has no `AuthService` in
    /// `oss/orchestrator`, so it can't resolve this itself); `EeRoutingEngine` is the only writer,
    /// filling it in from its own `Arc<dyn AuthService>` before delegating to the wrapped
    /// `OssRoutingEngine`. See `agent_registry::get_agents_for_user`.
    pub org_granted_agent_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RouteResult {
    pub agent: AgentCard,
    pub fallback_used: bool,
}

/// Mirrors `router_request_log` columns (`oss/migrations/0001_schema.sql`).
/// Written fire-and-forget after every successful route().
#[derive(Debug, Clone)]
pub struct RouterLogEntry {
    pub request_id: String,
    pub user_id: Uuid,
    pub session_id: String,
    pub query: String,
    pub agents_considered: i32,
    pub selected_agent_id: Option<Uuid>,
    pub selected_agent_name: Option<String>,
    pub selection_reasoning: Option<String>,
    pub fallback_used: bool,
    pub total_latency_ms: i32,
    pub registry_fetch_ms: Option<i32>,
    pub selection_llm_ms: Option<i32>,
    pub stage1_candidates: Option<i32>,
    pub stage2_candidates: Option<i32>,
    pub embedding_model: Option<String>,
    pub file_count: i32,
    /// UUID of token_usage record tracking the Stage 3 LLM selector call.
    pub selection_token_usage_id: Option<Uuid>,
    /// `false` for a routing decision that ended in a refusal (the caller's
    /// `RoutingPolicy` rejected every candidate) rather than an agent selection.
    pub success: bool,
    /// Set when `success` is `false`, to say why routing did not produce a pick.
    pub error_message: Option<String>,
}
