/**
 * /budgets search keys (plan feat-budget-burn F10, F12, F3). Loads with the app shell: zod/mini and `lib/search` only.
 *
 * - `scope`: `fleet`, `yours`, `owner:<user id>` or (EE) `unit:<id>`; absent → the viewer's default.
 * - `period`: Month · Quarter (a month budget viewed by quarter reads from the quarter's first day).
 * - `burn`: Burndown · Burn-up; absent → the remembered choice, else Burndown (replaced, not pushed).
 * - `by`: the daily bars' contributor dimension; absent → the scope's default (F3).
 * - `day`: a picked day's drill-down (pushed). `contributor`: a picked contributor's share view, keyed under `by`.
 */
import { z } from 'zod/mini'
import { fallback, isoDate, opt, text } from '@/lib/search'

const BY = ['agent', 'owner', 'unit', 'model', 'operation', 'session', 'source'] as const

export const budgetsSearchSchema = z.object({
  scope: opt(text),
  period: fallback(z.enum(['month', 'quarter']), 'month'),
  burn: opt(z.enum(['down', 'up'])),
  by: opt(z.enum(BY)),
  day: opt(isoDate),
  contributor: opt(text),
  // Mock-only (read by the mock bootstrap from the URL): kept so `?mock=budgets-golden` survives validation.
  mock: opt(text),
})

export type BudgetsSearch = z.infer<typeof budgetsSearchSchema>
