// @vitest-environment node
// Levers (plan feat-budget-burn F4) on the golden world (budgets.md §14): which levers a budget gets, their estimates
// from its own data, the ranking, and the previews.
import { describe, expect, it } from 'vitest'
import {
  breakdown as engineBreakdown,
  burn as engineBurn,
  pricesList,
  worldFromScenario,
  type Viewer,
} from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { projection } from './burn'
import {
  leverList,
  leverPreview,
  modelsOf,
  paceAfter,
  routedPaceOf,
  topContributors,
  type LeverAgent,
} from './levers'

const NOW = Date.parse(GOLDEN_ANCHOR)
const admin: Viewer = { id: 'admin', superuser: true }
const world = () => worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' })
const read = (scope: string, id: string | null) =>
  engineBurn(world(), admin, { scope, id, include_previous: 'true' }, NOW)
const prices = pricesList(world()).data
const agent = (id: string, name: string, compressOn: boolean | null = false): LeverAgent => ({
  id,
  name,
  ownerId: I.dev,
  compressOn,
  routedPace: routedPaceOf(read('agent', id)),
  models: modelsOf(engineBreakdown(world(), admin, { scope: 'agent', id, by: 'model' }, NOW)),
})

describe('which budgets get levers', () => {
  it('no budget, too early, on track: none', () => {
    expect(
      leverList({ burn: read('owner', I.ana), agents: [], measured: null, prices }).state,
    ).toBe('no_budget')
    expect(leverList({ burn: read('org', null), agents: [], measured: null, prices }).state).toBe(
      'on_track',
    )
  })
})

describe('Pricing Engine: projected past its $100 (186%)', () => {
  const levers = () => {
    const l = leverList({
      burn: read('agent', I.pricing),
      agents: [agent(I.pricing, 'Pricing Engine')],
      measured: { pct: 20, agents: 3 },
      prices,
    })
    if (l.state !== 'levers') throw new Error(l.state)
    return l
  }

  it('reduce: the cheaper model, stop at the limit, token optimization, largest first', () => {
    const l = levers()
    expect(l.reduce.map((x) => x.kind)).toEqual(['model', 'stop', 'compression'])
    const model = l.reduce[0]!
    if (model.kind !== 'model') throw new Error()
    // gpt-4o → gpt-4o-mini on 6.48M in / 6.48M out over 13.5 days, 17.5 days left.
    expect(model.to.model).toBe('gpt-4o-mini')
    expect(model.estimate).toBeCloseTo((6.48 * (2.35 + 9.4) * 17.5) / 13.5, 6)
    expect(l.reduce[1]).toMatchObject({ kind: 'stop', estimate: 86, immediate: false })
    // 20% of its $6 a day routed pace for 17.5 days.
    expect(l.reduce[2]).toMatchObject({ kind: 'compression', basisAgents: 3 })
    expect(l.reduce[2]!.estimate).toBeCloseTo(6 * 17.5 * 0.2, 6)
  })

  it('adjust: raise to where the projection lands, with the share already used', () => {
    expect(levers().adjust).toEqual([
      { kind: 'raise', id: 'raise', limit: 186, usedPct: (81 / 186) * 100 },
    ])
  })

  it('no measurement: token optimization is listed without a number; already on: not offered', () => {
    const noMeasure = leverList({
      burn: read('agent', I.pricing),
      agents: [agent(I.pricing, 'Pricing Engine')],
      measured: null,
      prices,
    })
    if (noMeasure.state !== 'levers') throw new Error()
    expect(noMeasure.reduce.find((x) => x.kind === 'compression')?.estimate).toBeNull()
    const on = leverList({
      burn: read('agent', I.pricing),
      agents: [agent(I.pricing, 'Pricing Engine', true)],
      measured: { pct: 20, agents: 3 },
      prices,
    })
    if (on.state !== 'levers') throw new Error()
    expect(on.reduce.some((x) => x.kind === 'compression')).toBe(false)
  })
})

describe('a stop budget that ran out', () => {
  it('Code Reviewer: no stop lever (it already stops), raise still offered', () => {
    const l = leverList({ burn: read('agent', I.reviewer), agents: [], measured: null, prices })
    if (l.state !== 'levers') throw new Error(l.state)
    expect(l.reduce.some((x) => x.kind === 'stop')).toBe(false)
    expect(l.adjust[0]?.kind).toBe('raise')
  })
})

describe('previews', () => {
  it('stop: climbs to the limit at the run-out, then flat to the reset', () => {
    const b = read('agent', I.pricing)
    const p = leverPreview(b, 'up', { kind: 'stop', id: 'stop', estimate: 86, immediate: false })!
    expect(p.projected).toBe(100)
    expect(p.line.at(-1)).toEqual({ t: Date.UTC(2026, 10, 1), v: 100 })
    expect(p.line[1]).toEqual({ t: Date.UTC(2026, 9, 17, 16), v: 100 })
  })

  it('a reduce lever lowers the pace by its estimate over the days left', () => {
    const b = read('agent', I.pricing)
    const p = projection(b)!
    expect(paceAfter(p, 35)).toBeCloseTo(6 - 2, 10)
    expect(paceAfter(p, 1e6)).toBe(0)
    const prev = leverPreview(b, 'up', {
      kind: 'compression',
      id: 'c',
      agent: agent(I.pricing, 'Pricing Engine'),
      estimate: 35,
      basisAgents: 3,
    })!
    expect(prev.projected).toBeCloseTo(81 + 4 * 17.5, 10)
  })

  it('raise keeps the pace and moves the limit', () => {
    const b = read('agent', I.pricing)
    expect(
      leverPreview(b, 'down', { kind: 'raise', id: 'raise', limit: 186, usedPct: 43 }),
    ).toMatchObject({
      projected: 186,
      limit: 186,
    })
  })
})

describe('inputs', () => {
  it('top contributors are the fastest spenders, three at most, nothing at $0', () => {
    expect(
      topContributors([
        { id: 'a', pace: 1 },
        { id: 'b', pace: 5 },
        { id: 'c', pace: 0 },
        { id: 'd', pace: 3 },
        { id: 'e', pace: 2 },
      ]).map((x) => x.id),
    ).toEqual(['b', 'd', 'e'])
  })

  it('an agent’s routed pace needs 3 complete days', () => {
    expect(routedPaceOf(read('agent', I.pricing))).toBe(6)
  })
})
