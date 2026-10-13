/**
 * Budget queries and writes (R-L10, moved from the router, eng D1). Every key starts with `['budgets']`, so one
 * invalidation re-reads every budget read, the session ledger's included.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiData, apiFetch, ApiError, type Checked } from '@/lib/api/client'
import {
  alertListSchema,
  atRiskListSchema,
  breakdownResponseSchema,
  burnResponseSchema,
  changesResponseSchema,
  hoursResponseSchema,
  traceListSchema,
  unbudgetedListSchema,
  type AlertV1,
  type AtRiskRow,
  type Breakdown,
  type Budget,
  type BudgetAlert,
  type BudgetStatusResponse,
  type Burn,
  type Changes,
  type CreateBudgetBody,
  type Dimension,
  type Hours,
  type Scope,
  type TraceRow,
  type UnbudgetedRow,
  type UpdateBudgetBody,
} from './types'
import { LIST_STALE_MS, MAX_PAGES } from './tuning'

export const budgetKeys = {
  all: ['budgets'] as const,
  list: ['budgets', 'list'] as const,
  status: ['budgets', 'status'] as const,
  alerts: ['budgets', 'alerts'] as const,
  session: (id: string) => ['budgets', 'session', id] as const,
  /** 1.0 reads (budgets.md §7, §8): keyed by route, then the full query string, so equal reads share an entry. */
  read: (route: string, query: string) => ['budgets', 'v1', route, query] as const,
}

const json = { 'Content-Type': 'application/json' }

/**
 * Every page of a budgets list (API_CONVENTIONS' cursor envelope; budgets.md §2): R-L10 callers expect the whole list,
 * and 1.0 pages it. A server without paging fields answers once. Capped, so a looping cursor can't spin.
 */
async function allPages<
  B extends { data: unknown[]; has_more?: boolean; next_cursor?: string | null },
>(path: string, signal: AbortSignal, schema?: Checked<B>['schema']): Promise<B> {
  const sep = path.includes('?') ? '&' : '?'
  const first = await apiFetch<B>(`${path}${sep}limit=100`, { signal, schema })
  if (!first || !Array.isArray(first.data))
    throw new ApiError(200, first, path, `GET ${path} → unexpected response (no data array)`)
  let page = first
  for (let i = 0; i < MAX_PAGES && page.has_more && page.next_cursor; i++) {
    page = await apiFetch<B>(
      `${path}${sep}limit=100&cursor=${encodeURIComponent(page.next_cursor)}`,
      { signal, schema },
    )
    if (!page || !Array.isArray(page.data))
      throw new ApiError(200, page, path, `GET ${path} → unexpected response (no data array)`)
    first.data.push(...page.data)
  }
  return first
}
const list = { staleTime: LIST_STALE_MS, refetchOnWindowFocus: true } as const

/** The caller's budgets; `['budgets']` prefixes every budget read, so one invalidation re-reads them all. */
export function useBudgets(enabled = true, pollMs?: number) {
  return useQuery({
    queryKey: budgetKeys.list,
    queryFn: async ({ signal }) =>
      (await allPages<{ data: Budget[] }>('/api/budgets', signal)).data,
    enabled,
    ...list,
    ...budgetPoll(pollMs),
  })
}

/**
 * A poll ends on a bare 404 (a server without budgets), a 401 or a 403: asking again every minute can't change any of
 * them.
 */
export const budgetPollEnds = (err: unknown) =>
  err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)

/** Poll options for a budgets read: no retry, since the next poll is the retry. */
const budgetPoll = (pollMs: number | undefined) =>
  pollMs
    ? {
        retry: false,
        refetchInterval: (q: { state: { error: unknown } }) =>
          budgetPollEnds(q.state.error) ? false : pollMs,
      }
    : {}

/**
 * The status of every budget the caller can read. `pollMs` re-reads it while the tab is visible (the home's budget
 * column, plans/feat-agent-centric.md PR2 "Live budgets"): no retry, since the next poll is the retry.
 */
