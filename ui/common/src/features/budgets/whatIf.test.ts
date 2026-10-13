// @vitest-environment node
// What-if's inputs (plan feat-budget-burn F6): a preview only when open, valid and different from the budget.
import { describe, expect, it } from 'vitest'
import { burn as engineBurn, worldFromScenario } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { WHAT_IF_CLOSED, whatIfInputs } from './whatIf'

const price = () =>
  engineBurn(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    { id: 'admin', superuser: true },
    { scope: 'agent', id: I.pricing },
    Date.parse(GOLDEN_ANCHOR),
  )

describe('whatIfInputs', () => {
  it('closed, or open with nothing changed, previews nothing', () => {
    expect(whatIfInputs(price(), WHAT_IF_CLOSED)).toBeNull()
    expect(whatIfInputs(price(), { open: true, limit: '', pace: 0 })).toBeNull()
  })

  it('a new limit or pace previews; the limit is read as dollars', () => {
    expect(whatIfInputs(price(), { open: true, limit: '$250', pace: 0 })).toEqual({
      limit: 250,
      paceChange: 0,
    })
    expect(whatIfInputs(price(), { open: true, limit: '', pace: -20 })).toEqual({
      limit: null,
      paceChange: -0.2,
    })
  })

  it('an invalid limit previews nothing', () => {
    expect(whatIfInputs(price(), { open: true, limit: '0', pace: 0 })).toBeNull()
    expect(whatIfInputs(price(), { open: true, limit: 'abc', pace: 0 })).toBeNull()
  })
})
