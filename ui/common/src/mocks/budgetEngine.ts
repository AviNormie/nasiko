/**
 * The budgets mock engine: one pure implementation of the 1.0 contract (docs/requirements/budgets.md) over a "world"
 * (a call ledger, budgets with versions, agents, users, units, sessions, watermarks). Every budget route of the mock
 * answers from it, R-L10's included, so status, burn, at risk and alerts can't disagree. Two worlds feed it: the app's
 * seed (`budgets.ts` `buildBudgetState`, the default, so budgets agree with Home and TokenOps) and the golden scenario
 * (`seed-budgets.ts`, the `budgets-golden` variant and the contract's fixtures).
 *
 * Rules, each from the spec: a refusal pass drops the routed calls a `stop` budget would have refused (§11); money is
 * summed in integer units of 1e-8 USD (§2); the threshold recorder walks calls in order and records each mark once
 * per (budget, period, version, percent) (§4.3a); forecast alerts replay every hour boundary (§9); unit attribution
 * follows the owner's membership and ancestry at the call's time (P-4); reads apply §5's ACL and §5.2's redaction.
 */
import { crossingAt, DAY_MS, project } from '@/features/budgets/projection'
import type {
  AlertV1,
  AtRiskRow,
  Breakdown,
  BudgetEvent,
  BudgetV1,
  Burn,
  BurnDay,
  Changes,
  Covers,
  Dimension,
  Hours,
  LimitStep,
  Price,
  Scope,
  StatusRow,
  TraceRow,
  UnbudgetedRow,
} from '@/features/budgets/types'
import { MockHttpError } from './aggregate'
import type { BudgetScenario, ScenarioCall, ScenarioVersion } from './seed-budgets'

// ─── world ──────────────────────────────────────────────────────────────────

type Source = ScenarioCall['source']
type Kind = 'month' | 'quarter' | 'session'

export interface WCall extends Omit<ScenarioCall, 'cost_usd'> {
  /** Cost in units of 1e-8 USD; null = unpriced. */
  u: number | null
}
export type WVersion = ScenarioVersion
export interface WBudget {
  id: string
  scope: Scope
  agent_id: string | null
  unit_id: string | null
  session_id: string | null
  owner_id: string | null
  created_at: number
  updated_at: number
  /** Ascending by `effective_from`; only versions that took effect or take effect at a write. */
  versions: WVersion[]
  next_period: {
    period: 'month' | 'quarter'
    effective_from: number
    set_by: string
    set_at: number
  } | null
  /** Deleted budgets stay in the world: their refusals happened (the refusal pass keeps them). */
  deleted_at: number | null
  /** Write events kept as records (§4.3a): period changes scheduled, fiscal year changes. Never rewritten. */
  log: {
    kind: 'period_change_scheduled' | 'fiscal_year_changed'
    at: number
    version: number
    period: 'month' | 'quarter' | null
    effective_from: number
    by: string
  }[]
}
interface WUser {
  id: string
  name: string
  role: 'superuser' | 'finance' | 'manager' | 'member'
}
interface WAgent {
  id: string
  name: string
  owner_id: string
  harness: boolean
  deleted?: boolean
}
export interface World {
  adminId: string
  edition: 'oss' | 'ee'
  /** Ascending by `at`, then `call_id`. */
  calls: WCall[]
  budgets: WBudget[]
  users: WUser[]
  agents: WAgent[]
  units: BudgetScenario['units']
  members: BudgetScenario['members']
  parents: BudgetScenario['parents']
  sessions: BudgetScenario['sessions']
  meta: { exact_dedupe_from: number | null; membership_history_from: number | null }
  /** Per-source completeness; Infinity = always complete (the default world). */
  watermarks: Record<Source, number>
  settings: {
    team_identity: boolean
    /** The fiscal year's first month over time, ascending (§6.8): a change applies from the next quarter start. */
    fiscal: { from: number; month: number }[]
    updated_at: number
  }
  prices: Price[]
  /** New budget ids: `${idPrefix}${n}` padded. */
  idPrefix: string
  seq: number
  /** Bumped on every write: memoized derivations key on it. */
  rev: number
}

export interface Viewer {
  id: string
  superuser: boolean
  finance?: boolean
  /** The member switched "Show my team's usage" on (EE, honoured only while `team_identity` is on). */
  teamUsage?: boolean
}

// ─── money, time, errors ────────────────────────────────────────────────────

