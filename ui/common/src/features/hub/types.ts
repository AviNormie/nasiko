/**
 * Wire types for the hub's one proposed read, the agent event log (AH-3 in
 * docs/designs/openruntime-agent-hub-recommendations.md): `GET /api/observability/agent/{id}/events?start_time&end_time&limit`,
 * in the `{data}` envelope. No server has it yet: it is mocked under the `events` group and read only while that
 * group is a preview (`isPreview('events')`). A bare 404 means the server predates it.
 *
 * Kinds with their own icon: deploy, restart, start, stop, rollback, crash, route_change, optimization_change,
 * compress_change, mcp_rule, budget_warning, budget_stop. An unknown kind keeps its summary and gets the generic icon.
 */
import { z } from 'zod'

/** A timestamp the page will format: an unparseable one fails the read instead of throwing while rendering. */
const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a timestamp')

const agentEventSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  at: timestamp,
  /** Who made the change (a username), null for the platform itself (a crash, a budget crossing). */
  actor: z.string().nullable(),
  /** One plain sentence the server writes, e.g. "Routing switched to gpt-4.1-mini". */
  summary: z.string(),
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
})
export type AgentEvent = z.infer<typeof agentEventSchema>

export const agentEventsSchema = z.looseObject({
  events: z.array(agentEventSchema),
  /** More events exist in the window than the read returned (newest first). */
  truncated: z.boolean(),
})
export type AgentEvents = z.infer<typeof agentEventsSchema>
