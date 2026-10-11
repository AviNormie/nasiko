// Regression: ISSUE-004 — a coding harness's hub asked for the per-agent savings series, which a harness never has
// (the request failed with a 400 in the console)
// Found by /qa on 2026-10-11
// Report: (session scratchpad) qa/qa-report-localhost-2026-10-11.md
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { setupPinnedSeed } from '@/test/pinnedSeed'
import { renderApp } from '@/test/renderApp'
import { recordRequests } from '@/test/setup'
import { copy } from './copy'

setupPinnedSeed()

describe('a coding harness hub', () => {
  it('reads no savings series', async () => {
    const rows = (await (await fetch('/api/agents?limit=100&offset=0')).json()) as {
      id: string
      name: string
    }[]
    // The seed admin's own harness: its finops are visible, so the hub gets past the gate.
    const harness = rows.find((a) => a.name === 'admin-claude-code')!
    const rec = recordRequests()
    renderApp(`/agents/${harness.id}`)
    await screen.findByText(copy.lanes.peakP95)
    rec.stop()
    expect(rec.urls.filter((u) => u.pathname.endsWith('/finops/context-savings'))).toHaveLength(0)
  })
})
