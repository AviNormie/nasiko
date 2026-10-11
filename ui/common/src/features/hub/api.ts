/**
 * The agent hub's reads (plans/feat-agent-centric.md eng "Gate", "Load"), in one module that owns the gate and every
 * key that depends on it. Keys live under `['agents', 'hub', …]`, never TokenOps' own, so a warm TokenOps cache can't
 * render through the gate.
 *
 * The gate is a frontend gate: the finops timeseries is fleet-wide on the server (not ACL-scoped), so the hub reads
 * the ACL-scoped dashboard (`view=agent`, `agent_id`) first and asks for the timeseries and savings only after a fresh
 * success for this exact agent and window. Cached or placeholder data never authorizes; a failed revalidation, a
 * window change while pending, or a late answer for another key all leave the dependent reads disabled and unrendered.
 * While the gate revalidates (a focus refetch, a retry, an invalidation of `['agents', …]`) the dependent reads are
 * disabled, and any dependent data fetched after the gate's last success is withheld until the gate answers again
 * (`GateResult.authorizes`): a refetch racing a revoked grant never draws (review: Codex P1).
 * The server-side gap is a written ask (AH-P0 in docs/designs/openruntime-agent-hub-recommendations.md).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isUnavailable, useDeployment, useVersions } from '@/features/agents/api'
import { useAgentBuilds } from '@/features/deploy/api'
import { contextSavingsSchema } from '@/features/optimization/types'
import { finopsDashboardSchema } from '@/features/tokenops/types'
import type {
  FinopsDashboardData,
  FinopsSpendTimeseries,
  SavingsBasis,
  SavingsData,
} from '@/features/tokenops/types'
import type { ResolvedWindow } from '@/features/tokenops/window'
import { ApiError, apiData, withQuery } from '@/lib/api/client'
import { isPreview } from '@/lib/env'
import { markersFor, type MarkerSet } from './events'
import { EVENTS_READ } from './tuning'
import { agentEventsSchema, type AgentEvents } from './types'

const FINOPS = '/api/observability/finops'

const hubKeys = {
  all: (id: string) => ['agents', 'hub', id] as const,
  dashboard: (id: string, w: string) => ['agents', 'hub', id, 'dashboard', w] as const,
  timeseries: (id: string, w: string) => ['agents', 'hub', id, 'timeseries', w] as const,
  savings: (id: string, w: string) => ['agents', 'hub', id, 'savings', w] as const,
  savedSeries: (id: string, w: string) => ['agents', 'hub', id, 'saved-series', w] as const,
  events: (id: string, w: string) => ['agents', 'hub', id, 'events', w] as const,
}

type Win = Pick<
  ResolvedWindow,
  'key' | 'params' | 'prevParams' | 'prevStart' | 'prevEnd' | 'start' | 'end'
>

function dashboardPath(id: string, win: Win) {
  return withQuery(`${FINOPS}/dashboard`, { ...win.params, agent_id: id, view: 'agent' })
}

/** The gate's read. */
function hubDashboardQuery(id: string, win: Win) {
  const path = dashboardPath(id, win)
  return {
    queryKey: hubKeys.dashboard(id, win.key),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiData<FinopsDashboardData>(path, { signal, schema: finopsDashboardSchema }),
    meta: { path },
  }
}

export interface HubMoney {
  current: number
  previous: number
  changePct: number | null
  requests: number
  prevRequests: number
  requestsChangePct: number | null
  /** Some calls had no price: the spend is a floor. */
  unpriced: boolean
}

export type GateState =
  | { kind: 'pending' }
  | { kind: 'ok'; money: HubMoney }
  /** The dashboard's 404 "agent not found": the viewer can't see this agent's finops. */
  | { kind: 'not-visible' }
  /** A 400: the server doesn't know the agent (unknown or soft-deleted). */
  | { kind: 'deleted' }
  | { kind: 'error'; error: unknown }

