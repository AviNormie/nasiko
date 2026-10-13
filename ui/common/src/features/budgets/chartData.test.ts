// @vitest-environment node
// The burn chart's props and wording (plan feat-budget-burn F1, design 1C, 4B, 5C, 7B): "ran out" and the stop line
// only where calls stop, "exceeded" where they don't, "−$41 over" below zero, and flags list known events only.
import { describe, expect, it } from 'vitest'
import { burn as engineBurn, worldFromScenario } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { chartModel } from './burn'
import { burnAxisMoney, burnChartData, burnChartLabels, eventLabel } from './chartData'
import { copy } from './copy'
import type { BudgetEvent } from './types'

const read = (scope: string, id: string | null) =>
  engineBurn(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    { id: 'admin', superuser: true },
    { scope, id },
    Date.parse(GOLDEN_ANCHOR),
  )

describe('burn chart labels', () => {
  it('a stop budget that ran out says so; the same budget alerting only says it exceeded', () => {
    const m = chartModel(read('agent', I.reviewer), 'down')
    expect(burnChartLabels(m, { stops: true, summary: '' }).runOut).toBe(copy.burnRanOut('Oct 13'))
    expect(burnChartLabels(m, { stops: false, summary: '' }).runOut).toBe(
      copy.burnExceeded('Oct 13'),
    )
  })

  it('a projected run-out is an estimate (design 4B); over the limit reads "−$x over"', () => {
    const m = chartModel(read('agent', I.pricing), 'down')
    expect(burnChartLabels(m, { stops: false, summary: '' }).runOut).toBe(
      copy.burnEstimated('Oct 17'),
    )
    const over = { ...m, actual: [...m.actual.slice(0, -1), { t: m.actual.at(-1)!.t, v: -41 }] }
    expect(burnChartLabels(over, { stops: false, summary: '' }).over).toBe('−$41.00 over')
  })

  it('burn-up and unbudgeted reads say Spent; the axis writes −$50, never $-50', () => {
    expect(
      burnChartLabels(chartModel(read('owner', I.ana), 'up'), { stops: false, summary: 's' }),
    ).toMatchObject({
      actual: copy.burnSpent,
      runOut: null,
      over: null,
      summary: 's',
    })
    expect(burnAxisMoney(-50)).toBe('−$50')
    expect(burnAxisMoney(50)).toBe('$50')
  })
})

describe('event flags (design 7B)', () => {
  it('merge per day and list each event; a newer server’s unknown kind is left out', () => {
    const data = burnChartData(chartModel(read('agent', I.reviewer), 'up'))
    expect(data.markers.find((x) => x.day === '2026-10-10')!.labels).toEqual([
      copy.eventLimit('$40.00', '$50.00'),
      copy.eventResumed,
    ])
    const unknown = { kind: 'something_new', at: '2026-10-10T00:00:00Z' } as unknown as BudgetEvent
    expect(eventLabel(unknown)).toBeNull()
  })
})
