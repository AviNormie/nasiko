// Regression: ISSUE-001 — on an R-L10-only server the fallback offered a dimension switch that did nothing, said the
// quarter end "needs 3 days of spend" (it can't be read at all) and read alerts with 1.0's schema (an R-L10 server's
// rows lack label, kind and percent, so the list would fail).
// Found by /qa on 2026-10-13
// Report: .gstack/qa-reports/qa-report-localhost-2026-10-13-b2.md
import { screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [] }))

it('the R-L10 fallback offers only what it can read', async () => {
  configureMocks({ budgetVariants: ['budgets-rl10-only'] })
  renderApp('/budgets?scope=yours')
  await screen.findByRole('heading', { level: 2, name: /^On pace/ })
  expect(screen.queryByRole('radio', { name: copy.dimension.model })).toBeNull()
  const strip = screen.getByRole('region', { name: copy.stripLabel })
  expect(within(strip).queryByText(copy.stripQuarter)).toBeNull()
  const alerts = screen.getByRole('heading', { name: copy.alertsTitleV1 }).closest('section')!
  expect(within(alerts).getByText(copy.sectionMissing)).toBeInTheDocument()
})
