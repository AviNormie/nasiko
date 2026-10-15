import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { copy } from './copy'

setupPinnedSeed()

const T = { timeout: 8000 }
const view = (router: { state: { location: { search: unknown } } }) =>
  (router.state.location.search as { view?: string }).view

describe('MCP catalog scope chips after the FilterChip extraction', () => {
  it.each(['yours', 'shared', 'toolkits'] as const)(
    'draws the %s chip as a toggle that starts unpressed',
    async (v) => {
      renderApp('/mcp')
      expect(
        await screen.findByRole('button', { name: copy.views[v], pressed: false }, T),
      ).toBeInTheDocument()
    },
  )

  it('presses Toolkits, writes ?view and releases it again', async () => {
    const { router } = renderApp('/mcp')
    await userEvent.click(
      await screen.findByRole('button', { name: copy.views.toolkits, pressed: false }, T),
    )
    await waitFor(() => expect(view(router)).toBe('toolkits'))
    expect(
      screen.getByRole('button', { name: copy.views.toolkits, pressed: true }),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: copy.views.toolkits, pressed: true }))
    await waitFor(() => expect(view(router)).toBeUndefined())
    expect(
      screen.getByRole('button', { name: copy.views.toolkits, pressed: false }),
    ).toBeInTheDocument()
  })

  it('switching scope leaves only the new chip pressed', async () => {
    const { router } = renderApp('/mcp')
    await userEvent.click(
      await screen.findByRole('button', { name: copy.views.yours, pressed: false }, T),
    )
    await waitFor(() => expect(view(router)).toBe('yours'))
    await userEvent.click(screen.getByRole('button', { name: copy.views.shared, pressed: false }))
    await waitFor(() => expect(view(router)).toBe('shared'))
    expect(
      screen.getByRole('button', { name: copy.views.yours, pressed: false }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: copy.views.shared, pressed: true }),
    ).toBeInTheDocument()
  })

  it('opens a deep link with the scope chip pressed', async () => {
    renderApp('/mcp?view=toolkits')
    expect(
      await screen.findByRole('button', { name: copy.views.toolkits, pressed: true }, T),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: copy.views.yours, pressed: false }),
    ).toBeInTheDocument()
  })

  it('drops the connection tab when a scope chip is pressed', async () => {
    const { router } = renderApp('/mcp?tab=connected')
    await userEvent.click(
      await screen.findByRole('button', { name: copy.views.toolkits, pressed: false }, T),
    )
    await waitFor(() => expect(view(router)).toBe('toolkits'))
    expect((router.state.location.search as { tab?: string }).tab).toBeUndefined()
  })

  it('opens with a junk ?view= and presses nothing', async () => {
    renderApp('/mcp?view=nonsense')
    await screen.findByRole('button', { name: copy.views.toolkits, pressed: false }, T)
    expect(
      screen.queryAllByRole('button', { pressed: true }).map((b) => b.textContent),
    ).not.toContain(copy.views.toolkits)
  })
})
