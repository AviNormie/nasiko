/**
 * A harness session's ledger (plans/feat-agent-centric.md PR1b; design "Ledger"; eng "Ledger"): one row per turn, in
 * plain language, with what was used and what controlled it. Pure.
 *
 * - Turns come from the chat history (`/api/chat/sessions/{id}/messages`, newest 100 first). Pages are merged, deduped
 *   by message id and sorted by time. A message's `external_turn_id` names its turn; without one, a user message starts
 *   a turn and the assistant messages after it join it. While older pages are unloaded the oldest loaded turn may be cut
 *   (`partial`) and every total is a loaded subtotal (`complete: false`).
 * - Tool calls are the recorded chat's own (`chat/recorded.ts`); a call whose association is `unknown` is listed under
 *   "Turn not recorded", never guessed onto a turn.
 * - Context, memory and applied controls are proposed per-turn records (AH-7, with CX-V1) on the assistant message's
 *   `metadata.coding_agent`. They're parsed only in preview mode (`preview`), so an unexpected live field never draws.
 *   A control is shown only from a recorded decision (time, rule identity, outcome); current settings are linked
 *   elsewhere, never presented as applied.
 * - Budgets (AH-8, preview): the tightest of the session's, agent's and owner's budgets, by percent used.
 */
import type { RecordedStep } from '@/features/chat/recorded'
import { toolCallsToSteps } from '@/features/chat/recorded'
import type { ChatMessage, MessagesPage } from '@/features/chat/types'
import { contextReport, type ContextReport } from '@/features/optimization/logic'
import { toCsv, type CsvColumn } from '@/features/tokenops/csv'
import type { SessionBudget } from './types'

const CONTROL_KINDS = ['tool_rule', 'context', 'budget'] as const
const CONTROL_OUTCOMES = ['blocked', 'asked', 'trimmed', 'warned', 'stopped'] as const
type ControlKind = (typeof CONTROL_KINDS)[number]
type ControlOutcome = (typeof CONTROL_OUTCOMES)[number]

/** A recorded decision a control made on this turn (proposed AH-7). */
export interface AppliedControl {
  at: string
  kind: ControlKind
  rule: { id: string; name: string }
  outcome: ControlOutcome
  /** The tool a tool rule acted on. */
  tool?: string
  /** Tokens a context trim removed. */
  tokensSaved?: number
}

interface MemoryUse {
  tokens: number
  items: number | null
}

export interface LedgerTurn {
  key: string
  /** 1-based among the loaded turns, oldest first. */
  n: number
  at: string
  prompt: string | null
  reply: string | null
  tools: RecordedStep[]
  tokensIn: number | null
  tokensOut: number | null
  cost: number | null
  model: string | null
  traceId: string | null
  context: ContextReport | null
  memory: MemoryUse | null
  controls: AppliedControl[]
  /** The oldest loaded turn while older messages are unloaded: its start may be on an older page. */
  partial: boolean
  /** Cost of the loaded turns up to and including this one; null while no turn reported a cost. */
  runningCost: number | null
}

export interface Ledger {
  turns: LedgerTurn[]
  /** Calls the harness couldn't tie to a turn (`association: 'unknown'`). */
  unplaced: RecordedStep[]
  totals: {
    turns: number
    toolCalls: number
    failedCalls: number
    tokensIn: number | null
    tokensOut: number | null
    cost: number | null
  }
  /** Every page is loaded: the totals are the session's, not a loaded subtotal. */
  complete: boolean
  /** Any turn carries a preview record (context, memory or a control). */
  hasPreview: boolean
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const money = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}
const codingAgent = (m: ChatMessage): Json | null =>
  isObject(m.metadata) && isObject(m.metadata.coding_agent) ? m.metadata.coding_agent : null

/** The recorded decisions on one message; anything without a time, a rule's id and name, and an outcome is dropped. */
export function controlsOf(m: ChatMessage): AppliedControl[] {
  const raw = codingAgent(m)?.controls
  if (!Array.isArray(raw)) return []
  const out: AppliedControl[] = []
  for (const c of raw) {
    if (!isObject(c) || !isTime(c.at) || !isObject(c.rule)) continue
    const { id, name } = c.rule
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) continue
    if (!(CONTROL_KINDS as readonly unknown[]).includes(c.kind)) continue
    if (!(CONTROL_OUTCOMES as readonly unknown[]).includes(c.outcome)) continue
    out.push({
      at: c.at,
      kind: c.kind as ControlKind,
      rule: { id, name },
      outcome: c.outcome as ControlOutcome,
      tool: typeof c.tool === 'string' && c.tool ? c.tool : undefined,
      tokensSaved: count(c.tokens_saved) ?? undefined,
    })
  }
  return out
}

