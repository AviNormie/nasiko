/**
 * The session ledger's budget (plans/feat-budget-burn.md F9, B5): the session's burn (`/api/budgets/burn?scope=session`)
 * on a server the availability probe says has budgets, drawn by `budgets/components/SessionBurn` (lazy). The server
 * decides who may read it (the session's owner, a superuser, a unit lead for their units' agents): a 404 (not readable,
 * or a server without the route) shows nothing. Loading is a skeleton, a failure a panel error with Retry. Only the
 * session's owner or a superuser may set its limit, and only while the session is open (400 `session_ended`).
 */
import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { PanelError, PanelSkeleton } from '@/components/shared/panel'
import { useBurn } from '@/features/budgets/api'
import { capabilitiesQuery, mayHave } from '@/features/budgets/availability'
import { meQuery } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/client'
import { copy } from '../copy'

const SessionBurn = lazy(() => import('@/features/budgets/components/SessionBurn'))
const SKELETON_PX = 300

export function LedgerBudget({
  sessionId,
  title,
  ownSession,
}: {
  sessionId: string
  title: string
  /** The session is one of the viewer's own chats. */
  ownSession: boolean
}) {
  const me = useQuery(meQuery).data
  const caps = useQuery(capabilitiesQuery)
  const on = mayHave(caps.data, 'burn')
  // Sessions are read whole: there is no period to pick (F9).
  const burn = useBurn({ scope: 'session', id: sessionId }, { period: 'month' }, on)
  if (!me || caps.isPending || (on && burn.isPending)) return <PanelSkeleton height={SKELETON_PX} />
  if (!on) return null
  if (burn.isError)
    // Not readable (or no such session for budgets) is the server's 404: say nothing.
    return burn.error instanceof ApiError && burn.error.status === 404 ? null : (
      <PanelError
        error={burn.error}
        onRetry={() => void burn.refetch()}
        what={copy.ledger.budgetSection}
      />
    )
  const b = burn.data
  if (!b?.session) return null
  const open = b.session.ended_at === null || Date.parse(b.session.ended_at) > Date.parse(b.as_of)
  return (
    <Suspense fallback={<PanelSkeleton height={SKELETON_PX} />}>
      <SessionBurn
        burn={b}
        sessionId={sessionId}
        sessionName={title}
        viewerId={me.sub}
        writable={open && (ownSession || me.is_superuser)}
      />
    </Suspense>
  )
}
