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
 * 640 px; PR2c the EE levels; PR2d the chart band between the strip and the table (`components/ChartBand`), whose health
 * bar filters the table (`?health=`).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { RotateCw } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { KpiTile } from '@/components/shared/kpi-tile'
import { PageHeader } from '@/components/shared/page-header'
import { PageLoader } from '@/components/shared/page-loader'
import { PanelSkeleton } from '@/components/shared/panel'
import { EmptyState, StateCard } from '@/components/shared/state-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { budgetsShown, useHome, type HomeBudgets, type SourceStatus } from './api'
import { filterByHealth } from './charts'
import { PhoneRows } from './components/PhoneRows'
import { RowsTable } from './components/RowsTable'
import { copy } from './copy'
import { budgetMonth, DEFAULT_SORT, sortRows, totals, type Sort } from './rows'
import { rememberScope, resolveScope, storedScope } from './scope'
import { isUnitScope, type HomeSearch, type Scope } from './search'
import {
  BAND_SKELETON_PX,
  PHONE_QUERY,
  RETURN_REFRESH_MS,
  SKELETON_ROW_PX,
  SKELETON_ROWS,
  TOUCH,
} from './tuning'
import { useBudgetStamp } from './useBudgetStamp'

/** The chart band is its own chunk (PR2d, #63): the chart kit loads only when it draws. */
const ChartBand = lazy(() => import('./components/ChartBand'))

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
    // Window-keyed reads move with `now`; the directory, the rows' build records and the org levels don't.
    void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
    void qc.invalidateQueries({ queryKey: ['builds', 'agent'] })
    // An edition's org levels too (units and members change elsewhere: Access control, the IdP sync).
    void qc.invalidateQueries({ queryKey: ['home', 'org'] })
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
  const phone = useMediaQuery(PHONE_QUERY, false)
  const rows = home.rows ? sortRows(home.rows, sort) : null
  const t = rows ? totals(rows) : null
  const unit = isUnitScope(scope)
  const sentence = t
    ? homeNarrative({
        scope: unit ? 'unit' : (scope ?? 'fleet'),
        unitName: home.org.level?.label,
        ...t,
        floor: home.unpriced,
        days,
      })
    : null

  // The health bar narrows the table only (#62): the strip and the charts keep the whole scope.
  const health = search.health
  // Every row reads Not rated until the ratings answer, so the filter waits for them: a shared `?health=watch` link
  // never opens on "No rows are Watch".
  const healthPending = !!health && home.ratingsPending
  const shown = rows ? filterByHealth(rows, healthPending ? undefined : health) : null
  const healthName = (h: NonNullable<HomeSearch['health']>) =>
    h === 'unknown' ? copy.charts.notRated : overviewCopy.rating[h]

  const rowsProps = {
    rows: shown ?? [],
    // Fleet and an org level group by owner; Yours is one owner.
    grouped: scope !== 'yours',
    days,
    range,
    now,
    win: home.win,
    series: me.is_superuser,
    ratingsPending: home.ratingsPending,
    savedStatus: home.savedStatus,
    budgets: home.budgets,
    ownerName: home.owner,
    unpriced: home.unpriced,
  }

  // First run: nothing deployed or registered yet. Its Setup guide (or deploy) card is on the page already.
  // A unit link shows the unit's own states even on an empty fleet (an OSS build, or a first run): never the first run.
  const firstRun = !!home.dir.data && !home.dir.data.length && !unit
  const actions = (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={scope === 'yours' || scope === 'fleet' ? scope : ''}
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
      {/* The org levels an edition adds (EE: units, PR2c). A member, or OSS, has none and sees no picker. */}
      {home.org.levels.length ? (
        // A unit the viewer can't pick shows the placeholder, never a blank trigger.
        <Select
          value={home.org.level ? (scope ?? '') : ''}
          onValueChange={(v) => v && change({ scope: v as Scope })}
        >
          <SelectTrigger
            size="sm"
            className={`h-8 w-fit max-w-[min(16rem,100%)] text-xs ${TOUCH}`}
            aria-label={copy.scope.unitLabel}
          >
            <SelectValue placeholder={copy.scope.unitPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {home.org.levels.map((l) => (
              // The indent sits on the item, outside its text (which the trigger repeats); the path names it, so
              // same-named units under different parents differ for a screen reader.
              <SelectItem
                key={l.id}
                value={`unit:${l.id}`}
                aria-label={l.path}
                // Radix names an option by its text (`aria-labelledby`), which beats `aria-label`: drop it.
                aria-labelledby={undefined}
                textValue={l.label}
                className={TOUCH}
                style={{ paddingInlineStart: `${0.5 + l.depth}rem` }}
              >
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
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
      {/* An empty fleet (only reachable here through a unit link) reads no sessions, so Needs you would never settle. */}
      {home.dir.data?.length === 0 ? null : (
        <NeedsYou data={needsYou} now={now.getTime()} userId={me.sub} pausedFlows={pausedFlows} />
      )}
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
      {unit && home.org.level ? (
        <p className="m-0 text-xs text-muted-foreground">
          {copy.scope.unitCaption(home.org.level.path, !me.is_superuser)}
        </p>
      ) : null}
      {unit && home.org.state === 'stale' ? (
        <p role="status" className="m-0 flex items-center gap-2 text-sm text-destructive">
          {copy.unitStale}
          <Button size="sm" variant="ghost" className={TOUCH} onClick={home.org.retry}>
            {copy.retry}
          </Button>
        </p>
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
      ) : unit && home.org.state === 'unknown' ? (
        // A unit link the viewer can't pick (deleted, outside a manager's subtrees, or a build without org levels).
        <EmptyState title={copy.empty.unknownUnit}>
          <Button
            size="sm"
            variant="outline"
            className={`mt-3 ${TOUCH}`}
            onClick={() => change({ scope: 'fleet' })}
          >
            {copy.empty.showFleet}
          </Button>
        </EmptyState>
      ) : unit && home.org.state === 'failed' ? (
        <StateCard
          tone="error"
          title={copy.unitFailed}
          action={
            <Button size="sm" variant="outline" className={TOUCH} onClick={home.org.retry}>
              <RotateCw className="size-3.5" aria-hidden /> {copy.retry}
            </Button>
          }
        />
      ) : !rows ? (
        <PanelSkeleton height={SKELETON_ROWS * SKELETON_ROW_PX} />
      ) : !rows.length && unit ? (
        <EmptyState title={copy.empty.noUnitRows}>
          <p className="m-0">{copy.empty.noUnitRowsBody}</p>
        </EmptyState>
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
          <Suspense fallback={<PanelSkeleton height={BAND_SKELETON_PX} />}>
            <ChartBand
              rows={rows}
              superuser={me.is_superuser}
              fleet={scope === 'fleet'}
              days={days}
              win={home.win}
              perf={home.perf}
              spendStatus={home.spendStatus}
              dashError={home.dashError}
              savedStatus={home.savedStatus}
              savedCapped={home.savedCapped}
              unpriced={home.unpriced}
              retryMoney={home.retryMoney}
              ratingsPending={home.ratingsPending}
              health={health}
              onHealth={(h) => change({ health: h })}
            />
          </Suspense>
          {health ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {/* Only the sentence is live: Clear isn't re-announced with each change. */}
              <p role="status" className="m-0">
                {healthPending
                  ? copy.charts.filterPending(healthName(health))
                  : shown?.length
                    ? copy.charts.filtered(healthName(health), shown.length, rows.length)
                    : copy.charts.noneMatch(healthName(health))}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className={TOUCH}
                onClick={() => change({ health: undefined })}
              >
                {copy.charts.clear}
              </Button>
            </div>
          ) : null}
          {!shown?.length ? null : phone ? (
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
  const own = scope === 'yours' && budgetsShown(budgets.state) ? budgets.own : null
  const stamp = useBudgetStamp(budgets.updatedAt)
  return (
    <section aria-label={copy.strip.label} className="flex flex-col gap-1">
      <div
        className={`grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0 ${own ? '@[560px]/overview:grid-cols-2 @[880px]/overview:grid-cols-4' : '@[560px]/overview:grid-cols-3'}`}
      >
        <KpiTile
          label={copy.strip.spend}
          aside={
            member && scope !== 'yours' ? (
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
            aside={
              <Badge variant="outline" className="text-3xs">
                {copy.budget.preview}
              </Badge>
            }
            // Floored, so 99.6% never reads as a full 100% while under the limit; a floor (≥) with unpriced calls.
            value={
              own.limit > 0
                ? copy.budget.pct(Math.floor((own.used / own.limit) * 100), own.unpriced)
                : '—'
            }
          >
            <span className="text-xs text-muted-foreground">
              {copy.budget.use(
                fmtMoneyFloor(own.used, own.unpriced),
                fmtMoney(own.limit),
                budgetMonth(own.resetsAt),
              )}
            </span>
            <span className="text-xs text-muted-foreground">{copy.budget.ownHint}</span>
          </KpiTile>
        ) : null}
        <KpiTile label={copy.strip.needs} value={t.needing === null ? '—' : String(t.needing)} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs text-muted-foreground">
        {/* One note for both layouts: the table header's badge and stamp aren't announced, and phones have no header. */}
        <p
          className="m-0"
          role={budgets.state === 'failed' || budgets.state === 'stale' ? 'status' : undefined}
        >
          {budgets.state === 'off'
            ? copy.budget.off
            : budgets.state === 'failed'
              ? copy.budget.failed
              : budgets.state === 'stale'
                ? `${copy.budget.stale} · ${copy.budget.note(stamp)}`
                : copy.budget.note(stamp)}
        </p>
        {asOf ? <p className="m-0">{copy.strip.asOf(fmtLocalTime(asOf))}</p> : null}
      </div>
    </section>
  )
}
