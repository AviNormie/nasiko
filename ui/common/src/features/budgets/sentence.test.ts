// @vitest-environment node
// The /budgets sentence (plan feat-budget-burn F12) on the golden world (budgets.md §14): stops vs alert-only wording
// (design 1C), floors with unpriced calls (F2), and the no-budget and too-early cases.
import { describe, expect, it } from 'vitest'
import { burn as engineBurn, worldFromScenario } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { burnSentence } from './sentence'

const read = (scope: string, id: string | null, now = Date.parse(GOLDEN_ANCHOR)) =>
  engineBurn(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    { id: 'admin', superuser: true },
    { scope, id },
    now,
  )

describe('burnSentence', () => {
  it('projected past the limit: the percent at the reset and the allowance', () => {
    expect(burnSentence(read('agent', I.pricing), 'month')).toBe(
      'On pace to use 186% by Oct 31. To stay within budget: $1.06 a day for the next 18 days.',
    )
  })

  it('a stop budget that ran out says calls are stopped until the reset', () => {
    expect(burnSentence(read('agent', I.reviewer), 'month')).toBe(
      'Ran out Oct 13; calls are stopped until Nov 1.',
    )
  })

  it('the fleet has unpriced calls: a floor and a ceiling', () => {
    expect(burnSentence(read('org', null), 'month')).toBe(
      'On pace to use at least 74% by Oct 31. To stay within budget: at most $19.17 a day for the next 18 days.',
    )
  })

  it('no budget: what was spent, then the pace (Ana has unpriced calls: floors)', () => {
    expect(burnSentence(read('owner', I.ana), 'month')).toBe(
      'No budget: at least $34.00 spent this month so far. On pace for at least $101.50 by Oct 31.',
    )
  })

  it('too early for a projection says so', () => {
    expect(burnSentence(read('agent', I.pricing, Date.UTC(2026, 9, 2, 12)), 'month')).toMatch(
      /used\. A projection needs 3 days of spend\.$/,
    )
  })
})
