/** Previous/Next on the agent page (docs/superpowers/plans/2026-10-06-prev-next.md). */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'

setupPinnedSeed()

const live = seed.agents.filter((a) => !a.deleted)
const cards = () =>
  screen
    .getAllByRole('link')
    .filter((l) => /^\/agents\/[0-9a-f-]{36}$/.test(l.getAttribute('href') ?? ''))
const position = (n: number, of: number) =>
  screen.getByRole('group', { name: `agent ${n} of ${of}` })

describe('agent Previous/Next', () => {
  it('steps through the catalog in its order with the buttons and J/K, replacing history', async () => {
    const { router } = renderApp('/agents')
    await screen.findByRole('link', { name: new RegExp(live[0]!.display_name) })
    const hrefs = cards().map((l) => l.getAttribute('href'))
    await userEvent.click(cards()[0]!)
    const next = await screen.findByRole('button', { name: 'Next agent' })
    expect(position(1, hrefs.length)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous agent' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await userEvent.click(next)
    await waitFor(() => expect(router.state.location.pathname).toBe(hrefs[1]))
    await waitFor(() => expect(position(2, hrefs.length)).toBeInTheDocument())
    // The new page's arrow has focus again after the remount.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next agent' })).toHaveFocus())
    await userEvent.keyboard('k')
    await waitFor(() => expect(router.state.location.pathname).toBe(hrefs[0]))
    await userEvent.keyboard('j')
    await waitFor(() => expect(router.state.location.pathname).toBe(hrefs[1]))
    // Replaced, not pushed: Back is the catalog.
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
  })

  it('keeps the list across a tab switch', async () => {
    renderApp('/agents')
    await screen.findByRole('link', { name: new RegExp(live[0]!.display_name) })
    const total = cards().length
    await userEvent.click(cards()[0]!)
    await screen.findByRole('button', { name: 'Next agent' })
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    )
    expect(screen.getByRole('button', { name: 'Next agent' })).toBeInTheDocument()
    expect(position(1, total)).toBeInTheDocument()
  })

  it('walks the list as filtered when the card was clicked', async () => {
    renderApp('/agents')
    await screen.findByRole('link', { name: new RegExp(live[0]!.display_name) })
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search agents' }),
      live[1]!.display_name,
    )
    await waitFor(() => expect(cards()).toHaveLength(1))
    await userEvent.click(cards()[0]!)
    expect(await screen.findByRole('group', { name: 'agent 1 of 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next agent' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('steps through Your agents too', async () => {
    renderApp('/agents/mine')
    const table = await screen.findByRole('table')
    const first = (await within(table).findAllByRole('link'))[0]!
    await userEvent.click(first)
    expect(await screen.findByRole('button', { name: 'Next agent' })).toBeInTheDocument()
  })

  it('shows no arrows on a deep link', async () => {
    renderApp(`/agents/${live[0]!.id}`)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: 'Next agent' })).toBeNull()
  })
})
