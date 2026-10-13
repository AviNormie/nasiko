// @vitest-environment node
// R-L10 fallback (plan feat-budget-burn F11): an owner budget's status row drawn as this period's burn.
import { describe, expect, it } from 'vitest'
import { chartModel, projection } from './burn'
import { burnFromStatus } from './fallback'
import type { Budget, BudgetStatus } from './types'

const budget: Budget = {
  id: 'b1',
  scope: 'owner',
  agent_id: null,
  owner_id: 'u1',
  set_by: 'u1',
  period: 'month',
  limit_usd: 100,
  thresholds: [50, 80, 100],
  action: 'stop',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}
const status: BudgetStatus = {
  budget_id: 'b1',
  used_usd: 40,
  unpriced_calls: 0,
  resets_at: '2026-11-01T00:00:00Z',
  state: 'ok',
  crossed: null,
  stopped: false,
  daily: Array.from({ length: 10 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    cost_usd: 4,
  })),
}

describe('burnFromStatus', () => {
  it('this period, one limit step, a projection from the daily series', () => {
    const b = burnFromStatus(budget, status, 'You', Date.UTC(2026, 9, 10, 12))!
    expect(b.period_start).toBe('2026-10-01T00:00:00Z')
    expect(b.budget?.limits).toEqual([
      expect.objectContaining({ limit_usd: 100, action: 'stop', to: null }),
    ])
    expect(projection(b)?.pace).toBe(4)
    expect(chartModel(b, 'down').actual.at(-1)?.v).toBe(60)
  })

  it('no days yet is no burn', () => {
    expect(burnFromStatus(budget, { ...status, daily: [] }, 'You', Date.now())).toBeNull()
  })
})
