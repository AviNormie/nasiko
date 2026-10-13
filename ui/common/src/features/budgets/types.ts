/**
 * Budget wire types. R-L10 (owner and agent monthly budgets, status, alerts) moved here from the router (plan
 * feat-budget-burn eng D1); the 1.0 contract's zod schemas join them in B0 (docs/requirements/budgets.md).
 */
// ─── R-L10 (the `budgets` mock group answers it; `router` brings it along) ──────────

type BudgetScope = 'owner' | 'agent'
export type BudgetAction = 'alert' | 'stop'
export type BudgetState = 'ok' | 'warning' | 'exceeded'

export interface Budget {
  id: string
  scope: BudgetScope
  /** Set for an agent budget, null for the owner budget. */
  agent_id: string | null
  /** The user it belongs to: the owner budget's user, or the agent's owner, whoever set it. */
  owner_id: string
  /** Who created or last changed it (a superuser may set a budget on anyone's agent). */
  set_by: string
  period: 'month'
  limit_usd: number
  /** Whole percents of the limit, ascending and unique (default 50, 80, 100); a `stop` budget always has 100. */
  thresholds: number[]
  action: BudgetAction
  created_at: string
  updated_at: string
}

export interface CreateBudgetBody {
  scope: BudgetScope
  agent_id?: string | null
  limit_usd: number
  thresholds?: number[]
  action?: BudgetAction
}

/** A full replace (R-L10 has no COALESCE), guarded against a change made elsewhere since it was read. */
export interface UpdateBudgetBody {
  limit_usd: number
  thresholds: number[]
  action: BudgetAction
  /** The `updated_at` the client read; a mismatch is 409 "budget changed elsewhere". */
  expected_updated_at: string
}

export interface BudgetStatus {
  budget_id: string
  used_usd: number
  /** Calls this period with no price (NULL cost_usd): they count as $0. */
  unpriced_calls: number
  resets_at: string
  state: BudgetState
  /** The highest threshold crossed this period, or null. */
  crossed: number | null
  /** One entry per UTC day of the period so far, zeros included. */
  daily: { date: string; cost_usd: number }[]
  /** A `stop` budget the router is refusing calls for right now (its effective state, after its cache window). */
  stopped: boolean
}

export interface BudgetStatusResponse {
  data: BudgetStatus[]
  covers: 'routed_calls'
}

export interface BudgetAlert {
  id: string
  budget_id: string
  threshold: number
  amount_usd: number
  at: string
  stopped: boolean
}
