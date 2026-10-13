/**
 * Levers (plan feat-budget-burn F4, design 4A), pure: what OpenRuntime could do about a budget that is over or projected
 * past its limit, each with an estimated effect on this period's projected spend from the scope's own data, in two
 * groups. Reduce projected spend: turn on token optimization (measured savings only), route an agent to a cheaper model
 * of the same provider (only that agent, eng D4), stop calls at the limit (not for fleet or unit budgets, §7 Q1, nor
 * once it stops). Adjust the budget: raise the limit to where the projection lands (never shown as a saving).
 * Fleet, unit and owner scopes list levers for their top 3 agents by share of the projected overrun. Every estimate
 * assumes the rest of the period follows the last 7 days; the copy says so. `levers.test.ts`.
 */
import {
  cheaperModelEstimate,
  compressionEstimate,
  currentLimit,
  previewLine,
  projection,
  raiseTo,
  runOut,
  stopEstimate,
  type BurnMode,
  type BurnProjection,
  type ChartPoint,
} from './burn'
import { PACE_DAYS } from './tuning'
import type { Breakdown, Burn, Price } from './types'

const DAY_MS = 86_400_000

/** One agent a lever acts on, from its own reads (each may be missing: the lever then has no number or isn't offered). */
export interface LeverAgent {
  id: string
  name: string
  ownerId: string | null
  /** Its Token optimization switch; null when unknown (then not offered). */
  compressOn: boolean | null
  /** Its routed spend per day over the trailing 7 complete days, from its own burn read; null when unread. */
  routedPace: number | null
  /**
   * Its routed tokens by model this period (BG-11), keyed `provider/model`, already scaled to the share this budget
   * counts (an owner budget counts only the calls billed to its owner); null when unread.
   */
  models: { key: string; inputTokens: number; outputTokens: number }[] | null
  /**
   * Its routing, read for agents the viewer may act on: the model pin and the attached (or default) config's provider.
   * A pin elsewhere means the agent already moved; a config on another provider can't take this pin. Absent: unread.
   */
  routing?: { pinned: string | null; provider: string | null } | null
}

export interface LeverInput {
  burn: Burn
  agents: readonly LeverAgent[]
  /** Token optimization's measured cost reduction and how many agents it was measured on; null with no measurement. */
  measured: { pct: number; agents: number } | null
  prices: readonly Price[] | null
  /**
   * The budget record's action now (§6.3), when read: a write lands after the burn read's `as_of`, so the burn can
   * still show the version before it; a budget that already stops gets no stop lever.
   */
  action?: 'alert' | 'stop'
}

type ReduceLever =
  | {
      kind: 'compression'
      id: string
      agent: LeverAgent
      estimate: number | null
      basisAgents: number | null
    }
  | { kind: 'model'; id: string; agent: LeverAgent; from: Price; to: Price; estimate: number }
  | { kind: 'stop'; id: string; estimate: number | null; immediate: boolean; limit: number }

interface RaiseLever {
  kind: 'raise'
  id: string
  limit: number
  /** Used so far against the new limit. */
  usedPct: number
}

export type Lever = ReduceLever | RaiseLever

export type LeverList =
  | { state: 'no_budget' }
  | { state: 'no_projection' }
  | { state: 'on_track' }
  | { state: 'levers'; reduce: ReduceLever[]; adjust: RaiseLever[] }

/** Over the limit, or projected past it before the reset: the budgets F4 lists levers for. */
export function needsLevers(b: Burn, p: BurnProjection | null): boolean {
  const limit = currentLimit(b)
  if (limit === null) return false
  return b.used_usd >= limit || (p !== null && p.projected > limit)
}

export function leverList(input: LeverInput): LeverList {
  const b = input.burn
  if (!b.budget) return { state: 'no_budget' }
  const p = projection(b)
  if (!p) return { state: 'no_projection' }
  if (!needsLevers(b, p)) return { state: 'on_track' }
  const reduce: ReduceLever[] = []
  // A stopped budget's calls are refused: nothing more is spent until the reset, so nothing to reduce (#68); only the
  // raise, which would resume them, uses the projection.
  for (const a of b.budget.stopped ? [] : input.agents) {
    if (a.compressOn === false)
      reduce.push({
        kind: 'compression',
        id: `compression:${a.id}`,
        agent: a,
        estimate:
          a.routedPace === null || !input.measured
            ? null
            : compressionEstimate(a.routedPace, p.daysLeft, input.measured.pct),
        basisAgents: input.measured?.agents ?? null,
      })
    const m = cheaperModel(a, b, p.daysLeft, input.prices)
    if (m) reduce.push({ kind: 'model', id: `model:${a.id}`, agent: a, ...m })
  }
  // Fleet and unit budgets alert only (§7 Q1); a budget that already stops has nothing to switch.
  if (
    !b.budget.stopped &&
    b.budget.action !== 'stop' &&
    input.action !== 'stop' &&
    b.scope !== 'org' &&
    b.scope !== 'unit' &&
    b.scope !== 'session'
  ) {
    const limit = currentLimit(b) ?? 0
    reduce.push({
      kind: 'stop',
      id: 'stop',
      estimate: stopEstimate(b, p),
      immediate: b.used_usd >= limit,
      limit,
    })
  }
  reduce.sort((x, y) => (y.estimate ?? -1) - (x.estimate ?? -1))
  const to = raiseTo(p)
  const adjust: RaiseLever[] =
    to !== null && to > (currentLimit(b) ?? 0)
      ? [{ kind: 'raise', id: 'raise', limit: to, usedPct: (b.used_usd / to) * 100 }]
      : []
  return { state: 'levers', reduce, adjust }
}

