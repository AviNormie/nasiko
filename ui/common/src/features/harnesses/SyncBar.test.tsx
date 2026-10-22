/**
 * The desktop app's sync bar (components/SyncBar.tsx, mounted by the `_app` route under the top bar): on any page while
 * coding-agent data syncs, with the same numbers as the Harnesses card; nothing in a browser or while idle.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { doneAgents, doneLocalRun, importingAgents, mockRun } from '@/mocks/codingAgents'
import { codingAgentsMockState, configureMocks, type MockVariant } from '@/mocks/handlers'
import { generateHarnessSeed } from '@/mocks/seed-harness'
import { FIXED, now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequests } from '@/test/setup'

const harnessSeed = generateHarnessSeed({ anchor: FIXED })
const STATE = '/__nasiko/coding-agents/state'

setupPinnedSeed()

function as(variant: MockVariant | null = null) {
  configureMocks({ seed, now, loggedIn: true, harnessSeed, persona: 'admin', variant })
}
afterEach(() =>
  configureMocks({ seed, now, loggedIn: true, harnessSeed, persona: null, variant: null }),
)

const bar = () => screen.findByTestId('sync-bar')
const progress = (el: HTMLElement) =>
  within(el).getByRole('progressbar', { name: 'Coding agent sync progress' })

describe('the desktop app syncing', () => {
  it('shows on a page that is not Harnesses while importing, with the windows read and what waits', async () => {
    as('desktop-running')
    renderApp('/agents')
    const b = await bar()
    expect(b).toHaveTextContent(/^Syncing coding agents · .+ · [\d,]+ turns? sent/)
    // The import's own progress: windows read over windows (a number, not an indeterminate bar).
    expect(progress(b)).toHaveAttribute('aria-valuenow', expect.stringMatching(/^\d+$/))
    expect(progress(b).className).not.toContain('animate-pulse')
  })

  it('shows while queued turns wait, on the Overview too, with the count and an indeterminate bar', async () => {
    as('desktop-sending')
    renderApp('/')
    const b = await bar()
    expect(b).toHaveTextContent('Syncing coding agents · 499 waiting')
    const p = progress(b)
    expect(p).not.toHaveAttribute('aria-valuenow')
    // Reduced motion: neither the pulse nor the fill's glide moves.
    expect(p).toHaveClass(
      'animate-pulse',
      'motion-reduce:animate-none',
      'motion-reduce:*:transition-none',
    )
  })

  it('Details opens Harnesses, where the card counts the same waiting turns', async () => {
    as('desktop-sending')
    renderApp('/agents')
    const b = await bar()
    await userEvent.click(within(b).getByRole('link', { name: 'Coding agent sync details' }))
    const card = await screen.findByTestId('agents-onboarding-run')
    expect(card).toHaveTextContent('Waiting to send 499 turns')
    // Still on screen, with the same count.
    expect(await bar()).toHaveTextContent('499 waiting')
  })

  it('says once that syncing finished, and goes away', async () => {
    as('desktop-sending')
    renderApp('/agents')
    await bar()
    const desktop = codingAgentsMockState().desktop!
    desktop.queued = 0
    desktop.sending = false
    await waitFor(() => expect(screen.queryByTestId('sync-bar')).toBeNull(), { timeout: 3_000 })
    expect(screen.getByTestId('sync-bar-announcer')).toHaveTextContent('Coding agents synced.')
  })
})

describe("Monitor's import note", () => {
  const note = () => screen.queryByTestId('import-notice')

  it('says what is happening while the import runs, with its progress and a way to the details', async () => {
    as('desktop-running')
    renderApp('/tokenops')
    const n = await screen.findByTestId('import-notice')
    expect(n).toHaveTextContent('Bringing in your coding agents')
    expect(
      within(n).getByRole('progressbar', { name: 'Coding agent import progress' }),
    ).toBeInTheDocument()
    expect(within(n).getByRole('link', { name: 'See progress' })).toHaveAttribute(
      'href',
      '/harnesses',
    )
  })

  it('stays away for a background delivery after the import is done', async () => {
    as('desktop-sending')
    renderApp('/tokenops')
    await bar()
    expect(note()).toBeNull()
  })

  it('in a browser, shows while the CLI reports an import, and goes once it is done', async () => {
    as()
    const st = codingAgentsMockState()
    st.runs = [mockRun('importing', importingAgents(), now())]
    renderApp('/tokenops')
    const n = await screen.findByTestId('import-notice')
    expect(
      within(n).getByRole('progressbar', { name: 'Coding agent import progress' }),
    ).toBeInTheDocument()
    st.runs = [mockRun('done', doneAgents(), now() + 1000)]
    await waitFor(() => expect(note()).toBeNull(), { timeout: 5_000 })
  })

  it('in a browser, stays away with no import running', async () => {
    as()
    const rec = recordRequests()
    try {
      renderApp('/tokenops')
      await screen.findByRole('heading', { level: 1 })
      await waitFor(() =>
        expect(rec.urls.some((u) => u.pathname === '/api/me/coding-agents/sync')).toBe(true),
      )
      expect(note()).toBeNull()
    } finally {
      rec.stop()
    }
  })
})

describe('hidden', () => {
  it('while the desktop app is idle', async () => {
    as('desktop-unasked')
    codingAgentsMockState().desktop!.run = doneLocalRun(now())
    const rec = recordRequests()
    try {
      renderApp('/agents')
      await waitFor(() => expect(rec.urls.some((u) => u.pathname === STATE)).toBe(true))
      await screen.findByRole('heading', { level: 1 })
      expect(screen.queryByTestId('sync-bar')).toBeNull()
      expect(screen.getByTestId('sync-bar-announcer')).toBeEmptyDOMElement()
    } finally {
      rec.stop()
    }
  })

  it('in a browser: one probe, no bar, no live region, no polling', async () => {
    as()
    const rec = recordRequests()
    try {
      renderApp('/agents')
      await waitFor(() => expect(rec.urls.some((u) => u.pathname === STATE)).toBe(true))
      await new Promise((r) => setTimeout(r, 1_500))
      expect(screen.queryByTestId('sync-bar')).toBeNull()
      expect(rec.urls.filter((u) => u.pathname === STATE)).toHaveLength(1)
      // No live region either: a page's own `status` stays the only one.
      expect(screen.queryByTestId('sync-bar-announcer')).toBeNull()
    } finally {
      rec.stop()
    }
  })
})
