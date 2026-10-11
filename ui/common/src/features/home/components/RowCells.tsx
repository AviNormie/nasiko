/**
 * The home's PR2b cells (plans/feat-agent-centric.md PR2, design "Home"): spend with its sparkline, budget use, and
 * last change. The two that read per row (series, builds) mount their query only while the row is on screen
 * (`useOnScreen`), through the page's limiter of 4; scrolling away cancels the read.
 */
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { relTime } from '@/features/agents/format'
import { latestMarker, markersFor, markerText } from '@/features/hub/events'
import type { Range } from '@/features/overview/search'
import type { ResolvedWindow } from '@/features/tokenops/window'
import { fmtMoney, fmtMoneyFloor } from '@/lib/format'
import { useRowBuilds, useRowSeries, type BudgetsState } from '../api'
import { copy } from '../copy'
import { budgetMonth, sparkPoints, type HomeRow } from '../rows'
import { useOnScreen } from '../useOnScreen'
import { Sparkline } from './Sparkline'

export function SpendCell({
  row,
  series,
  win,
}: {
  row: HomeRow
  /** Draw the sparkline: superusers only (the series isn't ACL-scoped; members get the total alone). */
  series: boolean
  win: Pick<ResolvedWindow, 'key' | 'params' | 'start' | 'end'>
}) {
  const [ref, on] = useOnScreen<HTMLSpanElement>()
  if (row.spend === null) return '—'
  return (
    <span ref={ref} className="inline-flex items-center justify-end gap-2">
      {series && on && row.spend > 0 ? <RowSpark id={row.id} win={win} /> : null}
      <span>
        {fmtMoney(row.spend)}
        {row.harness && row.spend > 0 ? (
          <span className="ml-1 text-xs text-muted-foreground">{copy.table.estimate}</span>
        ) : null}
      </span>
    </span>
  )
}

function RowSpark({
  id,
  win,
}: {
  id: string
  win: Pick<ResolvedWindow, 'key' | 'params' | 'start' | 'end'>
}) {
  const q = useRowSeries(id, win)
  // Loading or failed: the total beside it stands alone (a sparkline is never the only place a number lives).
  return q.data ? <Sparkline values={sparkPoints(q.data, win)} /> : null
}

const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** "$640 of $1,000 · Oct", then the X5 line. Never says the budget stops or controls spend. */
export function BudgetUse({ row, state }: { row: HomeRow; state: BudgetsState }) {
  const b = row.budget
  if (state !== 'ok') return '—'
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
            : copy.budget.crosses(shortDate(b.crossing.date))}
        </span>
      ) : null}
    </span>
  )
}

/**
 * The newest change the agent's build records show ("Build completed · v1.4.2 · 3 days ago"), linking to it on the
 * hub (`?marker=`) when it falls inside the hub's window. "—" with the reason otherwise.
 */
export function LastChangeCell({ row, now, range }: { row: HomeRow; now: Date; range: Range }) {
  const [ref, on] = useOnScreen<HTMLSpanElement>()
  if (row.harness) return <Quiet title={copy.lastChange.harness}>—</Quiet>
  return <span ref={ref}>{on ? <LastChange row={row} now={now} range={range} /> : '—'}</span>
}

function LastChange({ row, now, range }: { row: HomeRow; now: Date; range: Range }) {
  const q = useRowBuilds(row.id)
  if (q.isPending) return <Quiet>{copy.lastChange.loading}</Quiet>
  if (q.isError) return <Quiet title={copy.lastChange.failed}>—</Quiet>
  if (!q.data.available) return <Quiet title={copy.lastChange.hidden}>—</Quiet>
  const m = latestMarker(
    markersFor({
      builds: q.data.value,
      versions: null,
      crashedAt: null,
      events: null,
      win: { start: new Date(0), end: now },
      harness: false,
    }),
  )
  if (!m) return <Quiet title={copy.lastChange.none}>—</Quiet>
  // The hub opens on 7d or its own 30d default; a marker outside that window would be dropped there, so it isn't sent.
  const preset = range === '7d' ? ('7d' as const) : undefined
  const inHub = m.at >= now.getTime() - (range === '7d' ? 7 : 30) * 86_400_000
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: row.id }}
      search={inHub ? { marker: m.id, preset } : { preset }}
      className="flex flex-col underline-offset-4 hover:underline"
    >
      <span>{markerText(m)}</span>
      <span className="text-xs text-muted-foreground">
        {relTime(new Date(m.at).toISOString(), now.getTime())}
      </span>
    </Link>
  )
}

/** A muted cell; with a `title`, the reason is read out too (a tooltip alone isn't announced). */
const Quiet = ({ children, title }: { children: ReactNode; title?: string }) => (
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
