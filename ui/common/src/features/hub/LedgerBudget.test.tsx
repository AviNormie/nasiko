/**
 * The session ledger's budget (plans/feat-budget-burn.md F9, B5; ledger #85): the session's burn on its turns with its
 * sentence and three figures; a superuser or the session's owner sets its limit while the session is open (BG-10); an
 * ended session can't take one; a session the server won't show is nothing, a failed read a panel error with Retry.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { copy as budgetCopy } from '@/features/budgets/copy'
import { budgetMockState, configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequestBodies, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() =>
  configureMocks({ seed, now, loggedIn: true, variant: null, persona: null, budgetVariants: [] }),
)

const T = { timeout: 12_000 }
/** A chat session with routed calls in the budget world, open (no end yet) or ended. */
const sessionOf = (open: boolean) => {
  const w = budgetMockState().world
  const s = w.sessions.find((x) => w.calls.filter((c) => c.chat_session_id === x.id).length >= 2)!
  s.ended_at = open ? null : now() - 3_600_000
  return s.id
}
const panel = async () =>
  (await screen.findByRole('heading', { name: budgetCopy.sessionTitle }, T)).closest('section')!

describe('the ledger’s session budget', () => {
  it('its spend over its turns, with no limit yet, and the per-turn figure', async () => {
    renderApp(`/sessions/${sessionOf(false)}?view=ledger`)
    const p = await panel()
    expect(within(p).getByText(/ over \d+ turns; no session limit\.$/)).toBeInTheDocument()
    expect(within(p).getByText(budgetCopy.sessionUsedLabel)).toBeInTheDocument()
    expect(within(p).getByText(budgetCopy.sessionPerTurn)).toBeInTheDocument()
  })

  it('an open session: Set a session limit creates a session budget for it (BG-10)', async () => {
    const id = sessionOf(true)
    const rec = recordRequestBodies()
    renderApp(`/sessions/${id}?view=ledger`)
    const p = await panel()
    await userEvent.click(within(p).getByRole('button', { name: budgetCopy.setSessionLimit }))
    const sheet = await screen.findByRole('dialog', { name: budgetCopy.budgetNew })
    expect(sheet).toHaveTextContent(budgetCopy.budgetDescriptionSession)
    await userEvent.type(within(sheet).getByLabelText(budgetCopy.sessionLimit), '5')
    await userEvent.click(within(sheet).getByRole('button', { name: budgetCopy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      scope: 'session',
      session_id: id,
      period: 'session',
      limit_usd: 5,
    })
    rec.stop()
    expect(
      await within(await panel()).findByText(/ session limit used \(\d+%\)/, undefined, T),
    ).toBeInTheDocument()
  })

  it('an ended session takes no limit', async () => {
    renderApp(`/sessions/${sessionOf(false)}?view=ledger`)
    const p = await panel()
    expect(within(p).queryByRole('button', { name: budgetCopy.setSessionLimit })).toBeNull()
  })

  it('a session the server won’t show is nothing; a failed read says so with Retry', async () => {
    const id = sessionOf(false)
    let status = 404
    server.use(
      http.get('*/api/budgets/burn', () =>
        HttpResponse.json(
          { error: 'x', code: status === 404 ? 'scope_not_found' : 'bad' },
          { status },
        ),
      ),
    )
    renderApp(`/sessions/${id}?view=ledger`)
    await screen.findByRole('heading', { name: new RegExp(`^${copy.ledger.title}`) }, T)
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: budgetCopy.sessionTitle })).toBeNull(),
    )
    status = 400
    renderApp(`/sessions/${id}?view=ledger`)
    expect(await screen.findByRole('button', { name: /retry/i }, T)).toBeInTheDocument()
    expect(screen.getByText(`Couldn't load ${copy.ledger.budgetSection}`)).toBeInTheDocument()
  })
})
