/**
 * The Overview's shared data (plans/feat-overview.md §5, eng review R1), now the home's (plans/feat-agent-centric.md
 * PR2a): `useFleetHealth()` is the one source of the fleet ratings, called by the home, the agent hub and the Agents
 * catalog while `?health=` is set, so all apply the same rules to the same directory rows; `useNeedsYou()` feeds Needs
 * you. Both reuse existing query keys, so TokenOps and the Agents pages open warm.
 */
import { sessionRows, useChatSessions } from '@/features/chat/api'
import { useWaiting } from '@/features/chat/waiting'
import { checkSessions } from '@/features/observability/sessions'
import { STATUS_CHECK_ROWS } from '@/features/observability/tuning'
import { tempoSafeStart, useFleetSessions, useSessionStatuses } from '@/features/sessions/api'
import type { Me } from '@/lib/api/auth'
import { useCallback, useMemo } from 'react'
import { useSlots } from '@/app/edition-context'
import { useAgentsDirectory } from '@/features/agents/api'
import type { Agent } from '@/features/agents/types'
import { displayStatus, isHarness } from '@/features/agents/status'
import { useDashboard, useTimeseries } from '@/features/tokenops/api'
import { zeroFillTimeline } from '@/features/tokenops/series'
import type { AgentFinopsRow } from '@/features/tokenops/types'
import { resolveWindow, type ResolvedWindow } from '@/features/tokenops/window'
import type { Range } from './search'
import { copy } from './copy'
import { mergeNeeds, type Needs, type NeedsInput, type SourceId } from './needs'
import {
  RATED_STATUSES,
  rateAgent,
  spikeDrivers,
  summarizeFleet,
  uniqueByName,
  type FleetHealthSummary,
  type UsageWindow,
} from './health'

/** Agents the ratings cover: every visible agent except coding harnesses (never rated). */
const RATED = new Set<string>(RATED_STATUSES)

const usage = (rows: readonly AgentFinopsRow[] | undefined) => {
  const m = new Map<string, UsageWindow>()
  for (const r of rows ?? [])
    m.set(r.agent_id, {
      cost: r.total_cost,
      operations: r.operations,
      p95: r.avg_latency_p95_ms ?? null,
    })
  return m
}
const ZERO: UsageWindow = { cost: 0, operations: 0, p95: null }

export interface FleetHealth {
  /** The directory hasn't answered yet: nothing can be rated. */
  isPending: boolean
  /** The directory failed: the card shows its error. */
  error: unknown
  summary: FleetHealthSummary | null
  /** Some rating inputs are still loading (dashboards, spend series, budgets): Needs you waits (design review 5A). */
  ratingsPending: boolean
  /** A cost input failed (7-day or previous-week or 30-day dashboard, spend series, budgets): every agent's cost
   *  rating is Unknown, never Healthy, and the card says so (/ship adversarial). */
  costFailed: boolean
  /** Visible agents other than harnesses; zero means first run (design review 7A). */
  agentCount: number
  /** Of those, how many are deployed (running, deploying or crashed/failed): only these can be rated. */
  deployedCount: number
  /** The directory's indexes, so Needs you labels rows without a second directory observer. */
  byId: ReadonlyMap<string, Agent>
  /** A raw agent name → its display name, only when exactly one visible agent has that name (else the raw name). */
  displayName(raw: string): string
  /** Each agent's p95 latency over the last 7 days (the window the ratings use); absent when it had no calls. */
  p95: ReadonlyMap<string, number>
  retry(): void
  retryCost(): void
}

/**
 * Ratings for every visible agent. `enabled: false` (the Agents catalog without `?health=`) fetches and computes
 * nothing. There are no per-agent `/deployment` reads: the recent-crash rule was dropped (/ship review).
 * `fleetSeries: false` (anyone but a superuser) never reads the fleet-wide spend series, which isn't ACL-scoped
 * (plans/feat-agent-centric.md eng "Health input contract"): there is no spike check then, only the ACL-scoped dashboards.
 */
