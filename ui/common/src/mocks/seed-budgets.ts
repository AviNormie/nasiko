/**
 * The budgets golden scenario (docs/requirements/budgets.md §14.1-§14.3, plan feat-budget-burn #45): users, agents,
 * units, one chat session, every call and every budget, with times relative to the anchor. The golden anchor is
 * 2026-10-14T12:00:00Z; `budgetScenario(anchor)` shifts every time by the same amount, so another anchor moves the
 * figures with the calendar, never the rules. The UI mock's `budgets-golden` world and `seed:live` both read it.
 *
 * Import-free, erasable-only TypeScript: Node runs it directly from scripts/ (like seed.ts and seed-mcp.ts).
 */

export const GOLDEN_ANCHOR = '2026-10-14T12:00:00Z'
const GOLDEN = Date.parse(GOLDEN_ANCHOR)
const H = 3_600_000
const D = 24 * H

const id = (n: number) => `5eed0017-0000-4000-8000-${String(n).padStart(12, '0')}`
/** A flow (trace) id: 32 hex, no dashes. */
const flow = (n: number) => `5eed00170000400080000000000000${String(n).padStart(2, '0')}`

export const SCENARIO_IDS = {
  dev: id(1),
  ana: id(2),
  fin: id(3),
  pricing: id(11),
  reviewer: id(12),
  support: id(13),
  claude: id(14),
  platform: id(21),
  growth: id(22),
  bOrg: id(31),
  bPlatform: id(32),
  bGrowth: id(33),
  bDev: id(34),
  bPrice: id(35),
  bReview: id(36),
  bSess: id(37),
  s1: id(41),
  dedupeCall: id(101),
} as const

type Source = 'routed' | 'traced' | 'harness_estimate'
type Operation = 'chat' | 'tool' | 'workflow' | 'routing' | 'harness'

export interface ScenarioCall {
  call_id: string
  at: number
  source: Source
  agent_id: string | null
  billed_user_id: string | null
  flow_id: string | null
  chat_session_id: string | null
  turn_id: string | null
  /** `provider/model`. */
  model: string
  operation: Operation
  input_tokens: number
  output_tokens: number
  /** USD; null = unpriced. */
  cost_usd: number | null
  routed: boolean
  /** Also recorded as a trace span carrying `nasiko.call_id` (the dedupe pair, counted once). */
  traced_copy?: boolean
}

export interface ScenarioVersion {
  version: number
  effective_from: number
  set_by: string
  period: 'month' | 'quarter' | 'session'
  limit_usd: number
  thresholds: number[]
  forecast_thresholds: number[]
  action: 'alert' | 'stop'
}

interface ScenarioBudget {
  id: string
  scope: 'org' | 'unit' | 'owner' | 'agent' | 'session'
  agent_id: string | null
  unit_id: string | null
  session_id: string | null
  owner_id: string | null
  created_at: number
  versions: ScenarioVersion[]
}

export interface BudgetScenario {
  anchor: number
  users: { id: string; name: string; role: 'member' | 'finance' }[]
  agents: { id: string; name: string; owner_id: string; harness: boolean }[]
  units: { id: string; name: string; lead_id: string | null }[]
  members: { unit_id: string; user_id: string; from: number; to: number | null }[]
  parents: { unit_id: string; parent_id: string | null; from: number; to: number | null }[]
  sessions: {
    id: string
    title: string
    user_id: string
    agent_id: string
    started_at: number
    ended_at: number | null
  }[]
  calls: ScenarioCall[]
  budgets: ScenarioBudget[]
  meta: { exact_dedupe_from: number; membership_history_from: number }
}

/** October 2026 at `day`, `hh:mm` UTC, as an offset from the golden anchor. */
const oct = (day: number, hh: number, mm = 0) => Date.UTC(2026, 9, day, hh, mm) - GOLDEN

