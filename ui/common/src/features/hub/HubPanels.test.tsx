/**
 * The hub's PR1c sections on the agent's Overview (plans/feat-agent-centric.md PR1c; design "Hub section order",
 * "Needs you on the hub", "Layer cards"; CEO R2-5, R2-6, R2-7): Needs you, Recent runs, the layer cards, and the facts
 * that moved to Details.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequests } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()
afterEach(() =>
  configureMocks({ seed, now, loggedIn: true, variant: null, persona: null, chatVariants: [] }),
)

const agent = seed.agents[0]!
const url = (q = '') => `/agents/${agent.id}${q}`
const panel = async (name: string) =>
  (await screen.findByRole('heading', { name })).closest('section') as HTMLElement

describe('section order', () => {
  it('Needs you, the sentence, the window bar, the lanes, recent runs, then the layer cards', async () => {
    renderApp(url())
    await screen.findByText(copy.lanes.peakP95)
    const order = [
      await panel(copy.needs.title),
      screen.getByText(/^Spent |^No spend/),
      screen.getByRole('group', { name: copy.keyboard }),
      await panel(copy.runs.sessions),
      screen.getByRole('region', { name: copy.cards.title }),
    ]
    for (let i = 1; i < order.length; i++)
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
  })
})

describe('Needs you', () => {
  it('states what it checked, and its verdict or rows', async () => {
    renderApp(url())
    const p = await panel(copy.needs.title)
    expect(await within(p).findByText(/^Checked /)).toHaveTextContent(copy.needs.partRequests)
  })

  it('a crashed agent needs action, rated on the last 7 days', async () => {
    renderApp(`/agents/${seed.agents[2]!.id}`)
    const p = await panel(copy.needs.title)
    expect(await within(p).findByText(copy.needs.statusAction)).toBeInTheDocument()
    expect(within(p).getByText(copy.needs.ratedOn)).toBeInTheDocument()
  })

  it('this agent’s pending requests show with a way to answer them', async () => {
    configureMocks({ chatVariants: ['waiting'] })
    renderApp(url())
    const p = await panel(copy.needs.title)
    expect(await within(p).findByText(/waiting for you$/)).toBeInTheDocument()
  })

  it('a failed requests read is its own line with Retry, never the verdict', async () => {
    configureMocks({ chatVariants: ['pending-fail'] })
    renderApp(url())
    const p = await panel(copy.needs.title)
    expect(await within(p).findByText(copy.needs.failed.requests)).toBeInTheDocument()
    expect(within(p).queryByText(copy.needs.clear)).toBeNull()
  })
})

describe('Recent runs', () => {
  it('reads one bounded session sample from at most 7 days back', async () => {
    const rec = recordRequests()
    renderApp(url())
    await panel(copy.runs.sessions)
    await waitFor(() =>
      expect(rec.urls.some((u) => u.pathname.endsWith('/session/list'))).toBe(true),
    )
    rec.stop()
    const reads = rec.urls.filter(
      (u) => u.pathname.endsWith('/session/list') && u.searchParams.get('limit') === '25',
    )
    expect(reads.length).toBeGreaterThan(0)
    const start = Date.parse(reads[0]!.searchParams.get('start_time')!)
    expect(now() - start).toBeLessThanOrEqual(7 * 86_400_000)
  })

  it('an empty sessions list says what it checked and links to Sessions', async () => {
    renderApp(url())
    const p = await panel(copy.runs.sessions)
    expect(
      await within(p).findByRole('link', { name: copy.runs.sessionsAll(agent.name) }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(p).queryByText(/^None in the latest \d+ sessions checked\.$/) ??
          within(p)
            .queryAllByRole('link')
            .find((l) => /^\/sessions\/./.test(l.getAttribute('href') ?? '')),
      ).toBeTruthy(),
    )
  })

  it('lists only flows this agent started, and says so when none are in the window', async () => {
    configureMocks({ variant: 'flows-empty' })
    renderApp(url())
    const p = await panel(copy.runs.flows)
    expect(await within(p).findByText(copy.runs.flowsNone)).toBeInTheDocument()
  })
})

describe('layer cards', () => {
  it('the owner sees Routing, Tools, Optimization and the Budget preview', async () => {
    renderApp(url())
    const cards = await screen.findByRole('region', { name: copy.cards.title })
    for (const t of [
      copy.cards.routing,
      copy.cards.tools,
      copy.cards.optimization,
      copy.cards.budget,
    ])
      expect(
        await within(cards).findByRole('heading', { name: new RegExp(`^${t}`) }),
      ).toBeInTheDocument()
    expect(within(cards).getByText(copy.rail.preview)).toBeInTheDocument()
  })

  it('another viewer sees only Optimization, and never reads routing or tools', async () => {
    configureMocks({ persona: 'sam' })
    const rec = recordRequests()
    renderApp(url())
    const cards = await screen.findByRole('region', { name: copy.cards.title })
    expect(
      within(cards)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual([copy.cards.optimization])
    rec.stop()
    expect(rec.urls.filter((u) => u.pathname.endsWith('/llm-config'))).toEqual([])
    expect(rec.urls.filter((u) => u.pathname.includes('/api/mcp/agents/'))).toEqual([])
  })
})

describe('the facts moved to Details', () => {
  it('Overview no longer carries them; Details does', async () => {
    renderApp(url())
    await screen.findByText(copy.lanes.peakP95)
    expect(screen.queryByRole('heading', { name: 'What it does' })).toBeNull()
    renderApp(url('?tab=details'))
    expect(await screen.findAllByRole('heading', { name: 'What it does' })).not.toHaveLength(0)
  })

  it('Activity no longer lists recent sessions (the hub does)', async () => {
    renderApp(url('?tab=activity'))
    await screen.findByRole('heading', { name: 'Last 24 hours' })
    expect(screen.queryByRole('heading', { name: 'Recent sessions' })).toBeNull()
  })
})
