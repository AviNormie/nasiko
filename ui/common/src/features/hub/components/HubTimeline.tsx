/**
 * The agent hub's timeline (plans/feat-agent-centric.md PR1a): the sentence, TokenOps' window bar with Compare and a
 * Table view, the marker rail over the lanes (spend, requests, p95, and tokens saved where a per-agent series exists),
 * and the selected bucket's panel. Section order and states follow the design amendments; data rules live in
 * `api.ts` (the gate), `events.ts` (markers) and `timeline.ts` (buckets), all pure except the gate.
 *
 * URL (DX): `preset`/`from`/`to` (a window change clears `slice` in the same replace), `compare` (replace), `slice`
 * (pushed), `marker` (replaced away when it can't be shown).
 */
import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { BarChart3, Info, Table2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Swatch } from '@/components/shared/chart-marks'
import { Delta } from '@/components/shared/delta'
import { Announcer } from '@/components/shared/announcer'
import { useAnnounce } from '@/components/shared/announce'
import { PanelError } from '@/components/shared/panel'
import { TimeControl } from '@/components/shared/time-control'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LaneChart, type LaneSpec } from '@/components/charts/lanes'
import type { AgentView } from '@/features/agents/normalize'
import { hubNarrative } from '@/features/narrative/agentHub'
import { meQuery } from '@/lib/api/auth'
import { resolveWindow } from '@/features/tokenops/window'
import { seriesAt } from '@/lib/chart'
import { fmtInt, fmtLatency, fmtMoneyFloor, fmtTokens } from '@/lib/format'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { useFrozenNow, useReturnTick } from '@/lib/useReturnTick'
import { useSetSearch } from '@/lib/search'
import {
  useHubGate,
  useHubMarkers,
  useHubSavedSeries,
  useHubSavings,
  useHubTimeseries,
  type GateState,
  type HubMoney,
  type MarkersState,
  type SavedTotal,
} from '../api'
import { copy } from '../copy'
import { latestMarker, markerIdState } from '../events'
import { HUB_DEFAULT_PRESET, hubCompareOn, type HubSearch } from '../search'
import {
  bucketForPreset,
  bucketIndexOf,
  emptyRows,
  flagsFor,
  rowOfSlice,
  rowsFor,
  sliceOf,
  totalsOf,
  weeklyRows,
  type HubRow,
  type LaneTotals,
} from '../timeline'
import { BUILDS_READ, LANE_HEIGHT } from '../tuning'
import { BucketPanel } from './BucketPanel'
import { HubTable } from './HubTable'
import { MarkerRail } from './MarkerRail'

const SPEND = seriesAt(0)
const REQUESTS = seriesAt(1)
const P95 = seriesAt(2)
const SAVED = seriesAt(3)

export function HubTimeline({ agent, ownerLabel }: { agent: AgentView; ownerLabel: string }) {
  return (
    // The hub's one polite live region: bucket selection is announced here (design "Table view").
    <Announcer>
      <Timeline agent={agent} ownerLabel={ownerLabel} />
    </Announcer>
  )
}

