/**
 * The home's PR2b columns and layouts (plans/feat-agent-centric.md PR2, X5; design "Home", "Responsive"; eng "Home
 * execution table", "Member money"): budget use as a labelled preview polled by one read, sparklines for superusers
 * only, last change from build records read only for rows on screen through a limiter of 4, Fleet's owner groups,
 * and two-line rows on a phone.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/client'
import { budgetPollEnds } from '@/features/router/api'
import { configureMocks } from '@/mocks/handlers'
import { installIntersectionObserver } from '@/test/intersection'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequests, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() => {
  vi.unstubAllGlobals()
  configureMocks({
    seed,
    now,
    loggedIn: true,
    variant: null,
    persona: null,
    superuser: null,
    chatVariants: [],
    routerVariants: [],
    onboarding: { persona: null, completed: true },
  })
})

const table = () => screen.findByRole('table', { name: copy.table.label })
const strip = () => screen.findByRole('region', { name: copy.strip.label })
const tile = async (label: string) =>
  within(await strip())
    .queryByText(label)
    ?.closest<HTMLElement>('[data-slot="card"]') ?? null

/** Three agents owned by someone the viewer can't name, so Fleet has one small group. */
async function othersOnly() {
  const page = (await (await fetch('/api/agents?limit=100&offset=0')).json()) as Record<
    string,
    unknown
  >[]
  const others = page.slice(0, 3).map((a) => ({ ...a, owner_id: 'someone-else' }))
  server.use(
    http.get('/api/agents', ({ request }) =>
      HttpResponse.json(Number(new URL(request.url).searchParams.get('offset') ?? 0) ? [] : others),
    ),
  )
}

describe('budget use (a preview)', () => {
  it('shows each budgeted agent’s use with the preview badge and its freshness stamp', async () => {
    renderApp('/?scope=yours')
    const t = await table()
    const header = await within(t).findByRole('columnheader', { name: /Budget use/ })
    expect(within(header).getByText(copy.budget.preview)).toBeInTheDocument()
    await waitFor(() => expect(header).toHaveTextContent(/updated/))
    // "$412.10 of $500.00 · Oct": used, limit and the period's month.
    await waitFor(() =>
      expect(
        within(t).getAllByText(/^(≥ )?\$[\d,.]+ of \$[\d,.]+ · [A-Z][a-z]{2}$/).length,
      ).toBeGreaterThan(0),
    )
    // The seed's busiest agent is over its limit; the wording never says the budget stopped anything.
    expect(within(t).getAllByText(copy.budget.reached).length).toBeGreaterThan(0)
    expect(t).not.toHaveTextContent(/stopp|blocked|controls/i)
  })

  it('Yours shows the viewer’s own budget in the strip; Fleet never sums budgets into one', async () => {
    renderApp('/?scope=yours')
    await table()
    await waitFor(async () => expect(await tile(copy.budget.own)).not.toBeNull())
    expect(await tile(copy.budget.own)).toHaveTextContent(/%/)
    await userEvent.click(screen.getByRole('radio', { name: copy.scope.fleet }))
    await table()
    expect(await tile(copy.budget.own)).toBeNull()
  })

  it('a server without budgets (bare 404) hides the column and says so once', async () => {
    configureMocks({ variant: 'home-budgets-absent' })
    renderApp('/?scope=yours')
    const t = await table()
    expect(await screen.findByText(copy.budget.off)).toBeInTheDocument()
    expect(within(t).queryByRole('columnheader', { name: /Budget use/ })).toBeNull()
  })

  it('the poll stops on a bare 404 or a 401, and keeps going on a server error', () => {
    expect(budgetPollEnds(new ApiError(404, null, '/api/budgets/status', 'x'))).toBe(true)
    expect(budgetPollEnds(new ApiError(401, null, '/api/budgets/status', 'x'))).toBe(true)
    expect(budgetPollEnds(new ApiError(500, null, '/api/budgets/status', 'x'))).toBe(false)
    expect(budgetPollEnds(null)).toBe(false)
  })
})

