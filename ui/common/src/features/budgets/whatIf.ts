/**
 * What-if's state (plan feat-budget-burn F6), pure: the panel's inputs and the preview they make, by `burn.ts`'s rules.
 */
import { parseLimit } from './budgets'
import { whatIf, whatIfProblem } from './burn'
import type { Burn } from './types'

export interface WhatIfState {
  open: boolean
  /** The limit as typed ('' keeps the budget's own). */
  limit: string
  /** Whole percent, −50 … +50. */
  pace: number
}

export const WHAT_IF_CLOSED: WhatIfState = { open: false, limit: '', pace: 0 }

/** The preview's inputs, or null while nothing differs from the budget or an input is invalid. */
export function whatIfInputs(
  b: Burn,
  s: WhatIfState,
): { limit: number | null; paceChange: number } | null {
  if (!s.open) return null
  const limit = s.limit.trim() ? parseLimit(s.limit) : null
  const paceChange = s.pace / 100
  if (whatIfProblem(limit, paceChange)) return null
  if (limit === null && paceChange === 0) return null
  return whatIf(b, { limit, paceChange }) ? { limit, paceChange } : null
}
