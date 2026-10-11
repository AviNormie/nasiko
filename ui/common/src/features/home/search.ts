/**
 * The home's search params (plans/feat-agent-centric.md PR2): the window (`?range=`, the Overview's own key, so links to
 * `/?range=30d` keep working) and the scope. Both optional: the landing URL stays a bare `/`. Loaded with the shell, so
 * zod/mini only.
 *
 * Scope: `yours`, `fleet`, or `unit:<id>`, an org level an edition layer adds (PR2c, the `homeOrgScope` slot). The core
 * only checks its shape; what a unit holds is the layer's.
 */
import { z } from 'zod/mini'
import { opt } from '@/lib/search'
import { RANGES } from '@/features/overview/search'

export type UnitScope = `unit:${string}`
export type Scope = 'yours' | 'fleet' | UnitScope

const UNIT = /^unit:[0-9A-Za-z-]{1,64}$/

export const isUnitScope = (s: Scope | null | undefined): s is UnitScope =>
  !!s && s.startsWith('unit:')
/** The unit id in `unit:<id>`. */
export const unitOf = (s: UnitScope) => s.slice('unit:'.length)

const scopeSchema = z.union([
  z.enum(['yours', 'fleet']),
  z.pipe(
    z.string().check(z.regex(UNIT)),
    z.transform((s) => s as UnitScope),
  ),
])

export const homeSearchSchema = z.object({
  range: opt(z.enum(RANGES)),
  /** No static default: the persona decides when the URL doesn't (`scope.ts`). */
  scope: opt(scopeSchema),
})
export type HomeSearch = z.infer<typeof homeSearchSchema>
