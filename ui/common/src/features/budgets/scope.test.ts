// @vitest-environment node
// /budgets scope (plan feat-budget-burn F10, §4): who may read what, and the burn family's target.
import { describe, expect, it } from 'vitest'
import { parseScope, resolveScope, scopeParam, scopeRef } from './scope'

const admin = { id: 'u-admin', superuser: true }
const member = { id: 'u-member', superuser: false }

describe('scope', () => {
  it('parses fleet, yours and owner:<id>; junk is no choice', () => {
    expect(parseScope('fleet')).toEqual({ kind: 'fleet' })
    expect(parseScope('owner:abc-1')).toEqual({ kind: 'owner', id: 'abc-1' })
    expect(parseScope('owner:')).toBeNull()
    expect(parseScope('unit:x')).toBeNull()
    expect(scopeParam({ kind: 'owner', id: 'abc-1' })).toBe('owner:abc-1')
  })

  it('a superuser defaults to Fleet and may read any owner; your own id is Yours', () => {
    expect(resolveScope(undefined, admin)).toEqual({ kind: 'fleet' })
    expect(resolveScope('owner:x', admin)).toEqual({ kind: 'owner', id: 'x' })
    expect(resolveScope('owner:u-admin', admin)).toEqual({ kind: 'yours' })
  })

  it('anyone else reads Yours, whatever the link says', () => {
    expect(resolveScope(undefined, member)).toEqual({ kind: 'yours' })
    expect(resolveScope('fleet', member)).toEqual({ kind: 'yours' })
    expect(resolveScope('owner:x', member)).toEqual({ kind: 'yours' })
  })

  it('Fleet reads org; Yours and an owner read that owner', () => {
    expect(scopeRef({ kind: 'fleet' }, admin)).toEqual({ scope: 'org', id: null })
    expect(scopeRef({ kind: 'yours' }, admin)).toEqual({ scope: 'owner', id: 'u-admin' })
    expect(scopeRef({ kind: 'owner', id: 'x' }, admin)).toEqual({ scope: 'owner', id: 'x' })
  })
})
