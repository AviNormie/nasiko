// /budgets levers (plan feat-budget-burn F4, F12, design 4A) on the app seed's world, where the agents directory and
// the budgets world agree: which levers show, Review actions, previews on the chart and in the strip, one at a time.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { routingAnswer } from '@/test/routing'
import { recordRequestBodies, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [] }))

const levers = async () =>
  (await screen.findByRole('heading', { name: copy.leversTitle })).closest('section')!
const rows = async () => {
  const panel = await levers()
  await waitFor(() => expect(panel.querySelectorAll('[data-lever]').length).toBeGreaterThan(0))
  return panel
}

describe('levers', () => {
  it('a budget projected past its limit: Review actions focuses the levers, in two groups', async () => {
    renderApp('/budgets?scope=yours')
    await userEvent.click(await screen.findByRole('button', { name: copy.reviewActions }))
    const panel = await rows()
    expect(screen.getByRole('heading', { name: copy.leversTitle })).toHaveFocus()
    expect(within(panel).getByText(copy.leversReduce)).toBeInTheDocument()
    expect(within(panel).getByText(copy.leversAdjust)).toBeInTheDocument()
    expect(panel.querySelector('[data-lever="stop"]')).not.toBeNull()
    expect(panel.querySelector('[data-lever="raise"]')).not.toBeNull()
    // Estimates, never outcomes.
    expect(panel).toHaveTextContent(/≈ −\$[\d.,]+ projected spend this month/)
    expect(panel).not.toHaveTextContent(/landing/i)
  })

  it('Preview draws the dashed line and a strip line; Reset clears it', async () => {
    renderApp('/budgets?scope=yours')
    const panel = await rows()
    const stop = panel.querySelector('[data-lever="stop"]') as HTMLElement
    await userEvent.click(within(stop).getByRole('button', { name: /^Preview:/ }))
    expect(within(stop).getByRole('button', { name: /^Preview:/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText(copy.burnPreview)).toBeInTheDocument()
    const strip = screen.getByRole('region', { name: copy.stripLabel })
    expect(within(strip).getByText(/^Preview, not applied/)).toBeInTheDocument()
    await userEvent.click(within(strip).getByRole('button', { name: copy.previewReset }))
    expect(screen.queryByText(copy.burnPreview)).toBeNull()
  })

  it('one preview at a time: what-if replaces a lever’s preview, and a lever clears what-if', async () => {
    renderApp('/budgets?scope=yours')
    const panel = await rows()
    const raise = panel.querySelector('[data-lever="raise"]') as HTMLElement
    await userEvent.click(within(raise).getByRole('button', { name: /^Preview:/ }))
    await userEvent.click(screen.getByRole('button', { name: /^What if…/ }))
    await userEvent.type(screen.getByLabelText(copy.whatIfLimit), '500')
    await waitFor(() =>
      expect(within(raise).getByRole('button', { name: /^Preview:/ })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    )
    await userEvent.click(within(raise).getByRole('button', { name: /^Preview:/ }))
    expect(screen.getByLabelText(copy.whatIfLimit)).toHaveValue('')
  })

  it('on track, no budget: the levers say so', async () => {
    configureMocks({ now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] })
    renderApp('/budgets')
    expect(await within(await levers()).findByText(copy.leversOnTrack)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.reviewActions })).toBeNull()
  })

  it('Stop at the limit: a confirm with Cancel focused, then a guarded PUT to stop, announced', async () => {
    const rec = recordRequestBodies()
    renderApp('/budgets?scope=yours')
    const panel = await rows()
    const stop = panel.querySelector('[data-lever="stop"]') as HTMLElement
    await userEvent.click(within(stop).getByRole('button', { name: /^Apply:/ }))
    const dialog = await screen.findByRole('alertdialog', { name: copy.leverConfirmStop })
    expect(within(dialog).getByRole('button', { name: copy.cancel })).toHaveFocus()
    await userEvent.click(within(dialog).getByRole('button', { name: copy.leverDo.stop }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'PUT')?.body).toMatchObject({
      action: 'stop',
      expected_updated_at: expect.any(String),
    })
    await waitFor(() =>
      expect(screen.getByTestId('budgets-announcer')).toHaveTextContent(copy.leverApplied.stop),
    )
    rec.stop()
  })

  it('a cheaper model pins only that agent; token optimization turns on its switch', async () => {
    // The seed's agents route through an Anthropic config while their traces are OpenAI's: answer as an OpenAI config,
    // so a gpt-4o-mini pin fits (a mismatch withholds the lever, regression-1).
    server.use(routingAnswer('openai', null))
    const rec = recordRequestBodies()
    renderApp('/budgets?scope=yours')
    const panel = await rows()
    const model = panel.querySelector('[data-lever^="model:"]') as HTMLElement
    const agentId = model.getAttribute('data-lever')!.slice('model:'.length)
    await userEvent.click(within(model).getByRole('button', { name: /^Apply:/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/only this agent/)
    await userEvent.click(within(dialog).getByRole('button', { name: copy.leverDo.model }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await rec.flush()
    const patch = rec.requests.find(
      (r) => r.method === 'PATCH' && r.url.pathname === `/api/agents/${agentId}/llm-config`,
    )
    expect(patch?.body).toEqual({ pinned_model: expect.any(String) })

    const comp = panel.querySelector('[data-lever^="compression:"]') as HTMLElement
    const id = comp.getAttribute('data-lever')!.slice('compression:'.length)
    await userEvent.click(within(comp).getByRole('button', { name: /^Apply:/ }))
    const d2 = await screen.findByRole('alertdialog')
    await userEvent.click(within(d2).getByRole('button', { name: copy.leverDo.compression }))
    await waitFor(() => expect(d2).not.toBeInTheDocument())
    await rec.flush()
    expect(
      rec.requests.find((r) => r.method === 'PUT' && r.url.pathname === `/api/agents/${id}`)?.body,
    ).toEqual({ compress_enabled: true })
    rec.stop()
  })

  it('Raise opens the editor at the limit where the projection lands', async () => {
    renderApp('/budgets?scope=yours')
    const panel = await rows()
    const raise = panel.querySelector('[data-lever="raise"]') as HTMLElement
    const named = /Raise the limit to \$([\d,]+\.\d\d)/.exec(raise.textContent ?? '')![1]!
    await userEvent.click(within(raise).getByRole('button', { name: copy.leverDo.raise }))
    const sheet = await screen.findByRole('dialog')
    expect((within(sheet).getByLabelText(copy.monthlyLimit) as HTMLInputElement).value).toBe(
      named.replace(/,/g, ''),
    )
  })
})