export function useFleetHealth(now: Date, enabled = true, fleetSeries = true): FleetHealth {
  const dir = useAgentsDirectory(enabled)
  const win7 = useMemo(() => resolveWindow({ preset: '7d' }, now), [now])
  const win30 = useMemo(() => resolveWindow({ preset: '30d' }, now), [now])
  const agents = useMemo(
    () => (enabled ? (dir.data ?? []).filter((a) => !isHarness(a)) : []),
    [enabled, dir.data],
  )
  // First run (no agents but harnesses) fetches nothing else (design review 7A).
  const on = enabled && agents.length > 0
  const cur = useDashboard(win7, {}, 'agent', 'current', on)
  const prev = useDashboard(win7, {}, 'agent', 'previous', on)
  const d30 = useDashboard(win30, {}, 'agent', 'current', on)
  const ts = useTimeseries(win30, {}, on && fleetSeries)
  // Budgets are Enterprise only (docs/requirements/budgets.md): a stopped budget is an agent's reason where the
  // edition has them. An OSS build answers settled-and-empty without a request, so ratings never wait on it.
  const budgetInputs = useSlots().budgets.useOverviewBudgets(on)
  const deployedCount = useMemo(
    () => agents.filter((a) => RATED.has(displayStatus(a.status, false))).length,
    [agents],
  )
  const { byId, byNameAll } = dir
  const displayName = useCallback(
    (raw: string) => {
      const id = uniqueByName(byNameAll)(raw)
      return (id ? byId.get(id)?.display_name : undefined) || raw
    },
    [byId, byNameAll],
  )
  // Any failed cost input leaves ratings incomplete: rate cost as unknown rather than silently healthy.
  const costFailed =
    on &&
    (cur.isError ||
      prev.isError ||
      d30.isError ||
      (fleetSeries && ts.isError) ||
      budgetInputs.failed)

  const summary = useMemo(() => {
    if (!enabled || !dir.data) return null
    const t = now.getTime()
    const current = cur.data && !costFailed ? usage(cur.data.agents) : null
    const previous = prev.data && !prev.isError ? usage(prev.data.agents) : null
    const perOp30 = new Map(
      (d30.data?.agents ?? []).map((r) => [r.agent_id, r.avg_cost_per_operation ?? null]),
    )
    const days =
      // Gate the data, not just the fetch: a disabled query still hands out a cached fleet series (TokenOps fills the same
      // key), which a member must never be rated on (review: security, Codex P1).
      fleetSeries && ts.data?.bucket === 'day'
        ? zeroFillTimeline(ts.data.points, 'day', win30.start, win30.end).map((p) => ({
            date: p.iso.slice(0, 10),
            spend: p.spend,
            topAgent: p.topAgent,
          }))
        : []
    const spikes = spikeDrivers(days, uniqueByName(dir.byNameAll), t)
    const budgetByAgent = budgetInputs.byAgent
    return summarizeFleet(
      agents.map((a) =>
        rateAgent(
          {
            id: a.id,
            name: a.display_name || a.name,
            display: displayStatus(a.status, false),
            raw: a.status,
            createdAt: a.created_at,
            updatedAt: a.updated_at,
            // A loaded window without the agent's row is a real zero; a missing or failed window is unknown.
            current: current ? (current.get(a.id) ?? ZERO) : null,
            previous: previous ? (previous.get(a.id) ?? ZERO) : null,
            costPerOp30d: perOp30.get(a.id) ?? null,
            budget: budgetByAgent.get(a.id),
            spike: spikes.get(a.id),
          },
          t,
        ),
      ),
    )
  }, [
    enabled,
    dir.data,
    dir.byNameAll,
    agents,
    now,
    cur.data,
    costFailed,
    prev.data,
    prev.isError,
    d30.data,
    ts.data,
    fleetSeries,
    win30,
    budgetInputs.byAgent,
  ])

  const p95 = useMemo(
    () =>
      new Map(
        (cur.data?.agents ?? []).flatMap((r) =>
          r.avg_latency_p95_ms == null ? [] : [[r.agent_id, r.avg_latency_p95_ms] as const],
        ),
      ),
    [cur.data],
  )
  const ratingsPending =
    on &&
    (cur.isPending ||
      prev.isPending ||
      d30.isPending ||
      (fleetSeries && ts.isPending) ||
      !budgetInputs.settled)
  return {
    isPending: dir.isPending || (on && cur.isPending),
    error: dir.error,
    summary,
    ratingsPending,
    costFailed,
    agentCount: agents.length,
    deployedCount,
    byId: dir.byId,
    displayName,
    p95,
    retry: () => void dir.refetch(),
    retryCost: () => {
      // Never the fleet series for a member: Retry must not send the request the gate withholds.
      for (const q of [cur, prev, d30, ...(fleetSeries ? [ts] : [])])
        if (q.isError) void q.refetch()
      budgetInputs.retry()
    },
  }
}

/** 7d and 30d are the server's own ranges; 90d has none, so it sends explicit UTC days ending today. */
export function rangeWindow(range: Range, now: Date): ResolvedWindow {
  if (range !== '90d') return resolveWindow({ preset: range }, now)
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - 89 * 86_400_000).toISOString().slice(0, 10)
  return resolveWindow({ preset: 'custom', from, to }, now)
}

export interface NeedsYou {
  needs: Needs
  /** The oldest answer among the sources that answered (design review 8A's "Checked …"), or 0. */
  lastChecked: number
  retry: Record<SourceId, () => void>
  /** The newest sessions of the last 7 days and their checked status (eng review R7); the home counts failures per agent. */
  sessions: ReturnType<typeof useRecentSessions>
  /** The pending-requests match this card used, so the home counts requests per agent without a second matcher. */
  waiting: ReturnType<typeof useWaiting>
}

/** The newest STATUS_CHECK_ROWS sessions of the last 7 days, status-checked with the Sessions page's keys (eng review R7). */
function useRecentSessions(now: Date, enabled: boolean) {
  const win = useMemo(() => resolveWindow({ preset: '7d' }, now), [now])
  const start = useMemo(() => tempoSafeStart(win.start, now), [win.start, now])
  const list = useFleetSessions(win.key, start, win.end, enabled)
  const newest = useMemo(() => list.rows.slice(0, STATUS_CHECK_ROWS), [list.rows])
  const status = useSessionStatuses(newest, now.getTime(), false)
  return { list, newest, status }
}

