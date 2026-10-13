/**
 * The projection rule, written once for the UI and the server (docs/requirements/budgets.md §4.6, plan §5): pace from
 * the period's own complete days, days left as a fraction, projected spend, and the run-out instant. Pure; the mock
 * uses it to rank At risk and to replay forecast alerts, and B1's `burn.ts` builds the chart's figures on it.
 */
import { MIN_COMPLETE_DAYS, PACE_DAYS } from './tuning'

export const DAY_MS = 86_400_000

export interface ProjectionInput {
  /** The period's days from its start, ascending, `cost_usd` per UTC day (days after `asOf`'s day are ignored). */
  daily: readonly { date: string; cost_usd: number }[]
  /** Spend this period up to `asOf`, today's partial day included. */
  used: number
  /** The limit in effect at `asOf`; null for a scope with no budget. */
  limit: number | null
  resetsAt: number
  asOf: number
}

export interface Projection {
  pace: number
  /** `(resetsAt − asOf)` in days, fractional. */
  daysLeft: number
  projected: number
  /** null without a limit. */
  projectedPct: number | null
  /** The instant the projection passes the limit, before `resetsAt`; null when it doesn't, or already ran out. */
  runOut: number | null
  /** Spend already reached the limit. */
  ranOut: boolean
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** null when the period has fewer than 3 complete days. */
export function project(input: ProjectionInput): Projection | null {
  const today = utcDay(input.asOf)
  const complete = input.daily.filter((d) => d.date < today)
  if (complete.length < MIN_COMPLETE_DAYS) return null
  const window = complete.slice(-PACE_DAYS)
  const pace = window.reduce((t, d) => t + d.cost_usd, 0) / window.length
  const daysLeft = Math.max(0, (input.resetsAt - input.asOf) / DAY_MS)
  const projected = input.used + pace * daysLeft
  const limit = input.limit
  const ranOut = limit !== null && input.used >= limit
  let runOut: number | null = null
  if (limit !== null && !ranOut && pace > 0) {
    const at = input.asOf + ((limit - input.used) / pace) * DAY_MS
    if (at < input.resetsAt) runOut = at
  }
  return {
    pace,
    daysLeft,
    projected,
    projectedPct: limit ? (projected / limit) * 100 : null,
    runOut,
    ranOut,
  }
}

/** When spend at `pace` reaches `target` from `used` at `asOf` (forecast alerts' `crosses_on`). */
export const crossingAt = (used: number, pace: number, target: number, asOf: number) =>
  pace > 0 ? asOf + ((target - used) / pace) * DAY_MS : Infinity