function Timeline({ agent, ownerLabel }: { agent: AgentView; ownerLabel: string }) {
  const search: HubSearch = useSearch({ from: '/_app/agents/$agentId' })
  const setSearch = useSetSearch<HubSearch>('/agents/$agentId')
  const announce = useAnnounce()
  const tick = useReturnTick()
  const preset = search.preset ?? HUB_DEFAULT_PRESET
  const now = useFrozenNow(preset, search.from, search.to, tick)
  const win = resolveWindow({ preset, from: search.from, to: search.to }, now)
  const bucket = bucketForPreset(win.preset)
  const compare = hubCompareOn(search)
  const phone = !useMediaQuery('(min-width: 640px)', true)
  const [asTable, setAsTable] = useState(phone)
  const [hover, setHover] = useState<number | null>(null)
  const [openFlag, setOpenFlag] = useState<number | null>(null)
  // Both are bucket indexes: a new window has other buckets, so neither carries over (review).
  const [forWindow, setForWindow] = useState(win.key)
  if (forWindow !== win.key) {
    setForWindow(win.key)
    setHover(null)
    setOpenFlag(null)
  }

  const mine = useQuery(meQuery).data?.sub === agent.ownerId
  const gate = useHubGate(agent.id, win)
  const ok = gate.state.kind === 'ok'
  const ts = useHubTimeseries(agent.id, win, 'current', gate.canFetch)
  const prev = useHubTimeseries(
    agent.id,
    win,
    'previous',
    gate.canFetch && compare && bucket === 'day',
  )
  const savings = useHubSavings(agent.id, win, gate.canFetch)
  // Coding harnesses run no history selection, so there is no savings series to ask for (QA ISSUE-004).
  const savedSeries = useHubSavedSeries(agent.id, win, bucket, gate.canFetch && !agent.isHarness)
  const markers = useHubMarkers(agent.id, win, agent.isHarness)
  // Only data the gate vouches for renders: nothing fetched after its last success while it revalidates.
  const tsData = ts.data && gate.authorizes(ts.dataUpdatedAt) ? ts.data : undefined
  const prevData = prev.data && gate.authorizes(prev.dataUpdatedAt) ? prev.data : null
  const savedPoints =
    savedSeries.data && gate.authorizes(savedSeries.dataUpdatedAt) ? savedSeries.data : null
  const savedTotal = gate.authorizes(savings.dataUpdatedAt) ? savings.data : undefined
  /** Figures may show: the gate passed and this window's timeseries loaded (never the empty rows' zeros). */
  const figures = !!tsData

  const dayRows: HubRow[] = tsData
    ? rowsFor({
        series: tsData,
        win,
        createdAt: agent.createdAt,
        previous: compare ? prevData : null,
        saved: savedPoints,
      })
    : emptyRows(win, bucket, agent.createdAt)
  const truncated = dayRows.length > 0 && (dayRows.at(-1)?.end ?? 0) < win.end.getTime()
  // Phones draw weeks (design "Responsive"); the Table view keeps the days.
  const rows = phone && !asTable ? weeklyRows(dayRows) : dayRows
  const set =
    markers.kind === 'ready' ? markers.set : markers.kind === 'failed' ? markers.set : null
  const flags = set ? flagsFor(set.markers, rows) : []
  const selected = rowOfSlice(search.slice, rows, win)
  const markerState = markerIdState(search.marker, markers.kind === 'ready' ? markers.set : null)

  // A slice that isn't one of this window's buckets, or a marker that can't be shown, leaves the URL (replace).
  const staleSlice = !!search.slice && selected < 0
  const dropMarker = markerState === 'drop'
  useEffect(() => {
    if (staleSlice || dropMarker)
      setSearch(
        {
          ...(staleSlice ? { slice: undefined } : {}),
          ...(dropMarker ? { marker: undefined } : {}),
        },
        { replace: true },
      )
  }, [staleSlice, dropMarker, setSearch])
  // A `?marker=` deep link selects its bucket (so the panel lists it, in the Table view too) and opens its flag once,
  // with a focus ring (X3).
  const linked =
    markerState === 'found' && set ? set.markers.find((x) => x.id === search.marker) : undefined
  const linkedIndex = linked ? bucketIndexOf(linked.at, rows) : -1
  const linkedRow = rows[linkedIndex]
  const linkedSlice = linkedRow ? sliceOf(linkedRow) : null
  const [appliedMarker, setAppliedMarker] = useState<string | null>(null)
  if (linkedIndex >= 0 && search.marker && appliedMarker !== search.marker) {
    setAppliedMarker(search.marker)
    setOpenFlag(linkedIndex)
  }
  useEffect(() => {
    if (linkedSlice) setSearch({ slice: linkedSlice }, { replace: true })
  }, [linkedSlice, setSearch])

  const pick = (i: number) => {
    const r = rows[i]
    if (!r) return
    if (i === selected) return
    setSearch({ slice: sliceOf(r) })
    announce(copy.bucket.announce(r.label))
  }
  const clear = () => {
    setSearch({ slice: undefined }, { replace: true })
    announce(copy.bucket.announceCleared)
  }
  const openFlagAt = (i: number | null) => {
    setOpenFlag(i)
    if (i !== null) pick(i)
    else if (search.marker) setSearch({ marker: undefined }, { replace: true })
  }

  const money = gate.state.kind === 'ok' ? gate.state.money : null
  // The previous window only partly existed for this agent: no comparison in the sentence, none in the headers.
  const partialPrev = Date.parse(agent.createdAt) > win.prevStart.getTime()
  const sentences = hubNarrative({
    preset: win.preset,
    windowLabel: win.label,
    win,
    money,
    createdAt: agent.createdAt,
    latest: set ? latestMarker(set) : null,
  })
  const totals = totalsOf(dayRows)
  const unpriced = !!money?.unpriced
  const today = now.toISOString().slice(0, 10)

  return (
    <section aria-labelledby="hub-title" className="space-y-3">
      <h2 id="hub-title" className="sr-only">
        {copy.section}
      </h2>
      {sentences.length ? <p className="m-0 text-sm">{sentences.join(' ')}</p> : null}
      {/* TokenOps' window bar, sticky (design), with Compare and the Table view. */}
      <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <TimeControl
          preset={preset}
          invalid={preset === 'custom' && win.preset !== 'custom'}
          from={search.from}
          to={search.to}
          today={today}
          // A new window clears the picked bucket in the same replace (eng "URL interactions").
          onChange={(n) =>
            setSearch(
              { preset: n.preset, from: n.from, to: n.to, slice: undefined },
              { replace: preset === 'custom' && n.preset === 'custom' },
            )
          }
        />
        <Toggle
          variant="outline"
          size="sm"
          pressed={compare}
          onPressedChange={(on) => setSearch({ compare: on ? true : undefined }, { replace: true })}
          title={bucket === 'hour' ? copy.bar.compare24h : copy.bar.compareHint}
          className="pointer-coarse:min-h-11"
        >
          {copy.bar.compare}
        </Toggle>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto pointer-coarse:min-h-11"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}
          {asTable ? copy.bar.chart : copy.bar.table}
        </Button>
      </div>

      <GateBody state={gate.state} retry={gate.retry} ownerLabel={ownerLabel} mine={mine}>
        {ts.isError ? (
          <PanelError error={ts.error} onRetry={() => void ts.refetch()} what={copy.section} />
        ) : null}
      </GateBody>
      {compare && prev.isError ? (
        <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
          {copy.states.previousError}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs pointer-coarse:min-h-11"
            onClick={() => void prev.refetch()}
          >
            {copy.states.retry}
          </Button>
        </p>
      ) : null}
      {truncated ? (
        <p className="m-0 text-xs text-muted-foreground">{copy.lanes.truncated(dayRows.length)}</p>
      ) : null}

      {/* Not visible, deleted or failed: the lanes collapse to the gate's line (design "Lane states"). */}
      {gate.state.kind === 'pending' || (ok && !tsData && !ts.isError) ? (
        <LaneSkeletons />
      ) : !ok ? null : asTable ? (
        <HubTable
          rows={rows}
          flags={flags}
          money={figures}
          unpriced={unpriced}
          saved={!!savedPoints}
          selected={selected}
          onPick={pick}
        />
      ) : (
        <LaneChart<HubRow>
          rows={rows}
          rowKey={(r) => r.iso}
          lanes={
            figures && money
              ? lanesFor(
                  totals,
                  money,
                  savedTotal,
                  !!savedPoints,
                  compare && !partialPrev,
                  agent.isHarness,
                  bucket,
                )
              : []
          }
          height={LANE_HEIGHT}
          hatched={(r) => r.before}
          axisLabel={(r) => r.label}
          bucketName={(r) =>
            figures
              ? copy.bucketButton(
                  r.label,
                  fmtMoneyFloor(r.spend, unpriced),
                  copy.lanes.requestsCount(r.requests),
                )
              : r.label
          }
          axisLabelText={copy.keyboard}
          hoverIndex={hover}
          selectedIndex={selected >= 0 ? selected : null}
          onHover={setHover}
          onPick={pick}
          tooltip={
            figures
              ? (r) => <BucketTooltip row={r} saved={!!savedPoints} unpriced={unpriced} />
              : undefined
          }
          rail={
            <MarkerRail
              flags={flags}
              rows={rows}
              bucket={bucket}
              agentId={agent.id}
              agentName={agent.name}
              now={now}
              openIndex={openFlag}
              focusId={search.marker ?? null}
              onOpen={openFlagAt}
            />
          }
        />
      )}

      {/* Empty means none recorded in the window, not none drawn: a truncated window draws fewer (QA ISSUE-003). */}
      <RailLine markers={markers} harness={agent.isHarness} empty={!set?.markers.length} />
      {figures ? (
        <SavingsLine
          savings={savings}
          total={savedTotal}
          series={!!savedPoints}
          onRetry={() => void savings.refetch()}
        />
      ) : null}

      {selected >= 0 && rows[selected] ? (
        <BucketPanel
          row={rows[selected]}
          flag={flags.find((f) => f.index === selected) ?? null}
          money={figures}
          unpriced={unpriced}
          agentId={agent.id}
          agentName={agent.name}
          now={now}
          onClose={clear}
        />
      ) : null}
    </section>
  )
}

