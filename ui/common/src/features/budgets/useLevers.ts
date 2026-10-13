/**
 * The levers' reads (plan feat-budget-burn F4), only for a budget that needs them: the scope's top contributors by
 * agent (fleet, unit, owner) or the agent itself, each one's own burn (routed pace) and routed tokens by model, the
 * agents directory (their Token optimization switch and owner), model prices, and token optimization's measured cost
 * reduction over the last 30 days (`/finops/savings`, the Caveman program, measured only). A read that fails or that
 * this server lacks leaves its lever without a number or not offered, never a guess.
 */
import { useQueries } from '@tanstack/react-query'
import { useAgentsDirectory } from '@/features/agents/api'
import { useSavings } from '@/features/tokenops/api'
import { resolveWindow } from '@/features/tokenops/window'
import { breakdownQuery, burnQuery, useBreakdown, usePrices, type ScopeRef } from './api'
import { mayHave, type Availability } from './availability'
import { projection } from './burn'
import {
  leverList,
  modelsOf,
  needsLevers,
  routedPaceOf,
  topContributors,
  type LeverAgent,
} from './levers'
import { PACE_DAYS } from './tuning'
import type { Breakdown, Burn } from './types'

/** The program token optimization (`compress_enabled`) turns on, as `/finops/savings` names it. */
const COMPRESSION_PROGRAM = 'caveman'

export function useLevers(
  b: Burn,
  ref: ScopeRef,
  kind: 'month' | 'quarter',
  caps: Availability,
  enabled: boolean,
) {
  const wanted = enabled && !!b.budget && needsLevers(b, projection(b))
  const byAgent = useBreakdown(
    ref,
    { by: 'agent', period: kind, top: 10 },
    wanted && ref.scope !== 'agent' && mayHave(caps, 'breakdown'),
  )
  const contributors =
    ref.scope === 'agent' && ref.id
      ? [{ id: ref.id, name: b.label }]
      : byAgent.data
        ? topContributors(recentPaces(byAgent.data, b.as_of))
        : []
  const burns = useQueries({
    queries: contributors.map((c) => ({
      ...burnQuery({ scope: 'agent', id: c.id }, { period: kind }),
      enabled: wanted && mayHave(caps, 'burn'),
    })),
  })
  const models = useQueries({
    queries: contributors.map((c) => ({
      ...breakdownQuery({ scope: 'agent', id: c.id }, { by: 'model', period: kind }),
      enabled: wanted && mayHave(caps, 'breakdown'),
    })),
  })
  const dir = useAgentsDirectory(wanted)
  const prices = usePrices(wanted && mayHave(caps, 'prices'))
  const savings = useSavings(
    resolveWindow({ preset: '30d' }, new Date(b.as_of)),
    {},
    'total',
    wanted,
  )
  const program = savings.data?.by_program.find((x) => x.program === COMPRESSION_PROGRAM)
  const measured =
    program && program.basis === 'measured' && program.cost_reduction_pct !== null
      ? {
          pct: program.cost_reduction_pct,
          agents: savings.data?.coverage.agents_with_compress_enabled ?? 0,
        }
      : null
  const agents: LeverAgent[] = contributors.map((c, i) => {
    const row = dir.byId.get(c.id)
    const burn = burns[i]?.data
    const br = models[i]?.data
    return {
      id: c.id,
      name: row ? row.display_name || row.name : c.name,
      ownerId: row?.owner_id ?? null,
      compressOn: compressOf(row),
      routedPace: burn ? routedPaceOf(burn) : null,
      models: br ? modelsOf(br) : null,
    }
  })
  const loading =
    wanted &&
    (byAgent.isLoading ||
      burns.some((q) => q.isLoading) ||
      models.some((q) => q.isLoading) ||
      dir.isLoading ||
      prices.isLoading ||
      savings.isLoading)
  return {
    list: leverList({ burn: b, agents, measured, prices: prices.data ?? null }),
    loading,
  }
}

/** Each contributor's spend over the last 7 complete days, counted the scope's way (its breakdown). */
function recentPaces(br: Breakdown, asOf: string) {
  const today = asOf.slice(0, 10)
  const days = br.days.filter((d) => d.date < today).slice(-PACE_DAYS)
  return br.keys
    .filter((k) => !k.redacted)
    .map((k) => ({
      id: k.key,
      name: k.label,
      pace:
        days.reduce((s, d) => s + (d.items.find((x) => x.key === k.key)?.cost_usd ?? 0), 0) /
        Math.max(1, days.length),
    }))
}

/** A directory row's Token optimization switch (the generated type predates `compress_enabled`); unknown → null. */
function compressOf(row: object | undefined): boolean | null {
  const v = (row as { compress_enabled?: unknown } | undefined)?.compress_enabled
  return typeof v === 'boolean' ? v : null
}
