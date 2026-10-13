/**
 * Budget burn, pure (plan feat-budget-burn §5, F1, F2, F4, F6): the strip's figures, the projection band, the quarter
 * projection, the daily allowance, run-out, spike days, what-if, lever estimates and the chart model the kit draws.
 * Every number the burn surfaces show comes from here; the projection rule itself is `projection.ts` (budgets.md §4.6),
 * shared with the server's mirror. Inputs are the 1.0 burn read (`types.ts` `Burn`); the clock is its `as_of`.
 */
import { DAY_MS, project, type Projection } from './projection'
import {
  LOW_RATE_DAYS,
  SPIKE_FACTOR,
  SPIKE_MIN_USD,
  SPIKE_WINDOW_DAYS,
  WHATIF_MAX_LIMIT,
  WHATIF_PACE_LIMIT,
} from './tuning'
import type { Burn, BudgetEvent, Price } from './types'

// ─── time ───────────────────────────────────────────────────────────────────

const dayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`)
/** Monday 00:00 UTC of `t`'s week (plan §5). */
export const weekStart = (t: number) => {
  const d = dayStart(t)
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY_MS
}
const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0)
const mean = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : 0)

/** Every day the read carries (the previous period's too), by date. */
function dayCosts(b: Burn): Map<string, number> {
  const m = new Map<string, number>()
  for (const d of b.previous?.daily ?? []) m.set(d.date, d.cost_usd)
  for (const d of b.daily) m.set(d.date, d.cost_usd)
  return m
}

/** The current period's days, ascending (the projection's input). */
const periodDays = (b: Burn) => {
  const start = dayOf(Date.parse(b.period_start))
  return b.daily.filter((d) => d.date >= start)
}

/** The limit in force at `t` (the version step containing it), or null without a budget. */
function limitAt(b: Burn, t: number): number | null {
  const steps = b.budget?.limits ?? []
  const s = steps.find((x) => Date.parse(x.from) <= t && (x.to === null || t < Date.parse(x.to)))
  return s?.limit_usd ?? steps.at(-1)?.limit_usd ?? null
}

/** The limit in force at the read's `as_of`, or null without a budget. */
export const currentLimit = (b: Burn) => limitAt(b, Date.parse(b.as_of))

// ─── the projection and its band (§5) ───────────────────────────────────────

interface Band {
  /** Spend at the reset at the trailing 30-day (or period-so-far) rate. */
  low: number
  /** At the 7-day pace. */
  high: number
  /** The daily rates behind them. */
  lowRate: number
  highRate: number
}

export interface BurnProjection extends Projection {
  band: Band
}

/** null with fewer than 3 complete days in the period, or for a session (no reset). */
export function projection(b: Burn): BurnProjection | null {
  if (b.resets_at === null) return null
  const asOf = Date.parse(b.as_of)
  const days = periodDays(b)
  const limit = limitAt(b, asOf)
  const p = project({
    daily: days,
    used: b.used_usd,
    limit,
    resetsAt: Date.parse(b.resets_at),
    asOf,
  })
  if (!p) return null
  const today = dayOf(asOf)
  const complete = days.filter((d) => d.date < today)
  const lowRate = mean(complete.slice(-LOW_RATE_DAYS).map((d) => d.cost_usd))
  const lo = b.used_usd + lowRate * p.daysLeft
  // When the 30-day rate runs above the 7-day pace the two edges swap, so low ≤ high always.
  const band =
    lo <= p.projected
      ? { low: lo, high: p.projected, lowRate, highRate: p.pace }
      : { low: p.projected, high: lo, lowRate: p.pace, highRate: lowRate }
  return { ...p, band }
}

/**
 * The projection the page shows: none for a stopped budget, whose calls are refused, so nothing more is spent until the
 * reset (ledger #67). The levers that resume calls (raise the limit) still use `projection`.
 */
function shownProjection(b: Burn): BurnProjection | null {
  return b.budget?.stopped ? null : projection(b)
}

// ─── run-out (§5) ───────────────────────────────────────────────────────────

export type RunOut = { at: number; observed: true } | { at: number; observed: false } | null

/**
 * Observed when spend reached the limit this period (the day it did, from the budget's events, else the daily
 * series); projected from the 7-day pace otherwise. Sessions have none.
 */
export function runOut(b: Burn, p: BurnProjection | null = projection(b)): RunOut {
  if (b.resets_at === null) return null
  const asOf = Date.parse(b.as_of)
  const limit = limitAt(b, asOf)
  if (limit === null) return null
  if (b.used_usd >= limit) {
    const start = Date.parse(b.period_start)
    // The latest stop or 100% crossing this period: a raised limit that ran out again ran out then.
    const hit = b.events.findLast(
      (e) =>
        (e.kind === 'stopped' || (e.kind === 'threshold' && e.percent === 100)) &&
        Date.parse(e.at) >= start,
    )
    if (hit) return { at: Date.parse(hit.at), observed: true }
    let cum = 0
    for (const d of periodDays(b)) {
      cum += d.cost_usd
      // Against the limit in force that day: a limit lowered today ran out today, not when spend first passed it.
      const dayLimit = limitAt(b, parseDay(d.date) + DAY_MS - 1)
      if (dayLimit !== null && cum >= dayLimit) return { at: parseDay(d.date), observed: true }
    }
    return { at: asOf, observed: true }
  }
  return p?.runOut ? { at: p.runOut, observed: false } : null
}

// ─── the strip (F2) ─────────────────────────────────────────────────────────

export interface Figures {
  /** Unpriced calls make spend a floor and what's left a ceiling (plan §5). */
  floor: boolean
  today: { used: number; avg7: number | null }
  /** Monday to now; compared with last week's same complete weekdays (null on a Monday or without data). */
  week: { used: number | null; sameDaysLastWeek: number | null; usedCompleteDays: number | null }
  periodToDate: { used: number; pct: number | null }
  projected: { low: number; high: number; lowPct: number | null; highPct: number | null } | null
  quarter: QuarterProjection | null
  /** Per day left including today; null without a budget; 0 past the limit ("none left"). */
  allowance: { perDay: number; none: boolean; days: number } | null
  /** Session budgets: spend per turn, the last 5 turns vs the session's average (F2). */
  perTurn: { last5: number; average: number } | null
}

export function figures(b: Burn, opts: { quarter?: QuarterInput | null } = {}): Figures {
  const asOf = Date.parse(b.as_of)
  const costs = dayCosts(b)
  const today = dayOf(asOf)
  const p = shownProjection(b)
  const limit = limitAt(b, asOf)
  const trailing: number[] = []
  for (let d = dayStart(asOf) - DAY_MS; trailing.length < 7; d -= DAY_MS) {
    const c = costs.get(dayOf(d))
    if (c === undefined) break
    trailing.push(c)
  }
  // This week so far, and last week's same complete weekdays (Monday to yesterday).
  const monday = weekStart(asOf)
  let week = 0
  let completeThisWeek = 0
  let lastWeek = 0
  let lastWeekKnown = true
  let weekKnown = true
  for (let d = monday; d <= dayStart(asOf); d += DAY_MS) {
    const c = costs.get(dayOf(d))
    if (c === undefined) weekKnown = false
    week += c ?? 0
    if (d < dayStart(asOf)) {
      completeThisWeek += costs.get(dayOf(d)) ?? 0
      const prev = costs.get(dayOf(d - 7 * DAY_MS))
      if (prev === undefined) lastWeekKnown = false
      lastWeek += prev ?? 0
    }
  }
  const sessionTurns = b.turns
  return {
    floor: b.unpriced_calls > 0,
    today: { used: costs.get(today) ?? 0, avg7: trailing.length >= 3 ? mean(trailing) : null },
    week: {
      used: weekKnown ? week : null,
      usedCompleteDays: weekKnown ? completeThisWeek : null,
      sameDaysLastWeek: monday < dayStart(asOf) && lastWeekKnown ? lastWeek : null,
    },
    periodToDate: { used: b.used_usd, pct: limit ? (b.used_usd / limit) * 100 : null },
    projected: p
      ? {
          low: p.band.low,
          high: p.band.high,
          lowPct: limit ? (p.band.low / limit) * 100 : null,
          highPct: limit ? (p.band.high / limit) * 100 : null,
        }
      : null,
    quarter: opts.quarter && p ? quarterProjection(b, p, opts.quarter) : null,
    allowance:
      limit === null || b.resets_at === null
        ? null
        : allowance(b.used_usd, limit, asOf, Date.parse(b.resets_at)),
    perTurn:
      sessionTurns && sessionTurns.length
        ? {
            last5: mean(sessionTurns.slice(-5).map((t) => t.cost_usd)),
            average: mean(sessionTurns.map((t) => t.cost_usd)),
          }
        : null,
  }
}

/** max(0, limit − used) / days left including today (plan §5). */
export function allowance(used: number, limit: number, asOf: number, resetsAt: number) {
  const days = Math.max(1, Math.round((dayStart(resetsAt - 1) - dayStart(asOf)) / DAY_MS) + 1)
  const left = Math.max(0, limit - used)
  return { perDay: left / days, none: left === 0, days }
}

// ─── the quarter (§5) ───────────────────────────────────────────────────────

export interface QuarterInput {
  start: number
  end: number
  /** Each closed month of the quarter: its spend and its limit (null without a budget then). */
  closed: { used: number; limit: number | null }[]
}

export interface QuarterProjection {
  low: number
  high: number
  limitSum: number | null
  lowPct: number | null
  highPct: number | null
}

/**
 * Closed months (actual) + this month's band + each remaining month at the band's daily rates; % of the sum of the
 * month limits, where each future month assumes today's limit.
 */
/** The calendar quarter around `t` (UTC; fiscal quarters are B6, plan §7 Q2). */
export function quarterOf(t: number): { start: number; end: number } {
  const d = new Date(t)
  const q = Math.floor(d.getUTCMonth() / 3) * 3
  return { start: Date.UTC(d.getUTCFullYear(), q, 1), end: Date.UTC(d.getUTCFullYear(), q + 3, 1) }
}

/**
 * The quarter figure's inputs from a read that starts at the quarter's first day (`period=quarter` on a month budget):
 * its closed months, each with the limit in force at its start. null unless the read covers the whole quarter so far.
 */
export function quarterInput(b: Burn): QuarterInput | null {
  if (!b.budget || b.resets_at === null) return null
  const q = quarterOf(Date.parse(b.as_of))
  if (parseDay(b.from) > q.start) return null
  const current = Date.parse(b.period_start)
  return {
    ...q,
    closed: b.periods
      .filter((p) => Date.parse(p.period_start) >= q.start && Date.parse(p.period_start) < current)
      .map((p) => ({ used: p.used_usd, limit: limitAt(b, Date.parse(p.period_start)) })),
  }
}

export function quarterProjection(b: Burn, p: BurnProjection, q: QuarterInput): QuarterProjection {
  const resets = b.resets_at ? Date.parse(b.resets_at) : q.end
  const restDays = Math.max(0, (q.end - resets) / DAY_MS)
  // The months still to come after this one, by month boundary.
  let futureMonths = 0
  for (let m = resets; m < q.end; futureMonths++) {
    const d = new Date(m)
    m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
  const closed = sum(q.closed.map((m) => m.used))
  const low = closed + p.band.low + p.band.lowRate * restDays
  const high = closed + p.band.high + p.band.highRate * restDays
  const today = limitAt(b, Date.parse(b.as_of))
  const limitSum =
    today === null || q.closed.some((m) => m.limit === null)
      ? null
      : sum(q.closed.map((m) => m.limit ?? 0)) + today * (1 + futureMonths)
  return {
    low,
    high,
    limitSum,
    lowPct: limitSum ? (low / limitSum) * 100 : null,
    highPct: limitSum ? (high / limitSum) * 100 : null,
  }
}

// ─── spike days (F3, plan §5) ───────────────────────────────────────────────

export interface Spike {
  date: string
  cost: number
  /** The trailing pace it's compared with, and the ratio. */
  pace: number
  /** null over a zero pace (no "Infinity×"). */
  ratio: number | null
}

/** Days in `[from, as_of]` over 2× the trailing 7 complete days' pace and at least $1; the first 7 days have none. */
export function spikes(b: Burn): Spike[] {
  const costs = dayCosts(b)
  const out: Spike[] = []
  for (const d of b.daily) {
    const t = parseDay(d.date)
    const window: number[] = []
    for (let i = 1; i <= SPIKE_WINDOW_DAYS; i++) {
      const c = costs.get(dayOf(t - i * DAY_MS))
      if (c === undefined) break
      window.push(c)
    }
    if (window.length < SPIKE_WINDOW_DAYS) continue
    const pace = mean(window)
    if (d.cost_usd >= SPIKE_MIN_USD && d.cost_usd > SPIKE_FACTOR * pace)
      out.push({
        date: d.date,
        cost: d.cost_usd,
        pace,
        ratio: pace > 0 ? d.cost_usd / pace : null,
      })
  }
  return out
}

// ─── what-if (F6) ───────────────────────────────────────────────────────────

export type WhatIfProblem =
  'limit_required' | 'limit_positive' | 'limit_too_large' | 'pace_out_of_range'

/** The inputs' validation (Section 4: NaN, ≤ 0, > 1e9, pace outside ±50%): a problem, or null. */
export function whatIfProblem(limit: number | null, paceChange: number): WhatIfProblem | null {
  if (limit !== null) {
    if (!Number.isFinite(limit)) return 'limit_required'
    if (limit <= 0) return 'limit_positive'
    if (limit > WHATIF_MAX_LIMIT) return 'limit_too_large'
  }
  if (!Number.isFinite(paceChange) || Math.abs(paceChange) > WHATIF_PACE_LIMIT)
    return 'pace_out_of_range'
  return null
}

export interface WhatIf {
  limit: number
  pace: number
  projected: number
  runOut: number | null
  allowance: { perDay: number; none: boolean; days: number }
}

/** A different limit and/or pace (−50% … +50%) with the same rule; nothing is saved. null without a projection. */
export function whatIf(
  b: Burn,
  opts: { limit?: number | null; paceChange?: number },
): WhatIf | null {
  const p = projection(b)
  const asOf = Date.parse(b.as_of)
  const limit = opts.limit ?? limitAt(b, asOf)
  if (!p || limit === null || whatIfProblem(opts.limit ?? null, opts.paceChange ?? 0)) return null
  if (!b.resets_at) return null
  const pace = p.pace * (1 + (opts.paceChange ?? 0))
  const resets = Date.parse(b.resets_at)
  const projected = b.used_usd + pace * p.daysLeft
  let out: number | null = null
  if (b.used_usd < limit && pace > 0) {
    const at = asOf + ((limit - b.used_usd) / pace) * DAY_MS
    if (at < resets) out = at
  }
  return {
    limit,
    pace,
    projected,
    runOut: out,
    allowance: allowance(b.used_usd, limit, asOf, resets),
  }
}

// ─── levers (F4) ────────────────────────────────────────────────────────────

/**
 * Turn on token optimization: the measured `cost_reduction_pct` (from /finops/savings, over agents the viewer can
 * read) applied to this agent's routed spend for the remaining days at pace. No measurement → no number.
 */
export function compressionEstimate(
  routedPace: number,
  daysLeft: number,
  measuredReductionPct: number | null,
): number | null {
  if (measuredReductionPct === null || !Number.isFinite(measuredReductionPct)) return null
  return routedPace * daysLeft * (measuredReductionPct / 100)
}

/**
 * Route to a cheaper model: the routed tokens this period, per elapsed day, for the remaining days, priced at the
 * current model and at the candidate. Positive is a saving.
 */
export function cheaperModelEstimate(
  routed: { inputTokens: number; outputTokens: number },
  elapsedDays: number,
  daysLeft: number,
  from: Pick<Price, 'input_per_mtok_usd' | 'output_per_mtok_usd'>,
  to: Pick<Price, 'input_per_mtok_usd' | 'output_per_mtok_usd'>,
): number | null {
  if (elapsedDays <= 0) return null
  const k = daysLeft / elapsedDays / 1e6
  const cost = (p: typeof from) =>
    (routed.inputTokens * p.input_per_mtok_usd + routed.outputTokens * p.output_per_mtok_usd) * k
  return cost(from) - cost(to)
}

/**
 * Stop calls at the limit: the spend still avoidable, projected spend − max(limit, used); already-spent money is never
 * counted (plan F4). null for a session (no projection) or without a projection.
 */
export function stopEstimate(b: Burn, p: BurnProjection | null = projection(b)): number | null {
  const limit = limitAt(b, Date.parse(b.as_of))
  // Not offered when the budget already stops (plan F4).
  if (!p || limit === null || b.budget?.action === 'stop') return null
  return Math.max(0, p.projected - Math.max(limit, b.used_usd))
}

/** Raise the limit: the limit that lands at 100% of the projection, rounded up to whole dollars. */
export function raiseTo(p: BurnProjection | null): number | null {
  return p ? Math.ceil(p.projected) : null
}

// ─── the chart model (F1) ───────────────────────────────────────────────────

export type BurnMode = 'down' | 'up'

export interface ChartPoint {
  t: number
  v: number
}

export interface ChartModel {
  mode: BurnMode
  /** The x domain: the first day shown to the reset (or the session's last turn). */
  start: number
  end: number
  /** Spend so far: cumulative per period (up), or what's left of the limit (down); the last point is as_of. */
  actual: ChartPoint[]
  /** The even pace, per period: limit → 0 (down), 0 → limit (up). Empty without a budget. */
  pace: ChartPoint[][]
  /** From as_of to the reset: low and high edges, in the mode's units. */
  band: { t: number; low: number; high: number }[]
  /** Limit steps (up), or the stop/zero line (down); every version and period start is a step. */
  /** Unpriced calls this period: spend is a floor, so the run-out reads "or earlier" (plan F2). */
  floor: boolean
  /** Limit steps; `stops` when that version stopped calls (the stop line). In burndown, `v` is 0. */
  limits: { from: number; to: number; v: number; stops: boolean }[]
  /** Threshold lines per step, in the mode's units. */
  thresholds: { from: number; to: number; v: number; percent: number }[]
  runOut: RunOut
  /** Events merged per UTC day (plan F1, hub `timeline.ts` rule). */
  markers: { day: string; t: number; events: BudgetEvent[] }[]
  /** Daily spend for the bars, from `from` to as_of. */
  bars: { day: string; t: number; v: number; spike: boolean }[]
  /** The lowest y drawn: below 0 in burndown when over the limit (plan F1 5C). */
  minY: number
  maxY: number
}

/**
 * The kit chart's data. `preview` adds a dashed projected line (a lever or what-if), in the mode's units, never
 * written anywhere.
 */
export function chartModel(b: Burn, mode: BurnMode, opts: { end?: number } = {}): ChartModel {
  const asOf = Date.parse(b.as_of)
  // A session has no reset: it runs from its start to its end (or now), by turn (plan F9).
  const session = b.resets_at === null && b.session ? b.session : null
  const from = session ? Date.parse(session.started_at) : parseDay(b.from)
  const end = b.resets_at
    ? Date.parse(b.resets_at)
    : session?.ended_at
      ? Math.min(Date.parse(session.ended_at), asOf)
      : asOf
  // The x axis can run past this period (a month budget viewed by quarter); the projection still ends at the reset.
  const domainEnd = Math.max(end, opts.end ?? end)
  const periods = b.periods.map((p) => ({
    start: Date.parse(p.period_start),
    end: p.resets_at ? Date.parse(p.resets_at) : end,
  }))
  const periodOf = (t: number) =>
    periods.find((p) => t >= p.start && t < p.end) ?? periods.at(-1) ?? { start: from, end }
  const hasBudget = !!b.budget
  const lim = (t: number) => limitAt(b, t) ?? 0
  const show = (t: number, used: number) => (mode === 'up' || !hasBudget ? used : lim(t) - used)

  // Spend, cumulative within each period: at each day's end (then as_of), or after each turn for a session. `limT` is
  // when the limit is read: a closing point takes the limit of the interval it closes, so a reset never applies the
  // new period's limit to the old period's spend.
  const spend: { t: number; v: number; limT: number }[] = [
    { t: Math.max(from, periodOf(from).start), v: 0, limT: from },
  ]
  let cum = 0
  if (session) {
    for (const turn of b.turns ?? []) {
      cum += turn.cost_usd
      const t = Date.parse(turn.at)
      spend.push({ t, v: cum, limT: t })
    }
  } else {
    let current = periodOf(from).start
    for (const d of b.daily) {
      const t = parseDay(d.date)
      const p = periodOf(t)
      if (p.start !== current) {
        current = p.start
        cum = 0
        spend.push({ t: p.start, v: 0, limT: p.start })
      }
      cum += d.cost_usd
      const at = Math.min(t + DAY_MS, asOf)
      spend.push({ t: at, v: cum, limT: at - 1 })
    }
  }
  // Burndown steps where the limit changes inside a period: what's left jumps at that moment (spend read linearly
  // within its day), never drifting across the day.
  if (mode === 'down' && hasBudget && !session) {
    const starts = new Set(periods.map((p) => p.start))
    for (const step of (b.budget?.limits ?? []).slice(1)) {
      const t = Date.parse(step.from)
      if (t <= from || t >= asOf || starts.has(t)) continue
      const i = spend.findIndex((q) => q.t > t)
      const a = spend[i - 1]
      const z = spend[i]
      if (!a || !z) continue
      const v = a.v + ((z.v - a.v) * (t - a.t)) / (z.t - a.t)
      spend.splice(i, 0, { t, v, limT: t - 1 }, { t, v, limT: t })
    }
  }
  const actual: ChartPoint[] = spend.map((q) => ({ t: q.t, v: show(q.limT, q.v) }))

  const pace: ChartPoint[][] =
    hasBudget && !session
      ? periods.map((p) =>
          mode === 'down'
            ? [
                { t: p.start, v: lim(p.start) },
                { t: p.end, v: 0 },
              ]
            : [
                { t: p.start, v: 0 },
                { t: p.end, v: lim(p.end - 1) },
              ],
        )
      : []

  const proj = shownProjection(b)
  const band: ChartModel['band'] = []
  if (proj) {
    const at = (t: number) => {
      const dt = (t - asOf) / DAY_MS
      const a = show(t, b.used_usd + proj.band.lowRate * dt)
      const z = show(t, b.used_usd + proj.band.highRate * dt)
      band.push({ t, low: Math.min(a, z), high: Math.max(a, z) })
    }
    for (let t = asOf; t < end; t += DAY_MS / 4) at(t)
    // Always end at the reset, wherever as_of falls in its 6-hour step.
    at(end)
  }

  const steps = (b.budget?.limits ?? []).map((s) => ({
    from: Math.max(Date.parse(s.from), from),
    to: s.to ? Date.parse(s.to) : domainEnd,
    limit: s.limit_usd,
    thresholds: s.thresholds,
    stops: s.action === 'stop',
  }))
  // Each step carries its own action: calls stopped only while a stop version was in force (design 1C).
  const limits = steps.map((s) => ({
    from: s.from,
    to: s.to,
    v: mode === 'up' ? s.limit : 0,
    stops: s.stops,
  }))
  const thresholds = steps.flatMap((s) =>
    s.thresholds
      .filter((p) => p < 100)
      .map((p) => ({
        from: s.from,
        to: s.to,
        percent: p,
        v: mode === 'up' ? (s.limit * p) / 100 : s.limit * (1 - p / 100),
      })),
  )

  const markers = new Map<string, BudgetEvent[]>()
  for (const e of b.events) {
    const day = e.at.slice(0, 10)
    markers.set(day, [...(markers.get(day) ?? []), e])
  }

  const spikeDays = new Set(spikes(b).map((s) => s.date))
  const bars = b.daily.map((d) => ({
    day: d.date,
    t: parseDay(d.date),
    v: d.cost_usd,
    spike: spikeDays.has(d.date),
  }))

  const values = [
    ...actual.map((p) => p.v),
    ...band.flatMap((p) => [p.low, p.high]),
    ...pace.flat().map((p) => p.v),
    ...limits.map((l) => l.v),
    ...steps.map((s) => s.limit),
    0,
  ]
  return {
    mode,
    floor: b.unpriced_calls > 0,
    start: from,
    end: domainEnd,
    actual,
    pace,
    band,
    limits: hasBudget ? limits : [],
    thresholds: hasBudget ? thresholds : [],
    runOut: runOut(b, proj),
    markers: [...markers]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([day, events]) => ({ day, t: parseDay(day) + DAY_MS / 2, events })),
    bars,
    minY: Math.min(...values),
    maxY: Math.max(...values),
  }
}

/** A preview line (lever or what-if) from as_of to the reset at `pace`, in the chart's units. */
export function previewLine(b: Burn, mode: BurnMode, pace: number, limit?: number): ChartPoint[] {
  const asOf = Date.parse(b.as_of)
  const end = b.resets_at ? Date.parse(b.resets_at) : asOf
  const l = limit ?? limitAt(b, asOf) ?? 0
  const at = (t: number) => {
    const used = b.used_usd + (pace * (t - asOf)) / DAY_MS
    return mode === 'up' || !b.budget ? used : l - used
  }
  return [
    { t: asOf, v: at(asOf) },
    { t: end, v: at(end) },
  ]
}

// ─── the Table view and its CSV (F1) ────────────────────────────────────────

export interface TableRow {
  date: string
  spend: number
  cumulative: number
  /** What's left of the limit that day; null without a budget. */
  left: number | null
  /** The even pace's cumulative target that day; null without a budget. */
  pace: number | null
  /** The band's edges for days after today; null before. */
  low: number | null
  high: number | null
  spike: boolean
}

/** One row per day of the chart, history then the projection's days, the bounds' wording in the column headers. */
export function tableRows(b: Burn): TableRow[] {
  const asOf = Date.parse(b.as_of)
  const proj = shownProjection(b)
  const spikeDays = new Set(spikes(b).map((s) => s.date))
  const rows: TableRow[] = []
  let cum = 0
  let period = ''
  for (const d of b.daily) {
    const t = parseDay(d.date)
    const p = b.periods.find(
      (x) => t >= Date.parse(x.period_start) && (!x.resets_at || t < Date.parse(x.resets_at)),
    )
    if (p && p.period_start !== period) {
      period = p.period_start
      cum = 0
    }
    cum += d.cost_usd
    // The limit at the day's end, as the chart's points are (a raise during the day counts that day).
    const limit = limitAt(b, t + DAY_MS - 1)
    const ps = p ? Date.parse(p.period_start) : t
    const pe = p?.resets_at ? Date.parse(p.resets_at) : t + DAY_MS
    rows.push({
      date: d.date,
      spend: d.cost_usd,
      cumulative: cum,
      left: limit === null ? null : limit - cum,
      pace: limit === null ? null : (limit * (t + DAY_MS - ps)) / (pe - ps),
      low: null,
      high: null,
      spike: spikeDays.has(d.date),
    })
  }
  if (proj && b.resets_at) {
    const end = Date.parse(b.resets_at)
    for (let t = dayStart(asOf) + DAY_MS; t < end; t += DAY_MS) {
      const dt = (t + DAY_MS - asOf) / DAY_MS
      const limit = limitAt(b, asOf)
      const ps = Date.parse(b.period_start)
      rows.push({
        date: dayOf(t),
        spend: 0,
        cumulative: 0,
        left: null,
        pace: limit === null ? null : (limit * (t + DAY_MS - ps)) / (end - ps),
        low: b.used_usd + proj.band.lowRate * dt,
        high: b.used_usd + proj.band.highRate * dt,
        spike: false,
      })
    }
  }
  return rows
}
