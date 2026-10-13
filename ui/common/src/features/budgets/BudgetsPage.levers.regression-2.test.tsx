// Regression: ISSUE-001 — after "Stop at the limit" landed, the stop lever stayed and the coverage line still read
// "Alert only": the burn read describes the budget as of its `as_of`, which lags the write, so the page now reads the
// budget record's action for both.
// Found by /qa on 2026-10-13
// Report: .gstack/qa-reports/qa-report-localhost-2026-10-13-b3.md
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { budgetMockState, configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [] }))

it('a stop that just landed removes the stop lever and the coverage says calls stop', async () => {
  // A server whose burn `as_of` lags the write: the PUT lands on the record, the burn still shows the old version.
  let stopped = false
  server.use(
    http.put('/api/budgets/:id', ({ params }) => {
      stopped = true
      return HttpResponse.json({ data: record(String(params.id)) })
    }),
    // Budget ids only: `/burn`, `/status` and the other static routes share the pattern.
    http.get('/api/budgets/:id', ({ params }) =>
      stopped && String(params.id).includes('-')
        ? HttpResponse.json({ data: record(String(params.id)) })
        : undefined,
    ),
  )
  renderApp('/budgets?scope=yours')
  const panel = (await screen.findByRole('heading', { name: copy.leversTitle })).closest('section')!
  await waitFor(() => expect(panel.querySelector('[data-lever="stop"]')).not.toBeNull())
  const stop = panel.querySelector('[data-lever="stop"]') as HTMLElement
  await userEvent.click(within(stop).getByRole('button', { name: /^Apply:/ }))
  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: copy.leverDo.stop }))
  await waitFor(() => expect(panel.querySelector('[data-lever="stop"]')).toBeNull())
  await waitFor(() =>
    expect(screen.getByText(/^Routed calls ·/)).toHaveTextContent(copy.coverageRouted(true)),
  )
})

/** The budget as the record read answers once the stop landed. */
const record = (id: string) => ({
  ...budgetMockState().budgets.find((b) => b.id === id)!,
  action: 'stop',
  updated_at: new Date(now() + 60_000).toISOString(),
})
