/**
 * The home's reads (plans/feat-agent-centric.md PR2a; eng "Home execution table", in docs/home.md). Everything here is a
 * fleet-level read made once for all rows, never one per row:
 * - the directory (agents and harnesses, with owners);
 * - the ACL-scoped agent dashboard for the window (spend and requests by agent id, and how many calls had no price);
 * - the savings read's `by_agent` rows for the window (tokens saved, with basis), as many as the server returns;
 * - the Overview's ratings (`useFleetHealth`; the fleet-wide spend series only for a superuser) and its Needs you, whose
 *   reads also give the per-agent needs counts (action rows, the checked session sample, pending requests).
 *
 * A figure is shown only for the window it was read for: a window change's kept-previous data is "loading", never the
 * new window's number. A source that failed is unknown ("—"), never 0.
 *
 * PR2b adds one budgets read for all rows (a preview of the proposed R-L10 contract, polled every minute while the tab
 * is visible), and two reads per row on screen through a limiter of 4: the agent's spend series (superusers only: the
 * timeseries isn't ACL-scoped) and its build records (last change). A row read is dropped when its row scrolls away.
 */
import { useQuery } from '@tanstack/react-query'
import { useAgentsDirectory, useUsers } from '@/features/agents/api'
import { agentBuildsKey, fetchAgentBuilds } from '@/features/deploy/api'
import { createLimiter } from '@/features/observability/limiter'
import { useBudgets, useBudgetStatus } from '@/features/router/api'
import type { Budget, BudgetStatus } from '@/features/router/types'
import { crossingDate } from '@/features/tokenops/forecast'
import type { FinopsSpendTimeseries } from '@/features/tokenops/types'
import type { ResolvedWindow } from '@/features/tokenops/window'
import { ApiError, apiData, withQuery } from '@/lib/api/client'
import { isPreview } from '@/lib/env'
import { isHarness } from '@/features/agents/status'
import { usePendingRequests } from '@/features/chat/api'
import { pendingRequestRows } from '@/features/chat/waiting'
import { rangeWindow, useFleetHealth, useNeedsYou } from '@/features/overview/api'
import { uniqueByName } from '@/features/overview/health'
import type { Range } from '@/features/overview/search'
import { useDashboard, useSavings } from '@/features/tokenops/api'
import type { Me } from '@/lib/api/auth'
import { buildRows, needsByAgent, type HomeAgent, type RowBudget } from './rows'
import type { Scope } from './search'
import { BUDGET_POLL_MS, ROW_READ_STALE_MS, ROW_READS, SAVINGS_ROWS } from './tuning'

/** Where a source stands for the current window: its numbers are shown only when `ok` (or `stale`, kept and labelled). */
export type SourceStatus = 'loading' | 'ok' | 'failed' | 'stale'

const statusOf = (q: {
  data: unknown
  isPlaceholderData: boolean
  isError: boolean
  isPending: boolean
}): SourceStatus =>
  q.isPlaceholderData || (q.isPending && !q.isError)
    ? 'loading'
    : q.isError
      ? q.data
        ? 'stale'
        : 'failed'
      : q.data
        ? 'ok'
        : 'loading'

