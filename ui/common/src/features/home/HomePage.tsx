/**
 * The scoped home at `/` (plans/feat-agent-centric.md PR2a; design "Home", mockup A: a flat roll-up strip and one dense
 * table). It replaces the Overview's card grid, keeping what the design review mapped across: Needs you on top, the
 * money as a roll-up strip, fleet health as each row's health, coding harnesses as rows, Quick actions as the header's
 * "Deploy an agent". Recent sessions moved to each agent's hub and Recent chats to Chat.
 *
 * Scope (`?scope=yours|fleet`): Yours is what the viewer owns, Fleet everything they can see. With no key the persona
 * decides (`scope.ts`), and until it does the table shows neutral skeleton rows. The window is the Overview's
 * `?range=` (7/30/90 days). "Now" is frozen per visit and moves on return, as the Overview's did.
 *
 * PR2b adds the spend sparklines, last change, budget use and owner grouping; PR2c the EE levels.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RotateCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DataTable, type DataTableColumn } from '@/components/shared/data-table'
import { KpiTile } from '@/components/shared/kpi-tile'
import { PageHeader } from '@/components/shared/page-header'
import { PageLoader } from '@/components/shared/page-loader'
import { PanelSkeleton } from '@/components/shared/panel'
import { EmptyState, StateCard } from '@/components/shared/state-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { displayStatus } from '@/features/agents/status'
import { DeployAgentButton } from '@/features/deploy/components/DeployAgentButton'
import { usePausedFlows } from '@/features/flows/paused'
import { homeNarrative } from '@/features/narrative/home'
import { usePersona } from '@/features/onboarding/api'
import { homeScopeFor } from '@/features/onboarding/logic'
import { FirstRun, FirstRunLead, FirstRunPreview } from '@/features/overview/components/FirstRun'
import { NeedsYou } from '@/features/overview/components/NeedsYou'
import { RATED_STATUSES } from '@/features/overview/health'
import { SetupGuide } from '@/features/overview/components/SetupGuide'
import { copy as overviewCopy } from '@/features/overview/copy'
import { DEFAULT_RANGE, RANGE_DAYS, RANGES } from '@/features/overview/search'
import { meQuery, type Me } from '@/lib/api/auth'
import { fmtLocalTime, fmtMoney, fmtTokens } from '@/lib/format'
import { useReturnTick } from '@/lib/useReturnTick'
import { useHome } from './api'
import { copy } from './copy'
import { DEFAULT_SORT, sortRows, totals, type HomeRow, type Sort, type SortKey } from './rows'
import { rememberScope, resolveScope, storedScope } from './scope'
import type { HomeSearch, Scope } from './search'
import { RETURN_REFRESH_MS, SKELETON_ROWS } from './tuning'

type SetSearch = (patch: Partial<HomeSearch>, opts?: { replace?: boolean }) => void

function Frame({
  description,
  actions,
  children,
}: {
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="@container/overview mx-auto flex w-full max-w-page flex-col gap-4">
      <PageHeader title={overviewCopy.title} description={description} actions={actions} />
      {children}
    </div>
  )
}

export function HomePage({ search, setSearch }: { search: HomeSearch; setSearch: SetSearch }) {
  const meQ = useQuery(meQuery)
  const me = meQ.data
  if (!me && meQ.isError)
    return (
      <Frame>
        <StateCard
          tone="error"
          title={overviewCopy.meFailed}
          action={
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/status">{overviewCopy.checkStatus}</Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => void meQ.refetch()}>
                <RotateCw className="size-3.5" aria-hidden /> {overviewCopy.retry}
              </Button>
            </div>
          }
        />
      </Frame>
    )
  if (!me)
    return (
      <Frame>
        <PageLoader label={overviewCopy.loadingPage} />
      </Frame>
    )
  return <Home me={me} search={search} setSearch={setSearch} />
}

function Home({ me, search, setSearch }: { me: Me; search: HomeSearch; setSearch: SetSearch }) {
  const range = search.range ?? DEFAULT_RANGE
  const days = RANGE_DAYS[range]
  const qc = useQueryClient()
  const returnTick = useReturnTick(RETURN_REFRESH_MS)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` moves only on return (the Overview's rule)
  const now = useMemo(() => new Date(), [returnTick])
  useEffect(() => {
    if (!returnTick) return
    // Window-keyed reads move with `now`; the directory doesn't, so refresh it.
    void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
  }, [returnTick, qc])

  // Scope: the URL, else the stored choice, else the persona's default once it settles (scope.ts).
  const persona = usePersona()
  const [interacted, setInteracted] = useState(false)
  const resolved = resolveScope({
    url: search.scope,
    stored: storedScope(me.sub),
    persona: persona.settled ? homeScopeFor(persona.persona, me.is_superuser) : null,
    interacted,
  })
  const replaced = useRef(false)
  useEffect(() => {
    if (resolved.replace && !replaced.current) {
      replaced.current = true
      setSearch({ scope: resolved.replace }, { replace: true })
    }
  }, [resolved.replace, setSearch])
  const scope = resolved.scope
  const change = (patch: Partial<HomeSearch>) => {
    setInteracted(true)
    if (patch.scope) rememberScope(me.sub, patch.scope)
    setSearch(patch)
  }

  const home = useHome(now, range, me, scope)
  const { needsYou } = home
  const pausedFlows = usePausedFlows(needsYou.needs.rows.some((r) => r.kind === 'request'))
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)
  const rows = home.rows ? sortRows(home.rows, sort) : null
  const t = rows ? totals(rows) : null
  const sentence = t ? homeNarrative({ scope: scope ?? 'fleet', ...t, days }) : null

  // First run: nothing deployed or registered yet. Its Setup guide (or deploy) card is on the page already.
  const firstRun = !!home.dir.data && !home.dir.data.length
  const actions = (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={scope ?? ''}
        onValueChange={(v) => v && change({ scope: v as Scope })}
        aria-label={copy.scope.label}
      >
        <ToggleGroupItem
          value="yours"
          title={copy.scope.yoursHint}
          className="px-3 text-xs pointer-coarse:min-h-11"
        >
          {copy.scope.yours}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="fleet"
          title={copy.scope.fleetHint}
          className="px-3 text-xs pointer-coarse:min-h-11"
        >
          {copy.scope.fleet}
        </ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={range}
        onValueChange={(v) =>
          v && change({ range: v === DEFAULT_RANGE ? undefined : (v as HomeSearch['range']) })
        }
        aria-label={overviewCopy.range.label}
      >
        {RANGES.map((r) => (
          <ToggleGroupItem
            key={r}
            value={r}
            aria-label={overviewCopy.range.item(RANGE_DAYS[r])}
            className="px-3 text-xs pointer-coarse:min-h-11"
          >
            {r}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <DeployAgentButton variant="outline" />
      {firstRun ? null : <SetupGuide />}
    </>
  )

  if (home.dir.isError)
    return (
      <Frame actions={actions}>
        <StateCard
          tone="error"
          title={copy.error}
          action={
            <Button size="sm" variant="outline" onClick={() => void home.dir.refetch()}>
              <RotateCw className="size-3.5" aria-hidden /> {copy.retry}
            </Button>
          }
        />
      </Frame>
    )
  // The Overview's first-run layout, unchanged.
  if (firstRun)
    return (
      <Frame actions={actions}>
        <FirstRunLead />
        <div className="grid grid-cols-1 gap-3">
          <FirstRun />
          <FirstRunPreview className="mt-3" />
        </div>
      </Frame>
    )

  return (
    <Frame description={sentence ?? undefined} actions={actions}>
      <NeedsYou data={needsYou} now={now.getTime()} userId={me.sub} pausedFlows={pausedFlows} />
      {rows && t ? (
        <Strip totals={t} member={!me.is_superuser} scope={scope} asOf={home.asOf} />
      ) : null}
      {scope === 'fleet' && !me.is_superuser ? (
        <p className="m-0 text-xs text-muted-foreground">{copy.scope.sharedWithYou}</p>
      ) : null}
      {home.dashError ? (
        <p role="status" className="m-0 flex items-center gap-2 text-sm text-destructive">
          {copy.dashError}
          <Button size="sm" variant="ghost" onClick={home.retry}>
            {copy.retry}
          </Button>
        </p>
      ) : null}
      {!rows ? (
        <PanelSkeleton height={SKELETON_ROWS * 40} />
      ) : !rows.length ? (
        <EmptyState title={copy.empty.noOwned}>
          <p className="m-0">{copy.empty.noOwnedBody}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => change({ scope: 'fleet' })}
          >
            {copy.empty.showFleet}
          </Button>
        </EmptyState>
      ) : (
        <>
          {t && t.spend === 0 && !rows.some((r) => (r.requests ?? 0) > 0) ? (
            <p className="m-0 text-sm text-muted-foreground">{copy.empty.noUsage(days)}</p>
          ) : null}
          <RowsTable
            rows={rows}
            days={days}
            sort={sort}
            onSort={setSort}
            owner={(r) =>
              r.mine ? copy.table.you : (home.owner(r.ownerId) ?? r.ownerId.slice(0, 8))
            }
          />
        </>
      )}
    </Frame>
  )
}

function Strip({
  totals: t,
  member,
  scope,
  asOf,
}: {
  totals: ReturnType<typeof totals>
  member: boolean
  scope: Scope | null
  asOf: number
}) {
  return (
    <section aria-label={copy.strip.label} className="flex flex-col gap-1">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0 @[560px]/overview:grid-cols-3">
        <KpiTile
          label={copy.strip.spend}
          aside={
            member && scope === 'fleet' ? (
              <span className="text-xs text-muted-foreground">{copy.strip.spendVisible}</span>
            ) : null
          }
          value={t.spend === null ? '—' : fmtMoney(t.spend)}
        >
          {t.spendHasEstimates ? (
            <span className="text-xs text-muted-foreground">{copy.strip.estimates}</span>
          ) : null}
        </KpiTile>
        <KpiTile
          label={copy.strip.saved}
          value={
            t.saved === null ? copy.strip.notReported : copy.strip.savedTokens(fmtTokens(t.saved))
          }
        />
        <KpiTile label={copy.strip.needs} value={t.needing === null ? '—' : String(t.needing)} />
      </div>
      {asOf ? (
        <p className="m-0 self-end text-xs text-muted-foreground">
          {copy.strip.asOf(fmtLocalTime(asOf))}
        </p>
      ) : null}
    </section>
  )
}

const SORTABLE: Record<string, SortKey> = {
  name: 'name',
  needs: 'needs',
  spend: 'spend',
  saved: 'saved',
}

function RowsTable({
  rows,
  days,
  sort,
  onSort,
  owner,
}: {
  rows: HomeRow[]
  days: number
  sort: Sort
  onSort: (s: Sort) => void
  owner: (r: HomeRow) => string
}) {
  const columns: DataTableColumn<HomeRow>[] = [
    {
      id: 'name',
      header: copy.table.name,
      // A value makes the column sortable (TanStack); the order itself comes from `sortRows`.
      accessorFn: (r) => r.displayName,
      meta: { rowHeader: true },
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <Link
              to="/agents/$agentId"
              params={{ agentId: row.original.id }}
              className="font-medium underline-offset-4 hover:underline pointer-coarse:py-3"
            >
              {row.original.displayName}
            </Link>
            {row.original.harness ? <Badge variant="outline">{copy.table.harness}</Badge> : null}
          </span>
          <span className="text-xs text-muted-foreground">{owner(row.original)}</span>
        </span>
      ),
    },
    {
      id: 'health',
      header: copy.table.health,
      enableSorting: false,
      cell: ({ row }) => <Health row={row.original} />,
    },
    {
      id: 'needs',
      header: copy.table.needs,
      accessorFn: (r) => r.needs,
      meta: { numeric: true },
      cell: ({ row }) => (row.original.needs === null ? '—' : row.original.needs),
    },
    {
      id: 'spend',
      header: copy.table.spend(days),
      accessorFn: (r) => r.spend,
      meta: { numeric: true },
      cell: ({ row }) =>
        row.original.spend === null ? (
          '—'
        ) : (
          <span>
            {fmtMoney(row.original.spend)}
            {row.original.harness && row.original.spend > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">{copy.table.estimate}</span>
            ) : null}
          </span>
        ),
    },
    {
      id: 'saved',
      header: copy.table.saved,
      accessorFn: (r) => r.saved,
      meta: { numeric: true },
      cell: ({ row }) =>
        row.original.saved === null ? (
          <span className="text-muted-foreground">{copy.strip.notReported}</span>
        ) : (
          fmtTokens(row.original.saved)
        ),
    },
  ]
  return (
    // Wider than a phone: this box scrolls the columns, and takes focus so the keyboard can too (PR2b adds two-line
    // phone rows).
    <div
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable (axe scrollable-region-focusable)
      tabIndex={0}
      role="region"
      aria-label={copy.table.label}
      className="overflow-x-auto rounded-md contain-inline-size focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <DataTable
        className="w-max min-w-full"
        label={copy.table.label}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        sorting={[{ id: sort.key, desc: sort.desc }]}
        onSortingChange={(next) => {
          const s = next[0]
          const key = s ? SORTABLE[s.id] : undefined
          onSort(key && s ? { key, desc: s.desc } : DEFAULT_SORT)
        }}
      />
    </div>
  )
}

function Health({ row }: { row: HomeRow }) {
  const h = row.health
  // Harnesses and agents that aren't deployed are never rated; a deployed agent whose inputs failed is Unknown.
  const rated = !row.harness && RATED_STATUSES.includes(displayStatus(row.status, false))
  if (!h || h.rating === 'unknown')
    return (
      <span className="text-muted-foreground">
        {rated && h ? copy.rating.unknown : copy.table.notRated}
      </span>
    )
  const reason = h.reasons[0]?.text
  return (
    <span className="flex flex-col gap-0.5">
      <Badge variant={h.rating === 'action' ? 'destructive' : 'outline'} className="w-fit">
        {copy.rating[h.rating]}
      </Badge>
      {reason && h.rating !== 'healthy' ? (
        <span className="text-xs text-muted-foreground">{reason}</span>
      ) : null}
    </span>
  )
}
