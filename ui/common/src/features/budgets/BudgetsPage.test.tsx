// /budgets (plan feat-budget-burn B2: F1, F2, F10, F11, F12) on the golden scenario (budgets.md §14): the nav item
// follows the server's budgets, the sentence and strip follow the scope, a member reads Yours only, the burn mode is
// remembered, and a picked day is pushed to the URL.
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequestBodies, server } from '@/test/setup'
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

  it('the bars stack by agent; a contributor opens its share view, and Clear closes it', async () => {
    const { router } = renderApp('/budgets?burn=up')
    await sentence()
    const list = await screen.findByRole('list', { name: copy.contributorsTitle })
    await userEvent.click(
      within(list).getByRole('button', { name: copy.contributorsPick('Code Reviewer') }),
    )
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ contributor: I.reviewer }),
    )
    expect(await screen.findByText(copy.shareSpend('Code Reviewer'))).toBeInTheDocument()
    expect(screen.getByText(copy.shareLine('Code Reviewer'))).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: copy.shareClearLabel('Code Reviewer') }),
    )
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('contributor'))
    expect(screen.getByRole('region', { name: copy.stripLabel })).toHaveTextContent(copy.stripToday)
  })

  it('switching the dimension replaces the URL and re-reads the bars', async () => {
    const { router } = renderApp('/budgets')
    await sentence()
    await userEvent.click(await screen.findByRole('radio', { name: copy.dimension.owner }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ by: 'owner' }))
    const list = await screen.findByRole('list', { name: copy.contributorsTitle })
    expect(
      await within(list).findByRole('button', { name: copy.contributorsPick('Dev') }),
    ).toBeInTheDocument()
  })

  it('What changed ranks this week against last and lists spike days, each opening its day', async () => {
    const { router } = renderApp('/budgets')
    await sentence()
    const panel = (await screen.findByRole('heading', { name: copy.changesTitle })).closest(
      'section',
    )!
    // Claude Code had no spend the same hours last week (budgets.md §14.2): a new contributor.
    expect(await within(panel).findByText('Claude Code')).toBeInTheDocument()
    expect(within(panel).getAllByText(`(${copy.changesNew})`).length).toBeGreaterThan(0)
    const spikes = within(panel).getByRole('list', { name: copy.changesSpikeLabel })
    await userEvent.click(within(spikes).getAllByRole('button')[0]!)
    await waitFor(() => expect(router.state.location.search).toHaveProperty('day'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('a picked day opens its drill-down; another user’s session is a redacted row', async () => {
    server.use(
      http.get('/api/budgets/burn/traces', () =>
        HttpResponse.json({
          data: [
            {
              row_id: 'r1',
              as_of: GOLDEN_ANCHOR,
              covers: 'all_priced',
              redacted: true,
              trace_id: null,
              session_id: null,
              agent_id: null,
              agent_label: null,
              user_id: null,
              user_label: null,
              cost_usd: 4,
              calls: 2,
              unpriced_calls: 0,
              started_at: '2026-10-09T15:20:00Z',
            },
          ],
          has_more: false,
          next_cursor: null,
          prev_cursor: null,
        }),
      ),
    )
    renderApp('/budgets?day=2026-10-09')
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByRole('heading', { name: copy.dayContributors })).toBeInTheDocument()
    expect(within(sheet).getByRole('heading', { name: copy.dayHours })).toBeInTheDocument()
    expect(await within(sheet).findByText(copy.dayAnother)).toBeInTheDocument()
    expect(within(sheet).queryByRole('link')).toBeNull()
    expect(within(sheet).getByText('$4.00')).toBeInTheDocument()
  })

  it('At risk follows the server’s order (budgets.md §14.6); “ran out” only where calls stopped', async () => {
    renderApp('/budgets')
    const table = await screen.findByRole('table', { name: copy.atRiskTitle })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      `Code Reviewer${copy.atRiskStops}`,
      `Pricing Engine${copy.atRiskAlerts}`,
      `Dev${copy.atRiskAlerts}`,
      `Platform${copy.atRiskAlerts}`,
    ])
    expect(rows[0]).toHaveTextContent(copy.atRiskRanOut)
    // Stopped: nothing more is spent until the reset, so no projection (#68), whatever the server ranked it by.
    expect(within(rows[0]!).getAllByRole('cell')[3]).toHaveTextContent('—')
    expect(rows[1]).toHaveTextContent('186%')
    expect(rows[1]).toHaveTextContent('Oct 17')
    expect(rows[3]).toHaveTextContent('Oct 22')
  })

  it('Unbudgeted names agents with spend and no budget; a harness without routed calls says why', async () => {
    renderApp('/budgets')
    const table = await screen.findByRole('table', { name: copy.unbudgetedTitle })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Support Bot')
    expect(rows[0]).toHaveTextContent('≥ $14.00')
    expect(rows[1]).toHaveTextContent('Claude Code')
    expect(rows[1]).toHaveTextContent(copy.unbudgetedHarness)
  })

  it('the alerts list moved here: thresholds, stops and forecasts for every budget in scope', async () => {
    renderApp('/budgets')
    const list = await screen.findByRole('list', { name: copy.alertsTitleV1 })
    // It ran out twice: on Oct 9, then again on Oct 13 after its limit was raised.
    expect(within(list).getAllByText(/Code Reviewer reached 100% .*calls stopped/)).toHaveLength(2)
    expect(within(list).getAllByText(/will pass 100% around/).length).toBeGreaterThan(0)
  })

  it('what-if previews a limit, announces it, and clears a picked contributor (one preview at a time)', async () => {
    const { router } = renderApp(`/budgets?scope=owner:${I.dev}&contributor=${I.pricing}`)
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    await userEvent.type(screen.getByLabelText(copy.whatIfLimit), '250')
    expect(await screen.findByText(/^Projected spend \$[\d.,]+ by Oct 31$/)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('budgets-announcer')).toHaveTextContent(/^Preview, not applied/),
    )
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('contributor'))
    expect(screen.getByText(copy.burnPreview)).toBeInTheDocument()
  })

  it('Edit budget on Fleet: alert only, and Save sends a guarded full replace', async () => {
    const rec = recordRequestBodies()
    renderApp('/budgets')
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: copy.editBudget }))
    const sheet = await screen.findByRole('dialog', { name: copy.budgetEdit(copy.budgetFleet) })
    expect(within(sheet).getByText(copy.budgetDescriptionFleet)).toBeInTheDocument()
    expect(within(sheet).queryByRole('radio', { name: new RegExp(copy.actionStop) })).toBeNull()
    expect(within(sheet).getByText(copy.budgetFleetAlertOnly)).toBeInTheDocument()
    const limit = within(sheet).getByLabelText(copy.monthlyLimit)
    await userEvent.clear(limit)
    await userEvent.type(limit, '600')
    await userEvent.click(within(sheet).getByRole('button', { name: copy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    const put = rec.requests.find((r) => r.method === 'PUT')!
    expect(put.url.pathname).toBe(`/api/budgets/${I.bOrg}`)
    expect(put.body).toMatchObject({
      limit_usd: 600,
      action: 'alert',
      expected_updated_at: expect.any(String),
    })
    expect(screen.getByTestId('budgets-announcer')).toHaveTextContent(
      copy.budgetSaved(copy.budgetFleet),
    )
    rec.stop()
  })

  it('Adjust limit on an At risk row edits that budget, in place', async () => {
    renderApp('/budgets')
    await screen.findByRole('table', { name: copy.atRiskTitle })
    await userEvent.click(
      screen.getByRole('button', { name: copy.adjustLimitFor('Pricing Engine') }),
    )
    const sheet = await screen.findByRole('dialog', { name: copy.budgetEdit('Pricing Engine') })
    expect(within(sheet).getByLabelText(copy.monthlyLimit)).toHaveValue('100.00')
  })

  it('Set a budget on an unbudgeted agent creates an agent budget for it', async () => {
    const rec = recordRequestBodies()
    renderApp('/budgets')
    await screen.findByRole('table', { name: copy.unbudgetedTitle })
    await userEvent.click(screen.getByRole('button', { name: copy.setBudgetFor('Support Bot') }))
    const sheet = await screen.findByRole('dialog', { name: copy.budgetNew })
    expect(sheet).toHaveTextContent(`${copy.budgetFor}: Support Bot`)
    await userEvent.type(within(sheet).getByLabelText(copy.monthlyLimit), '40')
    await userEvent.click(within(sheet).getByRole('button', { name: copy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      scope: 'agent',
      agent_id: I.support,
      limit_usd: 40,
    })
    rec.stop()
  })

  it('a superuser sets another owner’s budget with user_id; the stop consequence names them', async () => {
    const rec = recordRequestBodies()
    renderApp(`/budgets?scope=owner:${I.ana}`)
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: copy.setBudget }))
    const sheet = await screen.findByRole('dialog', { name: copy.budgetNew })
    await userEvent.type(within(sheet).getByLabelText(copy.monthlyLimit), '80')
    await userEvent.click(within(sheet).getByRole('radio', { name: new RegExp(copy.actionStop) }))
    expect(within(sheet).getByTestId('stop-consequence')).toHaveTextContent(/billed to Ana/)
    await userEvent.click(within(sheet).getByRole('button', { name: copy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      scope: 'owner',
      user_id: I.ana,
      action: 'stop',
    })
    rec.stop()
  })

  it('What if… Use this limit opens the editor with that limit', async () => {
    renderApp(`/budgets?scope=owner:${I.dev}`)
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    await userEvent.type(screen.getByLabelText(copy.whatIfLimit), '250')
    await userEvent.click(await screen.findByRole('button', { name: copy.useThisLimit }))
    const sheet = await screen.findByRole('dialog', { name: copy.budgetEdit('Dev') })
    expect(within(sheet).getByLabelText(copy.monthlyLimit)).toHaveValue('250.00')
  })

  it('a member has no edit buttons on rows they don’t own', async () => {
    configureMocks({ ...golden, budgetVariants: [...golden.budgetVariants], superuser: false })
    renderApp('/budgets')
    await sentence()
    expect(screen.queryByRole('button', { name: /^Adjust limit/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Set a budget:/ })).toBeNull()
  })

  const axeClean = async () => {
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    expect(
      result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([])
  }

  it('has no axe violations', async () => {
    renderApp('/budgets')
    await sentence()
    await screen.findByRole('list', { name: copy.contributorsTitle })
    await axeClean()
  })

  it('has no axe violations with the day panel open', async () => {
    renderApp('/budgets?day=2026-10-09')
    await screen.findByRole('dialog')
    await axeClean()
  })
})