const U = 1e8
export const toUnits = (usd: number) => Math.round(usd * U)
const usd = (u: number) => u / U
const cents = (v: number) => Math.round(v * 100) / 100
/** Half-even to whole cents (§6.4), on the value's own decimal digits so float noise can't tip a tie. */
const centsHalfEven = (v: number) => {
  const scaled = Number((v * 100).toFixed(6))
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const n = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1
  return n / 100
}
const round2 = (v: number) => Math.round(v * 100) / 100
const HOUR = 3_600_000
/** RFC 3339 UTC, to the second, as the spec's examples (`2026-10-14T12:00:00Z`). */
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
const dayOf = (t: number) => iso(t).slice(0, 10)
const dayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS
const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`)

/** A 1.0 error: `{error, code}` JSON (§13). */
const fail = (status: number, code: string, message: string): never => {
  throw new MockHttpError(status, message, { error: message, code })
}
const notFound = () => fail(404, 'scope_not_found', 'not found')
const budgetNotFound = () => fail(404, 'budget_not_found', 'budget not found')

// ─── periods ────────────────────────────────────────────────────────────────

/** `[start, end)` of the month or (fiscal) quarter containing `t`. */
function periodAt(kind: 'month' | 'quarter', t: number, firstMonth = 1): [number, number] {
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  if (kind === 'month') return [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)]
  const k = (((m - (firstMonth - 1)) % 12) + 12) % 12
  const start = m - (k % 3)
  return [Date.UTC(y, start, 1), Date.UTC(y, start + 3, 1)]
}

/** A month, or a (fiscal) quarter under the setting in force at `t`, clamped at a fiscal change (§4.3). */
function periodOf(w: World, kind: 'month' | 'quarter', t: number): [number, number] {
  if (kind === 'month') return periodAt('month', t)
  const f = w.settings.fiscal
  let i = 0
  while (i + 1 < f.length && f[i + 1]!.from <= t) i++
  const [s0, e0] = periodAt('quarter', t, f[i]!.month)
  const next = f[i + 1]
  return [Math.max(s0, f[i]!.from), next && e0 > next.from ? next.from : e0]
}

export const versionAt = (b: WBudget, t: number): WVersion =>
  [...b.versions].reverse().find((v) => v.effective_from <= t) ?? b.versions[0]!

const sessionOf = (w: World, id: string | null) => w.sessions.find((s) => s.id === id)

/** The budget period containing `t`: a session budget's one period is its session, open-ended. */
function budgetPeriod(w: World, b: WBudget, t: number): [number, number] {
  const v = versionAt(b, t)
  if (v.period === 'session') {
    const s = sessionOf(w, b.session_id)
    return [s?.started_at ?? b.created_at, Infinity]
  }
  return periodOf(w, v.period, t)
}

// ─── units (P-4) ────────────────────────────────────────────────────────────

const active = (r: { from: number; to: number | null }, t: number) =>
  r.from <= t && (r.to === null || t < r.to)

/** Units a user belonged to at `t`, sub-units' ancestors included; before the history, current membership. */
function unitsOfUser(w: World, user: string, t: number): Set<string> {
  const current = w.meta.membership_history_from === null || t < w.meta.membership_history_from
  const live = (r: { from: number; to: number | null }) => (current ? r.to === null : active(r, t))
  const out = new Set<string>()
  for (const m of w.members) {
    if (m.user_id !== user || !live(m)) continue
    let unit: string | null = m.unit_id
    while (unit && !out.has(unit)) {
      out.add(unit)
      unit = w.parents.find((p) => p.unit_id === unit && live(p))?.parent_id ?? null
    }
  }
  return out
}

const ownerOf = (w: World, agentId: string | null) =>
  agentId ? w.agents.find((a) => a.id === agentId)?.owner_id : undefined

const unitCache = new WeakMap<World, { rev: number; map: Map<string, Set<string>> }>()
/** Units a call counts toward: its agent's owner's units at the call's time. */
function unitsOfCall(w: World, c: WCall): Set<string> {
  let cache = unitCache.get(w)
  if (!cache || cache.rev !== w.rev) unitCache.set(w, (cache = { rev: w.rev, map: new Map() }))
  let s = cache.map.get(c.call_id)
  if (!s) {
    const owner = ownerOf(w, c.agent_id)
    s = owner ? unitsOfUser(w, owner, c.at) : new Set()
    cache.map.set(c.call_id, s)
  }
  return s
}

/** Units `unit` and below, by current ancestry. */
function subtree(w: World, unit: string): Set<string> {
  const out = new Set([unit])
  let grew = true
  while (grew) {
    grew = false
    for (const p of w.parents)
      if (p.to === null && p.parent_id && out.has(p.parent_id) && !out.has(p.unit_id)) {
        out.add(p.unit_id)
        grew = true
      }
  }
  return out
}

/** Users who are members of `unit` or its sub-units now. */
const membersOf = (w: World, unit: string) => {
  const units = subtree(w, unit)
  return new Set(
    w.members.filter((m) => m.to === null && units.has(m.unit_id)).map((m) => m.user_id),
  )
}

// ─── populations (§4.2) ─────────────────────────────────────────────────────

const coversOf = (scope: Scope): Covers =>
  scope === 'org' || scope === 'unit' ? 'all_priced' : 'routed_calls'

function inScope(w: World, scope: Scope, id: string | null, c: WCall): boolean {
  switch (scope) {
    case 'org':
      return true
    case 'agent':
      return c.agent_id === id
    case 'owner':
      return c.billed_user_id === id
    case 'session':
      return c.chat_session_id === id
    case 'unit':
      return id !== null && unitsOfCall(w, c).has(id)
  }
}

/** The budgets that exist now (deleted ones only keep their history in the refusal pass). */
const alive = (w: World) => w.budgets.filter((b) => b.deleted_at === null)

const budgetOf = (w: World, scope: Scope, id: string | null) =>
  alive(w).find(
    (b) =>
      b.scope === scope &&
      (scope === 'org' ||
        (scope === 'unit' && b.unit_id === id) ||
        (scope === 'owner' && b.owner_id === id) ||
        (scope === 'agent' && b.agent_id === id) ||
        (scope === 'session' && b.session_id === id)),
  )
const targetOf = (b: WBudget) =>
  b.agent_id ?? b.unit_id ?? b.session_id ?? (b.scope === 'owner' ? b.owner_id : null)

// ─── the refusal pass (§11) ─────────────────────────────────────────────────

const acceptedCache = new WeakMap<World, { rev: number; calls: WCall[] }>()
/** The calls that happened: a routed call a `stop` budget was refusing at its time never reached a provider. */
export function accepted(w: World): WCall[] {
  const hit = acceptedCache.get(w)
  if (hit && hit.rev === w.rev) return hit.calls
  const stoppable = w.budgets.filter((b) => b.scope !== 'org' && b.scope !== 'unit')
  const spend = new Map<string, number>() // `${budget}:${periodStart}` → units
  const out: WCall[] = []
  for (const c of w.calls) {
    if (c.source !== 'routed') {
      out.push(c)
      continue
    }
    const mine = stoppable.filter((b) => inScope(w, b.scope, targetOf(b), c))
    const key = (b: WBudget) => `${b.id}:${budgetPeriod(w, b, c.at)[0]}`
    const refused = mine.some((b) => {
      if (c.at < b.created_at || (b.deleted_at !== null && c.at >= b.deleted_at)) return false
      const v = versionAt(b, c.at)
      return v.action === 'stop' && (spend.get(key(b)) ?? 0) >= toUnits(v.limit_usd)
    })
    if (refused) continue
    out.push(c)
    for (const b of mine) spend.set(key(b), (spend.get(key(b)) ?? 0) + (c.u ?? 0))
  }
  acceptedCache.set(w, { rev: w.rev, calls: out })
  return out
}

// ─── as_of (P-3) ────────────────────────────────────────────────────────────

const asOfFor = (w: World, now: number) =>
  Math.floor(
    Math.min(now, w.watermarks.routed, w.watermarks.traced, w.watermarks.harness_estimate) / 1000,
  ) * 1000

// ─── ACL and redaction (§5, §5.2) ───────────────────────────────────────────

/** A unit lead is a `manager` named as the unit's lead (§5); `lead_id` alone grants nothing. */
const ledUnits = (w: World, v: Viewer) => {
  const out = new Set<string>()
  if (w.users.find((u) => u.id === v.id)?.role !== 'manager') return out
  for (const u of w.units) if (u.lead_id === v.id) for (const s of subtree(w, u.id)) out.add(s)
  return out
}
const teamOn = (w: World, v: Viewer) =>
  w.edition === 'ee' && w.settings.team_identity && !!v.teamUsage
const directUnits = (w: World, v: Viewer) =>
  new Set(w.members.filter((m) => m.to === null && m.user_id === v.id).map((m) => m.unit_id))

/** A target that exists (agents not deleted). */
function targetLabel(w: World, scope: Scope, id: string | null): string | null {
  switch (scope) {
    case 'org':
      return 'Fleet'
    case 'unit':
      return w.units.find((u) => u.id === id)?.name ?? null
    case 'owner':
      return w.users.find((u) => u.id === id)?.name ?? null
    case 'agent':
      return w.agents.find((a) => a.id === id && !a.deleted)?.name ?? null
    case 'session': {
      const s = sessionOf(w, id)
      return s ? s.title || `Session ${s.id.slice(0, 8)}` : null
    }
  }
}

function canRead(w: World, v: Viewer, scope: Scope, id: string | null): boolean {
  if (targetLabel(w, scope, id) === null) return false
  if (v.superuser) return true
  const session = scope === 'session' ? sessionOf(w, id) : undefined
  if (v.finance) return scope !== 'session' || session?.user_id === v.id
  const led = ledUnits(w, v)
  const ledMember = (user: string | undefined) =>
    !!user && [...led].some((u) => membersOf(w, u).has(user))
  switch (scope) {
    case 'org':
      return false
    case 'unit':
      return led.has(id!) || (teamOn(w, v) && directUnits(w, v).has(id!))
    case 'owner':
      return id === v.id || ledMember(id!)
    case 'agent': {
      const owner = ownerOf(w, id)
      return owner === v.id || ledMember(owner)
    }
    case 'session':
      return session?.user_id === v.id || ledMember(ownerOf(w, session?.agent_id ?? null))
  }
}

/** Write after read (§5 precedence): 404 when unreadable, then 403. */
function requireWrite(w: World, v: Viewer, scope: Scope, id: string | null) {
  if (!canRead(w, v, scope, id)) notFound()
  if (v.superuser) return
  // Finance reads everything it may and writes nothing (§5).
  if (v.finance)
    fail(
      403,
      scope === 'org' || scope === 'unit' ? 'not_allowed' : 'not_owner',
      scope === 'org' || scope === 'unit' ? 'only an admin can do this' : 'not your budget',
    )
  if (scope === 'org' || scope === 'unit') fail(403, 'not_allowed', 'only an admin can do this')
  const mine =
    scope === 'owner'
      ? id === v.id
      : scope === 'agent'
        ? ownerOf(w, id) === v.id
        : sessionOf(w, id)?.user_id === v.id
  if (!mine)
    fail(
      403,
      'not_owner',
      scope === 'agent'
        ? 'not the agent owner'
        : scope === 'session'
          ? 'not the session owner'
          : 'not your budget',
    )
}

/** Another user's session or trace stays hidden from this viewer (§5.2). */
function identityVisible(w: World, v: Viewer, c: WCall): boolean {
  if (v.superuser || c.billed_user_id === v.id) return true
  const units = unitsOfCall(w, c)
  const led = ledUnits(w, v)
  if ([...units].some((u) => led.has(u))) return true
  if (teamOn(w, v)) {
    const mine = directUnits(w, v)
    if ([...units].some((u) => mine.has(u))) return true
  }
  return false
}

// ─── sums ───────────────────────────────────────────────────────────────────

interface Sum {
  u: number
  calls: number
  unpriced: number
  routed: number
  traced: number
  harness: number
}
const zero = (): Sum => ({ u: 0, calls: 0, unpriced: 0, routed: 0, traced: 0, harness: 0 })
function add(s: Sum, c: WCall) {
  const u = c.u ?? 0
  s.u += u
  s.calls += 1
  if (c.u === null) s.unpriced += 1
  if (c.source === 'routed') s.routed += u
  else if (c.source === 'traced') s.traced += u
  else s.harness += u
}
const sumOf = (cs: readonly WCall[]) => {
  const s = zero()
  for (const c of cs) add(s, c)
  return s
}
const dayRow = (date: string, s: Sum): BurnDay => ({
  date,
  cost_usd: usd(s.u),
  calls: s.calls,
  unpriced_calls: s.unpriced,
  routed_usd: usd(s.routed),
  traced_usd: usd(s.traced),
  harness_estimate_usd: usd(s.harness),
})
/** One row per UTC day from `from` to `toDay` inclusive, zeros included. */
function dailyRows(cs: readonly WCall[], from: number, toDay: number): BurnDay[] {
  const out: BurnDay[] = []
  const byDay = new Map<number, Sum>()
  for (const c of cs) {
    const d = dayStart(c.at)
    let s = byDay.get(d)
    if (!s) byDay.set(d, (s = zero()))
    add(s, c)
  }
  for (let d = dayStart(from); d <= toDay; d += DAY_MS)
    out.push(dayRow(dayOf(d), byDay.get(d) ?? zero()))
  return out
}

/** The population's counted calls before `asOf` (the budget's `covers`, or all priced without one). */
function counted(w: World, scope: Scope, id: string | null, covers: Covers, asOf: number) {
  return accepted(w).filter(
    (c) =>
      c.at < asOf && (covers === 'all_priced' || c.source === 'routed') && inScope(w, scope, id, c),
  )
}

// ─── budget state (§4.5) ────────────────────────────────────────────────────

interface Figures {
  start: number
  end: number
  used: Sum
  version: WVersion
  state: 'ok' | 'warning' | 'exceeded'
  crossed: number | null
  stopped: boolean
  calls: WCall[]
}
function figures(w: World, b: WBudget, asOf: number): Figures {
  const [start, end] = budgetPeriod(w, b, asOf)
  const scopeId = targetOf(b)
  const calls = counted(w, b.scope, scopeId, coversOf(b.scope), asOf).filter((c) => c.at >= start)
  const used = sumOf(calls)
  const version = versionAt(b, asOf)
  const limit = toUnits(version.limit_usd)
  const pct = (used.u / limit) * 100
  const crossed = [...version.thresholds].reverse().find((t) => pct >= t) ?? null
  const exceeded = used.u >= limit
  return {
    start,
    end,
    used,
    version,
    crossed,
    state: exceeded ? 'exceeded' : crossed !== null ? 'warning' : 'ok',
    stopped: exceeded && version.action === 'stop' && coversOf(b.scope) === 'routed_calls',
    calls,
  }
}

// ─── the threshold recorder and version events (§4.3a) ──────────────────────

interface Rec extends BudgetEvent {
  amount_usd?: number
  stoppedAlert?: boolean
}
const KIND_ORDER = [
  'limit_changed',
  'action_changed',
  'period_change_scheduled',
  'fiscal_year_changed',
  'threshold',
  'forecast',
  'forecast_cleared',
  'stopped',
  'resumed',
]
const ev = (
  b: WBudget,
  kind: string,
  at: number,
  version: number,
  p: Partial<BudgetEvent> = {},
): Rec => ({
  id: `${b.id}:${kind}:${iso(at)}:v${version}:${p.percent ?? '-'}`,
  at: iso(at),
  kind,
  budget_id: b.id,
  version,
  percent: null,
  crosses_on: null,
  from_usd: null,
  to_usd: null,
  from_action: null,
  to_action: null,
  by: null,
  period: null,
  effective_from: null,
  ...p,
})
const eventOrder = (a: BudgetEvent, b: BudgetEvent) =>
  a.at.localeCompare(b.at) ||
  KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
  a.version - b.version ||
  (a.percent ?? 0) - (b.percent ?? 0) ||
  a.id.localeCompare(b.id)

const recordsCache = new WeakMap<World, Map<string, { key: string; out: Rec[] }>>()
/** Every event and alert of one budget up to `asOf`: thresholds, stops, resumes, version events, forecasts. */
function records(w: World, b: WBudget, asOf: number): Rec[] {
  let byKey = recordsCache.get(w)
  if (!byKey) recordsCache.set(w, (byKey = new Map()))
  const key = `${w.rev}:${b.id}:${asOf}`
  const hit = byKey.get(b.id)
  if (hit && hit.key === key) return hit.out
  const out: Rec[] = []
  // Version events, written with the version.
  b.versions.forEach((v, i) => {
    const prev = b.versions[i - 1]
    if (!prev || v.effective_from >= asOf) return
    if (prev.limit_usd !== v.limit_usd)
      out.push(
        ev(b, 'limit_changed', v.effective_from, v.version, {
          from_usd: prev.limit_usd,
          to_usd: v.limit_usd,
          by: v.set_by,
        }),
      )
    if (prev.action !== v.action)
      out.push(
        ev(b, 'action_changed', v.effective_from, v.version, {
          from_action: prev.action,
          to_action: v.action,
          by: v.set_by,
        }),
      )
  })
  for (const l of b.log)
    if (l.at < asOf)
      out.push(
        ev(b, l.kind, l.at, l.version, {
          period: l.period,
          effective_from: iso(l.effective_from),
          by: l.by,
        }),
      )
  out.push(...thresholdWalk(w, b, asOf), ...forecastReplay(w, b, asOf))
  out.sort(eventOrder)
  // One entry per budget: a later as_of replaces it, so the cache never grows past the budget count.
  byKey.set(b.id, { key, out })
  return out
}

function thresholdWalk(w: World, b: WBudget, asOf: number): Rec[] {
  const out: Rec[] = []
  const stoppable = coversOf(b.scope) === 'routed_calls'
  const calls = counted(w, b.scope, targetOf(b), coversOf(b.scope), asOf)
  const firstStart = budgetPeriod(w, b, b.created_at)[0]
  // Timeline: calls, the creation (version 1's activation), later versions' activations, and every period start (a
  // stop that was refusing resumes there, even with no call after it).
  type Step = { at: number; call?: WCall; activate?: WVersion; boundary?: true }
  const boundaries: Step[] = []
  if (versionAt(b, b.created_at).period !== 'session')
    for (let p = budgetPeriod(w, b, firstStart)[1]; p < asOf; p = budgetPeriod(w, b, p)[1])
      boundaries.push({ at: p, boundary: true })
  const steps = (
    [
      ...boundaries,
      ...calls.filter((c) => c.at >= firstStart).map((c) => ({ at: c.at, call: c })),
      { at: b.created_at, activate: b.versions[0]! },
      ...b.versions
        .slice(1)
        .filter((v) => v.effective_from < asOf)
        .map((v) => ({ at: v.effective_from, activate: v })),
    ] as Step[]
  ).sort((x, y) => x.at - y.at || (x.activate ? -1 : 0) - (y.activate ? -1 : 0))
  let period = firstStart
  let cum = 0
  let live: WVersion | null = null // null before creation: spend counts silently
  const passed = new Set<string>() // `${period}:${version}:${percent}`
  const refusing = () =>
    live !== null && stoppable && live.action === 'stop' && cum >= toUnits(live.limit_usd)
  for (const s of steps) {
    const [ps] = budgetPeriod(w, b, s.at)
    if (ps !== period) {
      if (refusing()) out.push(ev(b, 'resumed', ps, live!.version))
      period = ps
      cum = 0
    }
    if (s.boundary) continue
    if (s.activate) {
      const was = refusing()
      live = s.activate
      for (const p of live.thresholds)
        if (cum >= (toUnits(live.limit_usd) * p) / 100) passed.add(`${period}:${live.version}:${p}`)
      const now = refusing()
      if (was && !now) out.push(ev(b, 'resumed', s.at, live.version))
      if (!was && now) out.push(ev(b, 'stopped', s.at, live.version))
      continue
    }
    const c = s.call!
    const before = cum
    cum += c.u ?? 0
    if (!live) continue
    const limit = toUnits(live.limit_usd)
    for (const p of live.thresholds) {
      const k = `${period}:${live.version}:${p}`
      if (passed.has(k) || cum < (limit * p) / 100) continue
      passed.add(k)
      out.push({
        ...ev(b, 'threshold', c.at, live.version, { percent: p }),
        amount_usd: cents((live.limit_usd * p) / 100),
        stoppedAlert: p >= 100 && live.action === 'stop',
      })
    }
    if (stoppable && live.action === 'stop' && before < limit && cum >= limit)
      out.push(ev(b, 'stopped', c.at, live.version))
  }
  return out.filter((r) => Date.parse(r.at) < asOf)
}

/** Forecast alerts (§9): every hour boundary of each period, in order, with the data known now. */
function forecastReplay(w: World, b: WBudget, asOf: number): Rec[] {
  if (b.scope === 'session' || !b.versions.some((v) => v.forecast_thresholds.length)) return []
  const out: Rec[] = []
  const calls = counted(w, b.scope, targetOf(b), coversOf(b.scope), asOf)
  let start = budgetPeriod(w, b, b.created_at)[0]
  while (start < asOf) {
    const [, end] = budgetPeriod(w, b, start)
    const inP = calls.filter((c) => c.at >= start && c.at < end)
    const daily = new Map<number, number>()
    for (const c of inP) daily.set(dayStart(c.at), (daily.get(dayStart(c.at)) ?? 0) + (c.u ?? 0))
    const state = new Map<number, { fired: boolean; below: number }>()
    let i = 0
    let used = 0
    for (let h = start; h <= Math.min(asOf, end - 1); h += HOUR) {
      while (i < inP.length && inP[i]!.at < h) used += inP[i++]!.u ?? 0
      const v = versionAt(b, h)
      if (!v.forecast_thresholds.length || h < b.created_at) continue
      const days: { date: string; cost_usd: number }[] = []
      for (let d = dayStart(start); d < dayStart(h); d += DAY_MS)
        days.push({ date: dayOf(d), cost_usd: usd(daily.get(d) ?? 0) })
      const pr = project({
        daily: days,
        used: usd(used),
        limit: v.limit_usd,
        resetsAt: end,
        asOf: h,
      })
      // Pace 0 is no projection (§9): nothing fires and a pending clear neither advances nor resets.
      if (!pr || pr.pace === 0) continue
      for (const p of v.forecast_thresholds) {
        const st = state.get(p) ?? { fired: false, below: 0 }
        state.set(p, st)
        const target = (v.limit_usd * p) / 100
        if (!st.fired) {
          if (usd(used) < target && pr.projected >= target) {
            const at = crossingAt(usd(used), pr.pace, target, h)
            if (at < end) {
              st.fired = true
              st.below = 0
              out.push({
                ...ev(b, 'forecast', h, v.version, { percent: p, crosses_on: dayOf(at) }),
                amount_usd: cents(target),
              })
            }
          }
        } else if (pr.projectedPct !== null && pr.projectedPct < p - 5) {
          st.below += 1
          if (st.below >= 25) {
            st.fired = false
            st.below = 0
            out.push({
              ...ev(b, 'forecast_cleared', h, v.version, { percent: p }),
              amount_usd: cents(target),
            })
          }
        } else st.below = 0
      }
    }
    start = end
  }
  return out
}

// ─── views ──────────────────────────────────────────────────────────────────

function budgetLabel(w: World, b: WBudget) {
  return (
    targetLabel(w, b.scope, targetOf(b)) ?? `Agent ${(b.agent_id ?? '').slice(0, 8)}… (not listed)`
  )
}

/** Limits inside an org or unit budget (§4.4): its direct children with the same period. */
function limitsInside(w: World, b: WBudget, now: number): [number | null, number | null] {
  if (b.scope !== 'org' && b.scope !== 'unit') return [null, null]
  const period = versionAt(b, now).period
  const rootOrChild = (u: string) =>
    w.parents.some(
      (p) =>
        p.to === null && p.unit_id === u && p.parent_id === (b.scope === 'org' ? null : b.unit_id),
    )
  const direct = (user: string) => {
    const units = w.members.filter((m) => m.to === null && m.user_id === user).map((m) => m.unit_id)
    return b.scope === 'org' ? units.length === 0 : units.includes(b.unit_id!)
  }
  const kids = alive(w).filter(
    (c) =>
      versionAt(c, now).period === period &&
      ((c.scope === 'unit' && rootOrChild(c.unit_id!)) ||
        (c.scope === 'owner' && direct(c.owner_id!))),
  )
  if (!kids.length) return [null, null]
  return [cents(kids.reduce((t, c) => t + versionAt(c, now).limit_usd, 0)), kids.length]
}

export function budgetView(w: World, b: WBudget, now: number): BudgetV1 {
  const v = versionAt(b, now)
  const [inside, count] = limitsInside(w, b, now)
  return {
    id: b.id,
    scope: b.scope,
    agent_id: b.agent_id,
    unit_id: b.unit_id,
    session_id: b.session_id,
    owner_id: b.owner_id,
    label: budgetLabel(w, b),
    set_by: v.set_by,
    period: v.period,
    limit_usd: v.limit_usd,
    thresholds: v.thresholds,
    forecast_thresholds: v.forecast_thresholds,
    action: v.action,
    covers: coversOf(b.scope),
    version: v.version,
    effective_from: iso(v.effective_from),
    next_period_change: b.next_period
      ? { period: b.next_period.period, effective_from: iso(b.next_period.effective_from) }
      : null,
    limits_inside_usd: inside,
    limits_inside_count: count,
    created_at: iso(b.created_at),
    updated_at: iso(b.updated_at),
  }
}

// ─── paging ─────────────────────────────────────────────────────────────────

function page<T>(rows: readonly T[], limit = 50, cursor?: string | null) {
  const max = Math.min(100, Math.max(1, limit))
  let offset = 0
  if (cursor) {
    const m = /^o(\d+)$/.exec(cursor)
    if (!m) fail(400, 'invalid_cursor', 'invalid cursor')
    offset = Number(m![1])
  }
  const data = rows.slice(offset, offset + max)
  const more = offset + max < rows.length
  return {
    data,
    has_more: more,
    next_cursor: more ? `o${offset + max}` : null,
    prev_cursor: offset > 0 ? `o${Math.max(0, offset - max)}` : null,
  }
}

// ─── reads: shared parameter rules ──────────────────────────────────────────

const SCOPE_LIST = ['org', 'unit', 'owner', 'agent', 'session'] as const
export interface ScopeQuery {
  scope: string | null
  id: string | null
}
/** 404 first, then 400s (§5 precedence). */
function readTarget(
  w: World,
  v: Viewer,
  q: ScopeQuery,
): { scope: Scope; id: string | null; label: string } {
  const scope = q.scope as Scope
  if (!(SCOPE_LIST as readonly string[]).includes(q.scope ?? ''))
    fail(400, 'invalid_scope', 'scope must be org, unit, owner, agent or session')
  if (scope === 'unit' && w.edition !== 'ee')
    fail(400, 'invalid_scope', 'scope must be org, unit, owner, agent or session')
  const id = scope === 'org' ? null : q.id
  if (scope !== 'org' && !id) fail(400, 'missing_id', 'id is required for this scope')
  if (!canRead(w, v, scope, id)) notFound()
  return { scope, id, label: targetLabel(w, scope, id)! }
}

const ALLOWED: Record<Scope, readonly Dimension[]> = {
  org: ['agent', 'owner', 'unit', 'model', 'operation', 'source'],
  unit: ['agent', 'owner', 'unit', 'model', 'operation', 'source'],
  owner: ['agent', 'model', 'operation', 'source'],
  agent: ['model', 'operation', 'session', 'source'],
  session: ['model', 'operation'],
}
function dimension(w: World, scope: Scope, by: string | null): Dimension {
  const ok = ALLOWED[scope].filter((d) => d !== 'unit' || w.edition === 'ee')
  if (!by || !(ok as readonly string[]).includes(by))
    fail(400, 'invalid_dimension', `by=${by ?? ''} is not available for this scope`)
  return by as Dimension
}

const OPERATION_LABELS: Record<string, string> = {
  chat: 'Chat',
  tool: 'Tools',
  workflow: 'Workflows',
  routing: 'Routing',
  harness: 'Coding harness',
}
const SOURCE_LABELS: Record<string, string> = {
  routed: 'Routed calls',
  traced: 'Other traced calls',
  harness_estimate: 'Harness estimates',
}

/** A call's key in a dimension (unit handled apart); null folds it into Other. */
function keyOf(w: World, by: Dimension, c: WCall): string | null {
  switch (by) {
    case 'agent':
      return c.agent_id ?? 'unattributed'
    case 'owner':
      return ownerOf(w, c.agent_id) ?? 'unattributed'
    case 'model':
      return c.model
    case 'operation':
      return c.operation
    case 'source':
      return c.source
    case 'session':
      return c.chat_session_id
    case 'unit':
      return null
  }
}
function labelOf(w: World, by: Dimension, key: string): string {
  if (key === 'unattributed') return 'Unattributed'
  switch (by) {
    case 'agent':
      return w.agents.find((a) => a.id === key)?.name ?? key
    case 'owner':
      return w.users.find((u) => u.id === key)?.name ?? key
    case 'unit':
      return w.units.find((u) => u.id === key)?.name ?? key
    case 'operation':
      return OPERATION_LABELS[key] ?? key
    case 'source':
      return SOURCE_LABELS[key] ?? key
    case 'session': {
      const s = sessionOf(w, key)
      return s ? s.title || `Session ${key.slice(0, 8)}` : `Session ${key.slice(0, 8)}`
    }
    case 'model':
      return key
  }
}

/** Session keys this viewer may not see become `redacted:N`, numbered by the real id's order (stable per response). */
function redactor(w: World, v: Viewer, cs: readonly WCall[]) {
  const hidden = [
    ...new Set(
      cs
        .filter((c) => c.chat_session_id && !identityVisible(w, v, c))
        .map((c) => c.chat_session_id!),
    ),
  ].sort()
  const token = new Map(hidden.map((s, i) => [s, `redacted:${i + 1}`]))
  return (key: string | null) => (key && token.get(key)) ?? key
}

// ─── GET /api/budgets/burn (§7.1) ───────────────────────────────────────────

export interface BurnQuery extends ScopeQuery {
  period?: string | null
  from?: string | null
  include_previous?: string | null
  contributor?: string | null
  by?: string | null
}

const okPeriod = (p: string | null | undefined) => {
  if (p && p !== 'month' && p !== 'quarter')
    fail(400, 'invalid_period', 'period must be month or quarter')
  return (p || null) as 'month' | 'quarter' | null
}

export function burn(w: World, v: Viewer, q: BurnQuery, now: number): Burn {
  const t = readTarget(w, v, q)
  const period = okPeriod(q.period)
  const b = budgetOf(w, t.scope, t.id)
  const covers: Covers = b ? coversOf(t.scope) : 'all_priced'
  const asOf = asOfFor(w, now)
  const session = t.scope === 'session' ? sessionOf(w, t.id) : undefined
  // A budget's own periods (its versions' kinds) govern; `period` alone sets the default range (§7.1): a month budget
  // read with `period=quarter` starts at the quarter's first day and still resets monthly.
  const periodFn = (at: number): [number, number] =>
    b ? budgetPeriod(w, b, at) : periodOf(w, period ?? 'month', at)
  const kind: Kind = session ? 'session' : b ? versionAt(b, asOf).period : (period ?? 'month')
  const [start, end] = session ? [session.started_at, Infinity] : periodFn(asOf)
  const from = session
    ? dayStart(start)
    : q.from
      ? parseDay(q.from)
      : dayStart(period ? periodOf(w, period, asOf)[0] : start)
  if (
    !Number.isFinite(from) ||
    from > dayStart(asOf) ||
    (!session && (dayStart(asOf) - from) / DAY_MS > 400)
  )
    fail(400, 'bad_range', 'from must be on or before to, within 400 days')
  if (!!q.contributor !== !!q.by) fail(400, 'contributor_needs_by', 'contributor needs by')
  const by = q.by ? dimension(w, t.scope, q.by) : null

  const all = counted(w, t.scope, t.id, covers, asOf)
  const range = all.filter((c) => c.at >= from)
  const current = all.filter((c) => c.at >= start && c.at < end)
  const used = sumOf(current)
  const outsidePop =
    covers === 'routed_calls'
      ? sumOf(
          counted(w, t.scope, t.id, 'all_priced', asOf).filter(
            (c) => c.at >= start && c.at < end && c.source !== 'routed',
          ),
        )
      : null

  let budget: Burn['budget'] = null
  let events: BudgetEvent[] = []
  if (b) {
    const f = figures(w, b, asOf)
    const bounds = new Set<number>([from])
    for (const ver of b.versions)
      if (ver.effective_from > from && ver.effective_from < end) bounds.add(ver.effective_from)
    if (!session) for (let p = periodFn(from)[1]; p < end; p = periodFn(p)[1]) bounds.add(p)
    const sorted = [...bounds].sort((x, y) => x - y)
    const limits: LimitStep[] = sorted.map((at, i) => {
      const ver = versionAt(b, at)
      return {
        from: iso(at),
        to: i + 1 < sorted.length ? iso(sorted[i + 1]!) : null,
        version: ver.version,
        limit_usd: ver.limit_usd,
        thresholds: ver.thresholds,
        action: ver.action,
      }
    })
    budget = {
      id: b.id,
      action: f.version.action,
      version: f.version.version,
      forecast_thresholds: f.version.forecast_thresholds,
      state: f.state,
      crossed: f.crossed,
      stopped: f.stopped,
      limits,
    }
    events = records(w, b, asOf)
      .filter((r) => Date.parse(r.at) >= from)
      .map(({ amount_usd: _a, stoppedAlert: _s, ...e }) => e)
  }

  const periods: Burn['periods'] = []
  if (session)
    periods.push({
      period_start: iso(start),
      resets_at: null,
      used_usd: usd(used.u),
      unpriced_calls: used.unpriced,
    })
  else
    for (let p = periodFn(from)[0]; p <= asOf;) {
      const [ps, pe] = periodFn(p)
      const s = sumOf(range.filter((c) => c.at >= ps && c.at < pe))
      periods.push({
        period_start: iso(ps),
        resets_at: iso(pe),
        used_usd: usd(s.u),
        unpriced_calls: s.unpriced,
      })
      p = pe
    }

  let previous: Burn['previous'] = null
  if (!session && q.include_previous === 'true') {
    const [ps, pe] = periodFn(start - 1)
    const cs = all.filter((c) => c.at >= ps && c.at < pe)
    const s = sumOf(cs)
    previous = {
      period_start: iso(ps),
      resets_at: iso(pe),
      used_usd: usd(s.u),
      unpriced_calls: s.unpriced,
      daily: dailyRows(cs, ps, pe - DAY_MS),
    }
  }

  let contributor: Burn['contributor'] = null
  if (by && q.contributor) {
    const redact = redactor(w, v, range)
    if (by === 'session') {
      const visible = range.some(
        (c) => c.chat_session_id === q.contributor && identityVisible(w, v, c),
      )
      if (!visible) fail(400, 'invalid_contributor', 'this contributor can’t be selected')
    } else if (q.contributor.startsWith('redacted:'))
      fail(400, 'invalid_contributor', 'this contributor can’t be selected')
    const mine =
      by === 'unit'
        ? range.filter((c) => unitsOfCall(w, c).has(q.contributor!))
        : range.filter((c) => redact(keyOf(w, by, c)) === q.contributor)
    const cur = sumOf(mine.filter((c) => c.at >= start && c.at < end))
    contributor = {
      by,
      key: q.contributor,
      label: labelOf(w, by, q.contributor),
      used_usd: usd(cur.u),
      unpriced_calls: cur.unpriced,
      daily: dailyRows(mine, from, dayStart(asOf)).map((d) => ({
        date: d.date,
        cost_usd: d.cost_usd,
        calls: d.calls,
      })),
    }
  }

  const owned =
    t.scope === 'owner'
      ? sumOf(
          accepted(w).filter(
            (c) => c.at < asOf && c.at >= start && c.at < end && ownerOf(w, c.agent_id) === t.id,
          ),
        )
      : null

  let turns: Burn['turns'] = null
  if (session) {
    const byTurn = new Map<string, WCall[]>()
    for (const c of current) {
      const k = c.turn_id ?? c.flow_id ?? c.call_id
      const list = byTurn.get(k)
      if (list) list.push(c)
      else byTurn.set(k, [c])
    }
    turns = [...byTurn]
      .map(([turn_id, cs]) => {
        const flows = new Set(cs.map((c) => c.flow_id))
        const s = sumOf(cs)
        return {
          turn_id,
          flow_id: flows.size === 1 ? ([...flows][0] ?? null) : null,
          at: iso(cs[0]!.at),
          cost_usd: usd(s.u),
          calls: s.calls,
          unpriced_calls: s.unpriced,
        }
      })
      .sort((x, y) => x.at.localeCompare(y.at) || x.turn_id.localeCompare(y.turn_id))
  }

  const dedupe = w.meta.exact_dedupe_from
  return {
    scope: t.scope,
    id: t.id,
    label: t.label,
    as_of: iso(asOf),
    covers,
    period: kind,
    period_start: iso(start),
    resets_at: session ? null : iso(end),
    from: dayOf(from),
    used_usd: usd(used.u),
    unpriced_calls: used.unpriced,
    calls: used.calls,
    sources: {
      routed_usd: usd(used.routed),
      traced_usd: usd(used.traced),
      harness_estimate_usd: usd(used.harness),
    },
    exact_dedupe_from: dedupe !== null && from < dedupe ? iso(dedupe) : null,
    outside: outsidePop
      ? { traced_usd: usd(outsidePop.traced), harness_estimate_usd: usd(outsidePop.harness) }
      : null,
    budget,
    periods,
    daily: session ? [] : dailyRows(range, from, dayStart(asOf)),
    previous,
    events,
    contributor,
    owned_agents: owned ? { used_usd: usd(owned.u), unpriced_calls: owned.unpriced } : null,
    membership:
      t.scope === 'unit' && w.meta.membership_history_from !== null
        ? {
            history_from: dayOf(w.meta.membership_history_from),
            basis_before: 'current_membership',
          }
        : null,
    turns,
    session: session
      ? {
          started_at: iso(session.started_at),
          ended_at: session.ended_at === null ? null : iso(session.ended_at),
        }
      : null,
  }
}

// ─── GET /api/budgets/burn/breakdown (§7.2) ─────────────────────────────────

/** The units a `by=unit` read lists (§7.2): the root units for `org`, a unit's direct sub-units. */
const listedUnits = (w: World, scope: Scope, id: string | null) =>
  w.units
    .filter((u) =>
      w.parents.some(
        (p) => p.to === null && p.unit_id === u.id && p.parent_id === (scope === 'org' ? null : id),
      ),
    )
    .map((u) => u.id)

export interface BreakdownQuery extends ScopeQuery {
  by: string | null
  period?: string | null
  from?: string | null
  to?: string | null
  top?: string | null
}

function topOf(q: string | null | undefined, def: number, max: number) {
  if (q === null || q === undefined || q === '') return def
  const n = Number(q)
  if (!Number.isInteger(n) || n < 1 || n > max)
    fail(400, 'invalid_top', `top must be between 1 and ${max}`)
  return n
}

export function breakdown(w: World, v: Viewer, q: BreakdownQuery, now: number): Breakdown {
  const t = readTarget(w, v, q)
  const period = okPeriod(q.period)
  const by = dimension(w, t.scope, q.by)
  const top = topOf(q.top, 5, 20)
  const asOf = asOfFor(w, now)
  const b = budgetOf(w, t.scope, t.id)
  const covers: Covers = b ? coversOf(t.scope) : 'all_priced'
  const session = t.scope === 'session' ? sessionOf(w, t.id) : undefined
  const kind =
    period ?? (b && !session ? (versionAt(b, asOf).period as 'month' | 'quarter') : 'month')
  const start = session ? session.started_at : periodOf(w, kind, asOf)[0]
  const from = q.from ? parseDay(q.from) : dayStart(start)
  const to = Math.min(q.to ? parseDay(q.to) : dayStart(asOf), dayStart(asOf))
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || (to - from) / DAY_MS > 400)
    fail(400, 'bad_range', 'from must be on or before to, within 400 days')
  const cs = counted(w, t.scope, t.id, covers, asOf).filter(
    (c) => c.at >= from && c.at < to + DAY_MS,
  )
  const redact = redactor(w, v, cs)

  type Acc = {
    key: string
    s: Sum
    byDay: Map<number, Sum>
    inTok: number
    outTok: number
    rIn: number
    rOut: number
  }
  const acc = new Map<string, Acc>()
  const bump = (key: string, c: WCall) => {
    let a = acc.get(key)
    if (!a)
      acc.set(key, (a = { key, s: zero(), byDay: new Map(), inTok: 0, outTok: 0, rIn: 0, rOut: 0 }))
    add(a.s, c)
    const d = dayStart(c.at)
    let ds = a.byDay.get(d)
    if (!ds) a.byDay.set(d, (ds = zero()))
    add(ds, c)
    a.inTok += c.input_tokens
    a.outTok += c.output_tokens
    if (c.routed) {
      a.rIn += c.input_tokens
      a.rOut += c.output_tokens
    }
  }
  const otherDay = new Map<number, Sum>()
  const overlapDay = new Map<number, number>()
  const outsideDay = new Map<number, number>()
  const dayTotal = new Map<number, Sum>()
  const listed = by === 'unit' ? listedUnits(w, t.scope, t.id) : []
  for (const c of cs) {
    const d = dayStart(c.at)
    let dt = dayTotal.get(d)
    if (!dt) dayTotal.set(d, (dt = zero()))
    add(dt, c)
    if (by === 'unit') {
      const units = unitsOfCall(w, c)
      const hits = listed.filter((u) => units.has(u))
      for (const u of hits) bump(u, c)
      if (hits.length > 1)
        overlapDay.set(d, (overlapDay.get(d) ?? 0) + (hits.length - 1) * (c.u ?? 0))
      if (!hits.length) outsideDay.set(d, (outsideDay.get(d) ?? 0) + (c.u ?? 0))
      continue
    }
    const key = redact(keyOf(w, by, c))
    if (key === null) {
      let o = otherDay.get(d)
      if (!o) otherDay.set(d, (o = zero()))
      add(o, c)
    } else bump(key, c)
  }
  const ranked = [...acc.values()].sort((x, y) => y.s.u - x.s.u || x.key.localeCompare(y.key))
  const keys = ranked.slice(0, top)
  const rest = ranked.slice(top)
  for (const r of rest)
    for (const [d, s] of r.byDay) {
      let o = otherDay.get(d)
      if (!o) otherDay.set(d, (o = zero()))
      o.u += s.u
      o.calls += s.calls
    }
  const days: Breakdown['days'] = []
  for (let d = from; d <= to; d += DAY_MS) {
    const o = otherDay.get(d) ?? zero()
    days.push({
      date: dayOf(d),
      items: keys.map((k) => {
        const s = k.byDay.get(d) ?? zero()
        return { key: k.key, cost_usd: usd(s.u), calls: s.calls }
      }),
      other_usd: usd(o.u),
      other_calls: o.calls,
      unpriced_calls: (dayTotal.get(d) ?? zero()).unpriced,
      overlap_usd: by === 'unit' ? usd(overlapDay.get(d) ?? 0) : null,
      outside_units_usd: by === 'unit' ? usd(outsideDay.get(d) ?? 0) : null,
    })
  }
  const restSum = rest.reduce((t2, r) => ({ u: t2.u + r.s.u, calls: t2.calls + r.s.calls }), {
    u: 0,
    calls: 0,
  })
  const otherFold = [...otherDay.values()].reduce((t2, s) => t2 + s.u, 0) - restSum.u
  let overlap: Breakdown['overlap'] = null
  if (by === 'unit') {
    const people = new Set<string>()
    for (const user of w.users)
      if (listed.filter((u) => membersOf(w, u).has(user.id)).length >= 2) people.add(user.id)
    overlap = {
      cost_usd: usd([...overlapDay.values()].reduce((a, x) => a + x, 0)),
      people: people.size,
      outside_units_usd: usd([...outsideDay.values()].reduce((a, x) => a + x, 0)),
    }
  }
  return {
    by,
    from: dayOf(from),
    to: dayOf(to),
    as_of: iso(asOf),
    covers,
    keys: keys.map((k) => ({
      key: k.key,
      label: k.key.startsWith('redacted:') ? 'Another user’s session' : labelOf(w, by, k.key),
      cost_usd: usd(k.s.u),
      calls: k.s.calls,
      unpriced_calls: k.s.unpriced,
      redacted: k.key.startsWith('redacted:'),
      ...(by === 'model'
        ? {
            input_tokens: k.inTok,
            output_tokens: k.outTok,
            routed_input_tokens: k.rIn,
            routed_output_tokens: k.rOut,
          }
        : {}),
    })),
    days,
    other: {
      cost_usd: usd(restSum.u + otherFold),
      calls: [...otherDay.values()].reduce((a, s) => a + s.calls, 0),
      contributors: rest.length,
    },
    overlap,
  }
}

// ─── GET /api/budgets/burn/changes (§7.3) ───────────────────────────────────

export interface ChangesQuery extends ScopeQuery {
  by: string | null
  from: string | null
  to: string | null
  compare_from: string | null
  compare_to: string | null
  top?: string | null
}

export function changes(w: World, v: Viewer, q: ChangesQuery, now: number): Changes {
  const t = readTarget(w, v, q)
  const by = dimension(w, t.scope, q.by)
  const top = topOf(q.top, 10, 50)
  const asOf = asOfFor(w, now)
  const parse = (s: string | null) => (s ? Date.parse(s) : NaN)
  const from = parse(q.from)
  const cFrom = parse(q.compare_from)
  let to = parse(q.to)
  let cTo = parse(q.compare_to)
  if (
    [from, to, cFrom, cTo].some((x) => !Number.isFinite(x)) ||
    to <= from ||
    cTo - cFrom !== to - from ||
    cTo > from
  )
    fail(400, 'bad_range', 'from must be on or before to, within 400 days')
  if (to > asOf) {
    const shift = to - asOf
    to -= shift
    cTo -= shift
    if (to <= from) fail(400, 'bad_range', 'from must be on or before to, within 400 days')
  }
  const b = budgetOf(w, t.scope, t.id)
  const covers: Covers = b ? coversOf(t.scope) : 'all_priced'
  const cs = counted(w, t.scope, t.id, covers, asOf)
  const redact = redactor(w, v, cs)
  const listed = by === 'unit' ? listedUnits(w, t.scope, t.id) : []
  const cur = cs.filter((c) => c.at >= from && c.at < to)
  const cmp = cs.filter((c) => c.at >= cFrom && c.at < cTo)
  const sums = new Map<string, [number, number]>()
  const put = (list: WCall[], i: 0 | 1) => {
    for (const c of list) {
      if (c.u === null) continue
      const keys =
        by === 'unit' ? listed.filter((u) => unitsOfCall(w, c).has(u)) : [redact(keyOf(w, by, c))]
      for (const k of keys) {
        if (k === null) continue
        const s = sums.get(k) ?? [0, 0]
        s[i] += c.u
        sums.set(k, s)
      }
    }
  }
  put(cur, 0)
  put(cmp, 1)
  const items = [...sums]
    .map(([key, [a, c]]) => ({
      key,
      label: key.startsWith('redacted:') ? 'Another user’s session' : labelOf(w, by, key),
      redacted: key.startsWith('redacted:'),
      cost_usd: usd(a),
      compare_cost_usd: usd(c),
      delta_usd: usd(a - c),
      delta_pct: c === 0 ? null : round2(((a - c) / c) * 100),
    }))
    .sort(
      (x, y) =>
        Math.abs(y.delta_usd) - Math.abs(x.delta_usd) ||
        y.delta_usd - x.delta_usd ||
        x.key.localeCompare(y.key),
    )
  return {
    by,
    as_of: iso(asOf),
    covers,
    from: iso(from),
    to: iso(to),
    compare_from: iso(cFrom),
    compare_to: iso(cTo),
    unpriced_calls: cur.filter((c) => c.u === null).length,
    compare_unpriced_calls: cmp.filter((c) => c.u === null).length,
    truncated: items.length > top,
    items: items.slice(0, top),
  }
}

// ─── GET /api/budgets/burn/hours (§7.4) ─────────────────────────────────────

function dateParam(q: string | null | undefined, asOf: number) {
  const d = q ? parseDay(q) : NaN
  if (!Number.isFinite(d) || d > dayStart(asOf) || (dayStart(asOf) - d) / DAY_MS > 400)
    fail(400, 'bad_date', 'date must be a past or current UTC day within 400 days')
  return d
}

export function hours(
  w: World,
  v: Viewer,
  q: ScopeQuery & { date: string | null },
  now: number,
): Hours {
  const t = readTarget(w, v, q)
  const asOf = asOfFor(w, now)
  const d = dateParam(q.date, asOf)
  const covers: Covers = budgetOf(w, t.scope, t.id) ? coversOf(t.scope) : 'all_priced'
  const cs = counted(w, t.scope, t.id, covers, asOf).filter((c) => c.at >= d && c.at < d + DAY_MS)
  const out: Hours['hours'] = []
  for (let h = 0; h < 24 && d + h * HOUR < asOf; h++) {
    const s = sumOf(cs.filter((c) => c.at >= d + h * HOUR && c.at < d + (h + 1) * HOUR))
    out.push({ hour: h, cost_usd: usd(s.u), calls: s.calls, unpriced_calls: s.unpriced })
  }
  return { date: dayOf(d), as_of: iso(asOf), covers, hours: out }
}

// ─── GET /api/budgets/burn/traces (§7.5) ────────────────────────────────────

/** FNV-1a, hex: an opaque, stable row id. */
const fnv = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

export function traces(
  w: World,
  v: Viewer,
  q: ScopeQuery & { date: string | null; limit?: string | null; cursor?: string | null },
  now: number,
) {
  const t = readTarget(w, v, q)
  const asOf = asOfFor(w, now)
  const d = dateParam(q.date, asOf)
  const covers: Covers = budgetOf(w, t.scope, t.id) ? coversOf(t.scope) : 'all_priced'
  const cs = counted(w, t.scope, t.id, covers, asOf).filter((c) => c.at >= d && c.at < d + DAY_MS)
  const groups = new Map<string, WCall[]>()
  for (const c of cs) {
    const k = c.flow_id ? `f:${c.flow_id}:${c.agent_id}` : `a:${c.agent_id}:${c.source}`
    const list = groups.get(k)
    if (list) list.push(c)
    else groups.set(k, [c])
  }
  const rows = [...groups].map(([k, g]) => {
    const s = sumOf(g)
    const first = g[0]!
    const shown = identityVisible(w, v, first)
    const row: TraceRow = {
      row_id: `r${fnv(`${dayOf(d)}:${k}`)}`,
      as_of: iso(asOf),
      covers,
      redacted: !shown,
      trace_id: shown ? first.flow_id : null,
      session_id: shown ? first.chat_session_id : null,
      agent_id: shown ? first.agent_id : null,
      agent_label: shown && first.agent_id ? labelOf(w, 'agent', first.agent_id) : null,
      user_id: shown ? first.billed_user_id : null,
      user_label: shown && first.billed_user_id ? labelOf(w, 'owner', first.billed_user_id) : null,
      cost_usd: usd(s.u),
      calls: s.calls,
      unpriced_calls: s.unpriced,
      started_at: iso(first.at),
    }
    return row
  })
  rows.sort(
    (x, y) =>
      y.cost_usd - x.cost_usd ||
      x.started_at.localeCompare(y.started_at) ||
      x.row_id.localeCompare(y.row_id),
  )
  return page(rows, Math.min(50, Number(q.limit) || 20), q.cursor)
}

// ─── inside a scope (§8.2) ──────────────────────────────────────────────────

function inside(w: World, scope: Scope, id: string | null, b: WBudget): boolean {
  const target = targetOf(b)
  if (scope === 'org') return b.scope !== 'org'
  if (scope === 'unit') {
    const units = subtree(w, id!)
    const members = membersOf(w, id!)
    if (b.scope === 'unit') return b.unit_id !== id && units.has(b.unit_id!)
    if (b.scope === 'owner') return members.has(b.owner_id!)
    if (b.scope === 'agent') return members.has(ownerOf(w, b.agent_id) ?? '')
    if (b.scope === 'session')
      return members.has(ownerOf(w, sessionOf(w, target)?.agent_id ?? null) ?? '')
    return false
  }
  if (scope === 'owner') {
    if (b.scope === 'agent') return ownerOf(w, b.agent_id) === id
    if (b.scope === 'session') return sessionOf(w, target)?.user_id === id
  }
  return false
}
const readableBudget = (w: World, v: Viewer, b: WBudget) => canRead(w, v, b.scope, targetOf(b))

// ─── GET /api/budgets/status (§8.1) ─────────────────────────────────────────

function statusRow(w: World, b: WBudget, now: number): StatusRow {
  const asOf = asOfFor(w, now)
  const f = figures(w, b, asOf)
  const view = budgetView(w, b, asOf)
  return {
    budget_id: b.id,
    scope: b.scope,
    label: view.label,
    covers: coversOf(b.scope),
    action: f.version.action,
    version: f.version.version,
    limit_usd: f.version.limit_usd,
    period_start: iso(f.start),
    resets_at: Number.isFinite(f.end) ? iso(f.end) : null,
    as_of: iso(asOf),
    used_usd: usd(f.used.u),
    unpriced_calls: f.used.unpriced,
    state: f.state,
    crossed: f.crossed,
    stopped: f.stopped,
    limits_inside_usd: view.limits_inside_usd,
    limits_inside_count: view.limits_inside_count,
    daily:
      f.version.period === 'session'
        ? []
        : dailyRows(f.calls, f.start, dayStart(asOf)).map((d) => ({
            date: d.date,
            cost_usd: d.cost_usd,
          })),
  }
}

const SCOPE_ORDER: Scope[] = ['org', 'unit', 'owner', 'agent', 'session']
const byScopeLabel = (w: World) => (x: WBudget, y: WBudget) =>
  SCOPE_ORDER.indexOf(x.scope) - SCOPE_ORDER.indexOf(y.scope) ||
  budgetLabel(w, x).localeCompare(budgetLabel(w, y)) ||
  x.id.localeCompare(y.id)

export function statusList(
  w: World,
  v: Viewer,
  q: ScopeQuery & { limit?: string | null; cursor?: string | null },
  now: number,
) {
  let list: WBudget[]
  if (!q.scope)
    list = alive(w)
      .filter((b) => b.owner_id === v.id)
      .sort(byScopeLabel(w))
  else {
    const t = readTarget(w, v, q)
    const own = budgetOf(w, t.scope, t.id)
    list = [
      ...(own ? [own] : []),
      ...alive(w)
        .filter((b) => b !== own && inside(w, t.scope, t.id, b) && readableBudget(w, v, b))
        .sort(byScopeLabel(w)),
    ]
  }
  const rows = list.map((b) => statusRow(w, b, now))
  const p = page(rows, Number(q.limit) || 50, q.cursor)
  return {
    ...p,
    ...(rows.every((r) => r.covers === 'routed_calls') ? { covers: 'routed_calls' as const } : {}),
  }
}

// ─── GET /api/budgets/at-risk (§8.2) ────────────────────────────────────────

const listScope = (q: ScopeQuery) => {
  if (q.scope !== 'org' && q.scope !== 'unit' && q.scope !== 'owner')
    fail(400, 'invalid_scope', 'scope must be org, unit or owner')
}

export function atRisk(
  w: World,
  v: Viewer,
  q: ScopeQuery & { limit?: string | null; cursor?: string | null },
  now: number,
) {
  listScope(q)
  const t = readTarget(w, v, q)
  const asOf = asOfFor(w, now)
  const rows: AtRiskRow[] = []
  for (const b of alive(w)) {
    if (!inside(w, t.scope, t.id, b) || !readableBudget(w, v, b)) continue
    const session = b.scope === 'session' ? sessionOf(w, b.session_id) : undefined
    if (session && session.ended_at !== null) continue
    const f = figures(w, b, asOf)
    const limit = f.version.limit_usd
    const daily = dailyRows(f.calls, f.start, dayStart(asOf))
    const raw = session
      ? null
      : project({ daily, used: usd(f.used.u), limit, resetsAt: f.end, asOf })
    // Pace 0 is no projection (§9): no run-out, no ranking basis.
    const pr = raw && raw.pace > 0 ? raw : null
    const reason =
      f.state === 'exceeded'
        ? 'exceeded'
        : pr?.runOut
          ? 'runs_out'
          : f.crossed !== null
            ? 'warning'
            : null
    if (!reason) continue
    const all14 = counted(w, b.scope, targetOf(b), coversOf(b.scope), asOf).filter(
      (c) => c.at >= dayStart(asOf) - 13 * DAY_MS,
    )
    const owner = b.owner_id
    rows.push({
      budget_id: b.id,
      scope: b.scope,
      target_id: targetOf(b),
      label: budgetLabel(w, b),
      owner_id: owner,
      owner_label: owner ? (w.users.find((u) => u.id === owner)?.name ?? null) : null,
      covers: coversOf(b.scope),
      action: f.version.action,
      period: f.version.period,
      period_start: iso(f.start),
      resets_at: Number.isFinite(f.end) ? iso(f.end) : null,
      as_of: iso(asOf),
      limit_usd: limit,
      used_usd: usd(f.used.u),
      unpriced_calls: f.used.unpriced,
      state: f.state,
      crossed: f.crossed,
      stopped: f.stopped,
      daily14: dailyRows(all14, dayStart(asOf) - 13 * DAY_MS, dayStart(asOf)).map((d) => ({
        date: d.date,
        cost_usd: d.cost_usd,
      })),
      rank: {
        reason,
        runs_out_on: pr?.runOut ? dayOf(pr.runOut) : null,
        pace_usd_per_day: pr ? Number(pr.pace.toFixed(8)) : null,
        projected_pct: pr?.projectedPct != null ? round2(pr.projectedPct) : null,
      },
    })
  }
  const rank = { exceeded: 0, runs_out: 1, warning: 2 }
  rows.sort(
    (x, y) =>
      rank[x.rank.reason] - rank[y.rank.reason] ||
      (x.rank.reason === 'exceeded' ? y.used_usd / y.limit_usd - x.used_usd / x.limit_usd : 0) ||
      (x.rank.reason === 'runs_out' ? x.rank.runs_out_on!.localeCompare(y.rank.runs_out_on!) : 0) ||
      (x.rank.reason === 'warning'
        ? (y.rank.projected_pct ?? -1) - (x.rank.projected_pct ?? -1)
        : 0) ||
      x.label.localeCompare(y.label) ||
      x.budget_id.localeCompare(y.budget_id),
  )
  return page(rows, Number(q.limit) || 20, q.cursor)
}

// ─── GET /api/budgets/unbudgeted (§8.3) ─────────────────────────────────────

export function unbudgeted(
  w: World,
  v: Viewer,
  q: ScopeQuery & { period?: string | null; limit?: string | null; cursor?: string | null },
  now: number,
) {
  listScope(q)
  const t = readTarget(w, v, q)
  const kind = okPeriod(q.period) ?? 'month'
  const asOf = asOfFor(w, now)
  const [start] = periodOf(w, kind, asOf)
  const members = t.scope === 'unit' ? membersOf(w, t.id!) : null
  const rows: UnbudgetedRow[] = []
  for (const a of w.agents) {
    if (a.deleted || budgetOf(w, 'agent', a.id)) continue
    if (t.scope === 'owner' && a.owner_id !== t.id) continue
    if (members && !members.has(a.owner_id)) continue
    if (!canRead(w, v, 'agent', a.id)) continue
    const cs = accepted(w).filter((c) => c.agent_id === a.id && c.at >= start && c.at < asOf)
    if (!cs.length) continue
    const s = sumOf(cs)
    rows.push({
      agent_id: a.id,
      label: a.name,
      owner_id: a.owner_id,
      owner_label: w.users.find((u) => u.id === a.owner_id)?.name ?? a.owner_id,
      as_of: iso(asOf),
      harness: a.harness,
      used_usd: usd(s.u),
      routed_usd: usd(s.routed),
      traced_usd: usd(s.traced),
      harness_estimate_usd: usd(s.harness),
      routed_calls: cs.filter((c) => c.source === 'routed').length,
      unpriced_calls: s.unpriced,
    })
  }
  rows.sort((x, y) => y.used_usd - x.used_usd || x.agent_id.localeCompare(y.agent_id))
  return page(rows, Number(q.limit) || 50, q.cursor)
}

// ─── GET /api/budgets/alerts (§8.4) ─────────────────────────────────────────

export function alertRows(
  w: World,
  v: Viewer,
  q: ScopeQuery & {
    kind?: string | null
    from?: string | null
    limit?: string | null
    cursor?: string | null
  },
  now: number,
) {
  const asOf = asOfFor(w, now)
  let list: WBudget[]
  if (!q.scope) list = alive(w).filter((b) => b.owner_id === v.id)
  else {
    const t = readTarget(w, v, q)
    list = alive(w).filter(
      (b) =>
        (b === budgetOf(w, t.scope, t.id) || inside(w, t.scope, t.id, b)) &&
        readableBudget(w, v, b),
    )
  }
  const all = q.kind === 'all'
  const rows: AlertV1[] = []
  for (const b of list) {
    if (q.from) {
      const f = parseDay(q.from)
      if (!Number.isFinite(f) || f > dayStart(asOf) || (dayStart(asOf) - f) / DAY_MS > 400)
        fail(400, 'bad_range', 'from must be on or before to, within 400 days')
    }
    const since = q.from ? parseDay(q.from) : budgetPeriod(w, b, budgetPeriod(w, b, asOf)[0] - 1)[0]
    for (const r of records(w, b, asOf)) {
      if (
        r.kind !== 'threshold' &&
        !(all && (r.kind === 'forecast' || r.kind === 'forecast_cleared'))
      )
        continue
      if (Date.parse(r.at) < since) continue
      rows.push({
        id: r.id,
        budget_id: b.id,
        label: budgetLabel(w, b),
        scope: b.scope,
        kind: r.kind,
        percent: r.percent!,
        threshold: r.kind === 'threshold' ? r.percent : null,
        version: r.version,
        amount_usd: r.amount_usd ?? 0,
        at: r.at,
        crosses_on: r.crosses_on,
        stopped: !!r.stoppedAlert,
      })
    }
  }
  rows.sort((x, y) => y.at.localeCompare(x.at) || y.percent - x.percent || y.id.localeCompare(x.id))
  return rows
}

export function alertsList(
  w: World,
  v: Viewer,
  q: ScopeQuery & {
    kind?: string | null
    from?: string | null
    limit?: string | null
    cursor?: string | null
  },
  now: number,
) {
  return page(alertRows(w, v, q, now), Number(q.limit) || 50, q.cursor)
}

// ─── budget CRUD (§6) ───────────────────────────────────────────────────────

export interface CreateBody {
  scope?: unknown
  agent_id?: unknown
  unit_id?: unknown
  session_id?: unknown
  user_id?: unknown
  period?: unknown
  limit_usd?: unknown
  thresholds?: unknown
  forecast_thresholds?: unknown
  action?: unknown
}

const marks = (thresholds: readonly number[], action: string) =>
  [...new Set([...thresholds, ...(action === 'stop' ? [100] : [])])].sort((a, b) => a - b)

function validateFields(body: CreateBody, scope: Scope, defaults: boolean) {
  const limit = body.limit_usd
  if (typeof limit !== 'number' || !Number.isFinite(limit) || centsHalfEven(limit) <= 0)
    fail(400, 'invalid_limit', 'limit_usd must be greater than 0')
  const thresholds = body.thresholds ?? (defaults ? [50, 80, 100] : undefined)
  if (
    !Array.isArray(thresholds) ||
    !thresholds.length ||
    thresholds.some((t) => !Number.isInteger(t) || t < 1 || t > 100) ||
    new Set(thresholds).size !== thresholds.length
  )
    fail(400, 'invalid_thresholds', 'thresholds must be whole percents from 1 to 100')
  const forecast =
    body.forecast_thresholds ?? (defaults ? (scope === 'session' ? [] : [100]) : undefined)
  if (
    forecast !== undefined &&
    (!Array.isArray(forecast) ||
      forecast.some((t) => !Number.isInteger(t) || t < 1 || t > 200) ||
      new Set(forecast).size !== forecast.length ||
      (scope === 'session' && forecast.length > 0))
  )
    fail(
      400,
      'invalid_forecast_thresholds',
      'forecast_thresholds must be whole percents from 1 to 200',
    )
  const action = body.action ?? (defaults ? 'alert' : undefined)
  if (action !== 'alert' && action !== 'stop')
    fail(400, 'invalid_action', 'action must be alert or stop')
  if (action === 'stop' && (scope === 'org' || scope === 'unit'))
    fail(400, 'stop_not_available', 'stop is not available for this scope')
  return {
    limit_usd: centsHalfEven(limit as number),
    thresholds: marks(thresholds as number[], action as string),
    forecast_thresholds:
      forecast === undefined ? undefined : [...(forecast as number[])].sort((a, b) => a - b),
    action: action as 'alert' | 'stop',
  }
}

export function createBudget(w: World, v: Viewer, body: CreateBody, now: number): WBudget {
  const scope = body.scope as Scope
  if (
    !(SCOPE_LIST as readonly string[]).includes(String(body.scope)) ||
    (scope === 'unit' && w.edition !== 'ee')
  )
    fail(400, 'invalid_scope', 'scope must be org, unit, owner, agent or session')
  const field =
    scope === 'agent'
      ? 'agent_id'
      : scope === 'unit'
        ? 'unit_id'
        : scope === 'session'
          ? 'session_id'
          : null
  const target =
    scope === 'org'
      ? null
      : scope === 'owner'
        ? ((body.user_id as string | null | undefined) ?? v.id)
        : (body[field! as keyof CreateBody] as string | null | undefined)
  if (scope !== 'org' && !target) fail(400, 'missing_target', `${field ?? 'user_id'} is required`)
  requireWrite(w, v, scope, target ?? null)
  const period = (body.period ?? (scope === 'session' ? 'session' : 'month')) as string
  if (scope === 'session' ? period !== 'session' : period !== 'month' && period !== 'quarter')
    fail(
      400,
      'invalid_period',
      scope === 'session'
        ? 'a session budget’s period is session'
        : 'period must be month or quarter',
    )
  const f = validateFields(body, scope, true)
  const session = scope === 'session' ? sessionOf(w, target!) : undefined
  if (session && session.ended_at !== null && session.ended_at <= now)
    fail(400, 'session_ended', 'this session has ended')
  if (budgetOf(w, scope, target ?? null))
    fail(409, 'budget_exists', 'budget already exists for this scope')
  const owner =
    scope === 'owner'
      ? target!
      : scope === 'agent'
        ? ownerOf(w, target!)!
        : scope === 'session'
          ? session!.user_id
          : null
  const b: WBudget = {
    id: `${w.idPrefix}${String(w.seq++).padStart(12, '0')}`,
    scope,
    agent_id: scope === 'agent' ? target! : null,
    unit_id: scope === 'unit' ? target! : null,
    session_id: scope === 'session' ? target! : null,
    owner_id: owner,
    created_at: now,
    updated_at: now,
    versions: [
      {
        version: 1,
        effective_from: now,
        set_by: v.id,
        period: period as WVersion['period'],
        limit_usd: f.limit_usd,
        thresholds: f.thresholds,
        forecast_thresholds: f.forecast_thresholds!,
        action: f.action,
      },
    ],
    next_period: null,
    deleted_at: null,
    log: [],
  }
  w.budgets.push(b)
  w.rev++
  return b
}

const findBudget = (w: World, v: Viewer, id: string) => {
  const b = alive(w).find((x) => x.id === id)
  if (!b || !readableBudget(w, v, b)) budgetNotFound()
  return b!
}

/** `GET /api/budgets/{id}`: unknown and unreadable are the same 404. */
export const getBudget = (w: World, v: Viewer, id: string) => findBudget(w, v, id)

export function updateBudget(
  w: World,
  v: Viewer,
  id: string,
  body: CreateBody & { expected_updated_at?: unknown },
  now: number,
): WBudget {
  const b = findBudget(w, v, id)
  requireWrite(w, v, b.scope, targetOf(b))
  const f = validateFields(body, b.scope, false)
  const cur = versionAt(b, now)
  if (body.period !== undefined) {
    if (b.scope === 'session')
      fail(400, 'period_change_not_available', 'a session budget’s period can’t change')
    if (body.period !== 'month' && body.period !== 'quarter')
      fail(400, 'invalid_period', 'period must be month or quarter')
  }
  if (body.expected_updated_at !== iso(b.updated_at))
    fail(409, 'budget_changed', 'budget changed elsewhere')
  const next: WVersion = {
    ...cur,
    limit_usd: f.limit_usd,
    thresholds: f.thresholds,
    action: f.action,
    forecast_thresholds: f.forecast_thresholds ?? cur.forecast_thresholds,
  }
  const versionChanged =
    next.limit_usd !== cur.limit_usd ||
    next.action !== cur.action ||
    next.thresholds.join() !== cur.thresholds.join() ||
    next.forecast_thresholds.join() !== cur.forecast_thresholds.join()
  let changed = versionChanged
  if (versionChanged)
    b.versions.push({ ...next, version: cur.version + 1, effective_from: now, set_by: v.id })
  if (body.period !== undefined) {
    const p = body.period as 'month' | 'quarter'
    if (p === cur.period) {
      if (b.next_period) changed = true
      b.next_period = null
    } else {
      // The first boundary that ends the current period and starts a period of the new kind.
      let at = periodOf(w, cur.period as 'month' | 'quarter', now)[1]
      for (let i = 0; i < 24 && periodOf(w, p, at)[0] !== at; i++)
        at = periodOf(w, cur.period as 'month' | 'quarter', at)[1]
      b.next_period = { period: p, effective_from: at, set_by: v.id, set_at: now }
      // A record (§4.3a): later PUTs and the activation never remove it.
      b.log.push({
        kind: 'period_change_scheduled',
        at: now,
        version: versionAt(b, now).version,
        period: p,
        effective_from: at,
        by: v.id,
      })
      changed = true
    }
  }
  if (changed) {
    b.updated_at = now
    w.rev++
  }
  return b
}

export function deleteBudget(w: World, v: Viewer, id: string, now: number) {
  const b = findBudget(w, v, id)
  requireWrite(w, v, b.scope, targetOf(b))
  b.deleted_at = now
  w.rev++
}

/** A pending period change takes effect at its boundary: the next version carries the limit then in effect. */
export function activatePending(w: World, now: number) {
  for (const b of w.budgets) {
    const np = b.next_period
    if (!np || np.effective_from > now) continue
    const cur = versionAt(b, np.effective_from)
    b.versions.push({
      ...cur,
      version: b.versions.at(-1)!.version + 1,
      effective_from: np.effective_from,
      set_by: np.set_by,
      period: np.period,
    })
    b.next_period = null
    w.rev++
  }
}

export function budgetsList(
  w: World,
  v: Viewer,
  q: ScopeQuery & { limit?: string | null; cursor?: string | null },
  now: number,
) {
  let list: WBudget[]
  // Deleted budgets keep their refusals as history (#66), never a row.
  if (!q.scope) list = alive(w).filter((b) => b.owner_id === v.id)
  else {
    const t = readTarget(w, v, q)
    const b = budgetOf(w, t.scope, t.id)
    list = b ? [b] : []
  }
  return page(
    list.sort(byScopeLabel(w)).map((b) => budgetView(w, b, now)),
    Number(q.limit) || 50,
    q.cursor,
  )
}

export function versionsList(
  w: World,
  v: Viewer,
  id: string,
  now: number,
  q: { limit?: string | null; cursor?: string | null } = {},
) {
  const b = findBudget(w, v, id)
  const rows = b.versions
    .filter((x) => x.effective_from <= now)
    .map((x) => ({ ...x, effective_from: iso(x.effective_from) }))
    .reverse()
  return page(rows, Number(q.limit) || 50, q.cursor)
}

// ─── settings, capabilities, prices (§6.8, §10) ─────────────────────────────

export function settingsView(w: World) {
  return {
    ...(w.edition === 'ee' ? { team_identity: w.settings.team_identity } : {}),
    fiscal_year_first_month: w.settings.fiscal.at(-1)!.month,
    updated_at: iso(w.settings.updated_at),
  }
}

export function updateSettings(
  w: World,
  v: Viewer,
  body: {
    team_identity?: unknown
    fiscal_year_first_month?: unknown
    expected_updated_at?: unknown
  },
  now: number,
) {
  if (!v.superuser) fail(403, 'not_allowed', 'only an admin can do this')
  if (body.team_identity !== undefined) {
    if (w.edition !== 'ee') fail(400, 'not_available', 'not available on this server')
    if (typeof body.team_identity !== 'boolean')
      fail(400, 'not_available', 'team_identity must be true or false')
  }
  const m = body.fiscal_year_first_month
  if (m !== undefined && (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 12))
    fail(400, 'not_available', 'fiscal_year_first_month must be 1 to 12')
  if (body.expected_updated_at !== iso(w.settings.updated_at))
    fail(409, 'settings_changed', 'settings changed elsewhere')
  if (body.team_identity !== undefined) w.settings.team_identity = body.team_identity as boolean
  if (m !== undefined && m !== w.settings.fiscal.at(-1)!.month) {
    // From the next quarter start under the setting in force now (§6.8), replacing a change still pending.
    const from = periodOf(w, 'quarter', now)[1]
    w.settings.fiscal = [
      ...w.settings.fiscal.filter((f) => f.from <= now),
      { from, month: m as number },
    ]
    for (const b of w.budgets)
      if (versionAt(b, now).period === 'quarter')
        b.log.push({
          kind: 'fiscal_year_changed',
          at: now,
          version: versionAt(b, now).version,
          period: null,
          effective_from: from,
          by: v.id,
        })
  }
  w.settings.updated_at = now
  w.rev++
  return settingsView(w)
}

/** Every feature this mock serves completely (§10.1); EE-only ones only in EE. */
export function capabilities(w: World) {
  const features = [
    'budgets',
    'burn',
    'breakdown',
    'changes',
    'hours',
    'traces',
    'contributor',
    'org_budgets',
    'quarter_periods',
    'versions',
    'forecast_alerts',
    'at_risk',
    'unbudgeted',
    'scope_status',
    'session_budgets',
    'prices',
    'fiscal_year',
    ...(w.edition === 'ee' ? ['unit_budgets', 'team_identity'] : []),
  ]
  return { version: '1.0', features }
}

export const pricesList = (w: World, q: { limit?: string | null; cursor?: string | null } = {}) =>
  page(
    [...w.prices].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
    Number(q.limit) || 50,
    q.cursor,
  )

// ─── worlds ─────────────────────────────────────────────────────────────────

/** The golden world (§14): watermarks at the anchor, so `as_of` is the anchor. */
export function worldFromScenario(
  sc: BudgetScenario,
  opts: { edition?: 'oss' | 'ee'; adminId: string },
): World {
  return {
    adminId: opts.adminId,
    edition: opts.edition ?? 'ee',
    calls: sc.calls.map(({ cost_usd, ...c }) => ({
      ...c,
      u: cost_usd === null ? null : toUnits(cost_usd),
    })),
    budgets: sc.budgets.map((b) => ({
      ...b,
      updated_at: b.versions.at(-1)!.effective_from,
      next_period: null,
      deleted_at: null,
      log: [],
    })),
    users: [
      { id: opts.adminId, name: 'admin', role: 'superuser' },
      ...sc.users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    ],
    agents: sc.agents.map((a) => ({ ...a })),
    units: sc.units,
    members: sc.members,
    parents: sc.parents,
    sessions: sc.sessions,
    meta: { ...sc.meta },
    // Complete up to now: the world's clock is the caller's (tests and the golden variant run at the anchor), so a
    // write made at `now` shows in every read at once.
    watermarks: { routed: Infinity, traced: Infinity, harness_estimate: Infinity },
    settings: {
      team_identity: false,
      fiscal: [{ from: -Infinity, month: 1 }],
      updated_at: sc.budgets[0]!.created_at,
    },
    prices: GOLDEN_PRICES,
    idPrefix: '5eed0017-0000-4000-8000-',
    seq: 500,
    rev: 0,
  }
}

const GOLDEN_PRICES: Price[] = [
  ['anthropic', 'claude-sonnet-4-5', 3, 15, 0.3],
  ['openai', 'gpt-4.1', 2, 8, 0.5],
  ['openai', 'gpt-4o', 2.5, 10, 1.25],
  ['openai', 'gpt-4o-mini', 0.15, 0.6, 0.075],
].map(([provider, model, i, o, c]) => ({
  provider: provider as string,
  model: model as string,
  input_per_mtok_usd: i as number,
  output_per_mtok_usd: o as number,
  cache_read_per_mtok_usd: c as number,
  cache_creation_per_mtok_usd: null,
  effective_from: '2026-01-01T00:00:00.000Z',
}))
