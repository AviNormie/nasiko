/**
 * The home's PR2b cells (plans/feat-agent-centric.md PR2, design "Home"): spend with its sparkline, budget use, and
 * last change. The two that read per row (series, builds) mount their query only once the row is on screen
 * (`useOnScreen`), through the page's limiter (`ROW_READS`); scrolling away before a read answers cancels it.
 */
import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { relTime } from '@/features/agents/format'
import { latestMarker, markersFor, markerText } from '@/features/hub/events'
import { HUB_DEFAULT_PRESET } from '@/features/hub/search'
import type { Range } from '@/features/overview/search'
import { resolveWindow, type ResolvedWindow } from '@/features/tokenops/window'
import { fmtMoney, fmtMoneyFloor, fmtShortDay } from '@/lib/format'
import { budgetsShown, useRowBuilds, useRowSeries, type BudgetsState } from '../api'
import { copy } from '../copy'
import { budgetMonth, sparkPoints, type HomeRow } from '../rows'
import { SPARK_H, SPARK_W, TOUCH } from '../tuning'
import { useOnScreen } from '../useOnScreen'
import { Sparkline } from './Sparkline'

type Win = Pick<ResolvedWindow, 'start' | 'end'>

export function SpendCell({
  row,
  series,
  win,
}: {
  row: HomeRow
  /** Draw the sparkline: superusers only (the series isn't ACL-scoped; members get the total alone). */
  series: boolean
  win: Win
}) {
  if (row.spend === null) return '—'
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {series && row.spend > 0 ? <SparkSlot id={row.id} win={win} /> : null}
      <SpendFigure row={row} />
    </span>
  )
}

/** The spend figure, with the harness estimate basis ("est."): the table's cell and the phone row's line. */
export function SpendFigure({ row }: { row: HomeRow }) {
  return (
    <span>
      {row.spend === null ? '—' : fmtMoney(row.spend)}
      {row.harness && (row.spend ?? 0) > 0 ? (
        <span className="ml-1 text-xs text-muted-foreground">{copy.table.estimate}</span>
      ) : null}
    </span>
  )
}

/** The sparkline's box, reserved before the series answers, so the columns never shift when it draws. */
function SparkSlot({ id, win }: { id: string; win: Win }) {
  const [ref, on] = useOnScreen<HTMLSpanElement>()
  return (
    <span ref={ref} className="inline-block shrink-0" style={{ width: SPARK_W, height: SPARK_H }}>
      {on ? <RowSpark id={id} win={win} /> : null}
    </span>
  )
}

function RowSpark({ id, win }: { id: string; win: Win }) {
  const q = useRowSeries(id, win)
  // Loading or failed: the total beside it stands alone (a sparkline is never the only place a number lives).
  return q.data ? <Sparkline values={sparkPoints(q.data, win)} /> : null
}

/** "$640 of $1,000 · Oct", then the X5 line. Never says the budget stops or controls spend. */
export function BudgetUse({ row, state }: { row: HomeRow; state: BudgetsState }) {
  const b = row.budget
  if (!budgetsShown(state)) return '—'
  if (!b)
    return row.mine ? (
      <Quiet>{copy.budget.none}</Quiet>
    ) : (
      <Quiet title={copy.budget.onlyYours}>—</Quiet>
    )
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">
        {copy.budget.use(
          fmtMoneyFloor(b.used, b.unpriced),
          fmtMoney(b.limit),
          budgetMonth(b.resetsAt),
        )}
      </span>
      {b.crossing ? (
        <span
          className={
            b.crossing.kind === 'reached'
              ? 'text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {b.crossing.kind === 'reached'
            ? copy.budget.reached
            : copy.budget.crosses(fmtShortDay(b.crossing.date))}
        </span>
      ) : null}
    </span>
  )
}

/**
 * The newest change the agent's build records show ("Build completed · v1.4.2 · 3 days ago"), linking to it on the
 * hub (`?marker=`) when it falls inside the window the hub opens on. "—" with the reason otherwise. Once a row has been
 * on screen it keeps its value: scrolling away only cancels a read that hasn't answered yet.
 */
export function LastChangeCell({ row, now, range }: { row: HomeRow; now: Date; range: Range }) {
  const [ref, on] = useOnScreen<HTMLSpanElement>()
  const [seen, setSeen] = useState(false)
  if (on && !seen) setSeen(true)
  if (row.harness) return <Quiet title={copy.lastChange.harness}>—</Quiet>
  return (
    <span ref={ref}>
      {on || seen ? (
        <LastChange row={row} now={now} range={range} offScreen={!on} />
      ) : (
        <Quiet title={copy.lastChange.notYet}>…</Quiet>
      )}
    </span>
  )
}

function LastChange({
  row,
  now,
  range,
  offScreen,
}: {
  row: HomeRow
  now: Date
  range: Range
  /** Scrolled away again: keep a value already read, and say a pending one waits for the row. */
  offScreen: boolean
}) {
  const q = useRowBuilds(row.id)
  if (q.isPending)
    return offScreen ? (
      <Quiet title={copy.lastChange.notYet}>…</Quiet>
    ) : (
      <Quiet>{copy.lastChange.loading}</Quiet>
    )
  if (q.isError) return <Quiet title={copy.lastChange.failed}>—</Quiet>
  if (!q.data.available) return <Quiet title={copy.lastChange.hidden}>—</Quiet>
  const m = latestMarker(
    markersFor({
      builds: q.data.value,
      versions: null,
      crashedAt: null,
      events: null,
      // No upper bound: a build that finished after this visit's frozen "now" is still the newest change.
      win: { start: new Date(0), end: new Date(8.64e15) },
      harness: false,
    }),
  )
  if (!m) return <Quiet title={copy.lastChange.none}>—</Quiet>
  // The hub opens on 7d, or on its own default; a marker outside that window would be dropped there, so it isn't sent.
  const preset = range === '7d' ? ('7d' as const) : undefined
  const inHub = m.at >= resolveWindow({ preset: preset ?? HUB_DEFAULT_PRESET }, now).start.getTime()
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: row.id }}
      search={inHub ? { marker: m.id, preset } : { preset }}
      className={`flex flex-col justify-center underline-offset-4 hover:underline ${TOUCH}`}
    >
      <span>{markerText(m)}</span>
      <span className="text-xs text-muted-foreground">
        {relTime(new Date(m.at).toISOString(), Math.max(now.getTime(), m.at))}
      </span>
    </Link>
  )
}

/** A muted cell; with a `title`, the reason is read out too (a tooltip alone isn't announced). */
export function Quiet({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="text-muted-foreground" title={title}>
      {title ? (
        <>
          <span aria-hidden>{children}</span>
          <span className="sr-only">{title}</span>
        </>
      ) : (
        children
      )}
    </span>
  )
}
