import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'

setupPinnedSeed()

const live = seed.agents.filter((a) => !a.deleted)
const cards = () =>
  screen
    .getAllByRole('link')
    .filter((l) => l.getAttribute('href')?.match(/^\/agents\/[0-9a-f-]{36}$/))
const ready = () => screen.findByRole('link', { name: new RegExp(live[0]!.display_name) })
const search = (router: { state: { location: { search: unknown } } }) =>
  router.state.location.search as Record<string, unknown>

describe('Agents catalog filter chips after the FilterChip extraction', () => {
  it('draws Yours and the tag chips as toggle buttons that start unpressed', async () => {
    renderApp('/agents')
    await ready()
    expect(screen.getByRole('button', { name: 'Yours', pressed: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ops', pressed: false })).toBeInTheDocument()
  })

  it('Yours presses, writes ?yours and releases again', async () => {
    const { router } = renderApp('/agents')
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Yours', pressed: false }))
    await waitFor(() => expect(search(router).yours).toBe(true))
    expect(screen.getByRole('button', { name: 'Yours', pressed: true })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Yours', pressed: true }))
    await waitFor(() => expect(search(router).yours).toBeUndefined())
    expect(screen.getByRole('button', { name: 'Yours', pressed: false })).toBeInTheDocument()
    await waitFor(() => expect(cards()).toHaveLength(live.length))
  })

  it('a tag chip presses, narrows the list, writes ?tag and releases again', async () => {
    const { router } = renderApp('/agents')
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'ops', pressed: false }))
    await waitFor(() => expect(search(router).tag).toBe('ops'))
    await waitFor(() => expect(cards().length).toBeLessThan(live.length))
    expect(screen.getByRole('button', { name: 'ops', pressed: true })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'ops', pressed: true }))
    await waitFor(() => expect(search(router).tag).toBeUndefined())
    await waitFor(() => expect(cards()).toHaveLength(live.length))
  })

  it('switching to another tag leaves only that one pressed', async () => {
    const { router } = renderApp('/agents')
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'ops', pressed: false }))
    await waitFor(() => expect(search(router).tag).toBe('ops'))
    const other = screen
      .getAllByRole('button', { pressed: false })
      .find((b) => ['data', 'support', 'customer', 'analytics'].includes(b.textContent ?? ''))
    expect(other).toBeDefined()
    await userEvent.click(other!)
    await waitFor(() => expect(search(router).tag).toBe(other!.textContent))
    expect(screen.getByRole('button', { name: 'ops', pressed: false })).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { pressed: true }).some((b) => b.textContent === 'ops'),
    ).toBe(false)
  })

  it('opens a deep link with both chips already pressed', async () => {
    renderApp('/agents?yours=1&tag=ops')
    await screen.findByRole('button', { name: 'Yours', pressed: true })
    expect(screen.getByRole('button', { name: 'ops', pressed: true })).toBeInTheDocument()
  })

  it('keeps Yours and a tag together and clears them one at a time', async () => {
    const { router } = renderApp('/agents')
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Yours', pressed: false }))
    await userEvent.click(screen.getByRole('button', { name: 'ops', pressed: false }))
    await waitFor(() => expect(search(router)).toMatchObject({ yours: true, tag: 'ops' }))
    await userEvent.click(screen.getByRole('button', { name: 'ops', pressed: true }))
    await waitFor(() => expect(search(router).tag).toBeUndefined())
    expect(search(router).yours).toBe(true)
    expect(screen.getByRole('button', { name: 'Yours', pressed: true })).toBeInTheDocument()
  })

  it('renders the extracted card for every visible agent with its status and owner chip', async () => {
    renderApp('/agents')
    await ready()
    const links = cards()
    expect(links).toHaveLength(live.length)
    for (const link of links) {
      expect(link.textContent).toMatch(/Yours|Available to you/)
      expect(link.textContent).toMatch(
        /Running|Deploying|Needs attention|Stopped|Not deployed|Unknown/,
      )
    }
  })
})
