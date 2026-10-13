/**
 * Budget wire types. R-L10 (owner and agent monthly budgets, status, alerts) moved here from the router (plan
 * feat-budget-burn eng D1); the 1.0 contract's zod schemas join them in B0 (docs/requirements/budgets.md).
 */
import { z } from 'zod'

// ─── R-L10 (the `budgets` mock group answers it; `router` brings it along) ──────────

/** R-L10's scopes, plus 1.0's fleet (`org`), which the sheet edits from /budgets (B2). */
type BudgetScope = 'owner' | 'agent' | 'org'
export type BudgetAction = 'alert' | 'stop'
export type BudgetState = 'ok' | 'warning' | 'exceeded'

export interface Budget {
  id: string
  scope: BudgetScope
  /** Set for an agent budget, null for the owner budget. */
  agent_id: string | null
  /** The user it belongs to: the owner budget's user, or the agent's owner, whoever set it. */
  owner_id: string
  /** Who created or last changed it (a superuser may set a budget on anyone's agent). */
  set_by: string
  period: 'month'
  limit_usd: number
  /** Whole percents of the limit, ascending and unique (default 50, 80, 100); a `stop` budget always has 100. */
  thresholds: number[]
  action: BudgetAction
  created_at: string
  updated_at: string
}

export interface CreateBudgetBody {
  /** 1.0 adds `session` (BG-10): a limit on one chat session, until it ends. */
  scope: BudgetScope | 'session'
  agent_id?: string | null
  /** 1.0: the chat session, for a session budget. */
  session_id?: string
  /** 1.0: `session` for a session budget (its one period); month otherwise (the default). */
  period?: 'session'
  /** 1.0: whose owner budget, when not the caller's (superuser, §6.4). */
  user_id?: string
  limit_usd: number
  thresholds?: number[]
  action?: BudgetAction
}

/** A full replace (R-L10 has no COALESCE), guarded against a change made elsewhere since it was read. */
export interface UpdateBudgetBody {
  limit_usd: number
  thresholds: number[]
  action: BudgetAction
  /** The `updated_at` the client read; a mismatch is 409 "budget changed elsewhere". */
  expected_updated_at: string
}

export interface BudgetStatus {
  budget_id: string
  used_usd: number
  /** Calls this period with no price (NULL cost_usd): they count as $0. */
  unpriced_calls: number
  resets_at: string
  state: BudgetState
  /** The highest threshold crossed this period, or null. */
  crossed: number | null
  /** One entry per UTC day of the period so far, zeros included. */
  daily: { date: string; cost_usd: number }[]
  /** A `stop` budget the router is refusing calls for right now (its effective state, after its cache window). */
  stopped: boolean
}

export interface BudgetStatusResponse {
  data: BudgetStatus[]
  covers: 'routed_calls'
}

export interface BudgetAlert {
  id: string
  budget_id: string
  threshold: number
  amount_usd: number
  at: string
  stopped: boolean
}

// ─── Contract 1.0 (docs/requirements/budgets.md, budgets.openapi.yaml): zod per route ──────────
// Loose objects (a server may add fields, API_CONVENTIONS §7); event and alert kinds accept unknown values, which the
// UI ignores. `openapi.test.ts` parses every OpenAPI example with these.

const usd = z.number()
const iso = z.string()
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const uuid = z.string()

const SCOPES = ['org', 'unit', 'owner', 'agent', 'session'] as const
const scopeSchema = z.enum(SCOPES)
export type Scope = z.infer<typeof scopeSchema>
const coversSchema = z.enum(['routed_calls', 'all_priced'])
export type Covers = z.infer<typeof coversSchema>
const actionSchema = z.enum(['alert', 'stop'])
const stateSchema = z.enum(['ok', 'warning', 'exceeded'])
const DIMENSIONS = ['agent', 'owner', 'unit', 'model', 'operation', 'session', 'source'] as const
const dimensionSchema = z.enum(DIMENSIONS)
export type Dimension = z.infer<typeof dimensionSchema>
const EVENT_KINDS = [
  'threshold',
  'forecast',
  'forecast_cleared',
  'stopped',
  'resumed',
  'limit_changed',
  'action_changed',
  'period_change_scheduled',
  'fiscal_year_changed',
] as const
/** A known kind, or any other string (a newer server's kind, ignored by the UI). */
const kindOf = <T extends readonly [string, ...string[]]>(known: T) =>
  z.union([z.enum(known), z.string()])

