/**
 * Burndown or Burn-up, remembered per user under the drafts prefix (plan feat-budget-burn F1, user decision D3), as
 * Home's scope is: sign-out clears it. Blocked storage keeps the choice for the visit (it's in the URL).
 */
import { DRAFT_PREFIX } from '@/lib/draftKeys'
import type { BurnMode } from './burn'

const key = (sub: string) => `${DRAFT_PREFIX}${sub}:budgets:burn`

export function storedBurnMode(sub: string): BurnMode | null {
  try {
    const v = localStorage.getItem(key(sub))
    return v === 'down' || v === 'up' ? v : null
  } catch {
    return null
  }
}

export function rememberBurnMode(sub: string, mode: BurnMode) {
  try {
    localStorage.setItem(key(sub), mode)
  } catch {
    // Blocked storage: see above.
  }
}
