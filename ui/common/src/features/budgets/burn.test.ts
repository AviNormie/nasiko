// @vitest-environment node
// Budget burn's pure rules (plan feat-budget-burn §5, F1, F2, F4, F6). The golden reads come from the mock engine over
// docs/requirements/budgets.md §14, so the UI's numbers match the spec's hand-checked ones (§14.7).
import { describe, expect, it } from 'vitest'
import { burn as engineBurn, worldFromScenario, type Viewer } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import {
  allowance,
  chartModel,
  cheaperModelEstimate,
  compressionEstimate,
  figures,
  previewLine,
  projection,
  quarterProjection,
  raiseTo,
  runOut,
  spikes,
  stopEstimate,
  tableRows,
  weekStart,
  whatIf,
  whatIfProblem,
} from './burn'
import type { Burn } from './types'

const NOW = Date.parse(GOLDEN_ANCHOR)
const DAY = 86_400_000
const admin: Viewer = { id: 'admin', superuser: true }
const read = (scope: string, id: string | null = null, extra: Record<string, string> = {}): Burn =>
  engineBurn(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    admin,
    { scope, id, ...extra },
    NOW,
  )
const price = () => read('agent', I.pricing, { include_previous: 'true' })

describe('projection and band (§5, budgets.md §14.7)', () => {
  it('Pricing Engine: pace 6, 17.5 days left, projected 186 (the 30-day and 7-day rates agree)', () => {
    const p = projection(price())!
    expect(p.pace).toBe(6)
    expect(p.daysLeft).toBe(17.5)
    expect(p.band).toMatchObject({ low: 186, high: 186, lowRate: 6, highRate: 6 })
    expect(p.projectedPct).toBeCloseTo(186, 10)
  })

  it('the fleet: pace 85/7, projected 367.5', () => {
    const p = projection(read('org'))!
    expect(p.pace).toBeCloseTo(85 / 7, 10)
    expect(p.band.high).toBeCloseTo(367.5, 10)
    // The 30-day rate is the period so far (13 complete days, $151): below the 7-day pace, so it is the low edge.
    expect(p.band.low).toBeCloseTo(155 + (151 / 13) * 17.5, 10)
  })

  it('needs 3 complete days; a session has none', () => {
    const early = { ...price(), as_of: '2026-10-03T12:00:00Z' }
    expect(
      projection({ ...early, daily: early.daily.filter((d) => d.date <= '2026-10-03') }),
    ).toBeNull()
    expect(projection(read('session', I.s1))).toBeNull()
  })

  it('the band swaps when the 30-day rate runs above the 7-day pace', () => {
    const b = price()
    const daily = b.daily.map((d) => (d.date < '2026-10-07' ? { ...d, cost_usd: 30 } : d))
    const p = projection({ ...b, daily })!
    expect(p.band.low).toBeLessThanOrEqual(p.band.high)
    expect(p.band.highRate).toBeGreaterThan(p.band.lowRate)
  })
})

describe('run-out (§5)', () => {
  it('projected: Pricing Engine around Oct 17 16:00', () => {
    expect(runOut(price())).toEqual({ at: Date.UTC(2026, 9, 17, 16), observed: false })
  })

  it('observed: Code Reviewer ran out again on Oct 13 after its limit was raised', () => {
    expect(runOut(read('agent', I.reviewer))).toEqual({
      at: Date.UTC(2026, 9, 13, 14),
      observed: true,
    })
  })

  it('none without a budget or for a session', () => {
    expect(runOut(read('owner', I.ana))).toBeNull()
    expect(runOut(read('session', I.s1))).toBeNull()
  })
})

