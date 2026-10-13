// Home's Budget burn panel (plans/feat-budget-burn.md F10, F12, D13; ledger #79) and Needs you's budget rows (F8):
// the panel takes the band's first row once the burn read answers and Spend keeps By agent; a server without budgets
// keeps today's band; Yours names both populations; links go to /budgets.
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { copy as budgetCopy } from '@/features/budgets/copy'
import { copy as overviewCopy } from '@/features/overview/copy'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() =>
  configureMocks({
    seed,
    now,
    loggedIn: true,
    budgetVariants: [],
    onboarding: { persona: null, completed: true },
  }),
)

const T = { timeout: 8000 }
const burnPanel = async (scope: string) =>
  (await screen.findByRole('heading', { name: budgetCopy.homeTitle(scope) }, T)).closest('section')!

describe('Home’s Budget burn', () => {
  it('Fleet: the panel leads the band; Spend keeps By agent (no Over time)', async () => {
    renderApp('/?scope=fleet')
    const p = await burnPanel(copy.budgetBurn.fleet)
    expect(
      within(p).getByRole('link', { name: budgetCopy.homeOpenLabel(copy.budgetBurn.fleet) }),
    ).toHaveAttribute('href', '/budgets?scope=fleet')
    const band = screen.getByRole('region', { name: copy.charts.label })
    expect(band.querySelector('section')).toBe(p)
    expect(within(band).queryByRole('radio', { name: copy.charts.overTime })).toBeNull()
  })

  it('a server without budgets keeps today’s band (D13)', async () => {
    configureMocks({ budgetVariants: ['budgets-absent'] })
    renderApp('/?scope=fleet')
    const band = await screen.findByRole('region', { name: copy.charts.label }, T)
    expect(
      await within(band).findByRole('radio', { name: copy.charts.overTime }, T),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: budgetCopy.homeTitle(copy.budgetBurn.fleet) }),
    ).toBeNull()
  })

  it('Yours names its populations: calls billed to you, your agents’ spend', async () => {
    renderApp('/?scope=yours')
    const p = await burnPanel(copy.budgetBurn.yours)
    await waitFor(() => expect(within(p).getByText(budgetCopy.homeBilled)).toBeInTheDocument())
    expect(within(p).getByText(budgetCopy.homeAgents)).toBeInTheDocument()
    expect(within(p).getByText(budgetCopy.homeAtRisk)).toBeInTheDocument()
  })

  it('Needs you: a budget past its projected limit says when, and opens /budgets', async () => {
    configureMocks({ now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] })
    renderApp('/?scope=fleet')
    const row = await screen.findByText(/budget exceeds its limit around Oct 17/, undefined, T)
    const item = row.closest('li')!
    expect(
      within(item).getByRole('link', { name: overviewCopy.needs.budgetsLabel('Pricing Engine') }),
    ).toHaveAttribute('href', '/budgets')
  })
})
