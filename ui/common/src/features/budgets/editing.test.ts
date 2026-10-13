// @vitest-environment node
// Editing from /budgets (plan feat-budget-burn F10; budgets.md §5): whose budget it is, and who may change it.
import { describe, expect, it } from 'vitest'
import { canWrite, scopeWho, toSheetBudget, whoFor } from './editing'
import type { BudgetV1 } from './types'

const admin = { id: 'u-admin', superuser: true }
const ana = { id: 'u-ana', superuser: false }

describe('whoFor', () => {
  it('fleet, you, another user, an agent; units and sessions aren’t edited here', () => {
    expect(whoFor('org', null, 'Fleet', admin)).toEqual({ kind: 'fleet' })
    expect(whoFor('owner', 'u-admin', 'admin', admin)).toEqual({ kind: 'you' })
    expect(whoFor('owner', 'u-ana', 'Ana', admin)).toEqual({
      kind: 'user',
      id: 'u-ana',
      name: 'Ana',
    })
    expect(whoFor('agent', 'a1', 'Pricing', admin)).toEqual({
      kind: 'agent',
      id: 'a1',
      name: 'Pricing',
    })
    expect(whoFor('unit', 'x', 'Platform', admin)).toBeNull()
    expect(whoFor('session', 'x', 'S1', admin)).toBeNull()
  })
})

describe('canWrite (§5)', () => {
  it('a superuser any owner, agent or fleet budget; never units or sessions here', () => {
    expect(canWrite('org', null, admin)).toBe(true)
    expect(canWrite('owner', 'u-ana', admin)).toBe(true)
    expect(canWrite('unit', null, admin)).toBe(false)
  })

  it('anyone else their own owner and agent budgets only', () => {
    expect(canWrite('owner', 'u-ana', ana)).toBe(true)
    expect(canWrite('agent', 'u-ana', ana)).toBe(true)
    expect(canWrite('agent', 'u-dev', ana)).toBe(false)
    expect(canWrite('org', null, ana)).toBe(false)
  })
})

describe('the sheet’s shapes', () => {
  it('a page scope’s own subject', () => {
    expect(scopeWho({ kind: 'fleet' }, 'Fleet')).toEqual({ kind: 'fleet' })
    expect(scopeWho({ kind: 'owner', id: 'u-ana' }, 'Ana')).toEqual({
      kind: 'user',
      id: 'u-ana',
      name: 'Ana',
    })
  })

  it('a 1.0 record keeps what PUT needs', () => {
    const v1 = {
      id: 'b1',
      scope: 'org',
      agent_id: null,
      unit_id: null,
      session_id: null,
      owner_id: null,
      label: 'Fleet',
      set_by: 'u-admin',
      period: 'month',
      limit_usd: 500,
      thresholds: [50, 80],
      forecast_thresholds: [100],
      action: 'alert',
      covers: 'all_priced',
      version: 1,
      effective_from: '2026-10-01T00:00:00Z',
      next_period_change: null,
      limits_inside_usd: null,
      limits_inside_count: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
    } satisfies BudgetV1
    expect(toSheetBudget(v1)).toMatchObject({
      id: 'b1',
      scope: 'org',
      limit_usd: 500,
      thresholds: [50, 80],
      action: 'alert',
      updated_at: '2026-10-02T00:00:00Z',
    })
  })
})
