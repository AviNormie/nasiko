/**
 * The budgets mock's default world (plan feat-budget-burn B0): the app's seed traces as routed calls billed to each
 * agent's owner, the seed agents and their owners, and R-L10's three seeded budgets, all answered by the one engine
 * (`budgetEngine.ts`, the 1.0 contract, docs/requirements/budgets.md). R-L10's functions keep their signatures and
 * meaning (`budgets.test.ts`), now over the engine:
 *
 * - A budget belongs to one user (`owner_id`: the agent's owner for an agent budget, whoever set it); one owner budget
 *   per user and one budget per agent, across all users.
 * - A `stop` budget refuses calls once spent: calls after the crossing never happened (the engine's refusal pass).
 * - Alerts are records: written when spend crosses a mark (at the crossing call's time) and never rewritten by an edit.
 *
 * Seeded limits are set from this month's spend, so the three states show on any date: the owner budget sits past
 * 80% (warning), the busiest agent is over its limit with Stop calls (exceeded, stopped), the next one is well under.
 * The golden world (`seed-budgets.ts`) is the other input, for the contract's fixtures (`budgets-golden`).
 */
import { DEFAULT_THRESHOLDS } from '@/features/budgets/tuning'
import type {
  Budget,
  BudgetAlert,
  BudgetStatusResponse,
  CreateBudgetBody,
  UpdateBudgetBody,
} from '@/features/budgets/types'
import type { MockAgent } from './agents'
import {
  accepted,
  alertRows,
  budgetView,
  createBudget as engineCreate,
  deleteBudget as engineDelete,
  statusList,
  toUnits,
  updateBudget as engineUpdate,
  versionAt,
  type Viewer,
  type WBudget,
  type WCall,
  type World,
} from './budgetEngine'
import { SEED_MODELS, type Seed } from './seed'
import { ADMIN_ID } from './seed-harness'
import { observabilityData } from './spanBuilder'

export type BudgetMockStore = World

const pad = (n: number) => String(n).padStart(12, '0')
const budgetId = (n: number) => `5eed000b-0000-4000-8000-${pad(n)}`
const cents = (v: number) => Math.round(v * 100) / 100
const monthStart = (t: number) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
/** A `stop` budget always alerts at 100 (R-L10). */
const marks = (thresholds: readonly number[], action: Budget['action']) =>
  [...new Set([...thresholds, ...(action === 'stop' ? [100] : [])])].sort((a, b) => a - b)

/** The seed's traces as the router's calls: billed to the agent's owner (the seed has no flow attribution). */
function seedCalls(seed: Seed, agents: readonly MockAgent[]): WCall[] {
  const owner = new Map(agents.map((a) => [a.id, a.owner_id]))
  const sessions = observabilityData(seed)
  return seed.traces
    .map((t): WCall => ({
      call_id: t.trace_id,
      at: t.ts,
      source: 'routed',
      agent_id: t.agent_id,
      billed_user_id: owner.get(t.agent_id) ?? null,
      flow_id: t.trace_id,
      // The Sessions mock's chat session for the trace (`spanBuilder.ts`: one per agent per UTC day, the spike day's PR
      // reviews their own), so a session's ledger and its session budget are the same session.
      chat_session_id: sessions.traceById.get(t.trace_id)?.session.session_id ?? null,
      turn_id: t.trace_id,
      model: `${t.provider}/${t.model}`,
      operation: t.workflow_id ? 'workflow' : 'chat',
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      // The seed's unpriced model costs $0: unpriced, as R-L10 counted it.
      u: t.cost_usd === 0 ? null : toUnits(t.cost_usd),
      routed: true,
    }))
    .sort((a, b) => a.at - b.at || a.call_id.localeCompare(b.call_id))
}

/** Idle this long after its last call, a session has ended (BG-10's idle timeout, as the golden S1). */
const SESSION_IDLE_MS = 60 * 60_000

/**
 * The chat sessions behind the seed's calls (BG-10: session budgets need them): one per `chat_session_id`, its user the
 * billed user, its agent the first call's, from its first call to an hour after its last (open while that is ahead).
 */
function sessionsOf(calls: readonly WCall[], now: number): World['sessions'] {
  const byId = new Map<string, WCall[]>()
  for (const c of calls)
    if (c.chat_session_id) byId.set(c.chat_session_id, [...(byId.get(c.chat_session_id) ?? []), c])
  return [...byId].flatMap(([id, cs]) => {
    const first = cs[0]!
    const last = cs.at(-1)!
    if (!first.billed_user_id || !first.agent_id) return []
    const end = last.at + SESSION_IDLE_MS
    return [
      {
        id,
        title: '',
        user_id: first.billed_user_id,
        agent_id: first.agent_id,
        // A minute before its first call: the session exists before its first turn (turn 0 is its start).
        started_at: first.at - 60_000,
        ended_at: end <= now ? end : null,
      },
    ]
  })
}

