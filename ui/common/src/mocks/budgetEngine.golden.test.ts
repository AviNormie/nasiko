// @vitest-environment node
// The golden fixtures (docs/requirements/budgets.md §14): the mock engine answers the scenario with the spec's exact
// numbers, so the backend's tests and the UI's mock agree on one hand-checked world (plan feat-budget-burn #45).
import { describe, expect, it } from 'vitest'
import {
  alertsList,
  atRisk,
  breakdown,
  burn,
  changes,
  hours,
  statusList,
  traces,
  unbudgeted,
  worldFromScenario,
  type Viewer,
  type World,
} from './budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from './seed-budgets'

const NOW = Date.parse(GOLDEN_ANCHOR)
const ADMIN = '5eed0017-0000-4000-8000-000000000000'
const fresh = (): World => worldFromScenario(budgetScenario(), { adminId: ADMIN, edition: 'ee' })
const admin: Viewer = { id: ADMIN, superuser: true }
const dev: Viewer = { id: I.dev, superuser: false }
const ana: Viewer = { id: I.ana, superuser: false }
const fin: Viewer = { id: I.fin, superuser: false, finance: true }
const q = (scope: string, id: string | null = null) => ({ scope, id })

describe('§14.4 figures at as_of', () => {
  it.each([
    ['org', null, 'all_priced', 155, 1, 'ok', null, false],
    ['unit', I.platform, 'all_priced', 101, 1, 'warning', 50, false],
    ['unit', I.growth, 'all_priced', 24, 1, 'ok', null, false],
    ['owner', I.dev, 'routed_calls', 121, 0, 'warning', 80, false],
    ['agent', I.pricing, 'routed_calls', 81, 0, 'warning', 80, false],
    ['agent', I.reviewer, 'routed_calls', 50, 0, 'exceeded', 100, true],
    ['session', I.s1, 'routed_calls', 10, 0, 'exceeded', 100, true],
  ] as const)('%s %s', (scope, id, covers, used, unpriced, state, crossed, stopped) => {
    const b = burn(fresh(), admin, q(scope, id), NOW)
    expect(b.as_of).toBe('2026-10-14T12:00:00.000Z')
    expect(b.covers).toBe(covers)
    expect(b.used_usd).toBe(used)
    expect(b.unpriced_calls).toBe(unpriced)
    expect(b.budget).toMatchObject({ state, crossed, stopped })
  })

  it('the fleet splits 131 routed + 14 traced + 10 harness estimates; the dedupe call counts once', () => {
    const b = burn(fresh(), admin, q('org'), NOW)
    expect(b.sources).toEqual({ routed_usd: 131, traced_usd: 14, harness_estimate_usd: 10 })
    expect(b.exact_dedupe_from).toBeNull()
    expect(b.daily.find((d) => d.date === '2026-10-12')).toMatchObject({ cost_usd: 14 })
  })

  it('Dev: calls billed to you 121, your agents’ spend 131; Ana without a budget reads all priced 34, her agents 24', () => {
    expect(burn(fresh(), admin, q('owner', I.dev), NOW)).toMatchObject({
      used_usd: 121,
      outside: { traced_usd: 0, harness_estimate_usd: 0 },
      owned_agents: { used_usd: 131 },
    })
    expect(burn(fresh(), admin, q('owner', I.ana), NOW)).toMatchObject({
      covers: 'all_priced',
      used_usd: 34,
      unpriced_calls: 1,
      budget: null,
      owned_agents: { used_usd: 24 },
    })
  })

  it('B-growth is a quarter; Platform says its membership history starts Oct 6', () => {
    expect(burn(fresh(), admin, q('unit', I.growth), NOW)).toMatchObject({
      period: 'quarter',
      period_start: '2026-10-01T00:00:00.000Z',
      resets_at: '2027-01-01T00:00:00.000Z',
    })
    expect(burn(fresh(), admin, q('unit', I.platform), NOW).membership).toEqual({
      history_from: '2026-10-06',
      basis_before: 'current_membership',
    })
  })

  it('B-org has $150 of same-period limits inside it (B-growth is a quarter)', () => {
    const s = statusList(fresh(), admin, q('org'), NOW)
    expect(s.data[0]).toMatchObject({
      budget_id: I.bOrg,
      limits_inside_usd: 150,
      limits_inside_count: 1,
    })
  })

  it('B-review’s burn: two limit steps, its daily series and its eight events', () => {
    const b = burn(fresh(), admin, q('agent', I.reviewer), NOW)
    expect(b.calls).toBe(15)
    expect(b.budget!.limits).toEqual([
      {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-10T09:00:00.000Z',
        version: 1,
        limit_usd: 40,
        thresholds: [50, 80, 100],
        action: 'stop',
      },
      {
        from: '2026-10-10T09:00:00.000Z',
        to: null,
        version: 2,
        limit_usd: 50,
        thresholds: [50, 80, 100],
        action: 'stop',
      },
    ])
    expect(b.daily.map((d) => d.cost_usd)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 10, 2, 2, 2, 2, 0])
    expect(b.events.map((e) => [e.at.slice(5, 16), e.kind, e.version, e.percent])).toEqual([
      ['10-05T14:00', 'threshold', 1, 50],
      ['10-08T14:00', 'threshold', 1, 80],
      ['10-09T15:20', 'threshold', 1, 100],
      ['10-09T15:20', 'stopped', 1, null],
      ['10-10T09:00', 'limit_changed', 2, null],
      ['10-10T09:00', 'resumed', 2, null],
      ['10-13T14:00', 'threshold', 2, 100],
      ['10-13T14:00', 'stopped', 2, null],
    ])
    expect(b.events.find((e) => e.kind === 'limit_changed')).toMatchObject({
      from_usd: 40,
      to_usd: 50,
      by: I.dev,
    })
  })
})

