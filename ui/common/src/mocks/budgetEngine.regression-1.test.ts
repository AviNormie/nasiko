// @vitest-environment node
// Regressions from the B0 /review (Claude adversarial + Codex, 2026-10-13): each was a departure from
// docs/requirements/budgets.md 1.0 in the mock engine. One test per finding.
import { describe, expect, it } from 'vitest'
import {
  alertsList,
  atRisk,
  burn,
  changes,
  createBudget,
  deleteBudget,
  statusList,
  updateBudget,
  updateSettings,
  worldFromScenario,
  type Viewer,
  type World,
} from './budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from './seed-budgets'

const NOW = Date.parse(GOLDEN_ANCHOR)
const DAY = 86_400_000
const ADMIN = '5eed0017-0000-4000-8000-000000000000'
const fresh = (): World => worldFromScenario(budgetScenario(), { adminId: ADMIN, edition: 'ee' })
const admin: Viewer = { id: ADMIN, superuser: true }
const q = (scope: string, id: string | null = null) => ({ scope, id })
const review = (w: World) => w.budgets.find((b) => b.id === I.bReview)!

describe('B0 review regressions', () => {
  it('a flat pace is no projection: at risk sends no pace, and a fired forecast never clears on its own', () => {
    // Pricing Engine stops spending after Oct 14: by Nov 1 the pace is 0 for days, never "projected under".
    const w = fresh()
    const rows = alertsList(
      w,
      admin,
      { ...q('agent', I.pricing), kind: 'all' },
      NOW + 10 * DAY,
    ).data
    expect(rows.filter((a) => a.kind === 'forecast_cleared')).toEqual([])
    const r = atRisk(w, admin, q('org'), NOW + 10 * DAY).data.find((x) => x.budget_id === I.bPrice)
    if (r) expect(r.rank.pace_usd_per_day).toBeNull()
  })

  it('changes by=unit compares the listed units only (the org’s root units), never ancestors', () => {
    const c = changes(
      fresh(),
      admin,
      {
        ...q('org'),
        by: 'unit',
        from: '2026-10-12T00:00:00Z',
        to: '2026-10-14T12:00:00Z',
        compare_from: '2026-10-05T00:00:00Z',
        compare_to: '2026-10-07T12:00:00Z',
      },
      NOW,
    )
    expect(c.items.map((i) => i.label).sort()).toEqual(['Growth', 'Platform'])
  })

  it('a scheduled period change stays a record after it is replaced, and after it takes effect', () => {
    const w = fresh()
    const b = () => statusList(w, admin, q('agent', I.pricing), NOW).data[0]!
    updateBudget(
      w,
      admin,
      I.bPrice,
      {
        limit_usd: 100,
        thresholds: [50, 80, 100],
        action: 'alert',
        period: 'quarter',
        expected_updated_at: '2026-10-01T00:00:00Z',
      },
      NOW,
    )
    const at = new Date(w.budgets.find((x) => x.id === I.bPrice)!.updated_at)
      .toISOString()
      .replace('.000Z', 'Z')
    updateBudget(
      w,
      admin,
      I.bPrice,
      {
        limit_usd: 100,
        thresholds: [50, 80, 100],
        action: 'alert',
        period: 'month',
        expected_updated_at: at,
      },
      NOW + 1000,
    )
    const events = burn(w, admin, q('agent', I.pricing), NOW + 2000).events.filter(
      (e) => e.kind === 'period_change_scheduled',
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ period: 'quarter', effective_from: '2027-01-01T00:00:00Z' })
    expect(b().budget_id).toBe(I.bPrice)
  })

  it('a fiscal year change applies from the next quarter start: the current quarter keeps its bounds', () => {
    const w = fresh()
    updateSettings(
      w,
      admin,
      {
        fiscal_year_first_month: 2,
        expected_updated_at: new Date(w.settings.updated_at).toISOString().replace('.000Z', 'Z'),
      },
      NOW,
    )
    expect(burn(w, admin, q('unit', I.growth), NOW)).toMatchObject({
      period_start: '2026-10-01T00:00:00Z',
      resets_at: '2027-01-01T00:00:00Z',
      used_usd: 24,
    })
    expect(
      burn(w, admin, q('unit', I.growth), NOW + 1000).events.find(
        (e) => e.kind === 'fiscal_year_changed',
      ),
    ).toMatchObject({
      effective_from: '2027-01-01T00:00:00Z',
    })
  })

  it('in the golden world a write shows at once in status and burn', () => {
    const w = fresh()
    updateBudget(
      w,
      admin,
      I.bPrice,
      {
        limit_usd: 500,
        thresholds: [50, 80, 100],
        action: 'alert',
        expected_updated_at: '2026-10-01T00:00:00Z',
      },
      NOW,
    )
    expect(statusList(w, admin, q('agent', I.pricing), NOW).data[0]).toMatchObject({
      limit_usd: 500,
      state: 'ok',
    })
  })

  it('a month budget read with period=quarter keeps its monthly periods (and its own spend this month)', () => {
    const nov14 = Date.UTC(2026, 10, 14, 12)
    const b = burn(fresh(), admin, { ...q('agent', I.pricing), period: 'quarter' }, nov14)
    expect(b.period).toBe('month')
    expect(b.from).toBe('2026-10-01')
    expect(b.periods.map((p) => [p.period_start.slice(0, 10), p.used_usd])).toEqual([
      ['2026-10-01', 81],
      ['2026-11-01', 0],
    ])
    expect(b.used_usd).toBe(0)
  })

  it('a stopped budget resumes at the next period start, even with no call after it', () => {
    const b = burn(
      fresh(),
      admin,
      { ...q('agent', I.reviewer), from: '2026-10-01' },
      Date.UTC(2026, 10, 3),
    )
    expect(b.events.filter((e) => e.kind === 'resumed').map((e) => e.at)).toContain(
      '2026-11-01T00:00:00Z',
    )
  })

  it('a unit lead must be a manager; finance writes nothing', () => {
    const w = fresh()
    w.units.find((u) => u.id === I.platform)!.lead_id = I.dev
    const dev: Viewer = { id: I.dev, superuser: false }
    expect(() => burn(w, dev, q('session', I.s1), NOW)).toThrow('not found')
    w.users.find((u) => u.id === I.dev)!.role = 'manager'
    expect(burn(w, dev, q('unit', I.platform), NOW).used_usd).toBe(101)
    const fin: Viewer = { id: I.fin, superuser: false, finance: true }
    expect(() => createBudget(w, fin, { scope: 'owner', limit_usd: 5 }, NOW)).toThrow()
  })

  it('deleting a stop budget doesn’t bring back the calls it refused', () => {
    const w = fresh()
    // Refuse one more call: a $7 Code Reviewer call after the Oct 13 stop.
    w.calls.push({
      ...w.calls.find((c) => c.agent_id === I.reviewer)!,
      call_id: 'x-late',
      at: Date.UTC(2026, 9, 14, 9),
      u: 7e8,
    })
    w.calls.sort((a, b) => a.at - b.at || a.call_id.localeCompare(b.call_id))
    w.rev++
    expect(burn(w, admin, q('org'), NOW).used_usd).toBe(155)
    deleteBudget(w, admin, I.bReview, NOW)
    expect(burn(w, admin, q('org'), NOW).used_usd).toBe(155)
    expect(review(w).deleted_at).toBe(NOW)
  })
})
