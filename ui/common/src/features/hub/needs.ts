/**
 * Needs you, for one agent (plans/feat-agent-centric.md PR1c; CEO R2-6, design "Needs you", DX "Errors"). Pure: the
 * hub feeds it three sources, re-sourced for this agent rather than filtered from the Overview's fleet sample.
 * - Requests: this agent's pending requests (a superuser sees only those provably theirs, as chat's Waiting does).
 * - Status: the agent's rating from the Overview's own rules (`overview/health.ts` via `useFleetHealth`), rated on the
 *   last 7 days. Harnesses aren't rated there (their health has its own rule, eng), so they skip this source.
 * - Sessions: failures among this agent's sessions found in the hub's bounded sample. That sample is always partial (it
 *   is the latest N sessions across the fleet, filtered to this agent), so the card says what it checked (R2-6).
 *
 * The verdict "No issues found in checked data" shows only when every source answered and found nothing; a failed source
 * shows its own line with Retry, never the verdict.
 */
import type { Status } from '@/features/observability/sessions'

type SourceState<T> =
  { state: 'loading' } | { state: 'failed' } | { state: 'absent' } | { state: 'ok'; value: T }

export interface HubNeedsInput {
  requests: SourceState<{ count: number; firstChat: string | null; firstRequest: string | null }>
  /** The agent's rating; `absent` for a harness or an agent that isn't deployed (nothing to rate). */
  status: SourceState<{
    rating: 'healthy' | 'watch' | 'action' | 'unknown'
    reason: string | null
    incomplete: boolean
  }>
  sessions: SourceState<{
    /** This agent's sessions found in the sample. */
    found: number
    /** Of those, how many were checked (finished checking as failed or ok). */
    checked: number
    failed: number
    /** Rows in the sample (the latest N across the fleet). */
    scanned: number
  }>
}

export type NeedRow =
  | { kind: 'requests'; count: number; firstChat: string | null; firstRequest: string | null }
  | { kind: 'status'; level: 'action' | 'watch'; reason: string }
  | { kind: 'sessions'; failed: number; checked: number }

export type HubSource = 'requests' | 'status' | 'sessions'

export interface HubNeeds {
  rows: NeedRow[]
  failed: HubSource[]
  loading: boolean
  /** Every source answered (or is absent) and nothing was found. */
  clear: boolean
  /** What was checked, for the coverage line; null while loading. */
  coverage: {
    requests: boolean
    status: boolean
    sessions: { checked: number; found: number; scanned: number } | null
  } | null
}

/** Session check states that count as checked: a verdict came back. */
export const CHECKED: readonly Status[] = ['failed', 'ok']

export function hubNeeds(i: HubNeedsInput): HubNeeds {
  const rows: NeedRow[] = []
  const failed: HubSource[] = []
  let loading = false
  const note = (s: HubSource, st: SourceState<unknown>) => {
    if (st.state === 'failed') failed.push(s)
    if (st.state === 'loading') loading = true
  }
  note('requests', i.requests)
  note('status', i.status)
  note('sessions', i.sessions)
  if (
    i.status.state === 'ok' &&
    (i.status.value.rating === 'action' || i.status.value.rating === 'watch')
  )
    rows.push({ kind: 'status', level: i.status.value.rating, reason: i.status.value.reason ?? '' })
  if (i.requests.state === 'ok' && i.requests.value.count > 0)
    rows.push({ kind: 'requests', ...i.requests.value })
  if (i.sessions.state === 'ok' && i.sessions.value.failed > 0)
    rows.push({
      kind: 'sessions',
      failed: i.sessions.value.failed,
      checked: i.sessions.value.checked,
    })
  // An incomplete rating (a cost input down) can't vouch that nothing else needs action.
  const statusIncomplete = i.status.state === 'ok' && i.status.value.incomplete
  if (statusIncomplete && !failed.includes('status')) failed.push('status')
  // Action first, then requests, then watch, then sessions.
  const rank = (r: NeedRow) =>
    r.kind === 'status' ? (r.level === 'action' ? 0 : 2) : r.kind === 'requests' ? 1 : 3
  rows.sort((a, b) => rank(a) - rank(b))
  const coverage = loading
    ? null
    : {
        requests: i.requests.state === 'ok',
        status: i.status.state === 'ok',
        sessions: i.sessions.state === 'ok' ? i.sessions.value : null,
      }
  return { rows, failed, loading, clear: !loading && !failed.length && !rows.length, coverage }
}