const contextOf = (m: ChatMessage): ContextReport | null => {
  const raw = codingAgent(m)?.context
  return isObject(raw) ? contextReport(raw) : null
}

const memoryOf = (m: ChatMessage): MemoryUse | null => {
  const raw = codingAgent(m)?.memory
  if (!isObject(raw)) return null
  const tokens = count(raw.tokens)
  return tokens === null ? null : { tokens, items: count(raw.items) }
}

/** Sum the reported values; null when none was reported (never 0 for "not reported"). */
function sum(values: (number | null)[]): number | null {
  let total: number | null = null
  for (const v of values) if (v !== null) total = (total ?? 0) + v
  return total
}

/** Every loaded message once, oldest first (pages arrive newest first; a refetch can repeat rows). */
export function mergeMessages(pages: readonly MessagesPage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const p of pages) for (const m of p.data) if (!byId.has(m.id)) byId.set(m.id, m)
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id),
  )
}

/** Messages grouped into turns, oldest first. */
export function groupTurns(messages: readonly ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = []
  const byTurnId = new Map<string, ChatMessage[]>()
  let current: { msgs: ChatMessage[]; id: string | null } | null = null
  for (const m of messages) {
    if (m.role === 'system') continue
    const tid = m.external_turn_id || null
    const known = tid ? byTurnId.get(tid) : undefined
    if (known) {
      known.push(m)
      continue
    }
    if (!current || (tid !== null && tid !== current.id) || (m.role === 'user' && !tid)) {
      current = { msgs: [m], id: tid }
      turns.push(current.msgs)
    } else {
      current.msgs.push(m)
      current.id ??= tid
    }
    if (tid) byTurnId.set(tid, current.msgs)
  }
  return turns
}

export function buildLedger(
  pages: readonly MessagesPage[],
  opts: { complete: boolean; preview: boolean },
): Ledger {
  const groups = groupTurns(mergeMessages(pages))
  const unplaced: RecordedStep[] = []
  let running: number | null = null
  let hasPreview = false
  const turns = groups.map((msgs, i): LedgerTurn => {
    const [first] = msgs as [ChatMessage, ...ChatMessage[]]
    const user = msgs.find((m) => m.role === 'user') ?? null
    const replies = msgs.filter((m) => m.role === 'assistant')
    const tools: RecordedStep[] = []
    for (const r of replies)
      for (const s of toolCallsToSteps(r.metadata)?.steps ?? [])
        (s.association === 'unknown' ? unplaced : tools).push(s)
    const cost = sum(replies.map((r) => money(r.cost_usd)))
    if (cost !== null) running = (running ?? 0) + cost
    const context = opts.preview ? (replies.map(contextOf).find(Boolean) ?? null) : null
    const memory = opts.preview ? (replies.map(memoryOf).find(Boolean) ?? null) : null
    const controls = opts.preview ? replies.flatMap(controlsOf) : []
    if (context || memory || controls.length) hasPreview = true
    return {
      key: msgs.find((m) => m.external_turn_id)?.external_turn_id ?? first.id,
      n: i + 1,
      at: first.timestamp,
      prompt: user?.content ?? null,
      reply:
        replies
          .map((r) => r.content)
          .filter(Boolean)
          .join('\n\n') || null,
      tools,
      tokensIn: sum(replies.map((r) => count(r.input_tokens))),
      tokensOut: sum(replies.map((r) => count(r.output_tokens))),
      cost,
      model: replies.find((r) => r.model)?.model ?? null,
      traceId: replies.find((r) => r.trace_id)?.trace_id ?? null,
      context,
      memory,
      controls,
      partial: !opts.complete && i === 0 && !user,
      runningCost: running,
    }
  })
  const calls = turns.flatMap((t) => t.tools).concat(unplaced)
  return {
    turns,
    unplaced,
    totals: {
      turns: turns.length,
      toolCalls: calls.length,
      failedCalls: calls.filter((s) => s.status === 'error').length,
      tokensIn: sum(turns.map((t) => t.tokensIn)),
      tokensOut: sum(turns.map((t) => t.tokensOut)),
      cost: sum(turns.map((t) => t.cost)),
    },
    complete: opts.complete,
    hasPreview,
  }
}

export interface BudgetLine {
  budget: SessionBudget
  /** Share of the limit this session used, 0-100+. */
  sessionPct: number
  /** Share used before the session started; null when not recorded. */
  beforePct: number | null
}

