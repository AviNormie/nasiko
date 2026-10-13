// @vitest-environment node
// Alert sentences (plan feat-budget-burn F5): threshold, stop, forecast with the server's date, unknown kinds left out.
import { describe, expect, it } from 'vitest'
import { alertText } from './alerts'
import type { AlertV1 } from './types'

const base: AlertV1 = {
  id: 'e1',
  budget_id: 'b1',
  label: 'Pricing Engine',
  scope: 'agent',
  kind: 'threshold',
  percent: 80,
  threshold: 80,
  version: 1,
  amount_usd: 80,
  at: '2026-10-12T09:00:00Z',
  crosses_on: null,
  stopped: false,
}

describe('alertText', () => {
  it('threshold and stop', () => {
    expect(alertText(base)).toBe('Pricing Engine crossed 80% ($80.00)')
    expect(alertText({ ...base, percent: 100, stopped: true })).toBe(
      'Pricing Engine reached 100% ($80.00); calls stopped',
    )
  })

  it('a forecast keeps the date the server projected', () => {
    expect(alertText({ ...base, kind: 'forecast', percent: 100, crosses_on: '2026-10-17' })).toBe(
      'Pricing Engine will pass 100% around Oct 17 (projected on Oct 12)',
    )
  })

  it('an unknown kind is left out', () => {
    expect(alertText({ ...base, kind: 'something_new' })).toBeNull()
  })
})
