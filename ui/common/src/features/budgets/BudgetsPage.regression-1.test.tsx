// Regressions from the B2 /review (Claude adversarial + Codex, 2026-10-13), each reproduced first. One test per finding;
// pure ones are in causes.test.ts and burn.test.ts.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
const golden = () =>
  configureMocks({ now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] })
beforeEach(golden)
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [], superuser: null }))

const sentence = () =>
  screen.findByRole('heading', { level: 2, name: /^(On pace|No budget|No spend|Ran out|Over by)/ })
const nav = () => screen.getByRole('navigation')
const caps = (features: string[]) =>
  server.use(
    http.get('/api/budgets/capabilities', () =>
      HttpResponse.json({ data: { version: '1.0', features } }),
    ),
  )

describe('B2 review regressions', () => {
  it('an R-L10-only server draws Yours from the owner budget’s status, this period only (F11)', async () => {
    configureMocks({ budgetVariants: ['budgets-rl10-only'] })
    renderApp('/budgets?scope=yours')
    expect(await sentence()).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't load the burn chart/)).toBeNull()
    expect(screen.getByRole('heading', { name: copy.burnCard })).toBeInTheDocument()
    // Every 1.0 section says it needs a newer server, never an empty state.
    const atRisk = (await screen.findByRole('heading', { name: copy.atRiskTitle })).closest(
      'section',
    )!
    expect(await within(atRisk).findByText(copy.sectionMissing)).toBeInTheDocument()
  })

  it('a server without a feature says so in one line, never "Nothing exceeds its limit" (F11)', async () => {
    caps(['budgets', 'burn'])
    const { router } = renderApp('/budgets')
    await sentence()
    expect(
      screen.getByText(/Some budget views need a newer OpenRuntime server/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Nothing exceeds its limit/)).toBeNull()
    await router.navigate({ to: '/budgets', search: (x) => ({ ...x, day: '2026-10-09' }) })
    const sheet = await screen.findByRole('dialog')
    // Hours and traces would pend forever on a disabled query.
    expect(within(sheet).getAllByText(copy.dayMissing).length).toBe(3)
  })

  it('a coded 404 from the R-L10 probe is a server with budgets, not one without', async () => {
    server.use(
      http.get('/api/budgets/capabilities', () => new HttpResponse(null, { status: 404 })),
      http.get('/api/budgets', () =>
        HttpResponse.json({ error: 'not visible', code: 'scope_not_found' }, { status: 404 }),
      ),
    )
    renderApp('/tokenops')
    await waitFor(() =>
      expect(within(nav()).getByRole('link', { name: copy.pageTitle })).toBeInTheDocument(),
    )
  })

  it('Quarter view of a month budget: month figures in month words, the quarter end from the same read', async () => {
    renderApp(`/budgets?scope=owner:${I.dev}&period=quarter`)
    await sentence()
    const strip = screen.getByRole('region', { name: copy.stripLabel })
    expect(within(strip).getByText(copy.stripToDate('month'))).toBeInTheDocument()
    const q = within(strip).getByText(copy.stripQuarter).closest('[data-slot="card"]')!
    expect(q).toHaveTextContent('$771.43 to $833.54')
  })

  it('what-if doesn’t follow you to another scope', async () => {
    renderApp(`/budgets?scope=owner:${I.dev}`)
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    await userEvent.type(screen.getByLabelText(copy.whatIfLimit), '250')
    expect(await screen.findByText(copy.burnPreview)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: copy.scopeFleet }))
    await waitFor(() => expect(screen.queryByText(copy.burnPreview)).toBeNull())
    expect(screen.queryByLabelText(copy.whatIfLimit)).toBeNull()
  })

  it('a contributor brought back by the URL wins over an open what-if (one preview at a time)', async () => {
    const { router } = renderApp(`/budgets?scope=owner:${I.dev}&burn=up`)
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    await userEvent.type(screen.getByLabelText(copy.whatIfLimit), '250')
    expect(await screen.findByText(copy.burnPreview)).toBeInTheDocument()
    await router.navigate({ to: '/budgets', search: (s) => ({ ...s, contributor: I.pricing }) })
    expect(await screen.findByText(copy.shareLine('Pricing Engine'))).toBeInTheDocument()
    expect(screen.queryByText(copy.burnPreview)).toBeNull()
  })

  it('a limit already passed is not "within the limit"', async () => {
    renderApp(`/budgets?scope=owner:${I.dev}`)
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    await userEvent.type(screen.getByLabelText(copy.whatIfLimit), '100')
    expect(await screen.findByText(copy.whatIfAlreadyOver(false))).toBeInTheDocument()
    expect(screen.queryByText(copy.whatIfWithin)).toBeNull()
  })

  it('the pace slider has a name; the share chip sits outside the card’s heading', async () => {
    renderApp(`/budgets?scope=owner:${I.dev}&contributor=${I.pricing}`)
    await sentence()
    expect(screen.getByRole('heading', { name: copy.burnCard })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    expect(screen.getByRole('slider', { name: copy.whatIfPace })).toHaveAttribute(
      'aria-valuetext',
      copy.whatIfPaceValue(0),
    )
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    expect(result.violations.map((v) => v.id)).toEqual([])
  })

  it('At risk keeps page 1 when page 2 fails, and says so', async () => {
    let calls = 0
    server.use(
      http.get('/api/budgets/at-risk', async ({ request }) => {
        calls++
        if (new URL(request.url).searchParams.get('cursor'))
          return HttpResponse.json({ error: 'internal', code: 'internal' }, { status: 500 })
        return HttpResponse.json({
          data: [
            {
              budget_id: I.bPrice,
              scope: 'agent',
              target_id: I.pricing,
              label: 'Pricing Engine',
              owner_id: I.dev,
              owner_label: 'Dev',
              covers: 'routed_calls',
              action: 'alert',
              period: 'month',
              period_start: '2026-10-01T00:00:00Z',
              resets_at: '2026-11-01T00:00:00Z',
              as_of: GOLDEN_ANCHOR,
              limit_usd: 100,
              used_usd: 81,
              unpriced_calls: 0,
              state: 'warning',
              crossed: 80,
              stopped: false,
              daily14: [],
              rank: {
                reason: 'runs_out',
                runs_out_on: '2026-10-17',
                pace_usd_per_day: 6,
                projected_pct: 186,
              },
            },
          ],
          has_more: true,
          next_cursor: 'c2',
          prev_cursor: null,
        })
      }),
    )
    renderApp('/budgets')
    const table = await screen.findByRole('table', { name: copy.atRiskTitle })
    expect(within(table).getByText('Pricing Engine')).toBeInTheDocument()
    expect(screen.getByText(copy.listPartial)).toBeInTheDocument()
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('closing a day opened on the page goes back, so Back doesn’t reopen it', async () => {
    const { router } = renderApp('/budgets')
    await sentence()
    await userEvent.click(screen.getByRole('button', { name: copy.showTable }))
    await userEvent.click(screen.getByRole('button', { name: 'Oct 9' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('day'))
    router.history.forward()
    await waitFor(() => expect(router.state.location.search).toHaveProperty('day'))
  })

  it('the router’s Budgets tab lists owner and agent budgets only, never a session’s', async () => {
    const base = {
      agent_id: null,
      unit_id: null,
      owner_id: 'u-admin',
      set_by: 'u-admin',
      limit_usd: 10,
      thresholds: [50, 80, 100],
      action: 'alert',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    }
    server.use(
      http.get('/api/budgets', () =>
        HttpResponse.json({
          data: [
            { ...base, id: 'b-own', scope: 'owner', session_id: null, period: 'month' },
            { ...base, id: 'b-sess', scope: 'session', session_id: 's1', period: 'session' },
          ],
          has_more: false,
          next_cursor: null,
          prev_cursor: null,
        }),
      ),
    )
    renderApp('/router?tab=budgets')
    const table = await screen.findByRole('table', { name: copy.budgetsTitle })
    expect(table.querySelectorAll('[data-budget]')).toHaveLength(1)
    expect(table).not.toHaveTextContent('(not listed)')
    expect(table).not.toHaveTextContent('Jan 1')
  })
})