describe('sparklines', () => {
  it('a superuser’s rows draw their spend series', async () => {
    renderApp('/?scope=yours')
    const t = await table()
    await waitFor(() =>
      expect(within(t).getAllByTestId('home-sparkline').length).toBeGreaterThan(0),
    )
  })

  it('a member gets the total alone and never reads a per-agent series', async () => {
    configureMocks({ superuser: false })
    const rec = recordRequests()
    renderApp('/?scope=yours')
    const t = await table()
    await waitFor(() => expect(within(t).getAllByText(/^\$/).length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 200))
    rec.stop()
    expect(within(t).queryByTestId('home-sparkline')).toBeNull()
    expect(
      rec.urls.filter(
        (u) => u.pathname.endsWith('/finops/spend-timeseries') && u.searchParams.get('agent_id'),
      ),
    ).toEqual([])
  })
})

describe('reads per row', () => {
  it('read only for rows on screen, at most four at a time', async () => {
    const io = installIntersectionObserver()
    let inFlight = 0
    let peak = 0
    let reads = 0
    server.use(
      http.get('/api/builds/agent/:id', async () => {
        reads++
        peak = Math.max(peak, ++inFlight)
        await delay(30)
        inFlight--
        return HttpResponse.json([])
      }),
    )
    try {
      renderApp('/?scope=yours')
      const t = await table()
      await new Promise((r) => setTimeout(r, 100))
      expect(reads).toBe(0)
      io.showAll()
      await waitFor(() => expect(reads).toBeGreaterThan(4))
      await waitFor(() => expect(inFlight).toBe(0))
      expect(peak).toBeLessThanOrEqual(4)
      expect(within(t).getAllByText(copy.lastChange.none, { exact: false }).length).toBeGreaterThan(
        0,
      )
    } finally {
      io.restore()
    }
  })

  it('last change names the newest build record and links to it on the hub', async () => {
    renderApp('/?scope=yours')
    const t = await table()
    const link = await within(t).findAllByRole('link', { name: /Build (completed|failed)/ })
    expect(link[0]!.getAttribute('href')).toMatch(/^\/agents\/[^?]+(\?.*marker=build)?/)
  })

  it('a coding harness says it records no builds, and reads none', async () => {
    const rec = recordRequests()
    renderApp('/?scope=yours')
    const t = await table()
    const harnessRow = await waitFor(() =>
      within(t)
        .getAllByRole('row')
        .find((r) => within(r).queryByText(copy.table.harness))!,
    )
    expect(within(harnessRow).getByText(copy.lastChange.harness)).toBeInTheDocument()
    rec.stop()
    const id = within(harnessRow).getAllByRole('link')[0]!.getAttribute('href')!.split('/').at(-1)
    expect(rec.urls.filter((u) => u.pathname === `/api/builds/agent/${id}`)).toEqual([])
  })
})

describe('owner groups (Fleet)', () => {
  it('groups rows by owner, and a group collapses', async () => {
    await othersOnly()
    renderApp('/?scope=fleet')
    const t = await table()
    const toggle = await within(t).findByRole('button', { name: new RegExp(copy.groups.others) })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent(copy.groups.count(3))
    const dataRows = () =>
      within(t)
        .getAllByRole('row')
        .slice(1)
        .filter((r) => !r.hasAttribute('data-group'))
    expect(dataRows()).toHaveLength(3)
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(dataRows()).toHaveLength(0)
  })

  it('Yours is one list, no groups', async () => {
    renderApp('/?scope=yours')
    const t = await table()
    await waitFor(() => expect(within(t).getAllByRole('row').length).toBeGreaterThan(2))
    expect(
      within(t)
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-group')),
    ).toEqual([])
  })
})

describe('phone width', () => {
  it('rows are two lines (name · kind · health, then spend · budget), with no table to scroll', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    renderApp('/?scope=yours')
    const rows = await screen.findAllByTestId('home-phone-row')
    expect(screen.queryByRole('table', { name: copy.table.label })).toBeNull()
    expect(within(rows[0]!).getAllByRole('link')[0]).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/agents\//),
    )
    await waitFor(() => expect(rows[0]).toHaveTextContent(copy.table.spend(30)))
  })
})

