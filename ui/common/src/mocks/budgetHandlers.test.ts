// The budgets mock's routes (plan feat-budget-burn B0): every 1.0 route answers through MSW with a body the UI's zod
// schema accepts, in the golden world and in the default one, and the availability variants answer as F11 expects.
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  alertListSchema,
  atRiskListSchema,
  breakdownResponseSchema,
  budgetErrorBodySchema,
  budgetListSchema,
  budgetResponseSchema,
  budgetSettingsSchema,
  burnResponseSchema,
  capabilitiesSchema,
  changesResponseSchema,
  hoursResponseSchema,
  priceListSchema,
  statusListSchema,
  traceListSchema,
  unbudgetedListSchema,
  versionListSchema,
} from '@/features/budgets/types'
import { configureMocks } from './handlers'
import { GOLDEN_ANCHOR, SCENARIO_IDS as I } from './seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'

setupPinnedSeed()
afterEach(() => configureMocks({ seed, now, loggedIn: true, superuser: null, budgetVariants: [] }))

const get = async (path: string) => {
  const r = await fetch(new URL(path, globalThis.location.origin))
  const text = await r.text()
  return { status: r.status, text, body: text ? (JSON.parse(text) as unknown) : null }
}
const golden = () =>
  configureMocks({ now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] })

const ROUTES: [string, z.ZodType][] = [
  ['/api/budgets/capabilities', capabilitiesSchema],
  ['/api/budgets/settings', budgetSettingsSchema],
  ['/api/budgets/prices', priceListSchema],
  ['/api/budgets?scope=org', budgetListSchema],
  [`/api/budgets/${I.bReview}`, budgetResponseSchema],
  [`/api/budgets/${I.bReview}/versions`, versionListSchema],
  ['/api/budgets/burn?scope=org&include_previous=true', burnResponseSchema],
  [
    `/api/budgets/burn?scope=agent&id=${I.reviewer}&contributor=openai/gpt-4.1&by=model`,
    burnResponseSchema,
  ],
  [`/api/budgets/burn?scope=session&id=${I.s1}`, burnResponseSchema],
  [`/api/budgets/burn?scope=unit&id=${I.platform}&period=quarter`, burnResponseSchema],
  ['/api/budgets/burn/breakdown?scope=org&by=unit', breakdownResponseSchema],
  ['/api/budgets/burn/breakdown?scope=org&by=model', breakdownResponseSchema],
  [
    '/api/budgets/burn/changes?scope=org&by=agent&from=2026-10-12T00:00:00Z&to=2026-10-14T12:00:00Z&compare_from=2026-10-05T00:00:00Z&compare_to=2026-10-07T12:00:00Z',
    changesResponseSchema,
  ],
  ['/api/budgets/burn/hours?scope=org&date=2026-10-14', hoursResponseSchema],
  [`/api/budgets/burn/traces?scope=agent&id=${I.reviewer}&date=2026-10-09`, traceListSchema],
  ['/api/budgets/status?scope=org', statusListSchema],
  ['/api/budgets/at-risk?scope=org', atRiskListSchema],
  ['/api/budgets/unbudgeted?scope=org', unbudgetedListSchema],
  ['/api/budgets/alerts?scope=org&kind=all', alertListSchema],
]

describe('golden world: every route parses', () => {
  it.each(ROUTES)('%s', async (path, schema) => {
    golden()
    const r = await get(path)
    expect(r.status).toBe(200)
    const p = schema.safeParse(r.body)
    expect(p.success ? [] : p.error.issues).toEqual([])
  })

  it('a member reading the fleet gets the coded 404', async () => {
    golden()
    configureMocks({ superuser: false })
    const r = await get('/api/budgets/burn?scope=org')
    expect(r.status).toBe(404)
    expect(budgetErrorBodySchema.parse(r.body)).toEqual({
      error: 'not found',
      code: 'scope_not_found',
    })
  })
})

describe('default world (the app seed)', () => {
  it('R-L10’s routes answer 1.0 shapes; the fleet burn and at risk answer too', async () => {
    for (const [path, schema] of [
      ['/api/budgets', budgetListSchema],
      ['/api/budgets/status', statusListSchema],
      ['/api/budgets/alerts', alertListSchema],
      ['/api/budgets/burn?scope=org', burnResponseSchema],
      ['/api/budgets/at-risk?scope=org', atRiskListSchema],
    ] as const) {
      const r = await get(path)
      expect(r.status, path).toBe(200)
      const p = schema.safeParse(r.body)
      expect(p.success ? [] : p.error.issues, path).toEqual([])
    }
  })
})

describe('availability variants (F11)', () => {
  it('budgets-absent: a bare 404 on every budgets route', async () => {
    configureMocks({ budgetVariants: ['budgets-absent'] })
    for (const path of [
      '/api/budgets',
      '/api/budgets/status',
      '/api/budgets/capabilities',
      '/api/budgets/burn?scope=org',
    ]) {
      const r = await get(path)
      expect([r.status, r.text], path).toEqual([404, ''])
    }
  })

  it('budgets-rl10-only: R-L10 answers, every 1.0 route is a bare 404', async () => {
    configureMocks({ budgetVariants: ['budgets-rl10-only'] })
    expect((await get('/api/budgets')).status).toBe(200)
    expect((await get('/api/budgets/status')).status).toBe(200)
    for (const path of [
      '/api/budgets/capabilities',
      '/api/budgets/burn?scope=org',
      '/api/budgets/at-risk?scope=org',
    ]) {
      const r = await get(path)
      expect([r.status, r.text], path).toEqual([404, ''])
    }
  })

  it('budgets-fail: reads answer the coded 500', async () => {
    configureMocks({ budgetVariants: ['budgets-fail'] })
    const r = await get('/api/budgets/burn?scope=org')
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'internal error', code: 'internal' })
  })
})