function lanesFor(
  t: LaneTotals,
  money: HubMoney,
  saved: SavedTotal | null | undefined,
  series: boolean,
  compare: boolean,
  harness: boolean,
  bucket: 'hour' | 'day',
): LaneSpec<HubRow>[] {
  // Window totals are the dashboard's, the same numbers the sentence states (review: one source per figure).
  const spend = fmtMoneyFloor(money.current, money.unpriced)
  const lanes: LaneSpec<HubRow>[] = [
    {
      key: 'spend',
      kind: 'bar',
      series: SPEND,
      value: (r) => r.spend,
      ghost: compare ? (r) => r.prevSpend : undefined,
      header: (
        <LaneHeader series={SPEND} name={copy.lanes.spend} value={spend}>
          {compare ? (
            <Delta changePct={money.changePct} polarity="neutral" current={money.current} />
          ) : null}
          {harness ? <span className="text-muted-foreground">{copy.lanes.estCost}</span> : null}
        </LaneHeader>
      ),
    },
    {
      key: 'requests',
      kind: 'bar',
      series: REQUESTS,
      value: (r) => r.requests,
      ghost: compare ? (r) => r.prevRequests : undefined,
      header: (
        <LaneHeader
          series={REQUESTS}
          name={copy.lanes.requests}
          value={money.requests === 0 ? copy.lanes.zeroRequests : fmtInt(money.requests)}
          hint={copy.lanes.requestsHint}
        >
          {compare ? (
            <Delta
              changePct={money.requestsChangePct}
              polarity="neutral"
              current={money.requests}
            />
          ) : null}
        </LaneHeader>
      ),
    },
    {
      key: 'p95',
      kind: 'line',
      series: P95,
      value: (r) => r.p95,
      header: (
        <LaneHeader series={P95} line name={copy.lanes.p95} value={fmtLatency(t.peakP95)}>
          <span className="text-muted-foreground">
            {bucket === 'hour' ? copy.lanes.peakHourlyP95 : copy.lanes.peakP95}
          </span>
        </LaneHeader>
      ),
    },
  ]
  // Daily savings exist only as the proposed per-agent series (mock mode): live mode has no savings lane.
  if (series)
    lanes.push({
      key: 'saved',
      kind: 'bar',
      series: SAVED,
      value: (r) => r.saved,
      header: (
        <LaneHeader
          series={SAVED}
          name={copy.lanes.saved}
          value={saved ? fmtTokens(saved.saved) : copy.notReported}
          hint={copy.lanes.savedTooltip}
        >
          {saved ? (
            <span className="text-muted-foreground">{copy.lanes.savedBasis(saved.basis)}</span>
          ) : null}
          <Badge variant="outline" className="text-3xs">
            {copy.rail.preview}
          </Badge>
        </LaneHeader>
      ),
    })
  return lanes
}

