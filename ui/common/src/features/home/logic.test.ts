/**
 * The home's pure rules (plans/feat-agent-centric.md PR2a; eng `resolveScope` truth table, "Fleet roll-up honesty").
 */
import { describe, expect, it } from 'vitest'
import { homeNarrative } from '@/features/narrative/home'
import { homeScopeFor } from '@/features/onboarding/logic'
import { PERSONAS } from '@/features/onboarding/types'
import type { AgentHealth } from '@/features/overview/health'
import { buildRows, DEFAULT_SORT, needsByAgent, sortRows, totals, type HomeAgent } from './rows'
import { rememberScope, resolveScope, storedScope } from './scope'

describe('scope', () => {
  it('maps all nine personas, and no persona by role', () => {
    const fleet = PERSONAS.filter((p) => homeScopeFor(p, false) === 'fleet')
    expect(fleet).toEqual([
      'platform_engineer',
      'finance',
      'engineering_manager',
      'sre',
      'leadership',
    ])
    expect(homeScopeFor('developer', true)).toBe('yours')
    expect(homeScopeFor(null, false)).toBe('yours')
    expect(homeScopeFor(null, true)).toBe('fleet')
  })

  it.each([
    // url, stored, persona, interacted → scope, replace
    ['yours', 'fleet', 'fleet', false, 'yours', null],
    [undefined, 'yours', 'fleet', false, 'yours', null],
    [undefined, null, null, false, null, null],
    [undefined, null, 'yours', false, 'yours', null],
    [undefined, null, 'fleet', false, 'fleet', 'fleet'],
    [undefined, null, 'fleet', true, 'fleet', null],
  ] as const)(
    'url %s, stored %s, persona %s, interacted %s → %s (replace %s)',
    (url, stored, persona, interacted, scope, replace) => {
      expect(resolveScope({ url, stored, persona, interacted })).toEqual({ scope, replace })
    },
  )

  it('remembers the last choice per user', () => {
    expect(storedScope('u1')).toBeNull()
    rememberScope('u1', 'fleet')
    expect(storedScope('u1')).toBe('fleet')
    expect(storedScope('u2')).toBeNull()
  })
})

const agent = (id: string, over: Partial<HomeAgent> = {}): HomeAgent => ({
  id,
  name: id,
  displayName: id.toUpperCase(),
  ownerId: 'me',
  harness: false,
  status: 'running',
  ...over,
})
const rated = (id: string, rating: AgentHealth['rating']): AgentHealth => ({
  id,
  name: id,
  rating,
  reasons: [],
})

describe('rows', () => {
  const agents = [agent('a'), agent('b', { ownerId: 'other' }), agent('h', { harness: true })]
  const base = {
    agents,
    meSub: 'me',
    spend: new Map([['a', { cost: 5, operations: 10 }]]),
    saved: new Map([['a', { tokens: 100, basis: 'measured' }]]),
    ratings: new Map([['a', rated('a', 'healthy')]]),
    needs: new Map([['b', 2]]),
  }

  it('Yours keeps what the viewer owns; Fleet everything visible', () => {
    expect(buildRows({ ...base, scope: 'yours' }).map((r) => r.id)).toEqual(['a', 'h'])
    expect(buildRows({ ...base, scope: 'fleet' }).map((r) => r.id)).toEqual(['a', 'b', 'h'])
  })

  it('a loaded dashboard without a row is a real zero; an unloaded one is unknown', () => {
    const loaded = buildRows({ ...base, scope: 'fleet' })
    expect(loaded.find((r) => r.id === 'b')?.spend).toBe(0)
    const pending = buildRows({ ...base, scope: 'fleet', spend: null })
    expect(pending.every((r) => r.spend === null)).toBe(true)
    expect(totals(pending).spend).toBeNull()
  })

  it('saved tokens with no row are "not reported", never 0', () => {
    const rows = buildRows({ ...base, scope: 'fleet' })
    expect(rows.find((r) => r.id === 'b')?.saved).toBeNull()
    expect(totals(rows).saved).toBe(100)
  })

  it('sorts by needs, then spend; unknowns last either way', () => {
    const rows = buildRows({
      ...base,
      scope: 'fleet',
      spend: new Map([
        ['a', { cost: 5, operations: 1 }],
        ['h', { cost: 9, operations: 1 }],
      ]),
    })
    expect(sortRows(rows, DEFAULT_SORT).map((r) => r.id)).toEqual(['b', 'h', 'a'])
    expect(sortRows(rows, { key: 'saved', desc: false }).map((r) => r.id)).toEqual(['a', 'h', 'b'])
  })

  it('totals are the sum of the rows shown, and flag harness estimates', () => {
    const rows = buildRows({
      ...base,
      scope: 'yours',
      spend: new Map([
        ['a', { cost: 5, operations: 1 }],
        ['b', { cost: 100, operations: 1 }],
        ['h', { cost: 2, operations: 1 }],
      ]),
    })
    expect(totals(rows)).toMatchObject({
      agents: 1,
      harnesses: 1,
      spend: 7,
      spendHasEstimates: true,
      needing: 0,
    })
  })

  it('needs counts come from action rows, failed sessions (unique names) and requests', () => {
    const m = needsByAgent({
      action: ['a'],
      failedSessionAgents: ['raw-b', 'shared'],
      idForName: (raw) => (raw === 'raw-b' ? 'b' : undefined),
      requestAgents: ['a', null, 'b'],
    })
    expect([...m]).toEqual([
      ['a', 2],
      ['b', 2],
    ])
  })
})

describe('the sentence', () => {
  it('names the rows, the spend and what needs the viewer', () => {
    expect(
      homeNarrative({
        scope: 'fleet',
        agents: 12,
        harnesses: 4,
        spend: 3840,
        days: 30,
        needing: 3,
      }),
    ).toBe('12 agents and 4 harnesses you can see spent $3,840.00 in the last 30 days; 3 need you.')
    expect(
      homeNarrative({ scope: 'yours', agents: 1, harnesses: 0, spend: 0, days: 7, needing: 0 }),
    ).toBe('Your 1 agent spent nothing in the last 7 days.')
    expect(
      homeNarrative({
        scope: 'yours',
        agents: 2,
        harnesses: 0,
        spend: null,
        days: 7,
        needing: null,
      }),
    ).toBeNull()
  })
})