const listMeta = {
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  prev_cursor: z.string().nullable(),
}
const list = <T extends z.ZodType>(row: T) => z.looseObject({ data: z.array(row), ...listMeta })
const one = <T extends z.ZodType>(row: T) => z.looseObject({ data: row })

export const capabilitiesSchema = one(
  z.looseObject({ version: z.string(), features: z.array(z.string()) }),
)

const budgetV1Schema = z.looseObject({
  id: uuid,
  scope: scopeSchema,
  agent_id: uuid.nullable(),
  unit_id: uuid.nullable(),
  session_id: z.string().nullable(),
  owner_id: uuid.nullable(),
  label: z.string(),
  set_by: uuid,
  period: z.enum(['month', 'quarter', 'session']),
  limit_usd: usd,
  thresholds: z.array(z.number().int()),
  forecast_thresholds: z.array(z.number().int()),
  action: actionSchema,
  covers: coversSchema,
  version: z.number().int().min(1),
  effective_from: iso,
  next_period_change: z
    .looseObject({ period: z.enum(['month', 'quarter']), effective_from: iso })
    .nullable(),
  limits_inside_usd: usd.nullable(),
  limits_inside_count: z.number().int().nullable(),
  created_at: iso,
  updated_at: iso,
})
export type BudgetV1 = z.infer<typeof budgetV1Schema>
export const budgetResponseSchema = one(budgetV1Schema)
export const budgetListSchema = list(budgetV1Schema)

export const createBudgetBodySchema = z.looseObject({
  scope: scopeSchema,
  agent_id: uuid.nullish(),
  unit_id: uuid.nullish(),
  session_id: z.string().nullish(),
  user_id: uuid.nullish(),
  period: z.enum(['month', 'quarter', 'session']).optional(),
  limit_usd: usd,
  thresholds: z.array(z.number().int()).optional(),
  forecast_thresholds: z.array(z.number().int()).optional(),
  action: actionSchema.optional(),
})
export const updateBudgetBodySchema = z.looseObject({
  limit_usd: usd,
  thresholds: z.array(z.number().int()),
  action: actionSchema,
  expected_updated_at: iso,
  forecast_thresholds: z.array(z.number().int()).optional(),
  period: z.enum(['month', 'quarter']).optional(),
})

const versionSchema = z.looseObject({
  version: z.number().int().min(1),
  effective_from: iso,
  set_by: uuid,
  period: z.enum(['month', 'quarter', 'session']),
  limit_usd: usd,
  thresholds: z.array(z.number().int()),
  forecast_thresholds: z.array(z.number().int()),
  action: actionSchema,
})
export const versionListSchema = list(versionSchema)

export const budgetSettingsSchema = one(
  z.looseObject({
    team_identity: z.boolean().optional(),
    /** EE: unit leads may write their units' budgets (budgets.md §5, §6.8; plan §7 Q4). */
    unit_leads_write: z.boolean().optional(),
    fiscal_year_first_month: z.number().int().min(1).max(12).optional(),
    updated_at: iso,
  }),
)

