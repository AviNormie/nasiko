// /budgets levers (plan feat-budget-burn F4, F12, design 4A) on the app seed's world, where the agents directory and
// the budgets world agree: which levers show, Review actions, previews on the chart and in the strip, one at a time.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
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
})