export function useBudgetStatus(enabled: boolean, pollMs?: number) {
  const path = '/api/budgets/status'
  return useQuery({
    queryKey: budgetKeys.status,
    queryFn: async ({ signal }) => {
      return allPages<BudgetStatusResponse>(path, signal)
    },
    enabled,
    ...list,
    ...budgetPoll(pollMs),
  })
}

/** @public Hidden until /api/budgets lands (R-L10); RouterPage has the call commented out until B2. */
export function useBudgetAlerts(enabled: boolean) {
  return useQuery({
    queryKey: budgetKeys.alerts,
    queryFn: async ({ signal }) =>
      (await allPages<{ data: BudgetAlert[] }>('/api/budgets/alerts', signal)).data,
    enabled,
    ...list,
  })
}

export type SaveBudget =
  | { mode: 'create'; body: CreateBudgetBody }
  | { mode: 'update'; id: string; body: UpdateBudgetBody }

export function useSaveBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: SaveBudget) =>
      v.mode === 'create'
        ? apiData<Budget>('/api/budgets', {
            method: 'POST',
            headers: json,
            body: JSON.stringify(v.body),
          })
        : apiData<Budget>(`/api/budgets/${v.id}`, {
            method: 'PUT',
            headers: json,
            body: JSON.stringify(v.body),
          }),
    // Awaited, so the mutation stays pending until the list is re-read (no window where a stale row can be clicked again).
    onSettled: () => qc.invalidateQueries({ queryKey: budgetKeys.all }),
  })
}

export function useDeleteBudget() {
  const qc = useQueryClient()
  return useMutation({
    // DELETE answers `data: null`, so apiFetch (apiData treats a null data as an error).
    mutationFn: (id: string) => apiFetch(`/api/budgets/${id}`, { method: 'DELETE' }),
    // Awaited, so the mutation stays pending until the list is re-read (no window where a stale row can be clicked again).
    onSettled: () => qc.invalidateQueries({ queryKey: budgetKeys.all }),
  })
}

// ─── 1.0 reads (plan feat-budget-burn B2; budgets.md §7, §8) ─────────────────────────────────────────────────────────

/** A burn-family target: `org` takes no id. */
export interface ScopeRef {
  scope: Scope
  id: string | null
}

/** `scope`, `id` and the rest, in a stable order (the key is the string), skipping null and undefined. */
function scopeQuery(
  ref: ScopeRef,
  extra: Record<string, string | number | boolean | null | undefined> = {},
) {
  const p = new URLSearchParams({ scope: ref.scope })
  if (ref.id !== null && ref.scope !== 'org') p.set('id', ref.id)
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined) p.set(k, String(v))
  return p.toString()
}

/** The burn read options: no polling, no focus refetch (plan §5 "Clock and refresh": `useReturnTick` moves them). */
const read = { staleTime: 60_000, refetchOnWindowFocus: false } as const

const one =
  <T>(route: string, schema: Checked<{ data: T }>['schema']) =>
  async (query: string, signal: AbortSignal) =>
    (await apiFetch<{ data: T }>(`/api/budgets/${route}?${query}`, { signal, schema })).data

const readBurn = one<Burn>('burn', burnResponseSchema)
const readBreakdown = one<Breakdown>('burn/breakdown', breakdownResponseSchema)
const readChanges = one<Changes>('burn/changes', changesResponseSchema)
const readHours = one<Hours>('burn/hours', hoursResponseSchema)

/** BG-3/BG-5: the scope's series for a period, with its budget (or null) inside. */
export function useBurn(
  ref: ScopeRef,
  opts: {
    period: 'month' | 'quarter'
    from?: string | null
    contributor?: { by: Dimension; key: string } | null
  },
  enabled: boolean,
) {
  const query = scopeQuery(ref, {
    period: opts.period,
    from: opts.from,
    include_previous: true,
    contributor: opts.contributor?.key,
    by: opts.contributor?.by,
  })
  return useQuery({
    queryKey: budgetKeys.read('burn', query),
    queryFn: ({ signal }) => readBurn(query, signal),
    enabled,
    ...read,
  })
}