describe('review fixes', () => {
  it('a failed budgets read says so, keeps the column with "—", and shows no budget tile', async () => {
    configureMocks({ routerVariants: ['router-budgets-fail'] })
    renderApp('/?scope=yours')
    const t = await table()
    expect(await screen.findByText(copy.budget.failed, {}, { timeout: 5_000 })).toBeInTheDocument()
    expect(within(t).getByRole('columnheader', { name: /Budget use/ })).toBeInTheDocument()
    expect(await tile(copy.budget.own)).toBeNull()
  })

  it('the budget column’s name stays "Budget use"; the strip says it is a preview, once', async () => {
    renderApp('/?scope=yours')
    const t = await table()
    expect(await within(t).findByRole('columnheader', { name: 'Budget use' })).toBeInTheDocument()
    expect(
      await screen.findByText(/^Budget use is a preview: needs server support/),
    ).toBeInTheDocument()
  })

  async function oneAgentBuilds(
    build: (b: Record<string, unknown>) => Parameters<typeof HttpResponse.json>[0],
    status = 200,
  ) {
    const page = (await (await fetch('/api/agents?limit=100&offset=0')).json()) as Record<
      string,
      unknown
    >[]
    const agent = page.find((a) => (a.status as string) === 'running')!
    const records = (await (
      await fetch(`/api/builds/agent/${agent.id as string}`)
    ).json()) as Record<string, unknown>[]
    const base = records[0] ?? {}
    server.use(
      http.get('/api/agents', ({ request }) =>
        HttpResponse.json(
          Number(new URL(request.url).searchParams.get('offset') ?? 0) ? [] : [agent],
        ),
      ),
      http.get('/api/builds/agent/:id', () =>
        status === 200 ? HttpResponse.json(build(base)) : new HttpResponse('boom', { status }),
      ),
    )
    return agent
  }

  it('last change links its marker when it is inside the hub’s window, and not when it is older', async () => {
    const recent = new Date(now() - 2 * 86_400_000).toISOString()
    await oneAgentBuilds((b) => [{ ...b, status: 'success', updated_at: recent }])
    renderApp('/?scope=fleet')
    const link = await within(await table()).findByRole('link', { name: /Build completed/ })
    expect(link.getAttribute('href')).toMatch(/marker=build/)
  })

  it('an old build links the hub without a marker it would drop', async () => {
    const old = new Date(now() - 60 * 86_400_000).toISOString()
    await oneAgentBuilds((b) => [{ ...b, status: 'success', updated_at: old }])
    renderApp('/?scope=fleet')
    const link = await within(await table()).findByRole('link', { name: /Build completed/ })
    expect(link.getAttribute('href')).not.toMatch(/marker=/)
  })

  it('build records the viewer can’t read, or that fail, say why instead of a bare "—"', async () => {
    await oneAgentBuilds(() => ({ available: false }))
    renderApp('/?scope=fleet')
    expect(await within(await table()).findByText(copy.lastChange.hidden)).toBeInTheDocument()
  })

  it('a failed build read says it couldn’t load', async () => {
    await oneAgentBuilds(() => null, 500)
    renderApp('/?scope=fleet')
    expect(await within(await table()).findByText(copy.lastChange.failed)).toBeInTheDocument()
  })

  it('on a phone, an unknown needs count says so rather than looking like none', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    configureMocks({ chatVariants: ['pending-fail'] })
    renderApp('/?scope=yours')
    const rows = await screen.findAllByTestId('home-phone-row')
    await waitFor(() => expect(rows[0]).toHaveTextContent(copy.phone.needsUnknown), {
      timeout: 15_000,
    })
  })
})

describe('phone list cap (decision #50)', () => {
  it('shows the first 25 rows, and "Show N more" draws the rest', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    // A member can't name other owners, so the fleet's other agents share one long group.
    configureMocks({ superuser: false })
    renderApp('/?scope=fleet')
    await waitFor(() => expect(screen.getAllByTestId('home-phone-row').length).toBeGreaterThan(0))
    const more = screen.getAllByRole('button', { name: /^Show \d+ more$/ })
    expect(more.length).toBeGreaterThan(0)
    const before = screen.getAllByTestId('home-phone-row').length
    await userEvent.click(more[0]!)
    expect(screen.getAllByTestId('home-phone-row').length).toBeGreaterThan(before)
  })
})
