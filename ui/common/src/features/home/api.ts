/**
 * The home's reads (plans/feat-agent-centric.md PR2a; eng "Home execution table", in docs/home.md). Everything here is a
 * fleet-level read made once for all rows, never one per row:
 * - the directory (agents and harnesses, with owners);
 * - the ACL-scoped agent dashboard for the window (spend and requests by agent id);
 * - the savings read's `by_agent` rows for the window (tokens saved, with basis);
 * - the Overview's ratings (`useFleetHealth`; the fleet-wide spend series only for a superuser) and its Needs you, whose
 *   reads also give the per-agent needs counts (action rows, the checked session sample, pending requests).
 */
import { isHarness } from '@/features/agents/status'
import { usePendingRequests } from '@/features/chat/api'
import { useWaiting } from '@/features/chat/waiting'
import { uniqueByName } from '@/features/overview/health'
import { rangeWindow, useFleetHealth, useNeedsYou } from '@/features/overview/api'
import type { Range } from '@/features/overview/search'
import { useDashboard, useSavings } from '@/features/tokenops/api'
import { useAgentsDirectory, useUsers } from '@/features/agents/api'
import type { Me } from '@/lib/api/auth'
import { buildRows, needsByAgent, type HomeAgent } from './rows'
import type { Scope } from './search'

export function useHome(now: Date, range: Range, me: Me, scope: Scope | null) {
  const superuser = me.is_superuser
  const dir = useAgentsDirectory()
  const fleet = useFleetHealth(now, true, superuser)
  const users = useUsers(superuser)
  const win = rangeWindow(range, now)
  const any = (dir.data?.length ?? 0) > 0
  const dash = useDashboard(win, {}, 'agent', 'current', any)
  const savings = useSavings(win, {}, 'agent', any)
  const ready = !!fleet.error || (!!fleet.summary && fleet.agentCount > 0)
  const needsYou = useNeedsYou(now, me, fleet, ready)
  const waiting = useWaiting(me.sub, superuser)
  const pending = usePendingRequests(me.sub, !superuser)

  const agents: HomeAgent[] = (dir.data ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    displayName: a.display_name || a.name,
    ownerId: a.owner_id,
    harness: isHarness(a),
    status: a.status,
  }))
  const spend = dash.data
    ? new Map(
        dash.data.agents.map((r) => [r.agent_id, { cost: r.total_cost, operations: r.operations }]),
      )
    : null
  // The savings read is optional on older servers: a failure leaves the column "not reported", never 0.
  const saved = savings.data
    ? new Map(
        savings.data.by_agent.map((r) => [r.agent_id, { tokens: r.saved_tokens, basis: r.basis }]),
      )
    : null

  // Needs counts: fleet-level reads only (eng). A superuser's requests count only once a chat proves them theirs.
  const { needs, sessions } = needsYou
  const failedRaw = sessions.newest
    .filter((r) => sessions.status.get(r.session_id) === 'failed' && r.agent_id)
    .map((r) => r.agent_id as string)
  const requestAgents = superuser
    ? waiting.match.chats.flatMap((c) => c.requests.map((r) => r.execution.agent_id))
    : (pending.data?.items ?? [])
        .filter((r) => r.status === 'pending')
        .map((r) => r.execution.agent_id)
  const needsLoading =
    needs.loading ||
    waiting.isPending ||
    (!superuser && pending.isPending) ||
    sessions.list.isPending
  const byName = uniqueByName(dir.byNameAll)
  const needsMap = needsLoading
    ? null
    : needsByAgent({
        action: needs.rows.flatMap((r) => (r.kind === 'agent' ? [r.id] : [])),
        failedSessionAgents: failedRaw,
        idForName: byName,
        requestAgents,
      })

  const rows =
    scope && dir.data
      ? buildRows({
          agents,
          meSub: me.sub,
          scope,
          spend,
          saved,
          ratings: fleet.summary?.byId ?? null,
          needs: needsMap,
        })
      : null

  return {
    dir,
    fleet,
    needsYou,
    rows,
    owner: (id: string) => users.data?.get(id) ?? null,
    dashError: dash.isError,
    asOf: dash.dataUpdatedAt,
    retry: () => {
      if (dir.isError) void dir.refetch()
      if (dash.isError) void dash.refetch()
      if (savings.isError) void savings.refetch()
    },
  }
}
