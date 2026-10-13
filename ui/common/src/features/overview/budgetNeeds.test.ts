// @vitest-environment node
// Needs you's budget rows (plans/feat-budget-burn.md F8) from the golden world's At risk (budgets.md §14.6): how much
// over and whether calls stop, when it reaches its limit ("runs out" only where calls stop), skipped when the agent row
// already says it.
import { describe, expect, it } from 'vitest'
import { atRisk, worldFromScenario } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { needsFromAtRisk } from './budgetNeeds'
import { copy } from './copy'
import { budgetView } from './needs'

const rows = () =>
  atRisk(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    { id: 'admin', superuser: true },
    { scope: 'org', id: null },
    Date.parse(GOLDEN_ANCHOR),
  ).data

describe('budget needs (F8)', () => {
  it('the golden fleet: a stopped reviewer, then three that reach their limit, in the server’s order', () => {
    const n = needsFromAtRisk(rows(), 'admin', () => false)
    expect(n.map((x) => x.label)).toEqual(['Code Reviewer', 'Pricing Engine', 'Dev', 'Platform'])
    expect(budgetView(n[0]!)).toEqual({
      title: copy.needs.budgetStopped('Code Reviewer'),
      detail: copy.needs.budgetStoppedUntil('Nov 1'),
    })
    // Alert only: "exceeds its limit", never "runs out" (design 1C).
    expect(budgetView(n[1]!).title).toBe(
      copy.needs.budgetRunsOut('Pricing Engine', 'Oct 17', false),
    )
    expect(budgetView(n[1]!).title).toMatch(/exceeds its limit around Oct 17/)
  })

  it('a stopped agent budget its agent row already shows is skipped; your own reads "Your monthly"', () => {
    const n = needsFromAtRisk(rows(), I.dev, (id) => id === I.reviewer)
    expect(n.map((x) => x.label)).toEqual(['Pricing Engine', copy.needs.yourBudget, 'Platform'])
  })

  it('an alert-only budget over its limit says by how much', () => {
    expect(
      budgetView({
        label: 'Dev',
        crossed: 100,
        state: 'exceeded',
        over: 12.5,
        stopped: false,
        stops: false,
        runsOutOn: null,
        resetsAt: '2026-11-01T00:00:00Z',
      }),
    ).toEqual({
      title: copy.needs.budget('Dev', 'exceeded', 100),
      detail: copy.needs.budgetOverBy('$12.50', null),
    })
  })
})