const sourcesSchema = z.looseObject({
  routed_usd: usd,
  traced_usd: usd,
  harness_estimate_usd: usd,
})
const burnDaySchema = z.looseObject({
  date: day,
  cost_usd: usd,
  calls: z.number().int(),
  unpriced_calls: z.number().int(),
  routed_usd: usd,
  traced_usd: usd,
  harness_estimate_usd: usd,
})
export type BurnDay = z.infer<typeof burnDaySchema>
const limitStepSchema = z.looseObject({
  from: iso,
  to: iso.nullable(),
  version: z.number().int(),
  limit_usd: usd,
  thresholds: z.array(z.number().int()),
  action: actionSchema,
})
export type LimitStep = z.infer<typeof limitStepSchema>
const periodSchema = z.looseObject({
  period_start: iso,
  resets_at: iso.nullable(),
  used_usd: usd,
  unpriced_calls: z.number().int(),
})
const budgetEventSchema = z.looseObject({
  id: z.string(),
  at: iso,
  kind: kindOf(EVENT_KINDS),
  budget_id: uuid,
  version: z.number().int(),
  percent: z.number().int().nullable(),
  crosses_on: day.nullable(),
  from_usd: usd.nullable(),
  to_usd: usd.nullable(),
  from_action: actionSchema.nullable(),
  to_action: actionSchema.nullable(),
  by: uuid.nullable(),
  period: z.enum(['month', 'quarter']).nullable(),
  effective_from: iso.nullable(),
})
export type BudgetEvent = z.infer<typeof budgetEventSchema>
const burnSchema = z.looseObject({
  scope: scopeSchema,
  id: z.string().nullable(),
  label: z.string(),
  as_of: iso,
  covers: coversSchema,
  period: z.enum(['month', 'quarter', 'session']),
  period_start: iso,
  resets_at: iso.nullable(),
  from: day,
  used_usd: usd,
  unpriced_calls: z.number().int(),
  calls: z.number().int(),
  sources: sourcesSchema,
  exact_dedupe_from: iso.nullable(),
  outside: z.looseObject({ traced_usd: usd, harness_estimate_usd: usd }).nullable(),
  budget: z
    .looseObject({
      id: uuid,
      action: actionSchema,
      version: z.number().int(),
      forecast_thresholds: z.array(z.number().int()),
      state: stateSchema,
      crossed: z.number().int().nullable(),
      stopped: z.boolean(),
      limits: z.array(limitStepSchema),
    })
    .nullable(),
  periods: z.array(periodSchema),
  daily: z.array(burnDaySchema),
  previous: z
    .looseObject({
      period_start: iso,
      resets_at: iso,
      used_usd: usd,
      unpriced_calls: z.number().int(),
      daily: z.array(burnDaySchema),
    })
    .nullable(),
  events: z.array(budgetEventSchema),
  contributor: z
    .looseObject({
      by: dimensionSchema,
      key: z.string(),
      label: z.string(),
      used_usd: usd,
      unpriced_calls: z.number().int(),
      daily: z.array(z.looseObject({ date: day, cost_usd: usd, calls: z.number().int() })),
    })
    .nullable(),
  owned_agents: z.looseObject({ used_usd: usd, unpriced_calls: z.number().int() }).nullable(),
  membership: z
    .looseObject({ history_from: day, basis_before: z.literal('current_membership') })
    .nullable(),
  turns: z
    .array(
      z.looseObject({
        turn_id: z.string(),
        flow_id: z.string().nullable(),
        at: iso,
        cost_usd: usd,
        calls: z.number().int(),
        unpriced_calls: z.number().int(),
      }),
    )
    .nullable(),
  session: z.looseObject({ started_at: iso, ended_at: iso.nullable() }).nullable(),
})
export type Burn = z.infer<typeof burnSchema>
export const burnResponseSchema = one(burnSchema)

const breakdownKeySchema = z.looseObject({
  key: z.string(),
  label: z.string(),
  cost_usd: usd,
  calls: z.number().int(),
  unpriced_calls: z.number().int(),
  redacted: z.boolean(),
  input_tokens: z.number().int().optional(),
  output_tokens: z.number().int().optional(),
  routed_input_tokens: z.number().int().optional(),
  routed_output_tokens: z.number().int().optional(),
})
const breakdownSchema = z.looseObject({
  by: dimensionSchema,
  from: day,
  to: day,
  as_of: iso,
  covers: coversSchema,
  keys: z.array(breakdownKeySchema),
  days: z.array(
    z.looseObject({
      date: day,
      items: z.array(z.looseObject({ key: z.string(), cost_usd: usd, calls: z.number().int() })),
      other_usd: usd,
      other_calls: z.number().int(),
      unpriced_calls: z.number().int(),
      overlap_usd: usd.nullable(),
      outside_units_usd: usd.nullable(),
    }),
  ),
  other: z.looseObject({ cost_usd: usd, calls: z.number().int(), contributors: z.number().int() }),
  overlap: z
    .looseObject({ cost_usd: usd, people: z.number().int(), outside_units_usd: usd })
    .nullable(),
})
export type Breakdown = z.infer<typeof breakdownSchema>
export const breakdownResponseSchema = one(breakdownSchema)

const changesSchema = z.looseObject({
  by: dimensionSchema,
  as_of: iso,
  covers: coversSchema,
  from: iso,
  to: iso,
  compare_from: iso,
  compare_to: iso,
  unpriced_calls: z.number().int(),
  compare_unpriced_calls: z.number().int(),
  truncated: z.boolean(),
  items: z.array(
    z.looseObject({
      key: z.string(),
      label: z.string(),
      redacted: z.boolean(),
      cost_usd: usd,
      compare_cost_usd: usd,
      delta_usd: usd,
      delta_pct: z.number().nullable(),
    }),
  ),
})
export type Changes = z.infer<typeof changesSchema>
export const changesResponseSchema = one(changesSchema)

