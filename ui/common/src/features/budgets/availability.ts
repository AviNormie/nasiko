/**
 * Which budget features this server serves (plan feat-budget-burn F11; budgets.md §10.1). One read per session:
 * `GET /api/budgets/capabilities`; a server without it (bare 404) is probed with R-L10's `GET /api/budgets`, which
 * means budgets alone, and a bare 404 there too means no budgets at all. A coded 404 or a 403 means present but not
 * visible to this caller, never absent. Its own key, outside `['budgets']`, so a budget write's invalidation never
 * re-reads it.
 *
 * Loads with the shell (`_app` hides the nav item from it): no zod, only the client.
 */
import { apiFetch, ApiError } from '@/lib/api/client'
import { isEndpointAbsent } from '@/lib/api/detect'

export type Feature =
  | 'budgets'
  | 'burn'
  | 'breakdown'
  | 'changes'
  | 'hours'
  | 'traces'
  | 'contributor'
  | 'org_budgets'
  | 'unit_budgets'
  | 'quarter_periods'
  | 'versions'
  | 'forecast_alerts'
  | 'at_risk'
  | 'unbudgeted'
  | 'scope_status'
  | 'session_budgets'
  | 'prices'
  | 'team_identity'
  | 'fiscal_year'

export type Availability =
  | { kind: 'absent' }
  /** `version` is null on an R-L10 server (no capabilities route). Unknown slugs are kept and ignored. */
  | { kind: 'available'; version: string | null; features: readonly string[] }

const capabilitiesKey = ['budget-capabilities'] as const

async function readCapabilities(signal: AbortSignal): Promise<Availability> {
  try {
    const res = await apiFetch<{ data?: { version?: unknown; features?: unknown } }>(
      '/api/budgets/capabilities',
      { signal },
    )
    const features = res?.data?.features
    const version = res?.data?.version
    if (!Array.isArray(features) || typeof version !== 'string')
      throw new Error('GET /api/budgets/capabilities → unexpected response')
    return {
      kind: 'available',
      version,
      features: features.filter((f): f is string => typeof f === 'string'),
    }
  } catch (err) {
    if (!isEndpointAbsent(err)) throw err
  }
  const present: Availability = { kind: 'available', version: null, features: ['budgets'] }
  try {
    await apiFetch('/api/budgets?limit=1', { signal })
    return present
  } catch (err) {
    if (isEndpointAbsent(err)) return { kind: 'absent' }
    // A coded 404 or a 403 is the route answering this caller: present, not absent (§10.1).
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return present
    throw err
  }
}

/** The probe, as query options (the shell and the page share the one cached answer). */
export const capabilitiesQuery = {
  queryKey: capabilitiesKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => readCapabilities(signal),
  staleTime: Infinity,
  // A probe: a failed read hides the nav item, and the page shows its own error with Retry.
  retry: false,
} as const

/** The server serves `feature` completely (budgets.md §10.1). */
export const has = (a: Availability | undefined, feature: Feature) =>
  a?.kind === 'available' && a.features.includes(feature)

/**
 * Worth asking for `feature`: listed, or a server without the capabilities route, which is read route by route (§10.1:
 * the route's own bare 404 then means absent, `isEndpointAbsent`).
 */
export const mayHave = (a: Availability | undefined, feature: Feature) =>
  has(a, feature) || (a?.kind === 'available' && a.version === null)
