/**
 * Quarter budgets in the editor (plans/feat-budget-burn.md B6; budgets.md §4.3, §6.4, §6.5; ledger #91): calendar
 * quarters (§7 Q2). A new budget can reset every quarter; an existing one's period change is scheduled for the next
 * quarter start and says so; a server without quarter budgets never offers the choice.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequestBodies, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
const golden = { now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] as const }
beforeEach(() => configureMocks({ ...golden, budgetVariants: [...golden.budgetVariants] }))
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [], superuser: null }))

const editPricing = async () => {
  renderApp('/budgets')
  await screen.findByRole('table', { name: copy.atRiskTitle })
  await userEvent.click(screen.getByRole('button', { name: copy.adjustLimitFor('Pricing Engine') }))
  return screen.findByRole('dialog', { name: copy.budgetEdit('Pricing Engine') })
}

describe('quarter budgets', () => {
  it('a new budget can reset every quarter: POST period=quarter, a quarterly limit', async () => {
    const rec = recordRequestBodies()
    renderApp('/budgets')
    await screen.findByRole('table', { name: copy.unbudgetedTitle })
    await userEvent.click(screen.getByRole('button', { name: copy.setBudgetFor('Support Bot') }))
    const sheet = await screen.findByRole('dialog', { name: copy.budgetNew })
    await userEvent.click(within(sheet).getByRole('radio', { name: copy.periodEveryQuarter }))
    await userEvent.type(within(sheet).getByLabelText(copy.quarterlyLimit), '120')
    await userEvent.click(within(sheet).getByRole('button', { name: copy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      scope: 'agent',
      agent_id: I.support,
      period: 'quarter',
      limit_usd: 120,
    })
    rec.stop()
  })

  it('an existing budget’s period change waits for the next quarter start and says so', async () => {
    const rec = recordRequestBodies()
    const sheet = await editPricing()
    expect(within(sheet).getByRole('radio', { name: copy.periodEveryMonth })).toBeChecked()
    await userEvent.click(within(sheet).getByRole('radio', { name: copy.periodEveryQuarter }))
    // Oct 14: the next boundary is Jan 1.
    expect(sheet).toHaveTextContent(copy.periodChangeFrom('quarter', 'Jan 1'))
    await userEvent.click(within(sheet).getByRole('button', { name: copy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ period: 'quarter' })
    rec.stop()
    // Opened again: the scheduled change shows, and the choice is the period it will become.
    const again = await editPricing()
    expect(again).toHaveTextContent(copy.periodPending('quarter', 'Jan 1'))
    expect(within(again).getByRole('radio', { name: copy.periodEveryQuarter })).toBeChecked()
  })

  it('an edit that keeps the period sends none', async () => {
    const rec = recordRequestBodies()
    const sheet = await editPricing()
    const limit = within(sheet).getByLabelText(copy.monthlyLimit)
    await userEvent.clear(limit)
    await userEvent.type(limit, '110')
    await userEvent.click(within(sheet).getByRole('button', { name: copy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'PUT')?.body).not.toHaveProperty('period')
    rec.stop()
  })

  it('a server without quarter budgets never offers the choice', async () => {
    const caps = await (await fetch('/api/budgets/capabilities')).json()
    server.use(
      http.get('*/api/budgets/capabilities', () =>
        HttpResponse.json({
          data: {
            ...caps.data,
            features: caps.data.features.filter((f: string) => f !== 'quarter_periods'),
          },
        }),
      ),
    )
    const sheet = await editPricing()
    expect(within(sheet).queryByRole('radio', { name: copy.periodEveryQuarter })).toBeNull()
  })
})
