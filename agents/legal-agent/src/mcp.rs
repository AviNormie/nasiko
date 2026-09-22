//! mcp.rs — the MCP-gateway client for platform agents.
//!
//! The whole configuration is two env vars, both injected at deploy time
//! (docs: `oss/docs/MCP_GATEWAY_DESIGN.md`, `docs/MCP_GATEWAY_AGENT_AUTH.md`):
//!
//!   `MCP_GATEWAY_URL`   — where the platform's aggregating gateway lives
//!   `MCP_GATEWAY_TOKEN` — this agent's own credential, sent as a Bearer header
//!
//! There is NO per-request credential to plumb: the platform resolves the
//! calling user server-side from the `traceparent` this agent forwards (the
//! same header it already forwards on LLM calls), and authorizes the call only
//! when this agent is a recorded participant of that flow. An agent that drops
//! the header gets a clean 403, never misattribution.
//!
//! Discovery (`tools/list`) runs once at startup with agent-only identity — no
//! flow exists yet, and none is needed for read-only metadata.

use std::collections::HashSet;

use serde_json::{Value, json};

/// Thin JSON-RPC client over the platform's MCP gateway.
///
/// Holds the tool manifest discovered at startup, already converted to the
/// OpenAI function shape the agent's LLM loop speaks, so the hot path never
/// re-derives it.
pub struct McpClient {
    url: String,
    token: String,
    http: reqwest::Client,
    /// Gateway tools discovered at startup, in OpenAI function shape.
    tools: Vec<Value>,
    /// Names of gateway tools, for dispatch routing.
    names: HashSet<String>,
}

impl McpClient {
    /// Returns a configured client, or `None` when the platform didn't inject
    /// the gateway env (local runs, MCP disabled) — the agent then simply runs
    /// with its built-in tools only.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("MCP_GATEWAY_URL")
            .ok()
            .filter(|u| !u.is_empty())?;
        let token = std::env::var("MCP_GATEWAY_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())?;
        Some(Self {
            url,
            token,
            http: reqwest::Client::new(),
            tools: Vec::new(),
            names: HashSet::new(),
        })
    }

    /// The discovered gateway tools, to advertise alongside the built-ins.
    pub fn tool_defs(&self) -> &[Value] {
        &self.tools
    }

    /// Whether `name` is a gateway tool (rather than one of the built-ins).
    pub fn handles(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    /// A system-prompt fragment naming the gateway tools, for the agent to
    /// append to its own prompt.
    ///
    /// Advertising the tools in the request is not enough: every agent's prompt
    /// enumerates its built-ins and names one of them (usually `web_search`) as
    /// the general-purpose fallback, so the model keeps answering "my issues" /
    /// "my emails" from a web search instead of the user's actual account.
    /// Empty when discovery found nothing, leaving the prompt untouched.
    pub fn system_prompt_hint(&self) -> String {
        if self.tools.is_empty() {
            return String::new();
        }
        let names: Vec<&str> = self
            .tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        format!(
            "\n\nConnected-account tools (MCP gateway): {}.\n\
             These reach the user's OWN connected accounts — email, chat, issue tracker, \
             calendar and so on — and return their real data.\n\
             - For any question about the user's own data (\"my issues\", \"my emails\", \
             \"messages I received\"), you MUST use these tools.\n\
             - NEVER answer such a question with a web search: that returns public \
             documentation about the product, not the user's data.\n\
             - Some of these are a search-then-execute pair; read each tool's own \
             description and follow it.\n\
             - If a tool reports the account is not connected, say so plainly and pass on \
             any authorization link it returns.",
            names.join(", ")
        )
    }

    /// POSTs one JSON-RPC request to the gateway. `traceparent` may be empty
    /// (startup discovery); when set it names the flow being served.
    async fn rpc(&self, traceparent: &str, body: Value) -> Result<Value, String> {
        let mut req = self
            .http
            .post(&self.url)
            .bearer_auth(&self.token)
            .json(&body);
        if !traceparent.is_empty() {
            req = req.header("traceparent", traceparent);
        }

        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let raw = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("gateway HTTP {}: {raw}", status.as_u16()));
        }

        let parsed: Value =
            serde_json::from_str(&raw).map_err(|e| format!("gateway response parse: {e}"))?;
        if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or_default();
            let message = err.get("message").and_then(Value::as_str).unwrap_or("");
            return Err(format!("gateway error {code}: {message}"));
        }
        Ok(parsed.get("result").cloned().unwrap_or_else(|| json!({})))
    }

    /// Fetches the agent's reachable tool manifest and converts it to the
    /// OpenAI function shape the LLM loop speaks. Best-effort: a failure only
    /// means the agent runs without gateway tools.
    pub async fn discover_tools(&mut self) {
        let result = match self
            .rpc(
                "",
                json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            )
            .await
        {
            Ok(result) => result,
            Err(e) => {
                tracing::warn!(error = %e, "mcp: tools/list failed, continuing without gateway tools");
                return;
            }
        };

        let Some(tools) = result.get("tools").and_then(Value::as_array) else {
            tracing::warn!("mcp: tools/list returned no tools array");
            return;
        };

        for tool in tools {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            // An MCP server may omit inputSchema for a no-argument tool, but
            // the chat-completions API rejects a function without a schema.
            let parameters = tool
                .get("inputSchema")
                .filter(|s| s.is_object())
                .cloned()
                .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
            self.tools.push(json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                    "parameters": parameters,
                }
            }));
            self.names.insert(name.to_string());
        }
        tracing::info!(count = self.tools.len(), "mcp: discovered gateway tools");
    }

    /// Executes one gateway tool on behalf of the flow named by `traceparent`.
    /// Errors come back as content (not `Err`) so the model can recover — the
    /// same convention the built-in `tools::execute` follows.
    pub async fn call_tool(&self, traceparent: &str, name: &str, args_json: &str) -> String {
        let arguments: Value = match serde_json::from_str(args_json) {
            Ok(args) => args,
            Err(e) => return format!("bad arguments: {e}"),
        };
        let result = match self
            .rpc(
                traceparent,
                json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                }),
            )
            .await
        {
            Ok(result) => result,
            Err(e) => return format!("tool {name} failed: {e}"),
        };

        // Prefer the standard MCP text content; fall back to the raw result
        // JSON so structured-only results still reach the model.
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|part| {
                part.get("type").and_then(Value::as_str) == Some("text")
                    && part
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|t| !t.is_empty())
            })
            .and_then(|part| part.get("text").and_then(Value::as_str));
        match text {
            Some(text) => text.to_string(),
            None => result.to_string(),
        }
    }
}
