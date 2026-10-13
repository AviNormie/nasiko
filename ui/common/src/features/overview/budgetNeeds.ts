/**
 * Needs you's budget rows (plans/feat-budget-burn.md F8): one row per budget that needs the viewer, for their scope (a
 * superuser's fleet, anyone else's own). From At risk where the server has it (BG-6: exceeded, runs out before its
 * reset, or past a mark, in the server's order), else from R-L10's own list and status. An exceeded budget says how
 * much over and whether calls are stopped; one that will reach its limit says when. Budgets show only on a server the
 * availability probe says has them (F11); a failed read is "Couldn't check budgets", never "Nothing needs you".
 */
import { useQuery } from '@tanstack/react-query'
import { useBudgetStatus, useBudgets, useAtRisk } from '@/features/budgets/api'
import { capabilitiesQuery, mayHave } from '@/features/budgets/availability'
import type { AtRiskRow, Budget, BudgetStatus } from '@/features/budgets/types'
import type { Me } from '@/lib/api/auth'
import { isEndpointAbsent } from '@/lib/api/detect'
import { copy } from './copy'
import type { NeedsInput } from './needs'

export type BudgetNeed = Extract<NeedsInput['budgets'], { state: 'ok' }>['value'][number]

/** At risk rows as Needs you rows; a stopped agent budget its agent row already shows is skipped. */
export function needsFromAtRisk(
  rows: readonly AtRiskRow[],
  me: string,
  shownAsAgent: (agentId: string) => boolean,
): BudgetNeed[] {
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
      },
    ]
  })
}

/** R-L10's own budgets and their status, for a server without At risk. */
function needsFromStatus(
  budgets: readonly Budget[],
  status: readonly BudgetStatus[],
  agentLabel: (agentId: string) => string | undefined,
  shownAsAgent: (agentId: string) => boolean,
): BudgetNeed[] {
  return budgets.flatMap((b) => {
    const st = status.find((x) => x.budget_id === b.id)
    // A stopped agent budget is skipped only when its agent row already says so (a stopped, harness or unlisted agent
    // isn't rated, so the budget row must stay; /ship adversarial).
    if (!st || st.state === 'ok' || (st.stopped && !!b.agent_id && shownAsAgent(b.agent_id)))
      return []
    return [
      {
        id: b.id,
        label: b.agent_id ? agentLabel(b.agent_id) || copy.needs.anAgent : copy.needs.yourBudget,
        crossed: st.crossed,
        state: st.state === 'warning' ? 'warning' : 'exceeded',
        over: st.used_usd > b.limit_usd ? st.used_usd - b.limit_usd : null,
        stopped: st.stopped,
        stops: b.action === 'stop',
        runsOutOn: null,
        resetsAt: st.resets_at,
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
  const atRiskRef = me.is_superuser
    ? ({ scope: 'org', id: null } as const)
    : ({ scope: 'owner', id: me.sub } as const)
  const atRisk = useAtRisk(atRiskRef, enabled && available && mayHave(caps.data, 'at_risk'))
  // R-L10 (no At risk, or it answered a bare 404): the viewer's own list and status.
  const fallback = available && (!mayHave(caps.data, 'at_risk') || isEndpointAbsent(atRisk.error))
  const list = useBudgets(enabled && fallback)
  const status = useBudgetStatus(enabled && fallback && list.isSuccess)
  const value: NeedsInput['budgets'] =
    !enabled || caps.isPending
      ? { state: 'loading' }
      : caps.isError
        ? { state: 'failed' }
        : !available || (fallback && isEndpointAbsent(list.error))
          ? { state: 'absent' }
          : !fallback
            ? atRisk.isError
              ? { state: 'failed' }
              : atRisk.data
                ? { state: 'ok', value: needsFromAtRisk(atRisk.data.rows, me.sub, shownAsAgent) }
                : { state: 'loading' }
            : list.isError || status.isError
              ? { state: 'failed' }
              : list.data && status.data
                ? {
                    state: 'ok',
                    value: needsFromStatus(list.data, status.data.data, agentLabel, shownAsAgent),
                  }
                : { state: 'loading' }
  return {
    value,
    stamp: fallback ? status.dataUpdatedAt : atRisk.dataUpdatedAt,
    retry: () => {
      if (caps.isError) void caps.refetch()
      if (fallback) {
        void list.refetch()
        void status.refetch()
      } else void atRisk.refetch()
    },
  }
}
