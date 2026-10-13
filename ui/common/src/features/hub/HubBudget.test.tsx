/**
 * The hub's Budget section (plans/feat-budget-burn.md F10, F13, B5; ledger #83): owner and superuser only; the agent's
 * burn with its bars by model, strip and levers; no budget → burn-up and "Set a budget" for this agent; a failed read →
 * a panel error with Retry; a server without budgets or a harness without routed calls → nothing. The agent's own
 * changes join the budget's flags (`withExtraMarkers`).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { BurnChartData } from '@/components/charts/burn-chart'
import { withExtraMarkers } from '@/features/budgets/chartData'
import { copy as budgetCopy } from '@/features/budgets/copy'
import type { BudgetEvent } from '@/features/budgets/types'
import { configureMocks } from '@/mocks/handlers'
import { agentNamed, agentWhere } from '@/test/agents'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequestBodies, recordRequests, server } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() =>
  configureMocks({
    seed,
    now,
    loggedIn: true,
    variant: null,
    persona: null,
    budgetVariants: [],
    onboarding: { persona: null, completed: true },
  }),
)

const T = { timeout: 10_000 }
const named = (display: string) =>
  agentWhere((a) => (a as { display_name?: string }).display_name === display)
const section = () => screen.findByRole('region', { name: budgetCopy.hubTitle }, T)
/** Needs you has every source's answer (its coverage line shows), the budget's included: the section has decided. */
const settled = () => screen.findByText(/^Checked /, undefined, T)
const noSection = () =>
  expect(screen.queryByRole('region', { name: budgetCopy.hubTitle })).toBeNull()

