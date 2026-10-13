// `contract:check -- --only budgets` (scripts/lib/budgetCheck.ts, docs/requirements/budgets.md §15) against the
// budgets mock: the golden world passes every route; an R-L10-only server reads as unavailable, not failed; a broken
// server fails with the first mismatch.
import { afterEach, describe, expect, it } from 'vitest'
import { checkBudgets, judge, report } from '../../../../scripts/lib/budgetCheck.ts'
import { capabilitiesSchema } from '@/features/budgets/types'
import { configureMocks } from '@/mocks/handlers'
import { GOLDEN_ANCHOR } from '@/mocks/seed-budgets'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'

setupPinnedSeed()
afterEach(() => configureMocks({ seed, now, loggedIn: true, budgetVariants: [] }))

const get = async (path: string) => {
  const r = await fetch(new URL(path, globalThis.location.origin))
  const text = await r.text()
  return { status: r.status, body: text ? (JSON.parse(text) as unknown) : null }
}

describe('contract:check budgets', () => {
  it('a server with the whole contract passes every route, exit 0', async () => {
    configureMocks({ now: () => Date.parse(GOLDEN_ANCHOR), budgetVariants: ['budgets-golden'] })
    const r = await checkBudgets(get)
    expect(r.verdicts.filter((v) => v.result !== 'pass')).toEqual([])
    expect(r.code).toBe(0)
    expect(report(r)).toContain('0 fail, 0 unavailable')
  })

  it('an R-L10-only server: the 1.0 routes are unavailable, R-L10’s pass, and nothing listed is missing (exit 0)', async () => {
    configureMocks({ budgetVariants: ['budgets-rl10-only'] })
    const r = await checkBudgets(get)
    expect(r.listed).toBeNull()
    expect(
      r.verdicts.filter((v) => v.feature === 'budgets').every((v) => v.result === 'pass'),
    ).toBe(true)
    expect(r.verdicts.find((v) => v.feature === 'burn')!.result).toBe('unavailable')
    expect(r.code).toBe(0)
  })

  it('a listed capability with a missing route, or any mismatch, exits 1', async () => {
    const get2 = async (path: string) =>
      path === '/api/budgets/capabilities'
        ? { status: 200, body: { data: { version: '1.0', features: ['burn'] } } }
        : { status: 404, body: null }
    expect((await checkBudgets(get2)).code).toBe(1)
    expect(
      judge('capabilities', '/x', 200, { data: { version: 1 } }, capabilitiesSchema),
    ).toMatchObject({
      result: 'fail',
      detail: expect.stringContaining('$.data.version'),
    })
    expect(
      judge('x', '/x', 404, { error: 'not found', code: 'scope_not_found' }, capabilitiesSchema)
        .result,
    ).toBe('fail')
  })

  it('a malformed as_of fails its own route, never the run; a listed fiscal_year needs the settings route', async () => {
    const odd = async (path: string) =>
      path === '/api/budgets/capabilities'
        ? { status: 200, body: { data: { version: '1.0', features: ['fiscal_year'] } } }
        : path.startsWith('/api/budgets/burn?scope=org')
          ? { status: 200, body: { data: { as_of: 'not-a-date' } } }
          : { status: 404, body: null }
    const r = await checkBudgets(odd)
    expect(r.verdicts.find((v) => v.feature === 'fiscal_year')!.result).toBe('unavailable')
    expect(r.code).toBe(1)
  })
})
