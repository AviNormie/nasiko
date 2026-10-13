/**
 * The hub's Budget section (plans/feat-budget-burn.md F10, F13, B5): replaces the Budget preview layer card. Owner and
 * superuser only, as the card was. It reads this agent's burn (month) on a server the availability probe says has
 * budgets; a coding harness shows it only once it made routed calls this period (F9). Loading is a skeleton, a failure
 * a panel error with Retry; the section itself (`budgets/components/AgentBudgetSection`, lazy) draws the rest, with this
 * agent's changes over the budget's period as flags (the hub's markers: deploys, the latest crash, and the event log's
 * changes while it is a preview; its budget warnings and stops are the budget's own events, so they are left out).
 */
import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { PanelError, PanelSkeleton } from '@/components/shared/panel'
import type { AgentView } from '@/features/agents/normalize'
import { useBurn } from '@/features/budgets/api'
import { capabilitiesQuery, mayHave, type Availability } from '@/features/budgets/availability'
import type { Burn } from '@/features/budgets/types'
import { resolveWindow } from '@/features/tokenops/window'
import { meQuery } from '@/lib/api/auth'
import { isEndpointAbsent } from '@/lib/api/detect'
import { useHubMarkers, type MarkersState } from '../api'
import { copy } from '../copy'
import { markerText } from '../events'

const AgentBudgetSection = lazy(() => import('@/features/budgets/components/AgentBudgetSection'))
const SECTION_SKELETON_PX = 360
/** The event log's kinds a lever writes that move the agent's pace: Token optimization and a model pin (B3, F4). */
const PACE_CHANGES = new Set(['compress_change', 'route_change'])

export function HubBudget({ agent }: { agent: AgentView }) {
  const me = useQuery(meQuery).data
  const reader = !!me && (me.sub === agent.ownerId || me.is_superuser)
  const caps = useQuery({ ...capabilitiesQuery, enabled: reader })
  const on = reader && mayHave(caps.data, 'burn')
  const burn = useBurn({ scope: 'agent', id: agent.id }, { period: 'month' }, on)
  if (!reader || !me) return null
  if (caps.isPending || (on && burn.isPending))
    return <PanelSkeleton height={SECTION_SKELETON_PX} />
  if (!on || !caps.data) return null
  if (burn.isError)
    return isEndpointAbsent(burn.error) ? null : (
      <PanelError
        error={burn.error}
        onRetry={() => void burn.refetch()}
        what={copy.budgetSection}
      />
    )
  // A harness's direct provider calls aren't routed: no routed call this period, nothing to budget here (F9).
  if (!burn.data || (agent.isHarness && burn.data.calls === 0)) return null
  return (
    <Loaded
      burn={burn.data}
      agent={agent}
      viewer={{ id: me.sub, superuser: me.is_superuser }}
      caps={caps.data}
    />
  )
}

function Loaded({
  burn,
  agent,
  viewer,
  caps,
}: {
  burn: Burn
  agent: AgentView
  viewer: { id: string; superuser: boolean }
  caps: Availability
}) {
  const win = resolveWindow(
    { preset: 'custom', from: burn.period_start.slice(0, 10), to: burn.as_of.slice(0, 10) },
    new Date(burn.as_of),
  )
  const state = useHubMarkers(agent.id, win, agent.isHarness)
  const set = state.kind === 'ready' ? state.set : state.kind === 'failed' ? state.set : null
  const markers = (set?.markers ?? [])
    .filter((m) => m.sub !== 'budget_warning')
    .map((m) => ({ at: m.at, label: markerText(m), budgetStop: m.sub === 'budget_stop' }))
  // The latest change that moves the pace (F13's expected line): optimization switched, or the model routing changed.
  const last = (set?.markers ?? []).findLast((m) => PACE_CHANGES.has(m.sub))
  const applied = last ? { at: last.at } : null
  return (
    <Suspense fallback={<PanelSkeleton height={SECTION_SKELETON_PX} />}>
      <AgentBudgetSection
        burn={burn}
        agent={{
          id: agent.id,
          name: agent.displayName || agent.name,
          ownerId: agent.ownerId || null,
        }}
        viewer={viewer}
        caps={caps}
        markers={markers}
        markersNote={markersNote(state, agent.isHarness)}
        applied={applied}
      />
    </Suspense>
  )
}

/** The rail's partial-state rule, in one line: which changes the flags can include. */
function markersNote(state: MarkersState, harness: boolean): string | null {
  if (state.kind === 'pending') return null
  if (state.kind === 'failed')
    return state.which === 'deploys' ? copy.rail.deploysFailed : copy.rail.changesFailed
  if (state.preview) return null
  if (harness) return copy.rail.otherLater
  const shown = state.set.markers.some((m) => m.kind === 'crash')
    ? copy.rail.showing
    : copy.rail.showingOss
  return `${shown}. ${copy.rail.otherLater}`
}
