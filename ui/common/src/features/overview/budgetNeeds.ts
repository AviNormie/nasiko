/**
 * Needs you's budget rows (plans/feat-budget-burn.md F8): one row per budget that needs the viewer, for their scope (a
 * superuser's fleet, anyone else's own). The scope's own budget comes from its status (§8.1: the scope's own first),
 * since At risk never lists it (§8.2); the budgets inside it from At risk (BG-6, the server's order). A server without
 * those 1.0 routes falls back to R-L10's own list and status. An exceeded budget says how much over and whether calls
 * are stopped; one that will reach its limit says when. Budgets show only on a server the availability probe says has
 * them (F11); a failed or partial read is "Couldn't check budgets", never "Nothing needs you".
 */
import { useQuery } from '@tanstack/react-query'
import {
  useAtRisk,
  useBudgetStatus,
  useBudgets,
  useScopeStatus,
  type ScopeRef,
} from '@/features/budgets/api'
import { capabilitiesQuery, mayHave } from '@/features/budgets/availability'
import { project } from '@/features/budgets/projection'
import type { AtRiskRow, Budget, BudgetStatus, StatusRow } from '@/features/budgets/types'
import type { Me } from '@/lib/api/auth'
import { isEndpointAbsent } from '@/lib/api/detect'
import { copy } from './copy'
import type { BudgetItem, NeedsInput } from './needs'

/** At risk rows as Needs you rows; a stopped agent budget its agent row already says is skipped. */
export function needsFromAtRisk(
  rows: readonly AtRiskRow[],
  me: string,
  shownAsAgent: (agentId: string) => boolean,
): BudgetItem[] {
  return rows.flatMap((r) => {
    if (r.scope === 'agent' && r.target_id && r.stopped && shownAsAgent(r.target_id)) return []
    const own = r.scope === 'owner' && r.target_id === me
    return [
      {
        id: r.budget_id,
        label: own ? copy.needs.yourBudget : r.label,
        crossed: r.crossed,
        state: r.state === 'exceeded' ? 'exceeded' : 'warning',
        over: r.used_usd > r.limit_usd ? r.used_usd - r.limit_usd : null,
        stopped: r.stopped,
        stops: r.action === 'stop',
        runsOutOn: r.rank.reason === 'runs_out' ? r.rank.runs_out_on : null,
        resetsAt: r.resets_at,
        period: r.period,
        covers: r.covers,
      },
    ]
  })
}

/**
 * The scope's own budget from its status row (§8.1), when it needs the viewer: past a mark, over, or projected to reach
 * its limit before the reset by the projection rule (§4.6, the same one At risk ranks by).
 */
export function needFromOwnStatus(row: StatusRow, label: string): BudgetItem | null {
  const p = row.resets_at
    ? project({
        daily: row.daily,
        used: row.used_usd,
        limit: row.limit_usd,
        resetsAt: Date.parse(row.resets_at),
        asOf: Date.parse(row.as_of),
      })
    : null
  const runsOut = !row.stopped && p?.runOut ? new Date(p.runOut).toISOString().slice(0, 10) : null
  if (row.state === 'ok' && !runsOut) return null
  return {
    id: row.budget_id,
    label,
    crossed: row.crossed,
    state: row.state === 'exceeded' ? 'exceeded' : 'warning',
    over: row.used_usd > row.limit_usd ? row.used_usd - row.limit_usd : null,
    stopped: row.stopped,
    stops: row.action === 'stop',
    runsOutOn: row.state === 'exceeded' ? null : runsOut,
    resetsAt: row.resets_at,
    period: 'month',
    covers: row.covers,
  }
}