/** BG-4: daily spend by contributor, the top `top` plus Other. */
export function useBreakdown(
  ref: ScopeRef,
  opts: {
    by: Dimension
    period: 'month' | 'quarter'
    from?: string | null
    to?: string | null
    top?: number
  },
  enabled: boolean,
) {
  const query = scopeQuery(ref, {
    by: opts.by,
    period: opts.period,
    from: opts.from,
    to: opts.to,
    top: opts.top,
  })
  return useQuery({
    queryKey: budgetKeys.read('breakdown', query),
    queryFn: ({ signal }) => readBreakdown(query, signal),
    enabled,
    ...read,
  })
}

/** BG-4b: ranked changes between two equal ranges, over every contributor. */
export function useChanges(
  ref: ScopeRef,
  opts: { by: Dimension; from: string; to: string; compareFrom: string; compareTo: string } | null,
  enabled: boolean,
) {
  const query = opts
    ? scopeQuery(ref, {
        by: opts.by,
        from: opts.from,
        to: opts.to,
        compare_from: opts.compareFrom,
        compare_to: opts.compareTo,
        top: 10,
      })
    : ''
  return useQuery({
    queryKey: budgetKeys.read('changes', query),
    queryFn: ({ signal }) => readChanges(query, signal),
    enabled: enabled && !!opts,
    ...read,
  })
}

/** BG-12: one UTC day's hours. */
export function useHours(ref: ScopeRef, date: string | null, enabled: boolean) {
  const query = scopeQuery(ref, { date })
  return useQuery({
    queryKey: budgetKeys.read('hours', query),
    queryFn: ({ signal }) => readHours(query, signal),
    enabled: enabled && !!date,
    ...read,
  })
}

/** BG-4c: the day's top traces inside the scope, server-scoped and redacted (§5.2). */
export function useTraces(ref: ScopeRef, date: string | null, enabled: boolean) {
  const query = scopeQuery(ref, { date, limit: 10 })
  return useQuery({
    queryKey: budgetKeys.read('traces', query),
    queryFn: async ({ signal }) =>
      (
        await apiFetch<{ data: TraceRow[] }>(`/api/budgets/burn/traces?${query}`, {
          signal,
          schema: traceListSchema,
        })
      ).data,
    enabled: enabled && !!date,
    ...read,
  })
}

/** BG-6: budgets inside the scope that are exceeded, will run out, or crossed a mark; the server's order. */
export function useAtRisk(ref: ScopeRef, enabled: boolean) {
  const query = scopeQuery(ref)
  return useQuery({
    queryKey: budgetKeys.read('at-risk', query),
    queryFn: async ({ signal }) =>
      (
        await allPages<{ data: AtRiskRow[] }>(
          `/api/budgets/at-risk?${query}`,
          signal,
          atRiskListSchema,
        )
      ).data,
    enabled,
    ...read,
  })
}

/** Agents inside the scope with spend this period and no agent budget, by spend. */
export function useUnbudgeted(ref: ScopeRef, period: 'month' | 'quarter', enabled: boolean) {
  const query = scopeQuery(ref, { period })
  return useQuery({
    queryKey: budgetKeys.read('unbudgeted', query),
    queryFn: async ({ signal }) =>
      (
        await allPages<{ data: UnbudgetedRow[] }>(
          `/api/budgets/unbudgeted?${query}`,
          signal,
          unbudgetedListSchema,
        )
      ).data,
    enabled,
    ...read,
  })
}

/** Alerts on every budget inside the scope, the scope's own included, every kind (§8.4: the UI sends `kind=all`). */
export function useScopeAlerts(ref: ScopeRef, enabled: boolean) {
  const query = scopeQuery(ref, { kind: 'all' })
  return useQuery({
    queryKey: budgetKeys.read('alerts', query),
    queryFn: async ({ signal }) =>
      (await allPages<{ data: AlertV1[] }>(`/api/budgets/alerts?${query}`, signal, alertListSchema))
        .data,
    enabled,
    ...read,
  })
}
