// Regressions from the B3 /review (Claude adversarial + Codex, 2026-10-13), each reproduced first; the pure ones are in
// levers.test.ts. The app seed's world, with its agents answering as OpenAI configs (`routingAnswer`).
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { routingAnswer } from '@/test/routing'
import { recordRequestBodies, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
beforeEach(() => server.use(routingAnswer('openai', null)))
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [] }))

const panel = async () => {
  const p = (await screen.findByRole('heading', { name: copy.leversTitle })).closest('section')!
  await waitFor(() => expect(p.querySelector('[data-lever^="model:"]')).not.toBeNull())
  return p
}
const lever = (p: Element, sel: string) => p.querySelector(`[data-lever${sel}]`) as HTMLElement
const preview = (row: HTMLElement) => within(row).getByRole('button', { name: /^Preview:/ })

describe('B3 review regressions', () => {
  it('picking a contributor ends a lever preview; clearing it doesn’t bring the preview back', async () => {
    renderApp('/budgets?scope=yours&burn=up')
    const p = await panel()
    await userEvent.click(preview(lever(p, '="stop"')))
    const list = screen.getByRole('list', { name: copy.contributorsTitle })
    await userEvent.click(within(list).getAllByRole('button')[0]!)
    const chip = await screen.findByRole('button', { name: /^Clear .*’s share view$/ })
    await userEvent.click(chip)
    await waitFor(() => expect(screen.queryByRole('button', { name: /share view$/ })).toBeNull())
    expect(screen.queryByText(copy.burnPreview)).toBeNull()
    expect(preview(lever(p, '="stop"'))).toHaveAttribute('aria-pressed', 'false')
  })

  it('Raise hands over to the editor: its preview ends', async () => {
    renderApp('/budgets?scope=yours')
    const p = await panel()
    const raise = lever(p, '="raise"')
    await userEvent.click(preview(raise))
    await userEvent.click(within(raise).getByRole('button', { name: copy.leverDo.raise }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText(copy.burnPreview)).toBeNull()
  })

  it('Cancel returns focus to the lever’s button', async () => {
    renderApp('/budgets?scope=yours')
    const p = await panel()
    const apply = within(lever(p, '="stop"')).getByRole('button', { name: /^Apply:/ })
    await userEvent.click(apply)
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: copy.cancel }))
    await waitFor(() => expect(apply).toHaveFocus())
  })

  it('Quarter view estimates from the budget’s own month, as Month view does', async () => {
    const text = async (url: string) => {
      renderApp(url)
      const t = lever(await panel(), '^="model:"').textContent
      cleanup()
      return t
    }
    expect(await text('/budgets?scope=yours&period=quarter')).toBe(
      await text('/budgets?scope=yours'),
    )
  })

  it('a pin made elsewhere after the list loaded: the dialog says so and nothing is sent', async () => {
    const rec = recordRequestBodies()
    renderApp('/budgets?scope=yours')
    const p = await panel()
    const row = lever(p, '^="model:"')
    const to = /→ (\S+), only this agent/.exec(row.textContent ?? '')![1]!
    server.use(routingAnswer('openai', to))
    await userEvent.click(within(row).getByRole('button', { name: /^Apply:/ }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: copy.leverDo.model }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already routes to/)
    await rec.flush()
    expect(rec.requests.some((r) => r.method === 'PATCH')).toBe(false)
    rec.stop()
  })
})