/** `adminId`: the superuser who set the org and unit budgets (seed:live passes the server's admin). */
export function budgetScenario(anchor: number = GOLDEN, adminId: string = id(0)): BudgetScenario {
  const t = (offset: number) => anchor + offset
  const I = SCENARIO_IDS
  const calls: ScenarioCall[] = []
  let n = 200
  const call = (
    offset: number,
    p: Omit<ScenarioCall, 'call_id' | 'at' | 'flow_id' | 'chat_session_id' | 'turn_id' | 'routed'> &
      Partial<Pick<ScenarioCall, 'call_id' | 'flow_id' | 'chat_session_id' | 'turn_id'>>,
  ) =>
    calls.push({
      call_id: p.call_id ?? id(n++),
      at: t(offset),
      flow_id: p.flow_id ?? null,
      chat_session_id: p.chat_session_id ?? null,
      turn_id: p.turn_id ?? null,
      routed: p.source === 'routed',
      ...p,
    })
  const routed = { source: 'routed' as const, operation: 'chat' as const }
  // Pricing Engine (Dev): $6 a day Oct 1-13 at 10:00 (gpt-4o, 480k/480k), $3 on Oct 14.
  for (let d = 1; d <= 14; d++) {
    const half = d === 14
    call(oct(d, 10), {
      ...routed,
      agent_id: I.pricing,
      billed_user_id: I.dev,
      model: 'openai/gpt-4o',
      input_tokens: half ? 240_000 : 480_000,
      output_tokens: half ? 240_000 : 480_000,
      cost_usd: half ? 3 : 6,
    })
  }
  // Code Reviewer (Dev): $4 a day Oct 1-8 at 14:00; Ana's session S1 on Oct 9; $2 a day Oct 10-13 (then stopped).
  for (let d = 1; d <= 8; d++)
    call(oct(d, 14), {
      ...routed,
      agent_id: I.reviewer,
      billed_user_id: I.dev,
      model: 'openai/gpt-4.1',
      input_tokens: 400_000,
      output_tokens: 400_000,
      cost_usd: 4,
    })
  ;[
    [0, 3],
    [10, 3],
    [20, 4],
  ].forEach(([mm, cost], i) =>
    call(oct(9, 15, mm), {
      ...routed,
      agent_id: I.reviewer,
      billed_user_id: I.ana,
      flow_id: flow(51 + i),
      chat_session_id: I.s1,
      turn_id: flow(51 + i),
      model: 'openai/gpt-4.1',
      input_tokens: 300_000,
      output_tokens: 300_000,
      cost_usd: cost!,
    }),
  )
  for (let d = 10; d <= 13; d++)
    call(oct(d, 14), {
      ...routed,
      agent_id: I.reviewer,
      billed_user_id: I.dev,
      model: 'openai/gpt-4.1',
      input_tokens: 200_000,
      output_tokens: 200_000,
      cost_usd: 2,
      // The dedupe pair: in token_usage and in trace_usage (its span carries nasiko.call_id), counted once.
      ...(d === 12 ? { call_id: I.dedupeCall, traced_copy: true } : {}),
    })
  // Support Bot (Ana) calls its provider directly: traced, $1 a day Oct 1-14 at 08:00, one unpriced call Oct 13.
  for (let d = 1; d <= 14; d++)
    call(oct(d, 8), {
      source: 'traced',
      operation: 'chat',
      agent_id: I.support,
      billed_user_id: I.ana,
      model: 'openai/gpt-4o-mini',
      input_tokens: 2_000_000,
      output_tokens: 1_166_666,
      cost_usd: 1,
    })
  call(oct(13, 9), {
    source: 'traced',
    operation: 'chat',
    agent_id: I.support,
    billed_user_id: I.ana,
    model: 'custom/custom-local',
    input_tokens: 10_000,
    output_tokens: 2_000,
    cost_usd: null,
  })
  // Claude Code (Ana): harness estimates, $5 on Oct 12 and 13 at 12:00.
  for (const d of [12, 13])
    call(oct(d, 12), {
      source: 'harness_estimate',
      operation: 'harness',
      agent_id: I.claude,
      billed_user_id: I.ana,
      model: 'anthropic/claude-sonnet-4-5',
      input_tokens: 1_000_000,
      output_tokens: 133_333,
      cost_usd: 5,
    })
  calls.sort((a, b) => a.at - b.at || a.call_id.localeCompare(b.call_id))

  const created = t(oct(1, 0))
  const month = (
    limit: number,
    action: 'alert' | 'stop',
    set_by: string,
    forecast: number[] = [],
  ): ScenarioVersion => ({
    version: 1,
    effective_from: created,
    set_by,
    period: 'month',
    limit_usd: limit,
    thresholds: [50, 80, 100],
    forecast_thresholds: forecast,
    action,
  })
  const base = {
    agent_id: null,
    unit_id: null,
    session_id: null,
    owner_id: null,
    created_at: created,
  }
  const budgets: ScenarioBudget[] = [
    { ...base, id: I.bOrg, scope: 'org', versions: [month(500, 'alert', adminId)] },
    {
      ...base,
      id: I.bPlatform,
      scope: 'unit',
      unit_id: I.platform,
      versions: [month(150, 'alert', adminId)],
    },
    {
      ...base,
      id: I.bGrowth,
      scope: 'unit',
      unit_id: I.growth,
      versions: [{ ...month(400, 'alert', adminId), period: 'quarter' }],
    },
    {
      ...base,
      id: I.bDev,
      scope: 'owner',
      owner_id: I.dev,
      versions: [month(150, 'alert', I.dev)],
    },
    {
      ...base,
      id: I.bPrice,
      scope: 'agent',
      agent_id: I.pricing,
      owner_id: I.dev,
      versions: [month(100, 'alert', I.dev, [100])],
    },
    {
      ...base,
      id: I.bReview,
      scope: 'agent',
      agent_id: I.reviewer,
      owner_id: I.dev,
      versions: [
        month(40, 'stop', I.dev),
        { ...month(50, 'stop', I.dev), version: 2, effective_from: t(oct(10, 9)) },
      ],
    },
    {
      ...base,
      id: I.bSess,
      scope: 'session',
      session_id: I.s1,
      owner_id: I.ana,
      created_at: t(oct(9, 14, 59)),
      versions: [
        {
          ...month(8, 'stop', I.ana),
          period: 'session',
          effective_from: t(oct(9, 14, 59)),
        },
      ],
    },
  ]

  const historyFrom = t(oct(6, 0))
  return {
    anchor,
    users: [
      { id: I.dev, name: 'Dev', role: 'member' },
      { id: I.ana, name: 'Ana', role: 'member' },
      { id: I.fin, name: 'Fin', role: 'finance' },
    ],
    agents: [
      { id: I.pricing, name: 'Pricing Engine', owner_id: I.dev, harness: false },
      { id: I.reviewer, name: 'Code Reviewer', owner_id: I.dev, harness: false },
      { id: I.support, name: 'Support Bot', owner_id: I.ana, harness: false },
      { id: I.claude, name: 'Claude Code', owner_id: I.ana, harness: true },
    ],
    units: [
      { id: I.platform, name: 'Platform', lead_id: null },
      { id: I.growth, name: 'Growth', lead_id: null },
    ],
    // Ana since before history (opened at the cut-over); Dev joins Platform on Oct 11.
    members: [
      { unit_id: I.platform, user_id: I.ana, from: historyFrom, to: null },
      { unit_id: I.growth, user_id: I.ana, from: historyFrom, to: null },
      { unit_id: I.platform, user_id: I.dev, from: t(oct(11, 0)), to: null },
    ],
    parents: [
      { unit_id: I.platform, parent_id: null, from: historyFrom, to: null },
      { unit_id: I.growth, parent_id: null, from: historyFrom, to: null },
    ],
    sessions: [
      {
        id: I.s1,
        title: 'Review the pricing PR',
        user_id: I.ana,
        agent_id: I.reviewer,
        started_at: t(oct(9, 14, 58)),
        ended_at: t(oct(9, 16, 20)),
      },
    ],
    calls,
    budgets,
    // Exact dedupe from 30 days before the period start; membership history from Oct 6.
    meta: { exact_dedupe_from: t(oct(1, 0) - 30 * D), membership_history_from: historyFrom },
  }
}
