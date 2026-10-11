/**
 * The home's search params (plans/feat-agent-centric.md PR2): the window (`?range=`, the Overview's own key, so links to
 * `/?range=30d` keep working) and the scope. Both optional: the landing URL stays a bare `/`. Loaded with the shell, so
 * zod/mini only.
 */
import { z } from 'zod/mini'
import { opt } from '@/lib/search'
import { RANGES } from '@/features/overview/search'

const SCOPES = ['yours', 'fleet'] as const
export type Scope = (typeof SCOPES)[number]

export const homeSearchSchema = z.object({
  range: opt(z.enum(RANGES)),
  /** No static default: the persona decides when the URL doesn't (`scope.ts`). */
  scope: opt(z.enum(SCOPES)),
})
export type HomeSearch = z.infer<typeof homeSearchSchema>
