// Regression: ISSUE-002 — coding harness rows said "No budget set", as if a budget could be set on them
// Found by /qa on 2026-10-11
// Report: .gstack/qa-reports/qa-report-localhost-2026-10-11-pr2b.md
// A budget counts routed calls; a harness's calls never go through the router (the hub hides its budget card too).
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { copy } from './copy'

setupPinnedSeed()

describe('budget use on coding harness rows (ISSUE-002)', () => {
  it('says harnesses have no budget, never "No budget set"', async () => {
    renderApp('/?scope=yours')
    const t = await screen.findByRole('table', { name: copy.table.label })
    const budgetCell = (r: HTMLElement) => within(r).getAllByRole('cell')[3]!
    await waitFor(() =>
      expect(
        within(t)
          .getAllByRole('row')
          .some((r) => within(r).queryByText(copy.budget.none)),
      ).toBe(true),
    )
    const harnesses = within(t)
      .getAllByRole('row')
      .filter((r) => within(r).queryByText(copy.table.harness))
    expect(harnesses.length).toBeGreaterThan(0)
    for (const r of harnesses) {
      expect(budgetCell(r)).toHaveTextContent(copy.budget.harness)
      expect(budgetCell(r)).not.toHaveTextContent(copy.budget.none)
    }
  })
})
