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
 * PR2b adds the spend sparklines, last change, budget use (a preview) and owner grouping, and two-line rows below
 * 640 px; PR2c the EE levels.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { RotateCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { KpiTile } from '@/components/shared/kpi-tile'
import { PageHeader } from '@/components/shared/page-header'
import { PageLoader } from '@/components/shared/page-loader'
import { PanelSkeleton } from '@/components/shared/panel'
import { EmptyState, StateCard } from '@/components/shared/state-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DeployAgentButton } from '@/features/deploy/components/DeployAgentButton'
import { usePausedFlows } from '@/features/flows/paused'
import { homeNarrative } from '@/features/narrative/home'
import { usePersona } from '@/features/onboarding/api'
import { homeScopeFor } from '@/features/onboarding/logic'
import { FirstRun, FirstRunLead, FirstRunPreview } from '@/features/overview/components/FirstRun'
import { NeedsYou } from '@/features/overview/components/NeedsYou'
import { SetupGuide } from '@/features/overview/components/SetupGuide'
import { copy as overviewCopy } from '@/features/overview/copy'
import { DEFAULT_RANGE, RANGE_DAYS, RANGES } from '@/features/overview/search'
import { meQuery, type Me } from '@/lib/api/auth'
import { fmtLocalTime, fmtMoney, fmtMoneyFloor, fmtTokens } from '@/lib/format'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { useFrozenNow, useReturnTick } from '@/lib/useReturnTick'
import { useHome, type HomeBudgets, type SourceStatus } from './api'
import { PhoneRows } from './components/PhoneRows'
import { RowsTable } from './components/RowsTable'
import { copy } from './copy'
import { budgetMonth, DEFAULT_SORT, sortRows, totals, type Sort } from './rows'
import { rememberScope, resolveScope, storedScope } from './scope'
import type { HomeSearch, Scope } from './search'
import { RETURN_REFRESH_MS, SKELETON_ROW_PX, SKELETON_ROWS, TOUCH } from './tuning'

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
  // Frozen per visit, moved on return (the Overview's rule); no hook-rule suppression, so the Compiler keeps the page.
  const now = useFrozenNow(returnTick)
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
  const router = useRouter()
  useEffect(() => {
    // Only while still on the home: the persona can answer during a navigation away (the old route stays mounted until
    // the next one loads), and a write then would pull the user back to `/` (review: onboarding's Open Sessions).
    if (resolved.replace && !replaced.current && router.state.location.pathname === '/') {
      replaced.current = true
      setSearch({ scope: resolved.replace }, { replace: true })
    }
  }, [resolved.replace, setSearch, router])
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
  const phone = useMediaQuery(PHONE, false)
  const rows = home.rows ? sortRows(home.rows, sort) : null
  const t = rows ? totals(rows) : null
  const sentence = t
    ? homeNarrative({ scope: scope ?? 'fleet', ...t, floor: home.unpriced, days })
    : null

  const rowsProps = {
    rows: rows ?? [],
    grouped: scope === 'fleet',
    days,
    range,
    now,
    win: home.win,
    series: me.is_superuser,
    ratingsPending: home.ratingsPending,
    savedStatus: home.savedStatus,
    budgets: home.budgets,
    ownerName: home.owner,
  }

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
          className={`px-3 text-xs ${TOUCH}`}
        >
          {copy.scope.yours}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="fleet"
          title={copy.scope.fleetHint}
          className={`px-3 text-xs ${TOUCH}`}
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
            className={`px-3 text-xs ${TOUCH}`}
          >
            {r}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* On first run the page's own card holds the one next action (design 7A). */}
      {firstRun ? null : <DeployAgentButton variant="outline" />}
      {firstRun ? null : <SetupGuide />}
    </>
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
        <Strip
          totals={t}
          member={!me.is_superuser}
          scope={scope}
          asOf={home.asOf}
          unpriced={home.unpriced}
          savedStatus={home.savedStatus}
          savedCapped={home.savedCapped}
          budgets={home.budgets}
        />
      ) : null}
      {scope === 'fleet' && !me.is_superuser ? (
        <p className="m-0 text-xs text-muted-foreground">{copy.scope.sharedWithYou}</p>
      ) : null}
      {home.spendStatus === 'failed' ||
      home.spendStatus === 'stale' ||
      home.savedStatus === 'failed' ||
      home.savedStatus === 'stale' ? (
        <p role="status" className="m-0 flex items-center gap-2 text-sm text-destructive">
          {home.spendStatus === 'failed' || home.savedStatus === 'failed'
            ? copy.moneyFailed
            : copy.moneyStale}
          <Button size="sm" variant="ghost" className={TOUCH} onClick={home.retryMoney}>
            {copy.retry}
          </Button>
        </p>
      ) : null}
      {home.dirFailed ? (
        // A directory outage costs the table, never Needs you above it (the Overview kept its cards apart too).
        <StateCard
          tone="error"
          title={copy.error}
          action={
            <Button
              size="sm"
              variant="outline"
              className={TOUCH}
              onClick={() => void home.dir.refetch()}
            >
              <RotateCw className="size-3.5" aria-hidden /> {copy.retry}
            </Button>
          }
        />
      ) : !rows ? (
        <PanelSkeleton height={SKELETON_ROWS * SKELETON_ROW_PX} />
      ) : !rows.length ? (
        <EmptyState title={copy.empty.noOwned}>
          <p className="m-0">{copy.empty.noOwnedBody}</p>
          <Button
            size="sm"
            variant="outline"
            className={`mt-3 ${TOUCH}`}
            onClick={() => change({ scope: 'fleet' })}
          >
            {copy.empty.showFleet}
          </Button>
        </EmptyState>
      ) : (
        <>
          {t && t.spend === 0 && !home.unpriced && !rows.some((r) => (r.requests ?? 0) > 0) ? (
            <p className="m-0 text-sm text-muted-foreground">{copy.empty.noUsage(days)}</p>
          ) : null}
          {phone ? (
            <PhoneRows {...rowsProps} />
          ) : (
            <RowsTable {...rowsProps} sort={sort} onSort={setSort} />
          )}
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
  unpriced,
  savedStatus,
  savedCapped,
  budgets,
}: {
  totals: ReturnType<typeof totals>
  member: boolean
  scope: Scope | null
  asOf: number
  unpriced: boolean
  savedStatus: SourceStatus
  savedCapped: boolean
  budgets: HomeBudgets
}) {
  const savedKnown = savedStatus === 'ok' || savedStatus === 'stale'
  // Yours shows the viewer's own monthly budget; Fleet has no authoritative fleet budget to show, and owner and agent
  // budgets overlap, so they are never summed into one (design "Home scope semantics").
  const own = scope === 'yours' && budgets.state === 'ok' ? budgets.own : null
  return (
    <section aria-label={copy.strip.label} className="flex flex-col gap-1">
      <div
        className={`grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0 ${own ? '@[560px]/overview:grid-cols-2 @[880px]/overview:grid-cols-4' : '@[560px]/overview:grid-cols-3'}`}
      >
        <KpiTile
          label={copy.strip.spend}
          aside={
            member && scope === 'fleet' ? (
              <span className="text-xs text-muted-foreground">{copy.strip.spendVisible}</span>
            ) : null
          }
          value={t.spend === null ? '—' : fmtMoneyFloor(t.spend, unpriced)}
        >
          {unpriced ? (
            <span className="text-xs text-muted-foreground">{copy.strip.unpriced}</span>
          ) : null}
          {t.spendHasEstimates ? (
            <span className="text-xs text-muted-foreground">{copy.strip.estimates}</span>
          ) : null}
        </KpiTile>
        <KpiTile
          label={copy.strip.saved}
          title={copy.strip.savedTooltip}
          value={
            !savedKnown || t.saved === null ? (
              '—'
            ) : (
              <>
                {savedCapped ? '≥ ' : ''}
                {fmtTokens(t.saved)}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  {copy.strip.tokens}
                </span>
              </>
            )
          }
        >
          {savedKnown && t.saved === null ? (
            <span className="text-xs text-muted-foreground">{copy.strip.notReported}</span>
          ) : null}
          {savedKnown && t.savedBasis ? (
            <span className="text-xs text-muted-foreground">{copy.strip.basis(t.savedBasis)}</span>
          ) : null}
        </KpiTile>
        {own ? (
          <KpiTile
            label={copy.budget.own}
            title={copy.budget.ownHint}
            aside={
              <Badge variant="outline" className="text-3xs">
                {copy.budget.preview}
              </Badge>
            }
            value={`${Math.round((own.used / own.limit) * 100)}%`}
          >
            <span className="text-xs text-muted-foreground">
              {copy.budget.use(
                fmtMoneyFloor(own.used, own.unpriced),
                fmtMoney(own.limit),
                budgetMonth(own.resetsAt),
              )}
            </span>
          </KpiTile>
        ) : null}
        <KpiTile label={copy.strip.needs} value={t.needing === null ? '—' : String(t.needing)} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs text-muted-foreground">
        <p className="m-0">
          {budgets.state === 'off'
            ? copy.budget.off
            : budgets.state === 'failed'
              ? copy.budget.failed
              : null}
        </p>
        {asOf ? <p className="m-0">{copy.strip.asOf(fmtLocalTime(asOf))}</p> : null}
      </div>
    </section>
  )
}

/** Below this the rows are two lines each (design "Responsive": < 640 px). */
const PHONE = '(max-width: 639px)'
