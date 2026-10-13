// @vitest-environment node
// What's causing the burn (plan feat-budget-burn F3), pure, on the golden world (budgets.md §14): dimensions per
// scope, bars stacked from the breakdown, a contributor's line and burn, What changed's ranges and rows.
import { describe, expect, it } from 'vitest'
import {
  breakdown as engineBreakdown,
  burn as engineBurn,
  changes as engineChanges,
  worldFromScenario,
  type Viewer,
} from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { chartModel, projection } from './burn'
import {
  changeRows,
  changesWindow,
  contributorBurn,
  dimensionsFor,
  keyLabel,
  pickDimension,
  shareLine,
  stackBars,
} from './causes'
import { burnChartData } from './chartData'
import { copy } from './copy'

const NOW = Date.parse(GOLDEN_ANCHOR)
const admin: Viewer = { id: 'admin', superuser: true }
const world = () => worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' })
const read = (scope: string, id: string | null, extra: Record<string, string> = {}) =>
  engineBurn(world(), admin, { scope, id, include_previous: 'true', ...extra }, NOW)

describe('dimensions (F3)', () => {
  it('fleet by agent, owner or source; an owner adds model and operation; a bad ?by= falls back', () => {
    expect(dimensionsFor('org')).toEqual(['agent', 'owner', 'source'])
    expect(dimensionsFor('owner')).toContain('model')
    expect(pickDimension('org', 'model')).toBe('agent')
    expect(pickDimension('org', 'owner')).toBe('owner')
  })
})

describe('stacked bars', () => {
  it('each day’s parts add up to that day’s bar; Other only when it holds anything', () => {
    const b = read('org', null)
    const br = engineBreakdown(
      world(),
      admin,
      { scope: 'org', id: null, by: 'agent', top: '2' },
      NOW,
    )
    const data = stackBars(burnChartData(chartModel(b, 'down')), br)
    expect(data.stack?.map((s) => s.key)).toEqual([...br.keys.map((k) => k.key), 'other'])
    for (const bar of data.bars.filter((x) => x.parts)) {
      const sum = (bar.parts ?? []).reduce((s, p) => s + p.v, 0)
      expect(sum).toBeCloseTo(bar.v, 6)
    }
  })

  it('a redacted contributor reads “Another user’s session”, whatever its label', () => {
    expect(keyLabel({ label: 'Fin’s chat', redacted: true })).toBe(copy.causesRedacted)
    expect(keyLabel({ label: 'Pricing Engine', redacted: false })).toBe('Pricing Engine')
  })
})

describe('a picked contributor (design 3B)', () => {
  it('its line climbs to its spend; as a burn it projects on its own pace', () => {
    const b = read('org', null, { contributor: I.reviewer, by: 'agent' })
    const line = shareLine(b)
    expect(line[0]).toEqual({ t: Date.parse(b.period_start), v: 0 })
    expect(line.at(-1)!.v).toBeCloseTo(b.contributor!.used_usd, 6)
    const c = contributorBurn(b)!
    expect(c.budget).toBeNull()
    expect(c.used_usd).toBe(b.contributor!.used_usd)
    expect(projection(c)).not.toBeNull()
  })
})

describe('What changed', () => {
  it('this week since Monday 00:00 UTC vs the same hours a week earlier; nothing on Monday at midnight', () => {
    expect(changesWindow(read('org', null))).toEqual({
      from: '2026-10-12T00:00:00Z',
      to: '2026-10-14T12:00:00Z',
      compareFrom: '2026-10-05T00:00:00Z',
      compareTo: '2026-10-07T12:00:00Z',
    })
    expect(changesWindow({ ...read('org', null), as_of: '2026-10-12T00:00:00Z' })).toBeNull()
  })

  it('rows keep the server’s order and drop contributors that didn’t change', () => {
    const w = changesWindow(read('org', null))!
    const c = engineChanges(
      world(),
      admin,
      {
        scope: 'org',
        id: null,
        by: 'agent',
        from: w.from,
        to: w.to,
        compare_from: w.compareFrom,
        compare_to: w.compareTo,
      },
      NOW,
    )
    const rows = changeRows(c)
    expect(rows.map((r) => r.key)).toEqual(
      c.items.filter((i) => i.delta_usd !== 0).map((i) => i.key),
    )
    expect(rows.every((r) => r.delta !== 0)).toBe(true)
  })
})
