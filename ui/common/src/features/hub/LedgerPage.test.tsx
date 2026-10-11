/**
 * The harness session ledger page (plans/feat-agent-centric.md PR1b; eng "Ledger", "Ledger live floor"; UC2 previews):
 * the session route's `?view=ledger`, and the ways in.
 */
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { agentNamed } from '@/test/agents'
import { renderApp } from '@/test/renderApp'
import { recordRequests, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() =>
  configureMocks({ seed, now, loggedIn: true, variant: null, persona: null, chatVariants: [] }),
)

const C4 = '5eedc000-0000-4000-8000-00000000c004'
const C5 = '5eedc000-0000-4000-8000-00000000c005'
const c = copy.ledger
const ledgerUrl = (id: string) => `/sessions/${id}?view=ledger`
const table = async () => screen.findByRole('table', { name: c.label })

describe('the owner’s ledger', () => {
  it('one row per turn, with tools, the harness cost basis and the running total', async () => {
    renderApp(ledgerUrl(C4))
    const t = await table()
    // A header row and three turns.
    expect(within(t).getAllByRole('row')).toHaveLength(4)
    expect(within(t).getByRole('columnheader', { name: c.estCost })).toBeInTheDocument()
    expect(within(t).getByText('read_file')).toBeInTheDocument()
    expect(screen.getByText(c.totals.turns(3))).toBeInTheDocument()
    expect(screen.getByText(c.totals.complete)).toBeInTheDocument()
  })

  it('calls the harness couldn’t tie to a turn are listed under "Turn not recorded"', async () => {
    renderApp(ledgerUrl(C4))
    const p = (await screen.findByRole('heading', { name: c.turnNotRecorded })).closest(
      'section',
    ) as HTMLElement
    expect(within(p).getByText('telemetry', { exact: false })).toBeInTheDocument()
  })

  it('previews (context, memory, controls, budgets) are labelled, and controls come only from records', async () => {
    renderApp(ledgerUrl(C4))
    const t = await table()
    expect(screen.getAllByText(copy.rail.preview).length).toBeGreaterThan(0)
    expect(
      within(t).getByText(c.controlLine('Block destructive shell commands', 'blocked', 'bash')),
    ).toBeInTheDocument()
    const budgets = (await screen.findByRole('heading', { name: c.budgets.title })).closest(
      'section',
    ) as HTMLElement
    expect(within(budgets).getByText(/this session's budget \(\$1\.00\)/)).toBeInTheDocument()
    expect(within(budgets).getByText(/your \w+ budget/)).toBeInTheDocument()
  })

  it('the ledger never edits a control: current settings are links to where they are set', async () => {
    renderApp(ledgerUrl(C4))
    const p = (await screen.findByRole('heading', { name: c.controlsNow.title })).closest(
      'section',
    ) as HTMLElement
    expect(within(p).queryAllByRole('button')).toEqual([])
    expect(within(p).queryAllByRole('switch')).toEqual([])
    expect(within(p).getByRole('link', { name: c.controlsNow.budgets })).toBeInTheDocument()
  })

  it('renders from the messages when the trace read fails (the live floor)', async () => {
    configureMocks({ variant: 'ledger-no-trace' })
    renderApp(ledgerUrl(C4))
    expect(within(await table()).getAllByRole('row')).toHaveLength(4)
  })

  it('a metadata-only session says so', async () => {
    renderApp(ledgerUrl(C5))
    expect(await screen.findByText(c.empty)).toBeInTheDocument()
    expect(screen.getByText(c.metadataOnly)).toBeInTheDocument()
  })
})

describe('more than 100 messages', () => {
  it('totals read as a loaded subtotal until the older turns load', async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({
      id: `m${String(i).padStart(4, '0')}`,
      session_id: C4,
      role: i % 2 ? 'assistant' : 'user',
      content: `message ${i}`,
      timestamp: new Date(now() - (200 - i) * 60_000).toISOString(),
    }))
    server.use(
      http.get('/api/chat/sessions/:id/messages', ({ request }) => {
        const before = new URL(request.url).searchParams.get('prev_cursor')
        const end = before ? all.findIndex((m) => m.id === before) : all.length
        const data = all.slice(Math.max(0, end - 100), end)
        return HttpResponse.json({
          data,
          has_more: end > 100,
          next_cursor: null,
          prev_cursor: data[0]?.id ?? null,
          hitl: [],
        })
      }),
    )
    renderApp(ledgerUrl(C4))
    await table()
    expect(screen.getByText(c.totals.subtotal)).toBeInTheDocument()
    expect(screen.getByText(c.totals.turns(50))).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: c.loadOlder }))
    expect(await screen.findByText(c.totals.complete)).toBeInTheDocument()
    expect(screen.getByText(c.totals.turns(75))).toBeInTheDocument()
  })
})

describe('someone else’s session', () => {
  it('shows metadata from the trace, never messages (owner-only, no superuser bypass)', async () => {
    const list = (await (await fetch('/api/observability/session/list?limit=25')).json()) as {
      data: { sessions: { session_id: string }[] }
    }
    const other = list.data.sessions.find((s) => !s.session_id.startsWith('5eedc'))!
    const rec = recordRequests()
    renderApp(ledgerUrl(other.session_id))
    expect(await screen.findByText(c.notOwner)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: c.label })).toBeNull()
    rec.stop()
    expect(rec.urls.filter((u) => u.pathname.startsWith('/api/budgets/session'))).toEqual([])
  })
})

describe('the ways in', () => {
  it('the trace page of a harness session offers the ledger', async () => {
    renderApp(`/sessions/${C4}`)
    const link = await screen.findByRole('link', { name: /Ledger/ })
    expect(link.getAttribute('href')).toContain('view=ledger')
  })

  it('a harness owner’s hub lists their recorded sessions, and each opens its ledger', async () => {
    const harness = await agentNamed('admin-claude-code')
    renderApp(`/agents/${harness.id}`)
    const p = (await screen.findByRole('heading', { name: copy.runs.sessions })).closest(
      'section',
    ) as HTMLElement
    expect(await within(p).findByText(copy.runs.harnessWindow)).toBeInTheDocument()
    const links = await within(p).findAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(l.getAttribute('href')).toContain('view=ledger')
    cleanup()
    // The first one's ledger: the owner reads its turns.
    renderApp(links[0]!.getAttribute('href')!)
    expect(within(await table()).getAllByRole('row').length).toBeGreaterThan(1)
    expect(screen.getByRole('columnheader', { name: c.estCost })).toBeInTheDocument()
  })

  it('Trace goes back to the trace', async () => {
    renderApp(ledgerUrl(C4))
    await table()
    const link = screen.getByRole('link', { name: c.trace })
    expect(link.getAttribute('href')).not.toContain('view=ledger')
  })
})