export function useNeedsYou(now: Date, me: Me, fleet: FleetHealth, enabled = true): NeedsYou {
  const waiting = useWaiting(me.sub, me.is_superuser)
  const chats = useChatSessions()
  // The fleet's directory, not a second observer: one enabled late would refetch a failed list and flicker it pending.
  const dir = { byId: fleet.byId }
  // Budgets (plans/feat-budget-burn.md F8): the viewer's scope's At risk, or R-L10's own list on an older server.
  const shownAsAgent = (agentId: string) =>
    // The agent row shows only its first reason: a stop listed lower down isn't said there.
    fleet.summary?.byId.get(agentId)?.reasons[0]?.code === 'budgetStopped'
  const agentLabel = (agentId: string) => {
    const a = dir.byId.get(agentId)
    return a?.display_name || a?.name
  }
  // Budgets are Enterprise only: an OSS build's source is absent, so Needs you simply never lists a budget row.
  const budgetNeeds = useSlots().budgets.useBudgetNeeds(me, enabled, agentLabel, shownAsAgent)
  const sessions = useRecentSessions(now, enabled)
  // Stable inputs for the memo below: query result objects are new on every render.
  const { match, failedCold, isPending: waitingPending } = waiting
  const statusKey = sessions.newest.map((r) => sessions.status.get(r.session_id) ?? '').join('|')

  const input: NeedsInput = useMemo(() => {
    const titles = new Map(sessionRows(chats.data).map((r) => [r.session_id, r.title]))
    const requests: NeedsInput['requests'] = failedCold
      ? { state: 'failed' }
      : waitingPending
        ? { state: 'loading' }
        : {
            state: 'ok',
            value: {
              chats: match.chats.flatMap((c) => {
                const first = c.requests[0]
                if (!first) return []
                return {
                  sessionId: c.sessionId,
                  firstId: first.id,
                  kind: first.kind,
                  count: c.requests.length,
                  chatTitle: titles.get(c.sessionId) || copy.needs.untitledChat,
                  at: first.created_at,
                }
              }),
              outside: match.outside,
            },
          }
    // Answered only once every rating input settled, or a spike or stopped budget could land after "Nothing needs
    // you" (design review 5A; /ship review).
    // Failed only with no data: a failed background refresh keeps the cached ratings, as Fleet health does.
    const agents: NeedsInput['agents'] =
      fleet.error && !fleet.summary
        ? { state: 'failed' }
        : !fleet.summary || fleet.ratingsPending
          ? { state: 'loading' }
          : {
              state: 'ok',
              value: fleet.summary.action.map((a) => ({
                id: a.id,
                name: a.name,
                reason: a.reasons[0]?.text ?? '',
                budget: a.reasons[0]?.code === 'budgetStopped',
              })),
              // Rows are real, but with a cost input down the source can't vouch that nothing else needs action.
              incomplete: fleet.costFailed,
            }
    const budgetRows = budgetNeeds.value
    const failedRows = sessions.newest.filter((r) => sessions.status.get(r.session_id) === 'failed')
    // The rule the hub shares (observability/sessions.ts `checkSessions`): most of the sample must answer before "no
    // failures" counts, and "N of M checked sessions failed" counts the sessions actually checked (user decisions).
    const verdict = checkSessions({
      listError: sessions.list.isError,
      listPending: sessions.list.isPending,
      verdicts: sessions.newest.map((r) => sessions.status.get(r.session_id)),
    })
    const sessionState: NeedsInput['sessions'] =
      verdict.state !== 'ok'
        ? verdict
        : {
            state: 'ok',
            value: {
              failed: verdict.failed,
              checked: verdict.checked,
              agents: [
                ...new Set(
                  failedRows.map((r) =>
                    r.agent_id ? fleet.displayName(r.agent_id) : copy.needs.unknownAgent,
                  ),
                ),
              ],
            },
          }
    return { requests, agents, budgets: budgetRows, sessions: sessionState }
    // statusKey stands in for sessions.status (a new Map every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    match,
    failedCold,
    waitingPending,
    chats.data,
    fleet.summary,
    fleet.error,
    fleet.ratingsPending,
    fleet.costFailed,
    fleet.displayName,
    budgetNeeds.value,
    sessions.newest,
    sessions.list.isError,
    sessions.list.isPending,
    statusKey,
  ])

  const needs = useMemo(() => mergeNeeds(input), [input])
  const stamps = [waiting.lastChecked, budgetNeeds.stamp, sessions.list.dataUpdatedAt].filter(
    (t) => t > 0,
  )
  return {
    needs,
    waiting,
    lastChecked: stamps.length ? Math.min(...stamps) : 0,
    retry: {
      requests: waiting.retry,
      // With a cost input down the agents source is incomplete: its Retry must refetch those too.
      agents: () => {
        fleet.retry()
        if (fleet.costFailed) fleet.retryCost()
      },
      budgets: budgetNeeds.retry,
      sessions: () => void sessions.list.refetch(),
    },
    sessions,
  }
}