export function buildBudgetState(
  seed: Seed,
  agents: readonly MockAgent[],
  user: string,
  now: number,
  opts: { empty?: boolean } = {},
): BudgetMockStore {
  const owners = [...new Set([user, ...agents.map((a) => a.owner_id)])]
  const calls = seedCalls(seed, agents)
  const w: World = {
    adminId: ADMIN_ID,
    edition: 'oss',
    calls,
    budgets: [],
    users: owners.map((id) => ({
      id,
      name: id === ADMIN_ID ? 'admin' : `User ${id.slice(-4)}`,
      role: id === ADMIN_ID ? 'superuser' : 'member',
    })),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.display_name || a.name,
      owner_id: a.owner_id,
      harness: a.tags.includes('coding-agent'),
      deleted: a.deleted,
    })),
    units: [],
    members: [],
    parents: [],
    sessions: sessionsOf(calls, now),
    meta: { exact_dedupe_from: null, membership_history_from: null },
    watermarks: { routed: Infinity, traced: Infinity, harness_estimate: Infinity },
    settings: {
      team_identity: false,
      unit_leads_write: false,
      fiscal: [{ from: -Infinity, month: 1 }],
      updated_at: monthStart(now),
    },
    prices: SEED_MODELS.filter((m) => m.inPerM > 0).map((m) => ({
      provider: m.provider,
      model: m.model,
      input_per_mtok_usd: m.inPerM,
      output_per_mtok_usd: m.outPerM,
      cache_read_per_mtok_usd: null,
      cache_creation_per_mtok_usd: null,
      effective_from: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    })),
    idPrefix: '5eed000b-0000-4000-8000-',
    seq: 4,
    rev: 0,
  }
  if (opts.empty) return w
  // Created at the start of last month, so both periods' alerts are this budget's own history.
  const created = monthStart(monthStart(now) - 1)
  const from = monthStart(now)
  const mk = (
    n: number,
    scope: 'owner' | 'agent',
    agent_id: string | null,
    limit: number,
    action: Budget['action'],
  ): WBudget => ({
    id: budgetId(n),
    scope,
    agent_id,
    unit_id: null,
    session_id: null,
    owner_id: user,
    created_at: created,
    updated_at: created,
    versions: [
      {
        version: 1,
        effective_from: created,
        set_by: user,
        period: 'month',
        limit_usd: limit,
        thresholds: marks(DEFAULT_THRESHOLDS, action),
        forecast_thresholds: [100],
        action,
      },
    ],
    next_period: null,
    deleted_at: null,
    log: [],
  })
  const used = (pick: (c: WCall) => boolean) =>
    accepted(w)
      .filter((c) => c.at >= from && c.at <= now && pick(c))
      .reduce((t, c) => t + (c.u ?? 0), 0) / 1e8
  // Agent limits from this month's spend first (in cents, no integer floors, so the states hold early on the 1st).
  const mine = agents
    .filter((a) => !a.deleted && a.owner_id === user && !a.tags.includes('coding-agent'))
    .map((a) => ({ a, u: used((c) => c.agent_id === a.id) }))
    .sort((x, y) => y.u - x.u || x.a.name.localeCompare(y.a.name))
  if (mine[0] && mine[0].u > 0)
    w.budgets.push(mk(2, 'agent', mine[0].a.id, Math.max(0.01, cents(mine[0].u * 0.9)), 'stop'))
  if (mine[1])
    w.budgets.push(mk(3, 'agent', mine[1].a.id, Math.max(1, cents(mine[1].u * 3)), 'alert'))
  w.rev++
  // The owner budget after the stop budget has refused its calls, so it reads 85% of what really happened.
  const owner = mk(1, 'owner', null, 0, 'alert')
  owner.owner_id = user
  owner.versions[0]!.limit_usd = Math.max(
    0.01,
    cents(used((c) => c.billed_user_id === user) / 0.85),
  )
  w.budgets.unshift(owner)
  w.rev++
  return w
}

/**
 * Keeps the world's agents and owners in step with the agents mock (a deploy or a delete in the session), so a budget
 * can be set on an agent made after the world was built. Spend comes only from the seed's traces.
 */
