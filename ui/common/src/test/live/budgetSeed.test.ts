// @vitest-environment node
// The budgets golden scenario as seed SQL (scripts/lib/budgetSeed.ts, docs/requirements/budgets.md §14.8): guarded,
// complete and reversible. (A throwaway Postgres run of the same SQL is the manual check; see the commit.)
import { describe, expect, it } from 'vitest'
import { BUDGET_RESET, budgetSeedSql } from '../../../../scripts/lib/budgetSeed.ts'
import { budgetScenario, SCENARIO_IDS } from '@/mocks/seed-budgets'

const ANCHOR = Date.parse('2026-10-14T12:00:00Z')
const sql = budgetSeedSql(ANCHOR).join('\n')

describe('budgets seed SQL', () => {
  it('only writes when the server has the budget tables, and reads the superuser after that check', () => {
    const guard = sql.indexOf("IF to_regclass('public.budget_calls') IS NULL THEN")
    expect(guard).toBeGreaterThan(-1)
    expect(sql.indexOf('admin_id := (SELECT id FROM users WHERE is_superuser')).toBeGreaterThan(
      guard,
    )
    expect(sql.indexOf('INSERT INTO budget_calls')).toBeGreaterThan(guard)
  })

  it('writes every call once (the dedupe call too), every budget version, and the router rows with their call ids', () => {
    const sc = budgetScenario(ANCHOR)
    for (const c of sc.calls)
      expect(sql.split(`'${c.call_id}'::uuid`).length - 1, c.call_id).toBe(1)
    expect(sql.match(new RegExp(SCENARIO_IDS.dedupeCall, 'g'))!.length).toBe(3) // budget_calls, token_usage, the summary line
    const versions = sc.budgets.reduce((n, b) => n + b.versions.length, 0)
    expect(versions).toBe(8)
    expect(sql).toContain(`'${SCENARIO_IDS.bReview}'::uuid, 2,`)
    const routed = sc.calls.filter((c) => c.source === 'routed').length
    expect(sql.split(`'{"key_source": "platform", "source": "router"}'::jsonb`).length - 1).toBe(
      routed,
    )
  })

  it('anchors at the given hour: the watermarks are the anchor', () => {
    expect(sql).toContain(`('routed', '2026-10-14T12:00:00.000Z'::timestamptz)`)
  })

  it('reset removes only 5eed0017 rows; a server’s own watermarks and instants are never overwritten or removed', () => {
    const reset = BUDGET_RESET.join('\n')
    for (const line of reset.split('\n').filter((l) => l.includes('DELETE FROM')))
      expect(line).toMatch(/5eed0017/)
    expect(reset).not.toMatch(/budget_meta|budget_watermarks/)
    expect(sql).not.toMatch(/\bDO UPDATE\b|\bUPDATE budget/)
  })
})
