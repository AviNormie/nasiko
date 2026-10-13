/**
 * Needs you rendered on its own with hand-built data (ship coverage audit): the states and links the page tests can't
 * reach deterministically from the seed (plans/feat-overview.md §6-§10). The home (PR2) keeps this card; the Overview's
 * other cards were retired with the Overview page (plans/feat-agent-centric.md PR2a).
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readRailView } from '@/features/chat/rememberTarget'
import type { NeedsYou as NeedsYouData } from './api'
import { NeedsYou } from './components/NeedsYou'
import { copy } from './copy'
import { mergeNeeds, type NeedsInput } from './needs'

function renderInRouter(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{node}</> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

const retries = () => ({ requests: vi.fn(), agents: vi.fn(), budgets: vi.fn(), sessions: vi.fn() })
const needsData = (input: NeedsInput, retry = retries()): NeedsYouData => ({
  needs: mergeNeeds(input),
  lastChecked: 0,
  retry,
  sessions: {} as NeedsYouData['sessions'],
  waiting: {} as NeedsYouData['waiting'],
})

describe('Needs you rows', () => {
  it('links every row kind to the page that resolves it', async () => {
    renderInRouter(
      <NeedsYou
        userId="u1"
        now={Date.parse('2026-09-29T12:00:00Z')}
        data={needsData({
          requests: {
            state: 'ok',
            value: {
              chats: [
                {
                  sessionId: 's1',
                  firstId: 'r1',
                  kind: 'input_required',
                  count: 2,
                  chatTitle: 'Deploy chat',
                  at: '2026-09-29T11:00:00Z',
                },
              ],
              outside: 1,
            },
          },
          agents: {
            state: 'ok',
            value: [
              { id: 'a1', name: 'Crashy', reason: 'crashed', budget: false },
              { id: 'a2', name: 'Spender', reason: copy.reason.budgetStopped, budget: true },
            ],
          },
          budgets: {
            state: 'ok',
            value: [
              {
                id: 'b1',
                label: copy.needs.yourBudget,
                agentId: null,
                crossed: 80,
                state: 'warning',
                over: null,
                stopped: false,
                stops: false,
                runsOutOn: null,
                resetsAt: null,
                period: 'month' as const,
                covers: 'routed_calls' as const,
              },
              {
                id: 'b2',
                label: 'Helper',
                agentId: 'a3',
                crossed: null,
                state: 'exceeded',
                over: null,
                stopped: false,
                stops: false,
                runsOutOn: null,
                resetsAt: null,
                period: 'month' as const,
                covers: 'routed_calls' as const,
              },
            ],
          },
          sessions: {
            state: 'ok',
            value: { failed: 3, checked: 25, agents: ['Crashy', 'Unknown agent'] },
          },
        })}
      />,
    )
    const list = await screen.findByRole('list', { name: copy.needs.title })
    const href = (name: string | RegExp) =>
      within(list).getByRole('link', { name }).getAttribute('href')
    expect(within(list).getByText('Input needed (+1 more)')).toBeInTheDocument()
    expect(href(copy.needs.reviewLabel('Deploy chat'))).toBe('/chat/s1')
    expect(href(copy.needs.openWaiting)).toBe('/chat')
    expect(href(copy.needs.openAgentLabel('Crashy'))).toBe('/agents/a1')
    // A stopped agent budget opens the agent's Budget section on its hub (B5).
    expect(href(copy.needs.agentBudgetLabel('Spender'))).toBe('/agents/a2#hub-budget')
    expect(within(list).getByText('Your monthly budget is at 80%')).toBeInTheDocument()
    expect(within(list).getByText('Helper budget is over its limit')).toBeInTheDocument()
    expect(href(copy.needs.agentBudgetLabel('Helper'))).toBe('/agents/a3#hub-budget')
    expect(within(list).getByText(copy.needs.sessions(3, 25))).toBeInTheDocument()
    expect(href(copy.needs.seeFailing)).toMatch(/^\/sessions\?(?=.*preset=7d)(?=.*lane=failing)/)
    // Severity is said by an icon with a label, most urgent sources first.
    expect(
      within(list)
        .getAllByRole('img')
        .map((i) => i.getAttribute('aria-label')),
    ).toEqual([
      copy.needs.waiting,
      copy.needs.waiting,
      copy.rating.action,
      copy.rating.action,
      copy.rating.watch,
      copy.rating.watch,
      copy.rating.action,
    ])
  })

  it('shows one card error when every source failed, and Retry retries all four', async () => {
    const retry = retries()
    renderInRouter(
      <NeedsYou
        userId="u1"
        now={0}
        data={needsData(
          {
            requests: { state: 'failed' },
            agents: { state: 'failed' },
            budgets: { state: 'failed' },
            sessions: { state: 'failed' },
          },
          retry,
        )}
      />,
    )
    expect(await screen.findByText(copy.couldntLoad(copy.needs.what))).toBeInTheDocument()
    expect(screen.queryByText(copy.couldntCheck(copy.needs.source.requests))).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: copy.retry }))
    for (const fn of Object.values(retry)) expect(fn).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: copy.needs.title }),
    )
  })
})

describe('shadcn conversion review (2026-09-29)', () => {
  it('a failed card is not a live region, so a server outage does not fire five alerts at once', async () => {
    renderInRouter(
      <NeedsYou
        userId="u1"
        now={0}
        data={needsData({
          requests: { state: 'failed' },
          agents: { state: 'failed' },
          budgets: { state: 'failed' },
          sessions: { state: 'failed' },
        })}
      />,
    )
    expect(await screen.findByText(copy.couldntLoad(copy.needs.what))).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// Moved from the retired Overview page tests (plans/feat-agent-centric.md PR2a; /review of PR2a: testing).
describe('Needs you on its own', () => {
  it('the outside-Chat row opens Chat on the Waiting view', async () => {
    renderInRouter(
      <NeedsYou
        userId="u1"
        now={0}
        data={needsData({
          requests: { state: 'ok', value: { chats: [], outside: 2 } },
          agents: { state: 'ok', value: [] },
          budgets: { state: 'absent' },
          sessions: { state: 'ok', value: { failed: 0, checked: 25, agents: [] } },
        })}
      />,
    )
    await userEvent.click(await screen.findByRole('link', { name: copy.needs.openWaiting }))
    expect(readRailView('u1')).toBe('waiting')
  })

  it('on OSS (budgets absent) shows one card error when every available source failed', async () => {
    renderInRouter(
      <NeedsYou
        userId="u1"
        now={0}
        data={needsData({
          requests: { state: 'failed' },
          agents: { state: 'failed' },
          budgets: { state: 'absent' },
          sessions: { state: 'failed' },
        })}
      />,
    )
    expect(await screen.findByText(copy.couldntLoad(copy.needs.what))).toBeInTheDocument()
  })
})
