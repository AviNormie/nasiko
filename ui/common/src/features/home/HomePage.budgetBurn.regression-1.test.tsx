// B4 review regressions (plans/feat-budget-burn.md ledger #82): Needs you lists the viewer's own budget (At risk never
// lists the scope's own), the panel's At risk failure has a Retry, the band holds the panel's row while the burn
// loads instead of flashing Spend · Over time, and a failed budgets probe leaves ratings incomplete, not healthy.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import BudgetBurnPanel from '@/features/budgets/components/BudgetBurnPanel'
import { copy as budgetCopy } from '@/features/budgets/copy'
import { copy as overviewCopy } from '@/features/overview/copy'
import { createQueryClient } from '@/lib/queryClient'
import { burn as engineBurn, worldFromScenario } from '@/mocks/budgetEngine'
import { configureMocks } from '@/mocks/handlers'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequests, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() =>
  configureMocks({
    seed,
    now,
    loggedIn: true,
    superuser: null,
    budgetVariants: [],
    onboarding: { persona: null, completed: true },
  }),
)

const T = { timeout: 8000 }
const needs = () => screen.getByTestId('overview-needs')
const burnPanel = async (scope: string) =>
  (await screen.findByRole('heading', { name: budgetCopy.homeTitle(scope) }, T)).closest('section')!

describe('B4 review regressions', () => {
  it('a member’s own budget is in Needs you: At risk leaves it out, its status brings it back (Codex P1)', async () => {
    configureMocks({ superuser: false })
    renderApp('/?scope=yours')
    await waitFor(
      () =>
        expect(
          within(needs()).getByText(new RegExp(`^${overviewCopy.needs.yourBudget}`)),
        ).toBeInTheDocument(),
      T,
    )
  })

  it('the panel’s At risk failure says so with a Retry that reads it again (Codex 7)', async () => {
    let calls = 0
    let fail = true
    server.use(
      http.get('*/api/budgets/at-risk', () => {
        calls++
        return fail
          ? HttpResponse.json({ error: 'boom', code: 'internal' }, { status: 400 })
          : undefined
      }),
    )
    renderApp('/?scope=fleet')
    const p = await burnPanel(copy.budgetBurn.fleet)
    const retry = await within(p).findByRole('button', { name: /retry/i }, T)
    expect(within(p).getByText(`Couldn't load ${budgetCopy.atRiskFailed}`)).toBeInTheDocument()
    fail = false
    const before = calls
    await userEvent.click(retry)
    await waitFor(() => expect(calls).toBeGreaterThan(before))
    await waitFor(() => expect(within(p).queryByRole('button', { name: /retry/i })).toBeNull(), T)
  })

  it('while the burn loads, the band holds its row and Over time waits (Claude 2)', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    server.use(
      http.get('*/api/budgets/burn', async () => {
        await held
        return undefined
      }),
    )
    renderApp('/?scope=fleet')
    const band = await screen.findByRole('region', { name: copy.charts.label }, T)
    await waitFor(() => expect(band.querySelector('#home-spend-title')).not.toBeNull(), T)
    expect(within(band).queryByRole('radio', { name: copy.charts.overTime })).toBeNull()
    release()
    await burnPanel(copy.budgetBurn.fleet)
    expect(within(band).queryByRole('radio', { name: copy.charts.overTime })).toBeNull()
  })

  it('a failed budgets probe leaves ratings incomplete, never healthy (Claude 1)', async () => {
    server.use(
      http.get('*/api/budgets/capabilities', async () => {
        await delay(10)
        return HttpResponse.json({ error: 'boom', code: 'internal' }, { status: 400 })
      }),
    )
    renderApp('/?scope=fleet')
    await screen.findByRole('table', { name: copy.table.label }, T)
    await waitFor(
      () =>
        expect(
          within(needs()).getByText(overviewCopy.couldntCheck(overviewCopy.needs.source.agents)),
        ).toBeInTheDocument(),
      T,
    )
  })

  it('coming back to the page reads the burn and At risk again (Codex 2)', async () => {
    renderApp('/?scope=fleet')
    await burnPanel(copy.budgetBurn.fleet)
    const rec = recordRequests()
    try {
      const real = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(real + 10 * 60_000)
      window.dispatchEvent(new Event('focus'))
      await waitFor(() => {
        const paths = rec.urls.map((u) => u.pathname)
        expect(paths).toContain('/api/budgets/burn')
        expect(paths).toContain('/api/budgets/at-risk')
      }, T)
    } finally {
      rec.stop()
      vi.restoreAllMocks()
    }
  })

  it('a coded 404 from the budgets list is an answer, not "no budgets here" (Codex 6)', async () => {
    server.use(
      http.get('*/api/budgets', () =>
        HttpResponse.json({ error: 'nope', code: 'not_found' }, { status: 404 }),
      ),
    )
    renderApp('/?scope=yours')
    expect(await screen.findByText(copy.budget.failed, undefined, T)).toBeInTheDocument()
    expect(screen.queryByText(copy.budget.off)).toBeNull()
  })

  it('a unit’s panel has no Open budgets link: /budgets has no unit scope until B6 (Codex 5)', () => {
    const w = worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' })
    const ref = { scope: 'unit' as const, id: I.platform }
    render(
      <QueryClientProvider client={createQueryClient(() => undefined)}>
        <BudgetBurnPanel
          burn={engineBurn(w, { id: 'admin', superuser: true }, ref, Date.parse(GOLDEN_ANCHOR))}
          scopeRef={ref}
          scopeName="Platform"
          scopeParam={undefined}
          yours={false}
          viewerId="admin"
          atRisk={false}
        />
      </QueryClientProvider>,
    )
    expect(
      screen.getByRole('heading', { name: budgetCopy.homeTitle('Platform') }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