export interface GateResult {
  state: GateState
  retry: () => void
  /** Dependent reads may run: authorized and not revalidating. */
  canFetch: boolean
  /** Dependent data updated at `at` may render: authorized, and not newer than an unfinished revalidation. */
  authorizes: (at: number) => boolean
}

export function useHubGate(id: string, win: Win): GateResult {
  const qc = useQueryClient()
  const q = useQuery({
    ...hubDashboardQuery(id, win),
    // Revalidate on every visit: only a response fetched since this page asked for this key authorizes
    // (`isFetchedAfterMount`, reset when the key changes), so an earlier visit's cache never does.
    refetchOnMount: 'always',
    staleTime: 0,
  })
  // Re-runs the gate (it is active, so it refetches at once), then the dependent reads as they enable again.
  const retry = () => void qc.invalidateQueries({ queryKey: hubKeys.all(id) })
  let state: GateState
  if (q.isError) {
    const err = q.error
    state =
      err instanceof ApiError && err.status === 404
        ? { kind: 'not-visible' }
        : err instanceof ApiError && err.status === 400
          ? { kind: 'deleted' }
          : { kind: 'error', error: err }
  } else if (q.isSuccess && q.isFetchedAfterMount) {
    const k = q.data.kpis
    state = {
      kind: 'ok',
      money: {
        current: k.total_spend.current,
        previous: k.total_spend.previous,
        changePct: k.total_spend.change_pct,
        requests: k.total_operations.current,
        prevRequests: k.total_operations.previous,
        requestsChangePct: k.total_operations.change_pct,
        unpriced: q.data.summary.unpriced_calls > 0,
      },
    }
  } else state = { kind: 'pending' }
  const ok = state.kind === 'ok'
  const revalidating = q.isFetching
  const confirmedAt = q.dataUpdatedAt
  return {
    state,
    retry,
    canFetch: ok && !revalidating,
    // Strictly older: data stamped in the same millisecond as the gate's success can't be shown to predate it.
    authorizes: (at) => ok && (!revalidating || at < confirmedAt),
  }
}

/** The timeseries for this agent; `which: 'previous'` is the compare ghost (7d/30d and other daily windows only). */
export function useHubTimeseries(
  id: string,
  win: Win,
  which: 'current' | 'previous',
  enabled: boolean,
) {
  const params = which === 'current' ? win.params : win.prevParams
  const key =
    which === 'current'
      ? win.key
      : `prev|${win.prevStart.toISOString()}|${win.prevEnd.toISOString()}`
  const path = withQuery(`${FINOPS}/spend-timeseries`, { ...params, agent_id: id })
  return useQuery({
    queryKey: hubKeys.timeseries(id, key),
    queryFn: ({ signal }) => apiData<FinopsSpendTimeseries>(path, { signal }),
    enabled,
    meta: { path },
  })
}

export interface SavedTotal {
  saved: number
  basis: SavingsBasis
}

/**
 * This agent's row of `/finops/savings` (`scope=agent`, `agent_id`) for the window: the window total and its basis. No
 * row means "not reported" (null), never 0. `agent_id` is ACL-checked by the server (handler.rs `get_finops_savings`,
 * b2a966332) and keeps the agent inside the default 25-row `by_agent` cap; the row is still matched by id, so a server
 * that ignores the filter answers the same way.
 */
export function useHubSavings(id: string, win: Win, enabled: boolean) {
  const path = withQuery(`${FINOPS}/savings`, { ...win.params, scope: 'agent', agent_id: id })
  return useQuery({
    queryKey: hubKeys.savings(id, win.key),
    queryFn: ({ signal }) => apiData<SavingsData>(path, { signal }),
    select: (s): SavedTotal | null => {
      const row = s.by_agent.find((a) => a.agent_id === id)
      return row ? { saved: row.saved_tokens, basis: row.basis } : null
    },
    enabled,
    meta: { path },
  })
}

/**
 * The per-agent savings series (proposed CX-V3a), a preview: read only while the `optimization` mocks answer
 * (`isPreview`), whatever the server says. Live mode has no daily savings, so the lane header shows the total alone.
 */
