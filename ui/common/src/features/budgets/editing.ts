/**
 * Editing from /budgets (plan feat-budget-burn F10: "editing happens in place"), pure: who a budget is for (the sheet's
 * words), who may change it (budgets.md §5: a superuser or org admin any owner, agent, unit or fleet budget; a unit lead
 * their units' while the org allows it, §7 Q4; finance nothing; anyone else their own owner and agent budgets; sessions
 * are set on their ledger, B5), and a 1.0 record in the sheet's R-L10 shape.
 * `editing.test.ts`.
 */
import type { BudgetWho } from './components/BudgetSheet'
import type { PageScope, Viewer } from './scope'
import type { Budget, BudgetV1, Scope } from './types'

/** The sheet's subject for a budget on `scope`/`target`, named `label`; null for scopes not edited here. */
export function whoFor(
  scope: Scope,
  target: string | null,
  label: string,
  v: Viewer,
): BudgetWho | null {
  if (scope === 'org') return { kind: 'fleet' }
  if (scope === 'unit' && target) return { kind: 'unit', id: target, name: label }
  if (scope === 'owner' && target)
    return target === v.id ? { kind: 'you' } : { kind: 'user', id: target, name: label }
  if (scope === 'agent' && target) return { kind: 'agent', id: target, name: label }
  return null
}

/** A loaded budget's subject. */
export const whoForBudget = (b: BudgetV1, label: string, v: Viewer) =>
  whoFor(
    b.scope,
    b.scope === 'agent' ? b.agent_id : b.scope === 'unit' ? b.unit_id : b.owner_id,
    label,
    v,
  )

/** May the viewer change a budget on `scope` owned by `ownerId` (§5). */
export function canWrite(scope: Scope, ownerId: string | null, v: Viewer): boolean {
  if (scope === 'session') return false
  if (v.superuser) return true
  if (v.finance) return false
  // A unit's "owner" is the unit itself: the viewer's writable units (an admin's all, a lead's per §7 Q4).
  if (scope === 'unit') return !!ownerId && !!v.writeUnits?.has(ownerId)
  return (scope === 'owner' || scope === 'agent') && ownerId === v.id
}

/** The page scope's own subject, for "Set a budget" on it. */
export function scopeWho(s: PageScope, label: string): BudgetWho {
  if (s.kind === 'fleet') return { kind: 'fleet' }
  if (s.kind === 'owner') return { kind: 'user', id: s.id, name: label }
  if (s.kind === 'unit') return { kind: 'unit', id: s.id, name: label }
  return { kind: 'you' }
}

/** A 1.0 budget in the sheet's R-L10 shape (`PUT` takes the same fields, §6.5). */
export function toSheetBudget(b: BudgetV1): Budget {
  return {
    id: b.id,
    scope: b.scope === 'org' || b.scope === 'agent' ? b.scope : 'owner',
    agent_id: b.agent_id,
    owner_id: b.owner_id ?? '',
    set_by: b.set_by,
    period: 'month',
    limit_usd: b.limit_usd,
    thresholds: b.thresholds,
    action: b.action,
    created_at: b.created_at,
    updated_at: b.updated_at,
  }
}
