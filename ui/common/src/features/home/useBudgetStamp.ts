import { relTime } from '@/features/agents/format'
import { useNow } from '@/lib/useNow'
import { copy } from './copy'
import { STAMP_TICK_MS } from './tuning'

/**
 * "updated 2 minutes ago" for a budgets read, or null before one answered. Its own clock: the stamp moves while the
 * page's "now" stays frozen for the visit.
 */
export function useBudgetStamp(updatedAt: number): string | null {
  const now = useNow(STAMP_TICK_MS)
  return updatedAt
    ? copy.budget.updated(relTime(new Date(updatedAt).toISOString(), Math.max(now, updatedAt)))
    : null
}