export function useHome(now: Date, range: Range, me: Me, scope: Scope | null) {
  const superuser = me.is_superuser
  const dir = useAgentsDirectory()
  const fleet = useFleetHealth(now, true, superuser)
  const users = useUsers(superuser)
  const win = rangeWindow(range, now)
  const any = (dir.data?.length ?? 0) > 0
  const dash = useDashboard(win, {}, 'agent', 'current', any)
  const savings = useSavings(win, {}, 'agent', any, SAVINGS_ROWS)
  // Needs you runs once a non-empty directory answered, a harness-only one included (its requests and sessions count
  // too); an empty fleet is the first run, which reads no sessions (design 7A).
  const ready = !!fleet.error || (!!fleet.summary && any)
  const needsYou = useNeedsYou(now, me, fleet, ready)
  const pending = usePendingRequests(me.sub, true)
  const budgets = useHomeBudgets(any, me.sub)

  const agents: HomeAgent[] = (dir.data ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    displayName: a.display_name || a.name,
    ownerId: a.owner_id,
    harness: isHarness(a),
    status: a.status,
  }))

  const spendStatus = statusOf(dash)
  const spend =
    dash.data && spendStatus !== 'loading' && spendStatus !== 'failed'
      ? new Map(
          dash.data.agents.map((r) => [
            r.agent_id,
            { cost: r.total_cost, operations: r.operations },
          ]),
        )
      : null
  const savedStatus = statusOf(savings)
  const saved =
    savings.data && savedStatus !== 'loading' && savedStatus !== 'failed'
      ? new Map(
          savings.data.by_agent.map((r) => [
            r.agent_id,
            { tokens: r.saved_tokens, basis: r.basis },
          ]),
        )
      : null

  // Needs counts: fleet-level reads only (eng). Unknown while any source loads or failed, never 0.
  const { needs, sessions, waiting } = needsYou
  const failedRaw = sessions.newest
    .filter((r) => sessions.status.get(r.session_id) === 'failed' && r.agent_id)
    .map((r) => r.agent_id as string)
  const requests = pendingRequestRows(superuser, waiting.match, pending.data?.items)
  const needsUnknown =
    !ready ||
    needs.loading ||
    needs.failed.length > 0 ||
    waiting.isPending ||
    waiting.failedCold ||
    pending.isPending ||
    (pending.isError && !pending.data) ||
    sessions.list.isPending ||
    sessions.list.isError
  const needsMap = needsUnknown
    ? null
    : needsByAgent({
        action: needs.rows.flatMap((r) => (r.kind === 'agent' ? [r.id] : [])),
        failedSessionAgents: failedRaw,
        idForName: uniqueByName(dir.byNameAll),
        requestAgents: requests.filter((r) => r.proven).map((r) => r.agentId),
      })

  const rows =
    scope && dir.data
      ? buildRows({
          agents,
          meSub: me.sub,
          scope,
          spend,
          saved,
          // Ratings settle together: a half-loaded set calls agents Healthy before their comparisons arrive.
          ratings: fleet.ratingsPending ? null : (fleet.summary?.byId ?? null),
          needs: needsMap,
          budgets: budgets.byAgent,
        })
      : null

  return {
    dir,
    /** The directory failed before it ever answered (a failed refresh keeps the rows it had). */
    dirFailed: dir.isError && !dir.data,
    needsYou,
    rows,
    ratingsPending: fleet.ratingsPending,
    budgets,
    win,
    owner: (id: string) => users.data?.get(id) ?? null,
    spendStatus,
    /** Calls in the window had no price: spend is a floor. */
    unpriced: (dash.data?.summary.unpriced_calls ?? 0) > 0 && spendStatus !== 'loading',
    savedStatus,
    /** The server returned as many savings rows as asked: agents past them may have savings too. */
    savedCapped: (savings.data?.by_agent.length ?? 0) >= SAVINGS_ROWS,
    asOf: spendStatus === 'ok' || spendStatus === 'stale' ? dash.dataUpdatedAt : 0,
    retryMoney: () => {
      if (dash.isError) void dash.refetch()
      if (savings.isError) void savings.refetch()
    },
  }
}

// ─── PR2b: budgets, and the reads per row on screen ─────────────────────────────────────────────

/**
 * Where budgets stand: `off` when this server has none (a bare 404) or they aren't a preview here (every budget is
 * the proposed R-L10 contract, so live mode never draws one); `failed` when a read failed without data to keep (a 401
 * or 403 included: it ends the poll but isn't "not set up"); `stale` when a refresh failed and the last figures stay.
 */
export type BudgetsState = 'off' | 'loading' | 'failed' | 'stale' | 'ok'

/** Budget figures are drawn while they are current or kept from the last successful read. */
export const budgetsShown = (s: BudgetsState) => s === 'ok' || s === 'stale'

export interface HomeBudgets {
  state: BudgetsState
  /** Agent budgets by agent id; null until both reads answered. */
  byAgent: ReadonlyMap<string, RowBudget> | null
  /** The viewer's own monthly budget (calls billed to them), when they set one. */
  own: RowBudget | null
  /** When the status was last read (the X5 clock and the "updated" stamp). */
  updatedAt: number
}

/** Whole cents: a recomputed sum like 0.1 + 0.7 must still meet a $0.80 limit. */
const cents = (v: number) => Math.round(v * 100)