const PRECEDENCE: SessionBudget['scope'][] = ['session', 'agent', 'owner']

/** The budgets in precedence order (session → agent → owner), with the tightest (highest share used) first among ties. */
export function budgetLines(budgets: readonly SessionBudget[]): BudgetLine[] {
  return [...budgets]
    .sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope))
    .map((budget) => ({
      budget,
      sessionPct: (budget.session_used_usd / budget.limit_usd) * 100,
      beforePct:
        budget.used_before_usd === null ? null : (budget.used_before_usd / budget.limit_usd) * 100,
    }))
}

/**
 * The tightest budget: the highest share used by the end of the session. A budget whose earlier use isn't recorded is
 * compared on the session's own share. Ties keep precedence (session, agent, owner).
 */
export function tightest(lines: readonly BudgetLine[]): BudgetLine | null {
  let best: BudgetLine | null = null
  for (const l of lines) {
    const pct = (l.beforePct ?? 0) + l.sessionPct
    const bestPct = best ? (best.beforePct ?? 0) + best.sessionPct : -1
    if (pct > bestPct) best = l
  }
  return best
}

/** The share of a budget used by the end of each turn, keyed by turn id: before + this session's turns so far. */
export function runningShare(line: BudgetLine): Map<string, number> {
  const out = new Map<string, number>()
  let used = line.budget.used_before_usd ?? 0
  for (const t of line.budget.turns) {
    used += t.used_usd
    out.set(t.turn_id, (used / line.budget.limit_usd) * 100)
  }
  return out
}

/** What a row of the CSV is (plans/feat-agent-centric.md eng "Preview policy": preview rows carry their provenance). */
export const CSV_SOURCE = { recorded: 'recorded', preview: 'preview (mock data)' } as const

interface LedgerCsvRow {
  turn: LedgerTurn | null
  /** The calls under "Turn not recorded" share one row. */
  unplaced?: RecordedStep[]
}

/**
 * The ledger's CSV (X4): turn, time (UTC), tool names, tokens in, tokens out, cost, context tokens, memory tokens,
 * controls applied, source. A value the server didn't report is the literal `not reported`. Tool arguments and
 * results are never exported (CEO decision 5): only names and recorded statuses. Formula escaping is `toCsv`'s.
 */
function ledgerCsvColumns(
  costHeader: string,
  notReported: string,
): CsvColumn<LedgerCsvRow>[] {
  const nr = <T>(v: T | null | undefined, f: (x: T) => string | number) =>
    v === null || v === undefined ? notReported : f(v)
  const names = (steps: RecordedStep[]) =>
    steps.map((s) => (s.statusWord ? `${s.name} (${s.recordedStatus})` : s.name)).join('; ')
  return [
    { header: 'turn', value: (r) => (r.turn ? r.turn.n : 'not recorded') },
    { header: 'time (UTC)', value: (r) => (r.turn ? r.turn.at : '') },
    { header: 'tool names', value: (r) => names(r.turn ? r.turn.tools : (r.unplaced ?? [])) },
    { header: 'tokens in', value: (r) => (r.turn ? nr(r.turn.tokensIn, (v) => v) : '') },
    { header: 'tokens out', value: (r) => (r.turn ? nr(r.turn.tokensOut, (v) => v) : '') },
    { header: costHeader, value: (r) => (r.turn ? nr(r.turn.cost, (v) => v) : '') },
    {
      header: 'context tokens',
      value: (r) => (r.turn ? nr(r.turn.context, (c) => c.kept.tokens) : ''),
    },
    { header: 'memory tokens', value: (r) => (r.turn ? nr(r.turn.memory, (m) => m.tokens) : '') },
    {
      header: 'controls applied',
      value: (r) =>
        r.turn
          ? r.turn.controls.length
            ? r.turn.controls.map((c) => `${c.rule.name}: ${c.outcome}`).join('; ')
            : notReported
          : '',
    },
    {
      header: 'source',
      value: (r) =>
        r.turn && (r.turn.context || r.turn.memory || r.turn.controls.length)
          ? CSV_SOURCE.preview
          : CSV_SOURCE.recorded,
    },
  ]
}

export function ledgerCsv(ledger: Ledger, costHeader: string, notReported: string): string {
  const rows: LedgerCsvRow[] = ledger.turns.map((turn) => ({ turn }))
  if (ledger.unplaced.length) rows.push({ turn: null, unplaced: ledger.unplaced })
  return toCsv(ledgerCsvColumns(costHeader, notReported), rows)
}
