-- Per-agent durable state: A2A task snapshots and a small key-value store.
--
-- Agents keep task state in memory by default, so a restart (or a resume on
-- another replica) loses paused work. This gives each agent a platform-held
-- store behind its existing credential (see oss/server/src/agent_state). Rows
-- are scoped by agent, expire, and are encrypted at rest.

-- Whether the agent has registered a durable task store. Written by
-- `POST /api/agent-state/register` when the agent declares the `tasks`
-- capability; a KV-only registration never changes it.
ALTER TABLE agents
    ADD COLUMN state_mode TEXT NOT NULL DEFAULT 'memory'
        CHECK (state_mode IN ('memory', 'durable'));

-- One row per (agent, task). `body` is the agent SDK's serialized task, opaque
-- to the server; it holds the AES-256-GCM ciphertext of its JSON text, not the
-- JSON itself. `version` starts at 1 and increments on every write.
--
-- ON DELETE CASCADE covers a hard delete of the agent row only. The catalog's
-- delete route is a soft delete (`agents.deleted_at`), which leaves these rows
-- in place until `expires_at`: the agent's credential stops authenticating the
-- moment it is soft-deleted, so they are unreachable meanwhile, and the sweeper
-- reclaims them after expiry.
CREATE TABLE agent_tasks (
    agent_id    UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id     TEXT        NOT NULL,
    context_id  TEXT,
    state       TEXT        NOT NULL,
    body        TEXT        NOT NULL,
    version     BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (agent_id, task_id)
);
CREATE INDEX idx_agent_tasks_context ON agent_tasks (agent_id, context_id);
-- Serves the expiry sweeper's `WHERE expires_at <= now() ... LIMIT` scan.
CREATE INDEX idx_agent_tasks_expires ON agent_tasks (expires_at);

-- One row per (agent, key). `value` is ciphertext of the entry's JSON text, as
-- `agent_tasks.body` is.
CREATE TABLE agent_kv (
    agent_id    UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    key         TEXT        NOT NULL,
    value       TEXT        NOT NULL,
    version     BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (agent_id, key)
);
CREATE INDEX idx_agent_kv_expires ON agent_kv (expires_at);