function rowBudget(b: Budget, st: BudgetStatus, now: Date): RowBudget {
  const days = st.daily.map((d) => ({ date: d.date, spend_usd: d.cost_usd }))
  return {
    used: st.used_usd,
    limit: b.limit_usd,
    resetsAt: st.resets_at,
    unpriced: st.unpriced_calls > 0,
    // "Limit reached" follows the same figure the cell prints (`used_usd`), never a recomputed sum of the days.
    crossing:
      b.limit_usd > 0 && cents(st.used_usd) >= cents(b.limit_usd)
        ? { kind: 'reached' }
        : crossingDate(b.limit_usd, days, now),
  }
}

function useHomeBudgets(any: boolean, meSub: string): HomeBudgets {
  const preview = isPreview('router')
  // Both reads poll together: a limit changed elsewhere, or a new budget, shows with the next status.
  const list = useBudgets(preview && any, BUDGET_POLL_MS)
  const status = useBudgetStatus(preview && !!list.data?.length, BUDGET_POLL_MS)
  const absent = (e: unknown) => e instanceof ApiError && e.status === 404
  const off = !preview || absent(list.error) || absent(status.error)
  const failed = (list.isError && !list.data) || (status.isError && !status.data)
  const stale = list.isError || status.isError
  const state: BudgetsState = off
    ? 'off'
    : failed
      ? 'failed'
      : list.isPending || (!!list.data?.length && status.isPending)
        ? 'loading'
        : stale
          ? 'stale'
          : 'ok'
  if (!budgetsShown(state) || !list.data) return { state, byAgent: null, own: null, updatedAt: 0 }
  // The status' own read time: the elapsed days and its daily series must agree (router budgets' rule).
  const now = new Date(status.dataUpdatedAt)
  const byId = new Map((status.data?.data ?? []).map((s) => [s.budget_id, s]))
  const byAgent = new Map<string, RowBudget>()
  let own: RowBudget | null = null
  for (const b of list.data) {
    const st = byId.get(b.id)
    if (!st) continue
    if (b.scope === 'agent' && b.agent_id) byAgent.set(b.agent_id, rowBudget(b, st, now))
    // Only the viewer's own: a list that also carries other people's owner budgets never labels theirs "Your budget".
    else if (b.scope === 'owner' && b.owner_id === meSub) own = rowBudget(b, st, now)
  }
  return { state, byAgent, own, updatedAt: status.dataUpdatedAt }
}

/** Row reads in flight across the page (eng "Home execution table": `ROW_READS`). */
const rowLimiter = createLimiter(ROW_READS)

const FINOPS = '/api/observability/finops'

/**
 * One agent's spend series for the window, for its sparkline. Superusers only: `/finops/spend-timeseries` is fleet-wide
 * on the server, not ACL-scoped (eng "Member money"). Mounted only while the row is on screen; leaving it cancels the
 * read, or drops it from the limiter's queue.
 *
 * The bounds are the page's frozen window, sent explicitly: a relative `range` read when a row scrolls in later would
 * describe a later window than the totals beside it. Every read is a Tempo search plus a fetch per trace on the
 * server, so a failure isn't retried (the row keeps its total) and a batched per-agent series is a server ask.
 */
export function useRowSeries(id: string, win: Pick<ResolvedWindow, 'start' | 'end'>) {
  const bounds = { start_time: win.start.toISOString(), end_time: win.end.toISOString() }
  const path = withQuery(`${FINOPS}/spend-timeseries`, { ...bounds, agent_id: id })
  return useQuery({
    queryKey: ['home', 'series', id, bounds.start_time, bounds.end_time],
    queryFn: ({ signal }) =>
      rowLimiter(signal, async () => {
        const body = await apiData<FinopsSpendTimeseries>(path, { signal })
        // A malformed body costs this row its line, never the table (it renders during the cell's render).
        if (!body || !Array.isArray(body.points))
          throw new ApiError(200, body, path, `GET ${path} → unexpected response (no points)`)
        return body
      }),
    staleTime: ROW_READ_STALE_MS,
    retry: false,
    meta: { path: `${FINOPS}/spend-timeseries` },
  })
}

/**
 * One agent's build records (newest 20), for its last change; `{available:false}` without deploy rights. The deploy
 * feature's own key, so a build started, finished or invalidated anywhere in the app reaches the row.
 */
export function useRowBuilds(id: string) {
  return useQuery({
    queryKey: agentBuildsKey(id),
    queryFn: ({ signal }) => rowLimiter(signal, () => fetchAgentBuilds(id, signal)),
    staleTime: ROW_READ_STALE_MS,
    retry: false,
    meta: { path: '/api/builds/agent/{id}' },
  })
}