describe('the strip (F2)', () => {
  it('Pricing Engine: today $3 vs a $6 average, the week $15, 81% to date, $1.06 a day left', () => {
    const f = figures(price())
    expect(f.today).toEqual({ used: 3, avg7: 6 })
    expect(f.week).toEqual({ used: 15, usedCompleteDays: 12, sameDaysLastWeek: 12 })
    expect(f.periodToDate.pct).toBeCloseTo(81, 10)
    expect(f.projected).toMatchObject({ low: 186, high: 186 })
    expect(f.allowance!.perDay).toBeCloseTo(19 / 18, 10)
    expect(f.floor).toBe(false)
  })

  it('unpriced calls make the figures floors; no budget has no allowance', () => {
    const f = figures(read('org'))
    expect(f.floor).toBe(true)
    expect(figures(read('owner', I.ana)).allowance).toBeNull()
  })

  it('past the limit the allowance is none; a session shows spend per turn', () => {
    expect(figures(read('agent', I.reviewer)).allowance).toMatchObject({ perDay: 0, none: true })
    expect(figures(read('session', I.s1)).perTurn).toEqual({ last5: 10 / 3, average: 10 / 3 })
  })

  it('allowance counts today: Oct 14 noon to Nov 1 is 18 days', () => {
    expect(allowance(81, 100, NOW, Date.UTC(2026, 10, 1)).perDay).toBeCloseTo(19 / 18, 10)
    expect(allowance(120, 100, NOW, Date.UTC(2026, 10, 1))).toMatchObject({ perDay: 0, none: true })
  })

  it('weeks start Monday 00:00 UTC', () => {
    expect(weekStart(NOW)).toBe(Date.UTC(2026, 9, 12))
    expect(weekStart(Date.UTC(2026, 9, 12))).toBe(Date.UTC(2026, 9, 12))
    expect(weekStart(Date.UTC(2026, 9, 18, 23))).toBe(Date.UTC(2026, 9, 12))
  })
})

describe('quarter (§5)', () => {
  it('closed months + this month’s band + the rest at the band’s rates, % of the month limits (future = today’s)', () => {
    const b = price()
    const p = projection(b)!
    const q = quarterProjection(b, p, {
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2027, 0, 1),
      closed: [],
    })
    // Nov and Dec at $6 a day: 61 days.
    expect(q.high).toBeCloseTo(186 + 6 * 61, 10)
    expect(q.limitSum).toBe(300)
    expect(q.highPct).toBeCloseTo(((186 + 366) / 300) * 100, 10)
  })
})

describe('spike days (F3)', () => {
  it('Code Reviewer’s Oct 9: $10 against a $4 pace; the first 7 days can’t be spikes', () => {
    expect(spikes(read('agent', I.reviewer))).toEqual([
      { date: '2026-10-09', cost: 10, pace: 4, ratio: 2.5 },
    ])
  })

  it('under $1 is never a spike', () => {
    const b = read('agent', I.reviewer)
    const daily = b.daily.map((d) => ({ ...d, cost_usd: d.cost_usd / 20 }))
    expect(spikes({ ...b, daily })).toEqual([])
  })
})

describe('what-if (F6)', () => {
  it('a higher limit moves the run-out past the reset; half the pace projects less', () => {
    expect(whatIf(price(), { limit: 200 })).toMatchObject({ limit: 200, runOut: null })
    expect(whatIf(price(), { paceChange: -0.5 })!.projected).toBeCloseTo(81 + 3 * 17.5, 10)
  })

  it('rejects a bad limit or pace and draws nothing', () => {
    expect(whatIfProblem(0, 0)).toBe('limit_positive')
    expect(whatIfProblem(Number.NaN, 0)).toBe('limit_required')
    expect(whatIfProblem(2e9, 0)).toBe('limit_too_large')
    expect(whatIfProblem(100, 0.6)).toBe('pace_out_of_range')
    expect(whatIf(price(), { limit: -5 })).toBeNull()
  })
})

describe('levers (F4)', () => {
  it('stop counts only the avoidable spend; raise lands at 100%', () => {
    const b = price()
    expect(stopEstimate(b)).toBe(86)
    expect(raiseTo(projection(b))).toBe(186)
    // Already over: avoidable is what the projection adds past what is spent, at the 7-day pace ("if the rest of
    // October follows the last 7 days"), not the band's high edge (here the 30-day rate). Not offered once it stops.
    const reviewer = read('agent', I.reviewer)
    expect(stopEstimate(reviewer)).toBeNull()
    const alerting = { ...reviewer, budget: { ...reviewer.budget!, action: 'alert' as const } }
    expect(stopEstimate(alerting)).toBeCloseTo((26 / 7) * 17.5, 10)
    expect(raiseTo(projection(reviewer))).toBe(Math.ceil(50 + (26 / 7) * 17.5))
  })

  it('compression needs a measurement; a cheaper model prices the routed tokens left', () => {
    expect(compressionEstimate(6, 17.5, 20)).toBeCloseTo(21, 10)
    expect(compressionEstimate(6, 17.5, null)).toBeNull()
    // gpt-4o → gpt-4o-mini on 6.48M/6.48M tokens over 13.5 days, 17.5 days left.
    const s = cheaperModelEstimate(
      { inputTokens: 6_480_000, outputTokens: 6_480_000 },
      13.5,
      17.5,
      { input_per_mtok_usd: 2.5, output_per_mtok_usd: 10 },
      { input_per_mtok_usd: 0.15, output_per_mtok_usd: 0.6 },
    )!
    expect(s).toBeCloseTo((6.48 * (2.35 + 9.4) * 17.5) / 13.5, 6)
  })
})

