/**
 * The Overview homepage (plans/feat-overview.md): what needs you, where the money goes, and how healthy the fleet is,
 * each card linking to the page that owns it. The header's range (`?range=`, 7/30/90 days) drives the KPI row, Spend and
 * Harnesses; the other cards keep the windows their rules are defined on.
 *
 * "Now" is frozen per visit; coming back to the page 1 min+ later moves it (useReturnTick, the TokenOps rule), so the
 * windows and the cards refresh together (design review 8A). Pending requests aren't refetched here: they already
 * refetch on focus (eng review correction).
 * The grids follow the page area's width, not the viewport, because the sidebar changes it (design review 1A). The summary
 * is a bento: the headline in a lead card beside the KPI tiles (2×2) from 1100 px of content, stacked below (tiles 2
 * across from 560 px). Below it, from 1100 px, twelve columns: Needs you and Spend each span the row, then Fleet health
 * beside Recent sessions and Recent chats beside Quick actions; 2 columns from 700 px, 1 below. DOM order stays the priority order (Needs you first); wide layouts place cards
 * explicitly, so nothing leaves a hole.
 *
 * Restored at `/` on 2026-10-17 in place of the agent-centric Home (its table, scope switch and chart band are gone),
 * with Home's Budget burn panel (the `budgets.useHomePanel` slot, EE only) spanning the row under Needs you. The panel
 * reads the persona's default scope (`homeScopeFor`: Fleet for leads and finance, Yours otherwise), since the Overview
 * has no scope switch; the first paint waits for it, so it never pushes the cards down mid-look.
 */
import { useSlots } from '@/app/edition-context'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { TourButton } from '@/app/shell/TopBar'
import { PageHeader } from '@/components/shared/page-header'
import { PageLoader } from '@/components/shared/page-loader'
import { StateCard } from '@/components/shared/state-card'
import { Button } from '@/components/ui/button'
import { useChatSessions } from '@/features/chat/api'
import { overviewNarrative } from '@/features/narrative/overview'
import { usePersona } from '@/features/onboarding/api'
import { homeScopeFor } from '@/features/onboarding/logic'
import { meQuery, type Me } from '@/lib/api/auth'
import { useReturnTick } from '@/lib/useReturnTick'
import {
  useFleetHealth,
  useHarnessSummary,
  useNeedsYou,
  useOverviewSavings,
  useSavedByAgent,
  useSpend,
} from './api'
import { FirstRun, FirstRunLead, FirstRunPreview } from './components/FirstRun'
import { FleetHealth } from './components/FleetHealth'
import { HarnessesLine } from './components/Harnesses'
import { NeedsYou } from './components/NeedsYou'
import { usePausedFlows } from '@/features/flows/paused'
import { QuickActions } from './components/QuickActions'
import { RecentChats } from './components/RecentChats'
import { RecentSessions } from './components/RecentSessions'
import { SavedByAgent } from './components/SavedByAgent'
import { SetupGuide } from './components/SetupGuide'
import { SummaryCard } from './components/SummaryCard'
import { Spend } from './components/Spend'
import { copy } from './copy'
import { DEFAULT_RANGE, RANGE_DAYS, RANGES, type OverviewSearch } from './search'
import { RETURN_REFRESH_MS } from './tuning'

type SetSearch = (patch: Partial<OverviewSearch>) => void

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
      <PageHeader title={copy.title} description={description} actions={actions} />
      {children}
    </div>
  )
}

