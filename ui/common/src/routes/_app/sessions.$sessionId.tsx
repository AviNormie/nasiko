import { createFileRoute } from '@tanstack/react-router'
import { traceSearchSchema, type TraceSearch } from '@/features/sessions/search'
import { prefetchChat } from '@/features/chat/api'
import { pickShared } from '@/app/shell/context'
import { prefetchSessionDetail } from '@/features/sessions/api'
import { SessionLineage } from '@/features/sessions/Subagents'
import { LedgerPage } from '@/features/hub/components/LedgerPage'
import { SessionTracePage } from '@/features/trace/SessionTracePage'
import { useSetSearch } from '@/lib/search'

/** Session trace: a sibling of the Sessions list (not nested), so it replaces the list. */
export const Route = createFileRoute('/_app/sessions/$sessionId')({
  validateSearch: traceSearchSchema,
  // Hover or touch intent on a link starts the page's first requests; a direct load fetches from the page (plan §8 Phase 3).
  // A ledger link warms the chat history it reads first (plans/feat-agent-centric.md PR1b).
  loaderDeps: ({ search }) => ({ view: search.view }),
  loader: ({ context, params, preload, deps }) => {
    if (!preload) return
    if (deps.view === 'ledger') prefetchChat(context.queryClient, params.sessionId)
    else prefetchSessionDetail(context.queryClient, params.sessionId)
  },
  // Another session is another page: its frozen clock, selection and panels start fresh.
  remountDeps: ({ params }) => params.sessionId,
  component: TraceRoute,
})

function TraceRoute() {
  const { sessionId } = Route.useParams()
  const search = Route.useSearch()
  const setSearch = useSetSearch<TraceSearch>(Route.fullPath, true)
  // Subagents (R15): both session pages show the parent link and the subagents. Composed here, as the route is the one
  // place that sees both pages and the sessions feature.
  const lineage = (
    <SessionLineage
      sessionId={sessionId}
      linkSearch={{
        ...pickShared(search),
        day: search.day,
        sort: search.sort,
        lane: search.lane,
        status: search.status,
        live: search.live,
      }}
    />
  )
  // The ledger is its own page, outside the trace page's success branch (plans/feat-agent-centric.md eng "Ledger").
  if (search.view === 'ledger')
    return <LedgerPage sessionId={sessionId} search={search} lineage={lineage} />
  return (
    <SessionTracePage
      sessionId={sessionId}
      search={search}
      setSearch={setSearch}
      lineage={lineage}
    />
  )
}