describe('§14.5 alerts', () => {
  it('every threshold and forecast alert, at its time and amount', () => {
    const rows = alertsList(fresh(), admin, { ...q('org'), kind: 'all' }, NOW).data
    const got = rows
      .map((a) => [
        a.label,
        a.at.slice(5, 16),
        a.kind,
        a.percent,
        a.amount_usd,
        a.stopped,
        a.crosses_on,
      ])
      .reverse()
    expect(got).toEqual([
      ['Pricing Engine', '10-04T00:00', 'forecast', 100, 100, false, '2026-10-17'],
      ['Code Reviewer', '10-05T14:00', 'threshold', 50, 20, false, null],
      ['Dev', '10-08T10:00', 'threshold', 50, 75, false, null],
      ['Code Reviewer', '10-08T14:00', 'threshold', 80, 32, false, null],
      ['Pricing Engine', '10-09T10:00', 'threshold', 50, 50, false, null],
      ['Review the pricing PR', '10-09T15:10', 'threshold', 50, 4, false, null],
      // Same instant: percent desc, then id desc (newest first), so reversed here.
      ['Review the pricing PR', '10-09T15:20', 'threshold', 80, 6.4, false, null],
      ['Code Reviewer', '10-09T15:20', 'threshold', 100, 40, true, null],
      ['Review the pricing PR', '10-09T15:20', 'threshold', 100, 8, true, null],
      ['Platform', '10-12T10:00', 'threshold', 50, 75, false, null],
      ['Code Reviewer', '10-13T14:00', 'threshold', 100, 50, true, null],
      ['Dev', '10-14T10:00', 'threshold', 80, 120, false, null],
      ['Pricing Engine', '10-14T10:00', 'threshold', 80, 80, false, null],
    ])
  })

  it('without kind=all only threshold alerts come back (R-L10 clients)', () => {
    const rows = alertsList(fresh(), admin, q('org'), NOW).data
    expect(rows.every((a) => a.kind === 'threshold' && a.threshold === a.percent)).toBe(true)
  })
})

