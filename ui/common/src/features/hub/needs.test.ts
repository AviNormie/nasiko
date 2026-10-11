/**
 * Needs you for one agent and the hub's session sample (plans/feat-agent-centric.md PR1c; CEO R2-5, R2-6; DX one
 * verdict string; eng "Hub sessions"). Pure.
 */
import { describe, expect, it } from 'vitest'
import { hubNeeds, type HubNeedsInput } from './needs'
import { agentRows, sampleStart } from './sessions'

const ok = <T>(value: T) => ({ state: 'ok' as const, value })
const base: HubNeedsInput = {
  requests: ok({ count: 0, firstChat: null, firstRequest: null }),
  status: ok({ rating: 'healthy', reason: null, incomplete: false }),
  sessions: ok({ found: 3, checked: 3, failed: 0, scanned: 25 }),
}

describe('hub Needs you', () => {
  it('says "No issues found in checked data" only when every source answered with nothing', () => {
    const n = hubNeeds(base)
    expect(n.clear).toBe(true)
    expect(n.coverage).toEqual({
      requests: true,
      status: true,
      sessions: { found: 3, checked: 3, failed: 0, scanned: 25 },
    })
    expect(hubNeeds({ ...base, sessions: { state: 'loading' } }).clear).toBe(false)
    expect(hubNeeds({ ...base, sessions: { state: 'loading' } }).coverage).toBeNull()
  })

  it('a failed source is its own line, never the verdict', () => {
    const n = hubNeeds({ ...base, requests: { state: 'failed' } })
    expect(n.failed).toEqual(['requests'])
    expect(n.clear).toBe(false)
  })

  it('an incomplete rating (a cost input down) can’t vouch for the status source', () => {
    const n = hubNeeds({
      ...base,
      status: ok({ rating: 'healthy', reason: null, incomplete: true }),
    })
    expect(n.failed).toEqual(['status'])
    expect(n.clear).toBe(false)
  })

  it('orders action, then requests, then watch, then failed sessions', () => {
    const rows = (rating: 'action' | 'watch') =>
      hubNeeds({
        requests: ok({ count: 2, firstChat: 'c1', firstRequest: 'r1' }),
        status: ok({ rating, reason: 'Crashed', incomplete: false }),
        sessions: ok({ found: 5, checked: 4, failed: 1, scanned: 25 }),
      }).rows.map((r) => r.kind)
    expect(rows('action')).toEqual(['status', 'requests', 'sessions'])
    expect(rows('watch')).toEqual(['requests', 'status', 'sessions'])
  })

  it('a harness (no rating) can still be clear on what was checked', () => {
    const n = hubNeeds({ ...base, status: { state: 'absent' } })
    expect(n.clear).toBe(true)
    expect(n.coverage?.status).toBe(false)
  })
})

describe('the hub session sample', () => {
  const now = new Date('2026-03-20T15:00:00Z')
  it('starts at the later of creation and Sessions’ 7-day bound', () => {
    expect(sampleStart('2026-03-18T00:00:00Z', now).toISOString()).toBe('2026-03-18T00:00:00.000Z')
    const old = sampleStart('2025-01-01T00:00:00Z', now)
    expect(now.getTime() - old.getTime()).toBeLessThanOrEqual(7 * 86_400_000)
    expect(now.getTime() - old.getTime()).toBeGreaterThan(6.9 * 86_400_000)
  })

  it('keeps this agent’s rows (raw name) created after the start', () => {
    const start = new Date('2026-03-18T00:00:00Z')
    const row = (agent_id: string, start_time: string) =>
      ({ session_id: `${agent_id}-${start_time}`, agent_id, start_time }) as never
    const rows = agentRows(
      [
        row('a', '2026-03-19T00:00:00Z'),
        row('b', '2026-03-19T00:00:00Z'),
        row('a', '2026-03-17T00:00:00Z'),
      ],
      'a',
      start,
    )
    expect(rows).toHaveLength(1)
  })
})