describe('chart model (F1)', () => {
  it('burndown: from the limit down to what’s left; the band goes below 0 when over (5C)', () => {
    const m = chartModel(price(), 'down')
    expect(m.actual[0]).toEqual({ t: Date.UTC(2026, 9, 1), v: 100 })
    expect(m.actual.at(-1)).toEqual({ t: NOW, v: 19 })
    expect(m.band.at(-1)).toMatchObject({ low: -86, high: -86 })
    expect(m.minY).toBe(-86)
    expect(m.pace).toEqual([
      [
        { t: Date.UTC(2026, 9, 1), v: 100 },
        { t: Date.UTC(2026, 10, 1), v: 0 },
      ],
    ])
    expect(m.thresholds.map((t) => t.percent)).toEqual([50, 80])
    expect(m.thresholds[1]!.v).toBeCloseTo(20, 10)
    expect(m.limits.every((l) => !l.stops)).toBe(true)
  })

  it('burn-up with stepped limits: the raise is a step, thresholds move with it, the stop line is the limit', () => {
    const m = chartModel(read('agent', I.reviewer), 'up')
    expect(m.limits.map((l) => l.v)).toEqual([40, 50])
    expect(m.limits[0]!.to).toBe(Date.UTC(2026, 9, 10, 9))
    expect(m.thresholds.filter((t) => t.percent === 80).map((t) => t.v)).toEqual([32, 40])
    expect(m.limits.map((l) => l.stops)).toEqual([true, true])
    // Events merged per day: Oct 9 holds the threshold and the stop.
    expect(m.markers.find((x) => x.day === '2026-10-09')!.events.map((e) => e.kind)).toEqual([
      'threshold',
      'stopped',
    ])
    expect(m.bars.find((x) => x.day === '2026-10-09')!.spike).toBe(true)
  })

  it('no budget: burn-up only, no limit or pace lines', () => {
    const m = chartModel(read('owner', I.ana), 'up')
    expect([m.limits, m.pace, m.thresholds]).toEqual([[], [], []])
    expect(m.actual.at(-1)!.v).toBe(34)
  })

  it('a preview line runs from as_of to the reset at the given pace', () => {
    expect(previewLine(price(), 'up', 3)).toEqual([
      { t: NOW, v: 81 },
      { t: Date.UTC(2026, 10, 1), v: 81 + 3 * 17.5 },
    ])
  })
})

describe('Table view rows', () => {
  it('history then projected days; left and pace per day; the band only after today', () => {
    const rows = tableRows(price())
    expect(rows[0]).toMatchObject({ date: '2026-10-01', spend: 6, cumulative: 6, left: 94 })
    expect(rows.find((r) => r.date === '2026-10-14')).toMatchObject({ cumulative: 81, low: null })
    const last = rows.at(-1)!
    expect(last.date).toBe('2026-10-31')
    expect(last.high).toBeCloseTo(186, 10)
    expect(rows.find((r) => r.date === '2026-10-15')!.pace).toBeCloseTo((100 * 15) / 31, 10)
  })

  it('a day beyond the data keeps nothing invented', () => {
    expect(tableRows(read('session', I.s1))).toEqual([])
    expect(DAY).toBe(86_400_000)
  })
})

