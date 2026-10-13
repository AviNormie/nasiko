// @vitest-environment node
// Needs you's budget rows (plans/feat-budget-burn.md F8) from the golden world's At risk (budgets.md §14.6): how much
// over and whether calls stop, when it reaches its limit ("runs out" only where calls stop), skipped when the agent row
// already says it.
import { describe, expect, it } from 'vitest'
import { atRisk, statusList, worldFromScenario, type Viewer } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { needFromOwnStatus, needsFromAtRisk } from './budgetNeeds'
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
        period: 'month',
        covers: 'routed_calls',
      }),
    ).toEqual({
      title: copy.needs.budget('Dev', 'exceeded', 100),
      detail: copy.needs.budgetOverBy('$12.50', null),
    })
  })
})

describe('B4 review regressions (#82)', () => {
  const NOW = Date.parse(GOLDEN_ANCHOR)
  const own = (v: Viewer, scope: string, id: string | null) =>
    statusList(
      worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
      v,
      { scope, id },
      NOW,
    ).data[0]!

  it('the viewer’s own budget comes from its status, since At risk never lists it (Codex P1)', () => {
    const row = own({ id: I.dev, superuser: false }, 'owner', I.dev)
    expect(row.budget_id).toBe(I.bDev)
    // At risk for Dev's own scope leaves Dev's budget out (§8.2); the status row brings it back.
    const mine = atRisk(
      worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
      { id: I.dev, superuser: false },
      { scope: 'owner', id: I.dev },
      NOW,
    ).data
    expect(mine.some((r) => r.budget_id === I.bDev)).toBe(false)
    const item = needFromOwnStatus(row, copy.needs.yourBudget)
    expect(item).toMatchObject({ id: I.bDev, label: copy.needs.yourBudget, period: 'month' })
    expect(item?.runsOutOn ?? item?.over).not.toBeNull()
  })

  it('an own budget that is on track needs nothing', () => {
    const row = own({ id: 'admin', superuser: true }, 'org', null)
    expect(row.state).toBe('ok')
    expect(needFromOwnStatus({ ...row, used_usd: 0, daily: [] }, copy.needs.fleetBudget)).toBeNull()
  })

  it('the detail names the budget’s period and what it covers', () => {
    const b = {
      label: 'Dev',
      crossed: 80,
      state: 'warning' as const,
      over: null,
      stopped: false,
      stops: false,
      runsOutOn: null,
      resetsAt: null,
      period: 'quarter' as const,
      covers: 'all_priced' as const,
    }
    expect(budgetView(b).detail).toBe('This quarter, all priced spend')
  })
})
