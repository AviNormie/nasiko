/**
 * Used of limit as DESIGN.md's Budgets (R2) bar (plan feat-budget-burn F7): 6 px, `--primary`, `--warning` once a mark
 * is crossed, `--destructive` when over or stopped; clamped at full width, with the true percent beside it when asked
 * ("112%"), so over the limit still reads.
 */
import { cn } from '@/lib/utils'
import { usedPercent } from '../budgets'
import type { BudgetState } from '../types'

export function UsedBar({
  used,
  limit,
  state,
  stopped = false,
}: {
  used: number
  limit: number
  state: BudgetState
  stopped?: boolean
}) {
  return (
    <span
      className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
      aria-hidden
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 rounded-full',
          state === 'exceeded' || stopped
            ? 'bg-destructive'
            : state === 'warning'
              ? 'bg-warning'
              : 'bg-primary',
        )}
        style={{ width: `${usedPercent(used, limit)}%` }}
      />
    </span>
  )
}