export function syncAgents(w: BudgetMockStore, agents: readonly MockAgent[]) {
  let changed = false
  for (const a of agents) {
    const have = w.agents.find((x) => x.id === a.id)
    if (!have) {
      w.agents.push({
        id: a.id,
        name: a.display_name || a.name,
        owner_id: a.owner_id,
        harness: a.tags.includes('coding-agent'),
        deleted: a.deleted,
      })
      changed = true
    } else if (!!have.deleted !== a.deleted || have.owner_id !== a.owner_id) {
      have.deleted = a.deleted
      have.owner_id = a.owner_id
      changed = true
    }
    if (!w.users.some((u) => u.id === a.owner_id)) {
      w.users.push({ id: a.owner_id, name: `User ${a.owner_id.slice(-4)}`, role: 'member' })
      changed = true
    }
  }
  if (changed) w.rev++
}

const viewer = (user: string, superuser = false): Viewer => ({ id: user, superuser })

/** The R-L10 view of a budget (its 1.0 fields are a superset). */
const legacy = (w: World, b: WBudget, now: number) => budgetView(w, b, now) as unknown as Budget

/** The caller's budgets in the order they were made (R-L10 has no order; GET sorts them, §6.2). */
export const listBudgets = (w: BudgetMockStore, user: string, now = Date.now()): Budget[] =>
  w.budgets
    .filter((b) => b.owner_id === user && b.deleted_at === null)
    .map((b) => legacy(w, b, now))

export function createBudget(
  w: BudgetMockStore,
  user: string,
  body: CreateBudgetBody,
  _agentOwner: (id: string) => string | undefined,
  superuser: boolean,
  now: number,
): Budget {
  return legacy(w, engineCreate(w, viewer(user, superuser), body, now), now)
}

export function updateBudget(
  w: BudgetMockStore,
  id: string,
  user: string,
  body: UpdateBudgetBody,
  now: number,
  superuser = false,
): Budget {
  return legacy(w, engineUpdate(w, viewer(user, superuser), id, body, now), now)
}

export function deleteBudget(
  w: BudgetMockStore,
  id: string,
  user: string,
  superuser = false,
  now = Date.now(),
) {
  engineDelete(w, viewer(user, superuser), id, now)
}

export function budgetStatus(
  w: BudgetMockStore,
  _seed: Seed,
  _agents: readonly MockAgent[],
  user: string,
  now: number,
): BudgetStatusResponse {
  const st = statusList(w, viewer(user), { scope: null, id: null, limit: '100' }, now)
  // The 1.0 row is a superset of R-L10's.
  return { data: st.data as unknown as BudgetStatusResponse['data'], covers: 'routed_calls' }
}

/** This period's and last period's threshold alerts on the caller's budgets, newest first. */
export function budgetAlerts(
  w: BudgetMockStore,
  _seed: Seed,
  _agents: readonly MockAgent[],
  user: string,
  now: number,
): BudgetAlert[] {
  return alertRows(w, viewer(user), { scope: null, id: null }, now).map((a) => ({
    ...a,
    threshold: a.percent,
  }))
}

/**
 * The ledger's proposed per-session read (AH-8, plans/feat-agent-centric.md PR1b): every budget that applies to one of
 * the caller's sessions, with what it recorded before the session started (this budget's own period) and per turn.
 * `sessionLimit` adds a session budget (the demo session has one). 1.0 replaces this read with
 * `GET /api/budgets?scope=session&id=` (budgets.md §12); B5 moves the ledger onto it.
 */
export function sessionBudgets(
  w: BudgetMockStore,
  _seed: Seed,
  _agents: readonly MockAgent[],
  user: string,
  session: {
    agentId: string | null
    start: number
    turns: { turn_id: string; used_usd: number }[]
  },
  sessionLimit?: number,
) {
  const sessionUsed = cents(session.turns.reduce((t, x) => t + x.used_usd, 0))
  const from = monthStart(session.start)
  const period = new Date(from).toISOString().slice(0, 7)
  const applies = w.budgets.filter(
    (b) =>
      b.owner_id === user &&
      (b.scope === 'owner' || (b.scope === 'agent' && b.agent_id === session.agentId)),
  )
  const out = applies.map((b) => ({
    budget_id: b.id,
    scope: b.scope as 'owner' | 'agent',
    limit_usd: versionAt(b, session.start).limit_usd,
    period,
    used_before_usd: cents(
      accepted(w)
        .filter(
          (c) =>
            c.at >= from &&
            c.at < session.start &&
            (b.scope === 'agent' ? c.agent_id === b.agent_id : c.billed_user_id === b.owner_id),
        )
        .reduce((t, c) => t + (c.u ?? 0), 0) / 1e8,
    ),
    session_used_usd: sessionUsed,
    turns: session.turns,
  }))
  return sessionLimit
    ? [
        {
          budget_id: 'session-budget',
          scope: 'session' as const,
          limit_usd: sessionLimit,
          period: null,
          used_before_usd: 0,
          session_used_usd: sessionUsed,
          turns: session.turns,
        },
        ...out,
      ]
    : out
}
