/**
 * What's causing the burn (plan feat-budget-burn F3), pure: which contributor dimensions a scope offers, the daily
 * bars stacked from a breakdown (the top 5 plus Other), a picked contributor's cumulative line, What changed's
 * ranges (this week so far vs the same hours last week, budgets.md §7.3) and its rows. `causes.test.ts`.
 */
import type { BurnChartData, BurnChartPoint } from '@/components/charts/burn-chart'
import { weekStart } from './burn'
import { copy } from './copy'
import type { Breakdown, Burn, Changes, Dimension, Scope } from './types'

const DAY_MS = 86_400_000

/**
 * The dimensions the daily bars switch between, by scope (F3; budgets.md §7.2 allows more). Fleet: agent, owner and
 * source (EE adds unit in B6); an owner: agent, model, operation, source; an agent: model, operation, session.
 */
export function dimensionsFor(scope: Scope): readonly Dimension[] {
  if (scope === 'org') return ['agent', 'owner', 'source']
  if (scope === 'unit') return ['agent', 'owner', 'source']
  if (scope === 'owner') return ['agent', 'model', 'operation', 'source']
  if (scope === 'agent') return ['model', 'operation', 'session']
  return ['model', 'operation']
}

/** The URL's `by` when this scope offers it, else the scope's first. */
export const pickDimension = (scope: Scope, by: string | undefined): Dimension => {
  const all = dimensionsFor(scope)
  return all.find((d) => d === by) ?? all[0] ?? 'agent'
}

/** The bars stacked by contributor: the breakdown's keys in its order, then Other when it holds anything. */
export function stackBars(data: BurnChartData, br: Breakdown | undefined): BurnChartData {
  if (!br) return data
  const days = new Map(br.days.map((d) => [d.date, d]))
  const anyOther = br.days.some((d) => d.other_usd > 0)
  return {
    ...data,
    stack: [
      ...br.keys.map((k) => ({ key: k.key, label: keyLabel(k) })),
      ...(anyOther ? [{ key: 'other', label: copy.causesOther(br.other.contributors) }] : []),
    ],
    bars: data.bars.map((b) => {
      const d = days.get(b.day)
      return d
        ? {
            ...b,
            parts: [
              ...d.items.map((i) => ({ key: i.key, v: i.cost_usd })),
              ...(d.other_usd > 0 ? [{ key: 'other', v: d.other_usd }] : []),
            ],
          }
        : b
    }),
  }
}

/** A contributor's name: redacted rows (§5.2) read "Another user's session", whatever the label says. */
export const keyLabel = (k: { label: string; redacted: boolean }) =>
  k.redacted ? copy.causesRedacted : k.label

/**
 * A picked contributor's cumulative spend this period (`burn?contributor=`), at each day's end and then `as_of`:
 * the share view's second line, in Burn-up units (F3, design 3B).
 */
export function shareLine(b: Burn): BurnChartPoint[] {
  const c = b.contributor
  if (!c) return []
  const start = Date.parse(b.period_start)
  const asOf = Date.parse(b.as_of)
  const out: BurnChartPoint[] = [{ t: start, v: 0 }]
  let cum = 0
  for (const d of c.daily) {
    const t = Date.parse(`${d.date}T00:00:00Z`)
    if (t < start) continue
    cum += d.cost_usd
    out.push({ t: Math.min(t + DAY_MS, asOf), v: cum })
  }
  return out
}

/**
 * What changed's ranges: Monday 00:00 UTC to `as_of`, against the same hours a week earlier (§7.3). null on Monday at
 * 00:00, when this week has no hours yet.
 */
export function changesWindow(b: Burn) {
  const to = Date.parse(b.as_of)
  const from = weekStart(to)
  if (to <= from) return null
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    from: iso(from),
    to: iso(to),
    compareFrom: iso(from - 7 * DAY_MS),
    compareTo: iso(to - 7 * DAY_MS),
  }
}

export interface ChangeRow {
  key: string
  label: string
  redacted: boolean
  cost: number
  compare: number
  delta: number
  /** null when last week was $0 ("new"). */
  pct: number | null
}

/**
 * The ranked rows, the server's order (largest change first, every contributor ranked, BG-4b); rows with no change
 * are dropped. Unpriced calls never make a delta: the server compares priced spend only (#58), and the page says how
 * many calls weren't compared.
 */
export function changeRows(c: Changes): ChangeRow[] {
  return c.items
    .filter((i) => i.delta_usd !== 0)
    .map((i) => ({
      key: i.key,
      label: keyLabel(i),
      redacted: i.redacted,
      cost: i.cost_usd,
      compare: i.compare_cost_usd,
      delta: i.delta_usd,
      pct: i.delta_pct,
    }))
}

/**
 * A picked contributor as a burn of its own, for its strip's spend and projection (design 3B): the same period and
 * clock, its own daily series, no budget (its allowance and run-out are its own budget's, which gets a link).
 */
export function contributorBurn(b: Burn): Burn | null {
  const c = b.contributor
  if (!c) return null
  return {
    ...b,
    label: c.label,
    budget: null,
    used_usd: c.used_usd,
    unpriced_calls: c.unpriced_calls,
    // Its split by source isn't read: only the totals feed the projection.
    daily: c.daily.map((d) => ({
      ...d,
      unpriced_calls: 0,
      routed_usd: 0,
      traced_usd: 0,
      harness_estimate_usd: 0,
    })),
    previous: null,
    events: [],
    contributor: null,
  }
}
