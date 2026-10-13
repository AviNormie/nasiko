/**
 * An R-L10 server (no burn route) still draws the viewer's own burn (plan feat-budget-burn F11): the owner budget's
 * status row, this period only, as a burn read. No events, no previous period and no split by source: the page says
 * once that some views need a newer server. The clock is the status read's `dataUpdatedAt` (plan §5). Pure;
 * `fallback.test.ts`.
 */
import type { Budget, BudgetStatus, Burn } from './types'

export function burnFromStatus(
  b: Budget,
  s: BudgetStatus,
  label: string,
  readAt: number,
): Burn | null {
  const first = s.daily[0]?.date
  if (!first) return null
  const periodStart = `${first}T00:00:00Z`
  const daily = s.daily.map((d) => ({
    date: d.date,
    cost_usd: d.cost_usd,
    calls: 0,
    unpriced_calls: 0,
    routed_usd: d.cost_usd,
    traced_usd: 0,
    harness_estimate_usd: 0,
  }))
  return {
    scope: 'owner',
    id: b.owner_id,
    label,
    as_of: new Date(Math.max(readAt, Date.parse(periodStart))).toISOString(),
    covers: 'routed_calls',
    period: 'month',
    period_start: periodStart,
    resets_at: s.resets_at,
    from: first,
    used_usd: s.used_usd,
    unpriced_calls: s.unpriced_calls,
    calls: 0,
    sources: { routed_usd: s.used_usd, traced_usd: 0, harness_estimate_usd: 0 },
    exact_dedupe_from: null,
    outside: null,
    budget: {
      id: b.id,
      action: b.action,
      version: 1,
      forecast_thresholds: [],
      state: s.state,
      crossed: s.crossed,
      stopped: s.stopped,
      limits: [
        {
          from: periodStart,
          to: null,
          version: 1,
          limit_usd: b.limit_usd,
          thresholds: b.thresholds,
          action: b.action,
        },
      ],
    },
    periods: [
      {
        period_start: periodStart,
        resets_at: s.resets_at,
        used_usd: s.used_usd,
        unpriced_calls: s.unpriced_calls,
      },
    ],
    daily,
    previous: null,
    events: [],
    contributor: null,
    owned_agents: null,
    membership: null,
    turns: null,
    session: null,
  }
}
