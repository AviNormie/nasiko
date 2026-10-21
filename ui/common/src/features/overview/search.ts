/**
 * The window the home reads its money for (7, 30 or 90 days), kept from the Overview (`?range=`). Needs you keeps its own
 * windows (its rules are defined on them). Loaded with the shell (the home's schema uses it), so no query code here.
 */
import { z } from 'zod/mini'
import { opt } from '@/lib/search'

export const RANGES = ['7d', '30d', '90d'] as const
export type Range = (typeof RANGES)[number]

/** Optional, so the landing page's own URL stays a bare `/` (sign-in redirects, the sidebar link); 30 days when unset. */
export const overviewSearchSchema = z.object({
  range: opt(z.enum(RANGES)),
})
export type OverviewSearch = z.infer<typeof overviewSearchSchema>

/** 30 days when `?range=` is unset (the home's window, `home/search.ts`, keeps the Overview's key). */
export const DEFAULT_RANGE: Range = '30d'

export const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 90 }
