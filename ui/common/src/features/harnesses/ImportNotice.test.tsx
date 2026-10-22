/**
 * Monitor while coding agents are brought in (components/ImportNotice.tsx): the note above the data while an import
 * runs, from the desktop app's own run or, in a browser, the run the CLI reports; nothing for a background delivery.
 * The loading state that stands in for the empty state is in tokenops/TokenopsPage.test.tsx.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { doneAgents, importingAgents, mockRun } from '@/mocks/codingAgents'
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
    const rec = recordRequests()
    try {
      renderApp('/tokenops')
      await screen.findByRole('heading', { level: 1 })
      await waitFor(() => expect(rec.urls.some((u) => u.pathname === STATE)).toBe(true))
      expect(note()).toBeNull()
    } finally {
      rec.stop()
    }
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