function HeaderActions({
  search,
  setSearch,
  setup,
}: {
  search: OverviewSearch
  setSearch: SetSearch
  /** False on first run: the Setup guide (or deploy) card is on the page already. */
  setup: boolean
}) {
  return (
    <>
      <ToggleGroup
        data-tour="overview-range"
        type="single"
        variant="outline"
        size="sm"
        value={search.range ?? DEFAULT_RANGE}
        onValueChange={(v) =>
          v &&
          setSearch({ range: v === DEFAULT_RANGE ? undefined : (v as OverviewSearch['range']) })
        }
        aria-label={copy.range.label}
      >
        {RANGES.map((r) => (
          <ToggleGroupItem
            key={r}
            value={r}
            aria-label={copy.range.item(RANGE_DAYS[r])}
            className="px-3 text-xs pointer-coarse:min-h-11"
          >
            {r}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {setup ? <SetupGuide /> : null}
      {/* No top bar here on desktop (phones keep it, with its own button). */}
      <TourButton className="max-md:hidden" />
    </>
  )
}

/** A first-run row that spans the grid at every width. */
const FULL_ROW = '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-3'

/** Where each card sits: twelve columns from 1100 px, 2 from 700. Literal class names, so Tailwind sees them. */
// Redesign 2026-10-13: Needs you, Budget burn and Spend span the row; then Fleet health beside Recent sessions and
// Recent chats beside Quick actions, alternating widths. Heights match within a row, so no card stretches far past
// its content.
// Redesign 2026-10-19: Needs you (8) beside Fleet health (4), both "what's wrong"; Needs you at that width draws one
// row per item (its tiles start at 900 px of card). Budget burn and Spend span the row; then Recent sessions (7) beside
// Saved tokens by agent (5), and Recent chats (7) beside Quick actions (5): pairs of about the same height, so neither
// card in a row is left half empty.
const PLACE = {
  needs: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-8',
  health: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-4',
  burn: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-12',
  spend: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-12',
  sessions: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-7',
  saved: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-5',
  chats: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-7',
  actions: '@[700px]/overview:col-span-2 @[1100px]/overview:col-span-5',
} as const

export function OverviewPage({
  search,
  setSearch,
}: {
  search: OverviewSearch
  setSearch: SetSearch
}) {
  const meQ = useQuery(meQuery)
  const me = meQ.data
  // A non-401 failure (server down, 5xx) must not spin forever; /status explains how to start the server (/ship review).
  if (!me && meQ.isError) {
    return (
      <Frame>
        <div data-testid="overview-me-error">
          <StateCard
            tone="error"
            title={copy.meFailed}
            action={
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link to="/status">{copy.checkStatus}</Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => void meQ.refetch()}>
                  <RotateCw className="size-3.5" aria-hidden /> {copy.retry}
                </Button>
              </div>
            }
          />
        </div>
      </Frame>
    )
  }
  if (!me)
    return (
      <Frame>
        <PageLoader label={copy.loadingPage} />
      </Frame>
    )
  return <Overview me={me} search={search} setSearch={setSearch} />
}

function Overview({
  me,
  search,
  setSearch,
}: {
  me: Me
  search: OverviewSearch
  setSearch: SetSearch
}) {
  const range = search.range ?? DEFAULT_RANGE
  const days = RANGE_DAYS[range]
  const qc = useQueryClient()
  const returnTick = useReturnTick(RETURN_REFRESH_MS)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [returnTick])
  useEffect(() => {
    if (!returnTick) return
    // Window-keyed queries (finops, sessions) move with `now`; these keys don't, so refresh them.
    void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
    void qc.invalidateQueries({ queryKey: ['agents', 'deployment'] })
    void qc.invalidateQueries({ queryKey: ['router', 'budgets'] })
    // The Budget burn panel's burn and At risk, and Needs you's budget rows (Home's rule, Codex 2).
    void qc.invalidateQueries({ queryKey: ['budgets', 'v1'] })
    // The month calendar is keyed by month, not window: refresh it too, as TokenOps does (/ship review).
    void qc.invalidateQueries({ queryKey: ['tokenops', 'calendar'] })
  }, [returnTick, qc])

  const fleet = useFleetHealth(now)
  // A failed agent list must not freeze the other cards: they load, and Needs you says agent health failed (/ship review).
  const ready = !!fleet.error || (!!fleet.summary && fleet.agentCount > 0)
  // First run: the directory answered with no agents but harnesses (design review 7A).
  const firstRun = !!fleet.summary && fleet.agentCount === 0
  const spend = useSpend(now, range, ready)
  const savings = useOverviewSavings(now, range, ready)
  const savedByAgent = useSavedByAgent(now, range, fleet, ready && !firstRun)
  const needsYou = useNeedsYou(now, me, fleet, ready)
  const harnesses = useHarnessSummary(now, me, range)
  // The Recent chats card's own query (same key): first paint waits for it too.
  const chats = useChatSessions()
  // Budget burn (EE): the persona's default scope; null until the persona settles (it settles on a failure too).
  const persona = usePersona()
  const burn = useSlots().budgets.useHomePanel({
    scope: persona.settled ? homeScopeFor(persona.persona, me.is_superuser) : null,
    meSub: me.sub,
    isSuperuser: me.is_superuser,
    unitLabel: null,
  })
  const { needs } = needsYou
  // Read only when there are requests to link (plans/feat-flows.md O2, amended 2026-10-06).
  const pausedFlows = usePausedFlows(needs.rows.some((r) => r.kind === 'request'))
  const narrative = useMemo(
    () =>
      overviewNarrative({
        month: spend.summary,
        unpriced: spend.unpriced,
        actionCount: needs.actionCount,
        waitingCount: needs.waitingCount,
        otherCount: needs.rows.filter((r) => r.kind === 'budget' || r.kind === 'sessions').length,
        empty: needs.empty,
      }),
    [spend.summary, spend.unpriced, needs],
  )

  const grid =
    'grid grid-cols-1 items-stretch gap-3 @[700px]/overview:grid-cols-2 @[1100px]/overview:grid-cols-3'
  const description = copy.greeting(now.getHours(), me.username, days)
  const actions = <HeaderActions search={search} setSearch={setSearch} setup={!firstRun} />
  // One page loader until the first paint's reads settle (data or error: a failed read renders its card's error), in
  // place of every card's skeleton. Latched: a later range change or return tick keeps the cards' own loading states.
  // Needs you's rating and session checks aren't waited for: its card shows them loading (a fan-out can be slow).
  const coldPending =
    (!fleet.summary && !fleet.error) ||
    harnesses.isPending ||
    (!firstRun &&
      (spend.isPending ||
        (!spend.totals && !spend.totalsError) ||
        needsYou.sessions.recent.isPending ||
        !persona.settled ||
        burn.pending ||
        chats.isPending))
  const [painted, setPainted] = useState(false)
  if (!painted && !coldPending) setPainted(true)
  if (!painted && coldPending) {
    return (
      <Frame description={description} actions={actions}>
        <PageLoader label={copy.loadingPage} />
      </Frame>
    )
  }
  if (firstRun) {
    return (
      <Frame description={description} actions={actions}>
        <FirstRunLead />
        <div className={grid}>
          {/* From 1100 px Quick actions and Harnesses' one line stack beside the first-run card, so neither stretches
              to its height; below that each spans the grid. The preview of later cards sits apart, after a wider gap. */}
          <FirstRun />
          <div className="contents @[1100px]/overview:flex @[1100px]/overview:flex-col @[1100px]/overview:gap-3">
            <QuickActions firstRun className={`${FULL_ROW} @[1100px]/overview:flex-1`} />
            <HarnessesLine data={harnesses} days={days} className={FULL_ROW} />
          </div>
          <FirstRunPreview className={`${FULL_ROW} mt-3`} />
        </div>
      </Frame>
    )
  }
  return (
    <Frame description={description} actions={actions}>
      <SummaryCard
        days={days}
        narrative={narrative}
        nothing={needs.empty}
        spend={spend}
        savings={savings}
        harnesses={harnesses}
      />
      <div className="grid grid-cols-1 items-stretch gap-3 @[700px]/overview:grid-cols-2 @[1100px]/overview:grid-cols-12">
        <NeedsYou
          data={needsYou}
          now={now.getTime()}
          userId={me.sub}
          pausedFlows={pausedFlows}
          className={PLACE.needs}
        />
        <FleetHealth fleet={fleet} className={PLACE.health} />
        {burn.node ? <div className={PLACE.burn}>{burn.node}</div> : null}
        <Spend spend={spend} now={now.getTime()} className={PLACE.spend} />
        <RecentSessions
          sessions={needsYou.sessions}
          displayName={fleet.displayName}
          now={now.getTime()}
          className={PLACE.sessions}
        />
        <SavedByAgent data={savedByAgent} className={PLACE.saved} />
        <RecentChats
          byId={fleet.byId}
          username={me.username}
          now={now.getTime()}
          className={PLACE.chats}
        />
        <QuickActions className={PLACE.actions} />
      </div>
    </Frame>
  )
}