/**
 * The cheaper model with the largest saving on this agent's own routed token mix, among its current model's provider's
 * priced models; null without its tokens or prices, or when nothing is cheaper.
 */
function cheaperModel(a: LeverAgent, b: Burn, daysLeft: number, prices: readonly Price[] | null) {
  if (!a.models?.length || !prices?.length) return null
  const elapsed = (Date.parse(b.as_of) - Date.parse(b.period_start)) / DAY_MS
  const priceOf = (key: string) => prices.find((x) => `${x.provider}/${x.model}` === key)
  // Its biggest model by routed tokens: the one a pin would replace.
  const main = [...a.models].sort(
    (x, y) => y.inputTokens + y.outputTokens - (x.inputTokens + x.outputTokens),
  )[0]
  const from = main && priceOf(main.key)
  if (!main || !from) return null
  // Already pinned elsewhere (its traffic this period is mixed), or a config this provider's pin can't apply to.
  if (a.routing === null) return null
  if (a.routing?.pinned && a.routing.pinned !== from.model) return null
  if (a.routing?.provider && a.routing.provider !== from.provider) return null
  let best: { to: Price; estimate: number } | null = null
  for (const to of prices) {
    if (to.provider !== from.provider || to.model === from.model) continue
    const estimate = cheaperModelEstimate(
      { inputTokens: main.inputTokens, outputTokens: main.outputTokens },
      elapsed,
      daysLeft,
      from,
      to,
    )
    if (estimate !== null && estimate > 0 && (!best || estimate > best.estimate))
      best = { to, estimate }
  }
  return best ? { from, to: best.to, estimate: best.estimate } : null
}

/**
 * The top 3 agents by share of the projected overrun (F4): the ones spending fastest over the last 7 days, as the
 * projection runs at that pace. `paces` are each agent's last-7-day spend counted the scope's way.
 */
export function topContributors<T extends { id: string; pace: number }>(
  paces: readonly T[],
  n = 3,
): T[] {
  return [...paces]
    .filter((x) => x.pace > 0)
    .sort((x, y) => y.pace - x.pace)
    .slice(0, n)
}

/** The scope's pace after a reduce lever (its estimate spread over the days left), never below zero. */
export function paceAfter(p: BurnProjection, estimate: number): number {
  return p.daysLeft > 0 ? Math.max(0, p.pace - estimate / p.daysLeft) : p.pace
}

export interface LeverPreview {
  /** The dashed "Preview, not applied" line. */
  line: ChartPoint[]
  /** Projected spend at the reset with it. */
  projected: number
  /** The limit it compares against (a raise changes it). */
  limit: number
}

/** A lever's preview on the chart and in the strip (F4: before anything is written). */
export function leverPreview(b: Burn, mode: BurnMode, lever: Lever): LeverPreview | null {
  const p = projection(b)
  const limit = currentLimit(b)
  if (!p || limit === null || !b.resets_at) return null
  if (lever.kind === 'raise') {
    // Burn-up: the new limit as a line (the pace doesn't change, so a spend line would hide under the projection);
    // Burndown: what's left of the new limit at the same pace.
    const line =
      mode === 'up'
        ? [
            { t: Date.parse(b.as_of), v: lever.limit },
            { t: Date.parse(b.resets_at), v: lever.limit },
          ]
        : previewLine(b, mode, p.pace, lever.limit)
    return { line, projected: p.projected, limit: lever.limit }
  }
  if (lever.kind === 'stop') {
    // Spend climbs at the pace until the limit, then calls stop: flat at the limit to the reset.
    const asOf = Date.parse(b.as_of)
    const end = Date.parse(b.resets_at)
    const ro = runOut(b, p)
    const at = ro && !ro.observed ? ro.at : asOf
    const show = (used: number) => (mode === 'up' ? used : limit - used)
    const capped = Math.max(limit, b.used_usd)
    return {
      line: [
        { t: asOf, v: show(b.used_usd) },
        { t: at, v: show(Math.min(capped, b.used_usd + (p.pace * (at - asOf)) / DAY_MS)) },
        { t: end, v: show(capped) },
      ],
      projected: capped,
      limit,
    }
  }
  if (lever.estimate === null) return null
  const pace = paceAfter(p, lever.estimate)
  return { line: previewLine(b, mode, pace), projected: b.used_usd + pace * p.daysLeft, limit }
}

/** An agent's routed spend per day over its trailing complete days (up to 7, at least 3), from its own burn read. */
export function routedPaceOf(b: Burn): number | null {
  const today = b.as_of.slice(0, 10)
  const days = [...(b.previous?.daily ?? []), ...b.daily]
    .filter((d) => d.date < today)
    .slice(-PACE_DAYS)
  if (days.length < 3) return null
  return days.reduce((s, d) => s + d.routed_usd, 0) / days.length
}

/** An agent's routed tokens by model this period (breakdown `by=model`, BG-11). */
export function modelsOf(br: Breakdown): NonNullable<LeverAgent['models']> {
  return br.keys
    .filter((k) => !k.redacted && (k.routed_input_tokens ?? 0) + (k.routed_output_tokens ?? 0) > 0)
    .map((k) => ({
      key: k.key,
      inputTokens: k.routed_input_tokens ?? 0,
      outputTokens: k.routed_output_tokens ?? 0,
    }))
}
