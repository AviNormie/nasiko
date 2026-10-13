/**
 * /budgets scope (plan feat-budget-burn F10, §4; budgets.md §5): the URL's `?scope=` resolved for a viewer. Fleet and
 * any owner are a fleet reader's (a superuser or org admin, or EE finance); a unit is anyone's who may read it (EE: an
 * admin's or finance's any unit, a unit lead's units and their sub-units, the `homeOrgScope` levels); everyone reads
 * Yours. A link the viewer can't read opens on their default: Fleet for a fleet reader, a lead's first unit, else Yours
 * (the server would refuse the wider read anyway). `owner:<own id>` is Yours. Pure; `scope.test.ts`.
 */
import type { HomeLevel } from '@/app/edition'
import type { ScopeRef } from './api'

export type PageScope =
  | { kind: 'fleet' }
  | { kind: 'yours' }
  | { kind: 'owner'; id: string }
  | { kind: 'unit'; id: string }

const ID = '[\\w-]{1,64}'

/** `fleet`, `yours`, `owner:<id>`, `unit:<id>`; anything else is no choice. */
export function parseScope(text: string | undefined): PageScope | null {
  if (text === 'fleet') return { kind: 'fleet' }
  if (text === 'yours') return { kind: 'yours' }
  const m = new RegExp(`^(owner|unit):(${ID})$`).exec(text ?? '')
  return m?.[1] && m[2] ? { kind: m[1] as 'owner' | 'unit', id: m[2] } : null
}

export const scopeParam = (s: PageScope) =>
  s.kind === 'owner' || s.kind === 'unit' ? `${s.kind}:${s.id}` : s.kind

export interface Viewer {
  id: string
  /** A superuser, or (EE) an org admin: the two are equal everywhere (budgets.md §5). */
  superuser: boolean
  /** EE finance: reads the fleet, every unit and owner, writes nothing (B6). */
  finance?: boolean
  /** Units this viewer may read, in tree order (EE `homeOrgScope` levels; none in OSS). */
  units?: readonly HomeLevel[]
  /** Units this viewer may write: an admin's every unit, a lead's while the org allows it (§7 Q4). */
  writeUnits?: ReadonlySet<string>
}

/** Fleet and any owner: a superuser or org admin, or finance. */
export const readsFleet = (v: Viewer) => v.superuser || !!v.finance

/** The scope shown: the URL's when this viewer may read it, else their default. */
export function resolveScope(text: string | undefined, v: Viewer): PageScope {
  const s = parseScope(text)
  if (s?.kind === 'owner' && s.id === v.id) return { kind: 'yours' }
  if (s?.kind === 'yours') return s
  if (s?.kind === 'unit' && v.units?.some((u) => u.id === s.id)) return s
  if (s && (s.kind === 'fleet' || s.kind === 'owner') && readsFleet(v)) return s
  if (readsFleet(v)) return { kind: 'fleet' }
  // A unit lead's widest view is their units (§5): their first one.
  const first = v.units?.[0]
  return first ? { kind: 'unit', id: first.id } : { kind: 'yours' }
}

/** The burn family's target for a page scope. */
export const scopeRef = (s: PageScope, v: Viewer): ScopeRef =>
  s.kind === 'fleet'
    ? { scope: 'org', id: null }
    : s.kind === 'unit'
      ? { scope: 'unit', id: s.id }
      : { scope: 'owner', id: s.kind === 'owner' ? s.id : v.id }
