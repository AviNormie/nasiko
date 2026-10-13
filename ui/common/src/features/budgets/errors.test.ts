// Budget errors (R-L10's fixed messages), moved from the router's error table (plan feat-budget-burn eng D1).
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api/client'
import { copy } from './copy'
import { budgetError } from './errors'

const e = (status: number, body: unknown) => new ApiError(status, body, '/api/x', 'x')

describe('budgetError', () => {
  it.each([
    // Matched before the router's config name rule ("already exists").
    [409, 'budget already exists for this scope', 'This scope already has a budget.', undefined],
    [409, 'budget changed elsewhere', copy.budgetChanged, undefined],
    [400, 'limit_usd must be greater than 0', copy.limitPositive, 'limit'],
    [400, 'thresholds must be whole percents from 1 to 100', copy.thresholdRange, 'thresholds'],
  ])('maps %i "%s"', (status, text, problem, field) => {
    const v = budgetError(e(status, text))
    expect(v.problem).toBe(problem)
    expect(v.field).toBe(field)
  })

  it('reads the 1.0 contract’s JSON error body the same way', () => {
    const v = budgetError(e(409, { error: 'budget changed elsewhere', code: 'budget_changed' }))
    expect(v.problem).toBe(copy.budgetChanged)
  })

  it('anything else maps as the router maps it', () => {
    expect(budgetError(e(418, 'teapot')).problem).toBe('OpenRuntime said: teapot (HTTP 418)')
  })
})
