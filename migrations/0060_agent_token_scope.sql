-- Scoped agent credentials.
--
-- `agent_gateway_tokens` held one credential per agent, the MCP gateway's
-- (`MCP_GATEWAY_TOKEN`). That credential also travels inside URL paths
-- (`/api/mcp/s/{token}`, for MCP clients that accept only a URL), where proxies
-- and access logs can record it, so it must not also open the agent's durable
-- state. Each credential now carries the one door it opens, and an agent may hold
-- one live credential per scope:
--   gateway  the MCP gateway and LLM router credential (every existing row)
--   state    the agent state API (/api/agent-state), injected as NASIKO_AGENT_TOKEN
--
-- The key widens from (agent_id) to (agent_id, scope). Every existing row is a
-- gateway credential, so it keeps its meaning and stays unique under the new key.
ALTER TABLE agent_gateway_tokens
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'gateway'
        CHECK (scope IN ('gateway', 'state'));

ALTER TABLE agent_gateway_tokens DROP CONSTRAINT agent_gateway_tokens_pkey;
ALTER TABLE agent_gateway_tokens ADD PRIMARY KEY (agent_id, scope);
