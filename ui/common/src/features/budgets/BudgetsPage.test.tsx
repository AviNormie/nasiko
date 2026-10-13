// /budgets (plan feat-budget-burn B2: F1, F2, F10, F11, F12) on the golden scenario (budgets.md §14): the nav item
// follows the server's budgets, the sentence and strip follow the scope, a member reads Yours only, the burn mode is
// remembered, and a picked day is pushed to the URL.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { copy } from './copy'

setupPinnedSeed()
const golden = { now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] as const }
beforeEach(() => configureMocks({ ...golden, budgetVariants: [...golden.budgetVariants] }))
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [], superuser: null }))

const sentence = () =>
  screen.findByRole('heading', { level: 2, name: /^(On pace|No budget|No spend|Ran out|Over by)/ })
const nav = () => screen.getByRole('navigation')

describe('/budgets', () => {
  it('Fleet for a superuser: the alert-only coverage line, the sentence with floors, six figures', async () => {
    renderApp('/budgets')
    expect(await sentence()).toHaveTextContent(
      'On pace to use at least 74% by Oct 31. To stay within budget: at most $19.17 a day for the next 18 days.',
    )
    expect(screen.getByText(copy.coverageAll)).toBeInTheDocument()
    const strip = screen.getByRole('region', { name: copy.stripLabel })
    for (const label of [copy.stripToday, copy.stripWeek, copy.stripQuarter, copy.stripAllowance])
      expect(within(strip).getByText(label)).toBeInTheDocument()
    await waitFor(() =>
      expect(within(nav()).getByRole('link', { name: copy.pageTitle })).toBeInTheDocument(),
    )
  })

  it('Yours reads the viewer’s own scope', async () => {
    const { router } = renderApp('/budgets')
    await sentence()
    await userEvent.click(screen.getByRole('radio', { name: copy.scopeYours }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ scope: 'yours' }))
    // The seed admin spent nothing in the golden world.
    expect(await sentence()).toHaveTextContent(copy.sentenceNoSpend('month'))
  })

  it('an owner link reads that owner’s budget', async () => {
    renderApp(`/budgets?scope=owner:${I.dev}`)
    // Dev: $121 of an alert-only $150 owner budget (budgets.md §14.4).
    expect(await screen.findByText(copy.coverageRouted(false))).toBeInTheDocument()
  })

  it('a member sees no scope switch, and a Fleet link opens on their own budget', async () => {
    configureMocks({ ...golden, budgetVariants: [...golden.budgetVariants], superuser: false })
    renderApp('/budgets?scope=fleet')
    await sentence()
    expect(screen.queryByRole('radio', { name: copy.scopeFleet })).toBeNull()
    expect(screen.queryByText(copy.coverageAll)).toBeNull()
  })

  it('Burn-up is remembered and replaces the URL; a picked date is pushed', async () => {
    const { router } = renderApp('/budgets')
    await sentence()
    await userEvent.click(screen.getByRole('radio', { name: copy.burnUp }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ burn: 'up' }))
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')
    expect(keys.some((k) => k.endsWith(':budgets:burn') && localStorage.getItem(k) === 'up')).toBe(
      true,
    )
    await userEvent.click(screen.getByRole('button', { name: copy.showTable }))
    await userEvent.click(screen.getByRole('button', { name: 'Oct 9' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ day: '2026-10-09' }))
  })

  it('a server without budgets: no nav item, and the page says so', async () => {
    configureMocks({ budgetVariants: ['budgets-absent'] })
    renderApp('/budgets')
    expect(await screen.findByText(copy.pageMissing)).toBeInTheDocument()
    expect(within(nav()).queryByRole('link', { name: copy.pageTitle })).toBeNull()
  })

  it('a failed probe is an error with Retry, never "no budgets"', async () => {
    configureMocks({ budgetVariants: ['budgets-fail'] })
    renderApp('/budgets')
    expect(await screen.findByText(/Couldn't load budgets/)).toBeInTheDocument()
    expect(screen.queryByText(copy.pageMissing)).toBeNull()
  })
})
