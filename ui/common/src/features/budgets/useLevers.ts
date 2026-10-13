/**
 * The levers' reads (plan feat-budget-burn F4), only for a budget that needs them. The contributors are the scope's top
 * agents over the last 7 complete days (a breakdown over that range, so the server ranks by recent spend, not the
 * period's total), or the agent itself. For each: its own burn (routed spend), on an owner or unit scope its share
 * counted the budget's way (`contributor=`, only the calls billed to the owner), and its routed tokens by model (the
 * top 20, so the biggest by tokens isn't cut by a ranking by cost), scaled to that share; its routing, where the viewer
 * may act on it; the agents directory; prices; and token optimization's measured saving over the last 30 days. Reads
 * follow the budget's own period (a month budget read by quarter still estimates from this month). A read that fails
 * or this server lacks leaves its lever without a number or not offered, never a guess.
 */
import { useQueries } from '@tanstack/react-query'
import { useAgentsDirectory } from '@/features/agents/api'
import { routingQuery } from '@/features/router/api'
import { useSavings } from '@/features/tokenops/api'
import { resolveWindow } from '@/features/tokenops/window'
import { breakdownQuery, burnQuery, useBreakdown, usePrices, type ScopeRef } from './api'
import { mayHave, type Availability } from './availability'
import { projection } from './burn'
import { leverList, modelsOf, needsLevers, routedPaceOf, type LeverAgent } from './levers'
import { PACE_DAYS } from './tuning'
import type { Burn } from './types'

/** The program token optimization (`compress_enabled`) turns on, as `/finops/savings` names it. */
const COMPRESSION_PROGRAM = 'caveman'
const CONTRIBUTORS = 3
const DAY_MS = 86_400_000
const day = (t: number) => new Date(t).toISOString().slice(0, 10)

export function useLevers(
  b: Burn,
  ref: ScopeRef,
  caps: Availability,
  viewer: { id: string; superuser: boolean },
  enabled: boolean,
  /** The budget record's action now (it can be newer than the burn read). */
  action?: 'alert' | 'stop',
) {
  const wanted = enabled && !!b.budget && needsLevers(b, projection(b))
  const period: 'month' | 'quarter' = b.period === 'quarter' ? 'quarter' : 'month'
  const today = Date.parse(`${b.as_of.slice(0, 10)}T00:00:00Z`)
  const recent = useBreakdown(
    ref,
    {
      by: 'agent',
      period,
      from: day(today - PACE_DAYS * DAY_MS),
      to: day(today - DAY_MS),
      top: CONTRIBUTORS + 3,
    },
    wanted && ref.scope !== 'agent' && mayHave(caps, 'breakdown'),
  )
  const contributors =
    ref.scope === 'agent' && ref.id
      ? [{ id: ref.id, name: b.label }]
      : (recent.data?.keys ?? [])
          .filter((k) => !k.redacted && k.key !== 'unattributed' && k.cost_usd > 0)
          .slice(0, CONTRIBUTORS)
          .map((k) => ({ id: k.key, name: k.label }))
  const scoped = ref.scope === 'owner' || ref.scope === 'unit'
  const own = useQueries({
    queries: contributors.map((c) => ({
      ...burnQuery({ scope: 'agent', id: c.id }, { period }),
      enabled: wanted && mayHave(caps, 'burn'),
    })),
  })
  const share = useQueries({
    queries: contributors.map((c) => ({
      ...burnQuery(ref, { period, contributor: { by: 'agent', key: c.id } }),
      enabled: wanted && scoped && mayHave(caps, 'contributor'),
    })),
  })
  const models = useQueries({
    queries: contributors.map((c) => ({
      ...breakdownQuery({ scope: 'agent', id: c.id }, { by: 'model', period, top: 20 }),
      enabled: wanted && mayHave(caps, 'breakdown'),
    })),
  })
  const dir = useAgentsDirectory(wanted)
  const mayAct = (id: string) => viewer.superuser || dir.byId.get(id)?.owner_id === viewer.id
  const routing = useQueries({
    queries: contributors.map((c) => ({
      ...routingQuery(c.id),
      enabled: wanted && mayAct(c.id),
      retry: false,
    })),
  })
  const prices = usePrices(wanted && mayHave(caps, 'prices'))
  const savings = useSavings(
    resolveWindow({ preset: '30d' }, new Date(b.as_of)),
    {},
    'agent',
    wanted,
  )
  const program = savings.data?.by_program.find((x) => x.program === COMPRESSION_PROGRAM)
  const measured =
    program && program.basis === 'measured' && program.cost_reduction_pct !== null
      ? {
          pct: program.cost_reduction_pct,
          // The agents the viewer can read that saved anything (the read is ACL-scoped, F4).
          agents: savings.data?.by_agent.filter((a) => a.saved_cost_usd > 0).length ?? 0,
        }
      : null
  const agents: LeverAgent[] = contributors.map((c, i) => {
    const row = dir.byId.get(c.id)
    const ownBurn = own[i]?.data
    const br = models[i]?.data
    const r = routing[i]
    // An owner budget counts only the calls billed to its owner: scale the agent's routed figures to that share.
    const fraction = scoped ? scopedFraction(ownBurn, share[i]?.data) : 1
    const pace = ownBurn ? routedPaceOf(ownBurn) : null
    return {
      id: c.id,
      name: row ? row.display_name || row.name : c.name,
      ownerId: row?.owner_id ?? null,
      compressOn: compressOf(row),
      routedPace: pace === null || fraction === null ? null : pace * fraction,
      models:
        !br || fraction === null
          ? null
          : modelsOf(br).map((m) => ({
              ...m,
              inputTokens: m.inputTokens * fraction,
              outputTokens: m.outputTokens * fraction,
            })),
      routing: !mayAct(c.id)
        ? undefined
        : r?.data
          ? { pinned: r.data.pinned_model, provider: r.data.llm_config?.provider ?? null }
          : r?.isError
            ? null
            : undefined,
    }
  })
  const loading =
    wanted &&
    (recent.isLoading ||
      [...own, ...share, ...models, ...routing].some((q) => q.isLoading) ||
      dir.isLoading ||
      prices.isLoading ||
      savings.isLoading)
  return {
    list: leverList({ burn: b, agents, measured, prices: prices.data ?? null, action }),
    loading,
  }
}

/** The share of an agent's routed spend this period that the budget counts; null when either read is missing. */
function scopedFraction(own: Burn | undefined, share: Burn | undefined): number | null {
  const total = own?.sources.routed_usd
  const counted = share?.contributor?.used_usd
  if (total === undefined || counted === undefined) return null
  return total > 0 ? Math.min(1, counted / total) : 0
}

/** A directory row's Token optimization switch (the generated type predates `compress_enabled`); unknown → null. */
function compressOf(row: object | undefined): boolean | null {
  const v = (row as { compress_enabled?: unknown } | undefined)?.compress_enabled
  return typeof v === 'boolean' ? v : null
}
