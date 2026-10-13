/**
 * /budgets scope (plan feat-budget-burn F10, §4): the URL's `?scope=` resolved for a viewer. A superuser reads Fleet,
 * Yours and any owner; anyone else reads Yours only, so a shared Fleet or owner link opens on their own budget (the
 * server would refuse the wider read anyway, §5). `owner:<own id>` is Yours. Pure; `scope.test.ts`.
 */
import type { ScopeRef } from './api'

export type PageScope = { kind: 'fleet' } | { kind: 'yours' } | { kind: 'owner'; id: string }

/** `fleet`, `yours`, `owner:<id>`; anything else is no choice. */
export function parseScope(text: string | undefined): PageScope | null {
  if (text === 'fleet') return { kind: 'fleet' }
  if (text === 'yours') return { kind: 'yours' }
  const m = /^owner:([\w-]{1,64})$/.exec(text ?? '')
  return m?.[1] ? { kind: 'owner', id: m[1] } : null
}

export const scopeParam = (s: PageScope) => (s.kind === 'owner' ? `owner:${s.id}` : s.kind)

export interface Viewer {
  id: string
  superuser: boolean
}

/** The scope shown: the URL's when this viewer may read it, else their default (a superuser's Fleet, else Yours). */
export function resolveScope(text: string | undefined, v: Viewer): PageScope {
  const s = parseScope(text)
  if (s?.kind === 'owner' && s.id === v.id) return { kind: 'yours' }
  if (s && (v.superuser || s.kind === 'yours')) return s
  return v.superuser ? { kind: 'fleet' } : { kind: 'yours' }
}

/** The burn family's target for a page scope. */
export const scopeRef = (s: PageScope, v: Viewer): ScopeRef =>
  s.kind === 'fleet'
    ? { scope: 'org', id: null }
    : { scope: 'owner', id: s.kind === 'owner' ? s.id : v.id }