describe('§14.6 reads', () => {
  it('by unit: Platform 101, Growth 24, overlap 24 / 1 person / 54 outside; Oct 6 reconciles to 11', () => {
    const b = breakdown(fresh(), admin, { ...q('org'), by: 'unit' }, NOW)
    expect(b.keys.map((k) => [k.label, k.cost_usd, k.calls])).toEqual([
      ['Platform', 101, 34],
      ['Growth', 24, 17],
    ])
    expect(b.overlap).toEqual({ cost_usd: 24, people: 1, outside_units_usd: 54 })
    const d6 = b.days.find((d) => d.date === '2026-10-06')!
    expect([d6.items.map((i) => i.cost_usd), d6.overlap_usd, d6.outside_units_usd]).toEqual([
      [1, 1],
      1,
      10,
    ])
  })

  it('by agent over the month', () => {
    const b = breakdown(fresh(), admin, { ...q('org'), by: 'agent' }, NOW)
    expect(b.keys.map((k) => [k.label, k.cost_usd, k.calls, k.unpriced_calls])).toEqual([
      ['Pricing Engine', 81, 14, 0],
      ['Code Reviewer', 50, 15, 0],
      ['Support Bot', 14, 15, 1],
      ['Claude Code', 10, 2, 0],
    ])
  })

  it('changes: this week so far vs the same hours last week, priced only', () => {
    const c = changes(
      fresh(),
      admin,
      {
        ...q('org'),
        by: 'agent',
        from: '2026-10-12T00:00:00Z',
        to: '2026-10-14T12:00:00Z',
        compare_from: '2026-10-05T00:00:00Z',
        compare_to: '2026-10-07T12:00:00Z',
      },
      NOW,
    )
    expect(
      c.items.map((i) => [i.label, i.cost_usd, i.compare_cost_usd, i.delta_usd, i.delta_pct]),
    ).toEqual([
      ['Claude Code', 10, 0, 10, null],
      ['Code Reviewer', 4, 8, -4, -50],
      ['Pricing Engine', 15, 18, -3, -16.67],
      ['Support Bot', 3, 3, 0, 0],
    ])
    expect([c.unpriced_calls, c.compare_unpriced_calls, c.truncated]).toEqual([1, 0, false])
  })

  it('hours of Oct 14: 0-11 only, $1 at 08:00 and $3 at 10:00', () => {
    const h = hours(fresh(), admin, { ...q('org'), date: '2026-10-14' }, NOW)
    expect(h.hours).toHaveLength(12)
    expect(h.hours.filter((x) => x.cost_usd).map((x) => [x.hour, x.cost_usd])).toEqual([
      [8, 1],
      [10, 3],
    ])
  })

  it('traces on Oct 9: F3, F1, F2; shown to admin, redacted for Dev and Fin', () => {
    const query = { ...q('agent', I.reviewer), date: '2026-10-09' }
    const asAdmin = traces(fresh(), admin, query, NOW).data
    expect(asAdmin.map((r) => [r.trace_id?.slice(-2), r.cost_usd, r.user_id])).toEqual([
      ['53', 4, I.ana],
      ['51', 3, I.ana],
      ['52', 3, I.ana],
    ])
    for (const viewer of [dev, fin]) {
      const rows = traces(fresh(), viewer, query, NOW).data
      expect(rows.map((r) => [r.redacted, r.cost_usd, r.trace_id, r.agent_id, r.user_id])).toEqual([
        [true, 4, null, null, null],
        [true, 3, null, null, null],
        [true, 3, null, null, null],
      ])
    }
  })

  it('S1: three turns, ended; Dev and Fin can’t read it, Ana can', () => {
    const s = burn(fresh(), ana, q('session', I.s1), NOW)
    expect(s.turns!.map((t) => [t.at.slice(11, 16), t.cost_usd])).toEqual([
      ['15:00', 3],
      ['15:10', 3],
      ['15:20', 4],
    ])
    expect(s).toMatchObject({
      used_usd: 10,
      daily: [],
      resets_at: null,
      session: { ended_at: '2026-10-09T16:20:00.000Z' },
    })
    for (const viewer of [dev, fin])
      expect(() => burn(fresh(), viewer, q('session', I.s1), NOW)).toThrow('not found')
    expect(() =>
      burn(fresh(), fin, { ...q('agent', I.reviewer), contributor: I.s1, by: 'session' }, NOW),
    ).toThrow('this contributor can’t be selected')
  })

  it('at risk, in order, with the server’s ranking basis (§14.7)', () => {
    const rows = atRisk(fresh(), admin, q('org'), NOW).data
    expect(
      rows.map((r) => [
        r.label,
        r.rank.reason,
        r.rank.runs_out_on,
        r.rank.pace_usd_per_day,
        r.rank.projected_pct,
      ]),
    ).toEqual([
      ['Code Reviewer', 'exceeded', null, 3.71428571, 230],
      ['Pricing Engine', 'runs_out', '2026-10-17', 6, 186],
      ['Dev', 'runs_out', '2026-10-18', 8.28571429, 177.33],
      ['Platform', 'runs_out', '2026-10-22', 5.85714286, 135.67],
    ])
    expect(atRisk(fresh(), fin, q('org'), NOW).data).toHaveLength(4)
  })

  it('unbudgeted: Support Bot, then Claude Code', () => {
    const rows = unbudgeted(fresh(), admin, q('org'), NOW).data
    expect(
      rows.map((r) => [
        r.label,
        r.used_usd,
        r.traced_usd,
        r.harness_estimate_usd,
        r.routed_calls,
        r.unpriced_calls,
        r.harness,
      ]),
    ).toEqual([
      ['Support Bot', 14, 14, 0, 0, 1, false],
      ['Claude Code', 10, 0, 10, 0, 0, true],
    ])
  })

  it('a member can’t read the fleet or another owner (404, not 403)', () => {
    expect(() => burn(fresh(), dev, q('org'), NOW)).toThrow('not found')
    expect(() => burn(fresh(), dev, q('owner', I.ana), NOW)).toThrow('not found')
  })
})
