// @vitest-environment node
// Regression: B2 — GET /api/budgets (no scope) listed a deleted budget: the B0 soft delete (#66) kept the row in the
// caller's own list, so the router's table kept a budget its owner had removed. Found while un-skipping the router's
// budget suites (plans/feat-budget-burn.md B2).
import { expect, it } from 'vitest'
import { budgetsList, deleteBudget, worldFromScenario } from './budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from './seed-budgets'

it('a deleted budget leaves the caller’s own list', () => {
  const w = worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' })
  const dev = { id: I.dev, superuser: false }
  const now = Date.parse(GOLDEN_ANCHOR)
  const ids = () => budgetsList(w, dev, { scope: null, id: null }, now).data.map((b) => b.id)
  expect(ids()).toContain(I.bPrice)
  deleteBudget(w, dev, I.bPrice, now)
  expect(ids()).not.toContain(I.bPrice)
})
