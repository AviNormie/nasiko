/**
 * B5 review regressions (plans/feat-budget-burn.md ledger #86): a failed probe is a failure with Retry on the hub and the
 * ledger, never an absent budget; coming back to the hub re-reads the budget; a picked contributor whose share read
 * fails says so instead of showing the agent's own figures; the ledger reads a session budget only from a server that
 * lists session budgets; the demo PR-review session has its budget (one session id in both mocks).
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy as budgetCopy } from '@/features/budgets/copy'
import { configureMocks } from '@/mocks/handlers'
import { SHOWCASE_SESSION } from '@/mocks/spanBuilder'
import { agentWhere } from '@/test/agents'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequests, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() => {
  vi.restoreAllMocks()
  configureMocks({ seed, now, loggedIn: true, variant: null, persona: null, budgetVariants: [] })
})

const T = { timeout: 12_000 }
const named = (display: string) =>
  agentWhere((a) => (a as { display_name?: string }).display_name === display)
const section = () => screen.findByRole('region', { name: budgetCopy.hubTitle }, T)

describe('B5 review regressions', () => {
  it('hub: a failed probe is a panel error whose Retry reads it again (Claude 6, Codex 2)', async () => {
    const a = await named('Code Reviewer')
    let fail = true
    server.use(
      http.get('*/api/budgets/capabilities', () =>
        fail ? HttpResponse.json({ error: 'x', code: 'bad' }, { status: 400 }) : undefined,
      ),
    )
    renderApp(`/agents/${a.id}`)
    const err = await screen.findByText(`Couldn't load ${copy.budgetSection}`, undefined, T)
    fail = false
    await userEvent.click(
      within(err.closest('[role="alert"], div')!.parentElement!).getByRole('button', {
        name: /retry/i,
      }),
    )
    expect(await section()).toBeInTheDocument()
  })

  it('hub: coming back to the page re-reads the budget (Codex 1)', async () => {
    const a = await named('Code Reviewer')
    renderApp(`/agents/${a.id}`)
    await section()
    const rec = recordRequests()
    try {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
      window.dispatchEvent(new Event('focus'))
      await waitFor(() => expect(rec.urls.map((u) => u.pathname)).toContain('/api/budgets/burn'), T)
    } finally {
      rec.stop()
    }
  })

  it('hub: a picked contributor whose share fails says so, never the agent’s own figures (Codex 4)', async () => {
    const a = await named('Code Reviewer')
    server.use(
      http.get('*/api/budgets/burn', ({ request }) =>
        new URL(request.url).searchParams.get('contributor')
          ? HttpResponse.json({ error: 'x', code: 'bad' }, { status: 400 })
          : undefined,
      ),
    )
    renderApp(`/agents/${a.id}`)
    const s = await section()
    // A model in the contributors list (keys are `provider/model`).
    const pick = await within(s).findByRole(
      'button',
      { name: budgetCopy.contributorsPick('anthropic/claude-sonnet-4') },
      T,
    )
    await userEvent.click(pick)
    expect(
      await within(s).findByText(`Couldn't load ${budgetCopy.shareFailed}`, undefined, T),
    ).toBeInTheDocument()
    expect(within(s).queryByText(budgetCopy.stripToday)).toBeNull()
  })

  it('ledger: no session-budget read from a server without session budgets (Claude 1)', async () => {
    const caps = await (await fetch('/api/budgets/capabilities')).json()
    const without = {
      data: {
        ...caps.data,
        features: caps.data.features.filter((f: string) => f !== 'session_budgets'),
      },
    }
    server.use(http.get('*/api/budgets/capabilities', () => HttpResponse.json(without)))
    const rec = recordRequests()
    renderApp(`/sessions/${SHOWCASE_SESSION}?view=ledger`)
    await screen.findByRole('heading', { name: new RegExp(`^${copy.ledger.title}`) }, T)
    await waitFor(() =>
      expect(rec.urls.some((u) => u.pathname === '/api/budgets/capabilities')).toBe(true),
    )
    await new Promise((r) => setTimeout(r, 300))
    rec.stop()
    expect(rec.urls.filter((u) => u.pathname === '/api/budgets/burn')).toEqual([])
    expect(screen.queryByRole('heading', { name: budgetCopy.sessionTitle })).toBeNull()
  })

  it('ledger: the demo PR-review session has its budget (one session id in both mocks, Claude 7)', async () => {
    renderApp(`/sessions/${SHOWCASE_SESSION}?view=ledger`)
    const p = (await screen.findByRole('heading', { name: budgetCopy.sessionTitle }, T)).closest(
      'section',
    )!
    expect(within(p).getByText(/ over \d+ turns?; no session limit\.$/)).toBeInTheDocument()
  })
})