describe('B1 review regressions', () => {
  const reviewer = () => read('agent', I.reviewer)

  it('a stopped budget is projected nowhere: chart, table, strip and quarter agree', () => {
    const b = reviewer()
    expect(b.budget!.stopped).toBe(true)
    expect(chartModel(b, 'down').band).toEqual([])
    expect(tableRows(b).some((r) => r.low !== null)).toBe(false)
    expect(figures(b).projected).toBeNull()
    // The raise lever still sees what spend would do if calls resumed.
    expect(projection(b)).not.toBeNull()
  })

  it('the table counts a limit raised during a day for that day, as the chart does', () => {
    // Oct 10: raised from $40 to $50 at 09:00; $46 spent by the end of the day.
    const row = tableRows(reviewer()).find((r) => r.date === '2026-10-10')!
    expect(row.left).toBe(50 - row.cumulative)
    const m = chartModel(reviewer(), 'down')
    expect(m.actual.find((p) => p.t === Date.UTC(2026, 9, 11))!.v).toBe(row.left)
  })

  it('only steps that stopped calls draw the stop line', () => {
    const b = reviewer()
    const limits = b.budget!.limits.map((l, i) =>
      i === 0 ? { ...l, action: 'alert' as const } : l,
    )
    const m = chartModel({ ...b, budget: { ...b.budget!, limits } }, 'up')
    expect(m.limits.map((l) => l.stops)).toEqual([false, true])
  })

  it('the band ends at the reset wherever as_of falls', () => {
    const b = { ...price(), as_of: '2026-10-14T12:37:00Z' }
    expect(chartModel(b, 'up').band.at(-1)!.t).toBe(Date.UTC(2026, 10, 1))
  })

  it('this week is unknown when a day of it is missing from the read', () => {
    const b = price()
    const daily = b.daily.filter((d) => d.date !== '2026-10-12')
    expect(figures({ ...b, daily }).week).toMatchObject({ used: null, usedCompleteDays: null })
  })

  it('a spike over a zero pace has no ratio, never Infinity', () => {
    const b = reviewer()
    const daily = b.daily.map((d) =>
      d.date === '2026-10-09' ? d : { ...d, cost_usd: d.date < '2026-10-09' ? 0 : d.cost_usd },
    )
    expect(spikes({ ...b, daily }).find((x) => x.date === '2026-10-09')!.ratio).toBeNull()
  })
})

describe('B1 review regressions (Codex)', () => {
  it('burndown steps at the moment the limit changes, not across the day', () => {
    // B-review: raised $40 → $50 on Oct 10 at 09:00; $42 spent by Oct 10 00:00, $44 by Oct 11 00:00.
    const m = chartModel(read('agent', I.reviewer), 'down')
    const at = m.actual.filter((p) => p.t === Date.UTC(2026, 9, 10, 9)).map((p) => p.v)
    expect(at).toHaveLength(2)
    expect(at[0]).toBeCloseTo(40 - 42.75, 10)
    expect(at[1]).toBeCloseTo(50 - 42.75, 10)
  })

  it('a period’s closing point keeps that period’s spend; the new period starts at $0', () => {
    // Pricing Engine read from Sep 1 (two periods), with $30 spent on Sep 30.
    const b = read('agent', I.pricing, { include_previous: 'true', from: '2026-09-01' })
    const daily = b.daily.map((d) => (d.date === '2026-09-30' ? { ...d, cost_usd: 30 } : d))
    const m = chartModel({ ...b, daily }, 'up')
    const atReset = m.actual.filter((p) => p.t === Date.UTC(2026, 9, 1)).map((p) => p.v)
    expect(atReset).toEqual([30, 0])
  })

  it('a limit lowered today ran out today, not the day spend first passed the new limit', () => {
    const b = price()
    const [first] = b.budget!.limits
    const limits = [
      { ...first!, to: '2026-10-14T11:00:00Z' },
      {
        ...first!,
        from: '2026-10-14T11:00:00Z',
        to: null,
        version: first!.version + 1,
        limit_usd: 50,
      },
    ]
    const lowered = { ...b, budget: { ...b.budget!, limits } }
    expect(runOut(lowered)).toEqual({ at: Date.UTC(2026, 9, 14), observed: true })
  })

  it('a session draws its turns from its start to its end, with no even pace', () => {
    const m = chartModel(read('session', I.s1), 'down')
    expect(m.pace).toEqual([])
    expect(m.band).toEqual([])
    expect(m.actual.at(-1)!.v).toBeCloseTo(8 - 10, 10)
    expect(m.end).toBeLessThan(NOW)
  })

  it('unpriced calls mark the model as a floor', () => {
    expect(chartModel(read('org'), 'down').floor).toBe(true)
    expect(chartModel(price(), 'down').floor).toBe(false)
  })
})