function LaneHeader({
  series,
  line,
  name,
  value,
  hint,
  children,
}: {
  series: typeof SPEND
  line?: boolean
  name: string
  value: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium" title={hint}>
        <Swatch series={series} line={line} /> {name}
      </span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
      {children}
    </div>
  )
}

function BucketTooltip({
  row,
  saved,
  unpriced,
}: {
  row: HubRow
  saved: boolean
  unpriced: boolean
}) {
  return (
    <div className="space-y-1">
      <div className="font-medium">{row.label}</div>
      {row.before ? (
        <span className="text-muted-foreground">{copy.lanes.notDeployedYet}</span>
      ) : (
        <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
          <span className="text-muted-foreground">{copy.lanes.spend}</span>
          <span>{fmtMoneyFloor(row.spend, unpriced)}</span>
          <span className="text-muted-foreground">{copy.lanes.requests}</span>
          <span>{fmtInt(row.requests)}</span>
          <span className="text-muted-foreground">{copy.lanes.p95}</span>
          <span>{fmtLatency(row.p95)}</span>
          {saved ? (
            <>
              <span className="text-muted-foreground">{copy.lanes.saved}</span>
              <span>{fmtTokens(row.saved)}</span>
            </>
          ) : null}
          {row.prevSpend !== null ? (
            <>
              <span className="text-muted-foreground">{copy.lanes.previousWindow}</span>
              <span>{fmtMoneyFloor(row.prevSpend, unpriced)}</span>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

function LaneSkeletons() {
  // One skeleton per lane, no flash of zeros before the gate (design "Lane states").
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="w-full rounded-md" style={{ height: LANE_HEIGHT + 20 }} />
      ))}
    </div>
  )
}

function GateBody({
  state,
  retry,
  ownerLabel,
  mine,
  children,
}: {
  state: GateState
  retry: () => void
  ownerLabel: string
  mine: boolean
  children?: ReactNode
}) {
  if (state.kind === 'not-visible')
    return (
      <p className="m-0 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        {/* The dashboard checks every agent with this name: an owner is refused when another user's agent shares it. */}
        {mine
          ? copy.states.notVisibleSameName
          : ownerLabel
            ? copy.states.notVisibleOwner(ownerLabel)
            : copy.states.notVisible}
      </p>
    )
  if (state.kind === 'deleted')
    return <p className="m-0 text-sm text-muted-foreground">{copy.states.deleted}</p>
  if (state.kind === 'error')
    // A 5xx or deadline is never the not-visible copy: one error, and Retry re-runs the gate then its reads (DX).
    return <PanelError error={state.error} onRetry={retry} what={copy.section} />
  return <>{children}</>
}

function RailLine({
  markers,
  harness,
  empty,
}: {
  markers: MarkersState
  harness: boolean
  empty: boolean
}) {
  if (markers.kind === 'pending') return null
  if (markers.kind === 'failed')
    return (
      <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
        {markers.which === 'deploys' ? copy.rail.deploysFailed : copy.rail.changesFailed}
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs pointer-coarse:min-h-11"
          onClick={markers.retry}
        >
          {copy.states.retry}
        </Button>
      </p>
    )
  const lines: string[] = []
  if (harness && empty && !markers.preview) lines.push(copy.rail.harness)
  else if (!harness) {
    // OSS never writes `crashed_at`: name the crash only when this server recorded one (eng "Markers").
    lines.push(
      markers.set.markers.some((m) => m.kind === 'crash')
        ? copy.rail.showing
        : copy.rail.showingOss,
    )
    if (markers.set.buildsCapped) lines.push(copy.rail.capped(BUILDS_READ))
    if (empty) lines.push(copy.rail.noDeploys)
  }
  if (markers.eventsTruncated) lines.push(copy.rail.eventsTruncated)
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>{lines.join(' · ')}</span>
      {markers.preview ? (
        <Badge variant="outline" className="text-3xs" title={copy.rail.previewHint}>
          {copy.rail.preview}
        </Badge>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="size-5 p-0 pointer-coarse:size-11"
              aria-label={copy.rail.otherLater}
            >
              <Info className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copy.rail.otherLater}</TooltipContent>
        </Tooltip>
      )}
    </p>
  )
}

function SavingsLine({
  savings,
  total,
  series,
  onRetry,
}: {
  savings: ReturnType<typeof useHubSavings>
  /** The row the gate vouches for (undefined while a revalidation is pending). */
  total: SavedTotal | null | undefined
  series: boolean
  onRetry: () => void
}) {
  if (savings.isPending) return null
  if (savings.isError)
    return (
      <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
        {copy.states.savingsError}
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs pointer-coarse:min-h-11"
          onClick={onRetry}
        >
          {copy.states.retry}
        </Button>
      </p>
    )
  // With a savings lane the total sits in its header; live mode states the window total and the missing series.
  if (series || total === undefined) return null
  const s = total
  return (
    <p
      className="m-0 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground"
      title={copy.lanes.savedTooltip}
    >
      <Swatch series={SAVED} />
      {s ? (
        <>
          <span className="font-medium text-foreground">
            {copy.lanes.saved} {fmtTokens(s.saved)}
          </span>
          <span>{copy.lanes.savedBasis(s.basis)}</span>
          <span>· {copy.lanes.noDailySavings}</span>
        </>
      ) : (
        <span>{copy.lanes.savedNotReported}</span>
      )}
    </p>
  )
}