const hoursSchema = z.looseObject({
  date: day,
  as_of: iso,
  covers: coversSchema,
  hours: z.array(
    z.looseObject({
      hour: z.number().int().min(0).max(23),
      cost_usd: usd,
      calls: z.number().int(),
      unpriced_calls: z.number().int(),
    }),
  ),
})
export type Hours = z.infer<typeof hoursSchema>
export const hoursResponseSchema = one(hoursSchema)

const traceRowSchema = z.looseObject({
  row_id: z.string(),
  as_of: iso,
  covers: coversSchema,
  redacted: z.boolean(),
  trace_id: z.string().nullable(),
  session_id: z.string().nullable(),
  agent_id: uuid.nullable(),
  agent_label: z.string().nullable(),
  user_id: uuid.nullable(),
  user_label: z.string().nullable(),
  cost_usd: usd,
  calls: z.number().int(),
  unpriced_calls: z.number().int(),
  started_at: iso,
})
export type TraceRow = z.infer<typeof traceRowSchema>
export const traceListSchema = list(traceRowSchema)

const dayCost = z.looseObject({ date: day, cost_usd: usd })
const statusRowSchema = z.looseObject({
  budget_id: uuid,
  scope: scopeSchema,
  label: z.string(),
  covers: coversSchema,
  action: actionSchema,
  version: z.number().int(),
  limit_usd: usd,
  period_start: iso,
  resets_at: iso.nullable(),
  as_of: iso,
  used_usd: usd,
  unpriced_calls: z.number().int(),
  state: stateSchema,
  crossed: z.number().int().nullable(),
  stopped: z.boolean(),
  limits_inside_usd: usd.nullable(),
  limits_inside_count: z.number().int().nullable(),
  daily: z.array(dayCost),
})
export type StatusRow = z.infer<typeof statusRowSchema>
export const statusListSchema = list(statusRowSchema).extend({
  covers: z.literal('routed_calls').optional(),
})

const atRiskRowSchema = z.looseObject({
  budget_id: uuid,
  scope: scopeSchema,
  target_id: z.string().nullable(),
  label: z.string(),
  owner_id: uuid.nullable(),
  owner_label: z.string().nullable(),
  covers: coversSchema,
  action: actionSchema,
  period: z.enum(['month', 'quarter', 'session']),
  period_start: iso,
  resets_at: iso.nullable(),
  as_of: iso,
  limit_usd: usd,
  used_usd: usd,
  unpriced_calls: z.number().int(),
  state: stateSchema,
  crossed: z.number().int().nullable(),
  stopped: z.boolean(),
  daily14: z.array(dayCost),
  rank: z.looseObject({
    reason: z.enum(['exceeded', 'runs_out', 'warning']),
    runs_out_on: day.nullable(),
    pace_usd_per_day: usd.nullable(),
    projected_pct: z.number().nullable(),
  }),
})
export type AtRiskRow = z.infer<typeof atRiskRowSchema>
export const atRiskListSchema = list(atRiskRowSchema)

const unbudgetedRowSchema = z.looseObject({
  agent_id: uuid,
  label: z.string(),
  owner_id: uuid,
  owner_label: z.string(),
  as_of: iso,
  harness: z.boolean(),
  used_usd: usd,
  routed_usd: usd,
  traced_usd: usd,
  harness_estimate_usd: usd,
  routed_calls: z.number().int(),
  unpriced_calls: z.number().int(),
})
export type UnbudgetedRow = z.infer<typeof unbudgetedRowSchema>
export const unbudgetedListSchema = list(unbudgetedRowSchema)

const alertV1Schema = z.looseObject({
  id: z.string(),
  budget_id: uuid,
  label: z.string(),
  scope: scopeSchema,
  kind: kindOf(['threshold', 'forecast', 'forecast_cleared'] as const),
  percent: z.number().int(),
  threshold: z.number().int().nullable(),
  version: z.number().int(),
  amount_usd: usd,
  at: iso,
  crosses_on: day.nullable(),
  stopped: z.boolean(),
})
export type AlertV1 = z.infer<typeof alertV1Schema>
export const alertListSchema = list(alertV1Schema)

export const priceListSchema = list(
  z.looseObject({
    provider: z.string(),
    model: z.string(),
    input_per_mtok_usd: usd,
    output_per_mtok_usd: usd,
    cache_read_per_mtok_usd: usd.nullable(),
    cache_creation_per_mtok_usd: usd.nullable(),
    effective_from: iso,
  }),
)
export type Price = z.infer<typeof priceListSchema>['data'][number]

/** The 1.0 error body (API_CONVENTIONS §2). */
export const budgetErrorBodySchema = z.looseObject({ error: z.string(), code: z.string() })
