// @vitest-environment node
// Unit-lead writes (plans/feat-budget-burn.md §7 Q4, answered 2026-10-13; budgets.md §5, §6.8): an org setting, off by
// default; EE only (OSS refuses the field); while on, a unit lead writes the units they lead, and still nothing else.
import { describe, expect, it } from 'vitest'
import { createBudget, settingsView, updateSettings, worldFromScenario } from './budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from './seed-budgets'

const NOW = Date.parse(GOLDEN_ANCHOR)
const admin = { id: 'admin', superuser: true }
const world = (edition: 'oss' | 'ee') =>
  worldFromScenario(budgetScenario(), { adminId: 'admin', edition })
const codeOf = (f: () => unknown) => {
  try {
    f()
    return 'ok'
  } catch (e) {
    return (e as { body?: { code?: string } }).body?.code ?? String(e)
  }
}

describe('unit_leads_write', () => {
  it('EE shows it off by default; OSS has no such field and refuses it', () => {
    expect(settingsView(world('ee'))).toMatchObject({ unit_leads_write: false })
    const oss = world('oss')
    expect(settingsView(oss)).not.toHaveProperty('unit_leads_write')
    const at = settingsView(oss).updated_at
    expect(
      codeOf(() =>
        updateSettings(oss, admin, { unit_leads_write: true, expected_updated_at: at }, NOW),
      ),
    ).toBe('not_available')
  })

  it('a lead writes a unit they lead only while it is on; never one they don’t', () => {
    const w = world('ee')
    // Dev leads Platform (a unit lead is a manager named as its lead, §5); Growth is someone else's.
    const lead = w.units.find((u) => u.id === I.platform)!
    const other = w.units.find((u) => u.id === I.growth)!
    lead.lead_id = I.dev
    w.users = w.users.map((u) => (u.id === I.dev ? { ...u, role: 'manager' as const } : u))
    const v = { id: I.dev, superuser: false }
    // The golden scenario's units have budgets already: delete-free check through a fresh create on a unit with none.
    w.budgets = w.budgets.filter((b) => b.scope !== 'unit')
    const create = (unit: string) => () =>
      createBudget(w, v, { scope: 'unit', unit_id: unit, limit_usd: 10, action: 'alert' }, NOW)
    expect(codeOf(create(lead.id))).toBe('not_allowed')
    updateSettings(
      w,
      admin,
      { unit_leads_write: true, expected_updated_at: settingsView(w).updated_at },
      NOW,
    )
    expect(codeOf(create(lead.id))).toBe('ok')
    expect(codeOf(create(other.id))).not.toBe('ok')
    // Never the fleet, which a lead can't even read (404 before 403, §5).
    expect(
      codeOf(() => createBudget(w, v, { scope: 'org', limit_usd: 10, action: 'alert' }, NOW)),
    ).toBe('scope_not_found')
  })
})
