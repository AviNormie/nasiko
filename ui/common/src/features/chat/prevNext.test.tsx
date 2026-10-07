/** Previous/Next on a chat: the rail's order (docs/superpowers/plans/2026-10-06-prev-next.md). */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '@/test/renderApp'
import { clearDrafts } from './drafts'
import { useRailOrder } from './railOrder'
import { clearChatRegistry } from './registry'

afterEach(() => {
  clearChatRegistry()
  clearDrafts()
  // The store is module state (a sign-out's full page load clears it in the app); don't leak it between tests.
  useRailOrder.setState({ ids: [] })
})

describe('chat Previous/Next', () => {
  it("steps through the rail's chats in the order shown, with the buttons and K", async () => {
    const { router } = renderApp('/chat')
    const rail = await screen.findByRole('navigation', { name: 'Chats' })
    const rows = await within(rail).findAllByTestId('rail-row')
    const paths = rows.map((r) => r.getAttribute('href')!.split('?')[0])
    expect(paths.length).toBeGreaterThan(1)
    await userEvent.click(rows[0]!)
    await screen.findByRole('group', { name: `chat 1 of ${paths.length}` })
    expect(screen.getByRole('button', { name: 'Previous chat' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Next chat' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(paths[1]))
    await screen.findByRole('group', { name: `chat 2 of ${paths.length}` })
    // The header remounts with the chat (SessionView is keyed by it), and focus falls to <body>: nothing in an
    // opened chat takes it, so PrevNext puts it back on the arrow used.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next chat' })).toHaveFocus())
    // Typing in the composer is ignored; J/K work once focus is elsewhere.
    await userEvent.keyboard('k')
    await waitFor(() => expect(router.state.location.pathname).toBe(paths[0]))
  })

  it('the Waiting view has its own order, so the arrows go', async () => {
    renderApp('/chat')
    const rail = await screen.findByRole('navigation', { name: 'Chats' })
    const rows = await within(rail).findAllByTestId('rail-row')
    await userEvent.click(rows[0]!)
    await screen.findByRole('group', { name: /^chat 1 of / })
    // The rail remounts when a chat opens: query it again.
    const openRail = screen.getByRole('navigation', { name: 'Chats' })
    await userEvent.click(await within(openRail).findByRole('radio', { name: /^Waiting/ }))
    await waitFor(() => expect(screen.queryByRole('group', { name: /^chat / })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Next chat' })).toBeNull()
  })
})