describe('the hub’s Budget section', () => {
  it('a stopped budget: the sentence, Review actions, bars by model and the levers', async () => {
    const a = await named('Code Reviewer')
    renderApp(`/agents/${a.id}`)
    const s = await section()
    expect(within(s).getByText(/^Ran out .*calls are stopped/)).toBeInTheDocument()
    expect(within(s).getByRole('button', { name: budgetCopy.reviewActions })).toBeInTheDocument()
    expect(within(s).getByRole('radio', { name: 'Model' })).toBeChecked()
    expect(
      await within(s).findByRole('heading', { name: budgetCopy.leversTitle }, T),
    ).toBeInTheDocument()
  })

  it('the agent’s own changes join the budget’s flags; its stop is said once (Table)', async () => {
    const a = await named('Code Reviewer')
    renderApp(`/agents/${a.id}`)
    const s = await section()
    await userEvent.click(within(s).getByRole('button', { name: budgetCopy.showTable }))
    const events = await within(s).findByRole('region', { name: budgetCopy.tableEvents }, T)
    // The event log's changes sit beside the budget's own events, one line per day.
    await waitFor(() => expect(events).toHaveTextContent('Restarted'), T)
    expect(events).toHaveTextContent('Token optimization turned on')
    expect(events).toHaveTextContent('Crossed 100% · Calls stopped')
    // Its own record of the stop is the budget's stop (BG-3 wins): said once.
    expect(events.textContent?.match(/stop/gi)?.length).toBe(1)
  })

  it('no budget: burn-up, and Set a budget opens the editor for this agent', async () => {
    const a = await named('Legal Reviewer')
    const rec = recordRequestBodies()
    renderApp(`/agents/${a.id}`)
    const s = await section()
    expect(within(s).queryByRole('radio', { name: budgetCopy.burnDown })).toBeNull()
    await userEvent.click(within(s).getByRole('button', { name: budgetCopy.setBudget }))
    const sheet = await screen.findByRole('dialog', { name: budgetCopy.budgetNew })
    expect(sheet).toHaveTextContent(`${budgetCopy.budgetFor}: Legal Reviewer`)
    await userEvent.type(within(sheet).getByLabelText(budgetCopy.monthlyLimit), '25')
    await userEvent.click(within(sheet).getByRole('button', { name: budgetCopy.save }))
    await waitFor(() => expect(sheet).not.toBeInTheDocument())
    await rec.flush()
    expect(rec.requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      scope: 'agent',
      agent_id: a.id,
      limit_usd: 25,
    })
    rec.stop()
  })

  it('Needs you lists the stopped budget, with its sentence and a way to the section (F8)', async () => {
    const a = await named('Code Reviewer')
    renderApp(`/agents/${a.id}`)
    const needs = (await screen.findByRole('heading', { name: copy.needs.title })).closest(
      'section',
    )!
    const row = (
      await within(needs).findByText(/^Ran out .*calls are stopped/, undefined, T)
    ).closest('li')!
    expect(within(row).getByText(copy.needs.budgetBadge)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: copy.needs.reviewBudget })).toHaveAttribute(
      'href',
      '#hub-budget',
    )
  })

  it('a recent model pin draws its expected line until 3 days of new data; an older one none (F13)', async () => {
    const a = await named('Invoice Parser')
    const pinAt = (daysBack: number) => new Date(now() - daysBack * 86_400_000).toISOString()
    let at = pinAt(1)
    server.use(
      http.get('*/api/observability/agent/:id/events', () =>
        HttpResponse.json({
          data: {
            events: [
              {
                id: 'e1',
                kind: 'route_change',
                at,
                actor: 'admin',
                summary: 'Routing switched to gpt-4o-mini',
              },
            ],
            truncated: false,
          },
        }),
      ),
    )
    renderApp(`/agents/${a.id}`)
    const s = await section()
    expect(
      await within(s).findByText(/^Expected without the .* change$/, undefined, T),
    ).toBeInTheDocument()
    cleanup()
    at = pinAt(5)
    renderApp(`/agents/${a.id}`)
    const s2 = await section()
    await within(s2).findByText(budgetCopy.burnUp, undefined, T)
    expect(within(s2).queryByText(/^Expected without the/)).toBeNull()
  })

  it('another viewer gets no section and reads no burn', async () => {
    configureMocks({ persona: 'sam' })
    const rec = recordRequests()
    renderApp(`/agents/${seed.agents[0]!.id}`)
    await settled()
    noSection()
    rec.stop()
    expect(rec.urls.filter((u) => u.pathname === '/api/budgets/burn')).toEqual([])
  })

  it('a failed burn read is a panel error whose Retry reads it again', async () => {
    const a = await named('Code Reviewer')
    let fail = true
    server.use(
      http.get('*/api/budgets/burn', () =>
        fail ? HttpResponse.json({ error: 'nope', code: 'bad' }, { status: 400 }) : undefined,
      ),
    )
    renderApp(`/agents/${a.id}`)
    const retry = await screen.findByRole('button', { name: /retry/i }, T)
    expect(screen.getByText(`Couldn't load ${copy.budgetSection}`)).toBeInTheDocument()
    fail = false
    await userEvent.click(retry)
    expect(await section()).toBeInTheDocument()
  })

  it('a server without budgets: no section, once the probe answered', async () => {
    configureMocks({ budgetVariants: ['budgets-absent'] })
    const a = await named('Code Reviewer')
    const rec = recordRequests()
    renderApp(`/agents/${a.id}`)
    await settled()
    rec.stop()
    expect(rec.urls.some((u) => u.pathname === '/api/budgets/capabilities')).toBe(true)
    noSection()
  })

  it('a harness with no routed calls this period has no section', async () => {
    const h = await agentNamed('admin-claude-code')
    const rec = recordRequests()
    renderApp(`/agents/${h.id}`)
    await settled()
    rec.stop()
    // Its burn was read (the harness rule decided, not a missing read).
    expect(rec.urls.some((u) => u.pathname === '/api/budgets/burn')).toBe(true)
    noSection()
  })
})

describe('withExtraMarkers', () => {
  const day = (d: string, h = 12) => Date.parse(`2026-10-${d}T${String(h).padStart(2, '0')}:00:00Z`)
  const base = {
    start: day('01', 0),
    end: day('31', 0),
    markers: [{ day: '2026-10-05', t: day('05'), labels: ['Reached 50%'] }],
  } as unknown as BurnChartData
  const stopped = { kind: 'stopped', at: new Date(day('09')).toISOString() } as BudgetEvent

  it('merges one flag per day and leaves out changes outside the axis', () => {
    const out = withExtraMarkers(
      base,
      [
        { at: day('05', 9), label: 'Build completed' },
        { at: day('07'), label: 'Restarted' },
        { at: Date.parse('2026-09-30T12:00:00Z'), label: 'Too early' },
      ],
      [],
    )
    expect(out.markers.map((m) => [m.day, m.labels])).toEqual([
      ['2026-10-05', ['Reached 50%', 'Build completed']],
      ['2026-10-07', ['Restarted']],
    ])
  })

  it('the event log’s stop within a minute of the budget’s own is the same stop (BG-3 wins)', () => {
    const out = withExtraMarkers(
      base,
      [
        { at: day('09') + 30_000, label: 'Budget stop', budgetStop: true },
        { at: day('20'), label: 'Budget stop', budgetStop: true },
      ],
      [stopped],
    )
    expect(out.markers.map((m) => m.day)).toEqual(['2026-10-05', '2026-10-20'])
  })
})
