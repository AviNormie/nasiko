/**
 * Budget errors (R-L10's fixed messages, docs/requirements/budgets.md §13): matched first, then anything else maps as
 * the router maps it. Moved from the router (eng D1); the 1.0 contract's `code`s join them in B0.
 */
import { routerError, type ErrorView } from '@/features/router/errors'
import { ApiError } from '@/lib/api/client'
import { copy } from './copy'

type Rule = { status: number; match: RegExp; view: () => ErrorView }

const RULES: Rule[] = [
  { status: 409, match: /budget changed elsewhere/, view: () => ({ problem: copy.budgetChanged }) },
  {
    status: 409,
    match: /budget already exists/,
    view: () => ({
      problem: 'This scope already has a budget.',
      action: 'Edit that budget instead.',
    }),
  },
  {
    status: 400,
    match: /session has ended/,
    view: () => ({ problem: copy.sessionEnded, action: copy.sessionEndedAction }),
  },
  {
    status: 400,
    match: /limit_usd/,
    view: () => ({ problem: copy.limitPositive, field: 'limit' }),
  },
  {
    status: 400,
    match: /thresholds must/,
    view: () => ({ problem: copy.thresholdRange, field: 'thresholds' }),
  },
]

export function budgetError(err: unknown): ErrorView {
  if (err instanceof ApiError) {
    const msg = err.serverMessage ?? ''
    const r = RULES.find((x) => x.status === err.status && x.match.test(msg))
    if (r) return r.view()
  }
  return routerError(err)
}
