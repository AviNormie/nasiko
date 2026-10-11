/**
 * The hub's bounded session sample (plans/feat-agent-centric.md eng "Hub sessions"; replaces `useAgentSessions`, whose
 * start could exceed Tempo's 7-day search and lose every row's trace data). Pure.
 * - Start: the later of the agent's creation and 7 days back (Sessions' Tempo-safe start), so every row can be checked.
 * - Rows: `session/list` names agents by raw name ("" when unresolved); only this agent's rows created after it.
 *   Another visible agent with the same raw name makes the match ambiguous: the list says so, never merges them.
 */
import { tempoSafeStart } from '@/features/sessions/api'
import type { SessionSummary } from '@/features/observability/types'

const DAY = 86_400_000

export function sampleStart(createdAt: string, now: Date): Date {
  const week = tempoSafeStart(new Date(now.getTime() - 7 * DAY), now)
  const created = Date.parse(createdAt)
  return Number.isNaN(created) || created < week.getTime() ? week : new Date(created)
}

export function agentRows(
  rows: readonly SessionSummary[],
  name: string,
  start: Date,
): SessionSummary[] {
  return rows.filter(
    (s) => s.agent_id === name && (!s.start_time || Date.parse(s.start_time) >= start.getTime()),
  )
}