/** R-L10's own budgets and their status, for a server without the 1.0 routes. */
function needsFromStatus(
  budgets: readonly Budget[],
  status: readonly BudgetStatus[],
  me: string,
  agentLabel: (agentId: string) => string | undefined,
  shownAsAgent: (agentId: string) => boolean,
): BudgetItem[] {
  return budgets.flatMap((b) => {
    const st = status.find((x) => x.budget_id === b.id)
    // A stopped agent budget is skipped only when its agent row already says so (a stopped, harness or unlisted agent
    // isn't rated, so the budget row must stay; /ship adversarial).
    if (!st || st.state === 'ok' || (st.stopped && !!b.agent_id && shownAsAgent(b.agent_id)))
      return []
    return [
      {
        id: b.id,
        // Only the viewer's own owner budget is "Your monthly" (home/api's guard).
        label: b.agent_id
          ? agentLabel(b.agent_id) || copy.needs.anAgent
          : b.scope === 'owner' && b.owner_id === me
            ? copy.needs.yourBudget
            : copy.needs.aBudget,
        crossed: st.crossed,
        state: st.state === 'warning' ? 'warning' : 'exceeded',
        over: st.used_usd > b.limit_usd ? st.used_usd - b.limit_usd : null,
        stopped: st.stopped,
        stops: b.action === 'stop',
        runsOutOn: null,
        resetsAt: st.resets_at,
        period: 'month',
        covers: 'routed_calls',
      },
    ]
  })
}

export function useBudgetNeeds(
  me: Me,
  enabled: boolean,
  agentLabel: (agentId: string) => string | undefined,
  shownAsAgent: (agentId: string) => boolean,
) {
  const caps = useQuery({ ...capabilitiesQuery, enabled })
  const available = caps.data?.kind === 'available'
  const ref: ScopeRef = me.is_superuser
    ? { scope: 'org', id: null }
    : { scope: 'owner', id: me.sub }
  const atRisk = useAtRisk(ref, enabled && available && mayHave(caps.data, 'at_risk'))
  const own = useScopeStatus(ref, enabled && available && mayHave(caps.data, 'scope_status'))
  // R-L10 (no At risk, or it answered a bare 404): the viewer's own list and status.
  const fallback = available && (!mayHave(caps.data, 'at_risk') || isEndpointAbsent(atRisk.error))
  const list = useBudgets(enabled && fallback)
  const status = useBudgetStatus(enabled && fallback && list.isSuccess)
  // The scope's own budget: absent on a server without scope status (its bare 404), never a failure of the source.
  const ownAbsent = !mayHave(caps.data, 'scope_status') || isEndpointAbsent(own.error)
  const ownRow = own.data?.rows.find((r) => r.scope === ref.scope)
  const ownItem = ownRow
    ? needFromOwnStatus(ownRow, me.is_superuser ? copy.needs.fleetBudget : copy.needs.yourBudget)
    : null
  const value: NeedsInput['budgets'] = (() => {
    if (!enabled || caps.isPending) return { state: 'loading' }
    if (caps.isError) return { state: 'failed' }
    if (!available || (fallback && isEndpointAbsent(list.error))) return { state: 'absent' }
    if (fallback) {
      if (list.isError || status.isError) return { state: 'failed' }
      if (!list.data || !status.data) return { state: 'loading' }
      return {
        state: 'ok',
        value: needsFromStatus(list.data, status.data.data, me.sub, agentLabel, shownAsAgent),
      }
    }
    if (atRisk.isError || (own.isError && !ownAbsent)) return { state: 'failed' }
    if (!atRisk.data || (!ownAbsent && !own.data)) return { state: 'loading' }
    return {
      state: 'ok',
      value: [
        ...(ownItem ? [ownItem] : []),
        ...needsFromAtRisk(atRisk.data.rows, me.sub, shownAsAgent),
      ],
      // Rows are real, but a later page failed: the source can't vouch that nothing else needs the viewer.
      incomplete: atRisk.data.partial || !!own.data?.partial,
    }
  })()
  return {
    value,
    stamp: fallback ? status.dataUpdatedAt : atRisk.dataUpdatedAt,
    retry: () => {
      // The probe first: until it answers, nothing says which routes this server has.
      if (caps.isError) return void caps.refetch()
      if (fallback) {
        void list.refetch()
        void status.refetch()
        return
      }
      void atRisk.refetch()
      if (!ownAbsent) void own.refetch()
    },
  }
}
