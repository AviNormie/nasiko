/**
 * Regression: ISSUE-006 — an agent with no sessions in its sample read "the latest 0 sessions"
 * Found by /qa on 2026-10-11 (PR1c)
 * Report: .gstack/qa-reports/qa-report-localhost-2026-10-11.md
 *
 * The hub's session sample starts at the agent's creation (or 7 days back), so a harness created today scanned nothing,
 * and both Needs you and Recent sessions said "latest 0 sessions". An empty sample means this agent had none in 7 days.
 */
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { copy } from './copy'

setupPinnedSeed()

const panel = async (name: string) =>
  (await screen.findByRole('heading', { name })).closest('section') as HTMLElement

describe('an empty session sample', () => {
  it('says none in the last 7 days, never "the latest 0 sessions"', () => {
    expect(copy.needs.partSessions(0, 0, 0)).toBe("this agent's sessions (none in the last 7 days)")
    expect(copy.runs.sessionsNone(0)).toBe('None in the last 7 days.')
    expect(copy.runs.sessionsNone(1)).toBe('None in the latest 1 session checked.')
    expect(copy.needs.partSessions(0, 0, 25)).toContain('the latest 25 sessions you can see')
  })

  it('a harness created today reads that way on its hub', async () => {
    const rows = (await (await fetch('/api/agents?limit=100&offset=0')).json()) as {
      id: string
      name: string
      created_at: string
    }[]
    const harness = rows.find((a) => a.name === 'admin-claude-code')!
    renderApp(`/agents/${harness.id}`)
    const runs = await panel(copy.runs.sessions)
    const needs = await panel(copy.needs.title)
    await within(needs).findByText(/^Checked /)
    for (const p of [runs, needs]) expect(p).not.toHaveTextContent(/latest 0 sessions/)
  })
})