export function useHubSavedSeries(id: string, win: Win, bucket: 'hour' | 'day', enabled: boolean) {
  const path = withQuery(`${FINOPS}/context-savings`, {
    ...win.params,
    agent_id: id,
    series: bucket === 'hour' ? 'hourly' : 'daily',
  })
  return useQuery({
    queryKey: hubKeys.savedSeries(id, win.key),
    queryFn: ({ signal }) => apiData(path, { signal, schema: contextSavingsSchema }),
    select: (s) => s.series?.points ?? [],
    enabled: enabled && isPreview('optimization'),
    meta: { path },
  })
}

/**
 * The proposed event log (AH-3), a preview: read only while the `events` mocks answer. Under `/api/observability`, never
 * `/api/agents/{id}/…`: that prefix is the A2A proxy (lib.rs `/agents/{id}/{*rest}`), where the agent itself would
 * answer. Any 404 (no such route, or no such agent) means no events to draw.
 */
function useHubEvents(id: string, win: Win) {
  const path = withQuery(`/api/observability/agent/${encodeURIComponent(id)}/events`, {
    start_time: win.start.toISOString(),
    end_time: win.end.toISOString(),
    limit: EVENTS_READ,
  })
  return useQuery({
    queryKey: hubKeys.events(id, win.key),
    queryFn: async ({ signal }): Promise<AgentEvents | null> => {
      try {
        return await apiData(path, { signal, schema: agentEventsSchema })
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null
        throw err
      }
    },
    enabled: isPreview('events'),
    meta: { path: '/api/observability/agent/{id}/events' },
  })
}

export type MarkersState =
  | { kind: 'pending' }
  | { kind: 'ready'; set: MarkerSet; eventsTruncated: boolean; preview: boolean }
  /** The deploy reads failed; the event log's markers (if any) still draw. */
  | { kind: 'failed'; which: 'deploys' | 'changes'; retry: () => void; set: MarkerSet | null }

/**
 * Markers from the builds (newest 20), versions, the current deployment's `crashed_at` (EE writes it) and, as a
 * preview, the event log. Independent of the gate: none of them carry money, and each has its own ACL.
 */
export function useHubMarkers(id: string, win: Win, harness: boolean): MarkersState {
  const builds = useAgentBuilds(id, !harness)
  const versions = useVersions(id, !harness)
  const deployment = useDeployment(id, !harness)
  const events = useHubEvents(id, win)
  const preview = isPreview('events')
  const deploysPending =
    !harness && (builds.isPending || versions.isPending || deployment.isPending)
  // A failed deployment read hides the crash marker: that is a failed source too, never "no crash" (review).
  const deploysFailed = !harness && (builds.isError || versions.isError || deployment.isError)
  if (deploysPending || (preview && events.isPending)) return { kind: 'pending' }
  const buildRecords = harness ? null : builds.data?.available ? builds.data.value : null
  const dep = deployment.data
  const crashedAt = dep && !isUnavailable(dep) ? (dep.crashed_at ?? null) : null
  const set = markersFor({
    builds: buildRecords,
    versions: harness ? null : (versions.data ?? null),
    crashedAt,
    events: events.data?.events ?? null,
    win,
    harness,
  })
  if (deploysFailed)
    return {
      kind: 'failed',
      which: 'deploys',
      // Only the event log's markers: with the deploy reads failed, nothing is said about builds or versions.
      set: events.data
        ? markersFor({
            builds: null,
            versions: null,
            crashedAt: null,
            events: events.data.events,
            win,
            harness: true,
          })
        : null,
      retry: () => {
        if (builds.isError) void builds.refetch()
        if (versions.isError) void versions.refetch()
        if (deployment.isError) void deployment.refetch()
      },
    }
  if (preview && events.isError)
    return { kind: 'failed', which: 'changes', set, retry: () => void events.refetch() }
  return {
    kind: 'ready',
    set,
    eventsTruncated: !!events.data?.truncated,
    preview: preview && !!events.data,
  }
}
