/**
 * Budget queries and writes (R-L10, moved from the router, eng D1). Every key starts with `['budgets']`, so one
 * invalidation re-reads every budget read, the session ledger's included.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiData, apiFetch, ApiError } from '@/lib/api/client'
import type {
  Budget,
  BudgetAlert,
  BudgetStatusResponse,
  CreateBudgetBody,
  UpdateBudgetBody,
} from './types'
import { LIST_STALE_MS, MAX_PAGES } from './tuning'

export const budgetKeys = {
  all: ['budgets'] as const,
  list: ['budgets', 'list'] as const,
  status: ['budgets', 'status'] as const,
  alerts: ['budgets', 'alerts'] as const,
  session: (id: string) => ['budgets', 'session', id] as const,
}

const json = { 'Content-Type': 'application/json' }

/**
 * Every page of a budgets list (API_CONVENTIONS' cursor envelope; budgets.md §2): R-L10 callers expect the whole list,
 * and 1.0 pages it. A server without paging fields answers once. Capped, so a looping cursor can't spin.
 */
async function allPages<
  B extends { data: unknown[]; has_more?: boolean; next_cursor?: string | null },
>(path: string, signal: AbortSignal): Promise<B> {
  const sep = path.includes('?') ? '&' : '?'
  const first = await apiFetch<B>(`${path}${sep}limit=100`, { signal })
  if (!first || !Array.isArray(first.data))
    throw new ApiError(200, first, path, `GET ${path} → unexpected response (no data array)`)
  let page = first
  for (let i = 0; i < MAX_PAGES && page.has_more && page.next_cursor; i++) {
    page = await apiFetch<B>(
      `${path}${sep}limit=100&cursor=${encodeURIComponent(page.next_cursor)}`,
      { signal },
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
