/**
 * The burn chart's Table view (plan feat-budget-burn F1, design 6B): one row per day, history then the projected
 * days, with the projection's bounds named in their headers. Each date is a button that picks the day (the same
 * drill-down as a bar), so the investigation works from the keyboard, and the chart's event flags are a list under
 * the table (design 6B parity). Unpriced calls make spend a floor and what's left a ceiling (plan F2). Download CSV
 * goes through TokenOps' writer, which neutralises formula-like labels.
 */
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  CELL,
  ChartTable,
  HEAD,
  NUM,
  ROW_HEAD,
  STICKY_HEAD,
} from '@/features/tokenops/components/ChartTable'
import { downloadCsv, toCsv } from '@/features/tokenops/csv'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { TableRow as Row } from '../burn'
import { copy } from '../copy'
import { BURN_CSV } from '../csv'

// Over the limit reads "−$2.00", as the chart's axis does (design 5C).
const money = (v: number | null, bound: '≥ ' | '≤ ' | '' = '') =>
  v === null ? '—' : `${bound}${v < 0 ? `−${fmtMoney(-v)}` : fmtMoney(v)}`

export function BurnTable({
  rows,
  scopeLabel,
  fileName,
  onPickDay,
  pickedDay,
  floor = false,
  events = [],
}: {
  rows: Row[]
  scopeLabel: string
  fileName: string
  onPickDay?: (day: string) => void
  pickedDay?: string | null
  /** Unpriced calls this period. */
  floor?: boolean
  /** The chart's flags, one entry per day (`burnChartData(m).markers`). */
  events?: { day: string; labels: string[] }[]
}) {
  const budgeted = rows.some((r) => r.left !== null || r.pace !== null)
  const atLeast = floor ? '≥ ' : ''
  const atMost = floor ? '≤ ' : ''
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(fileName, toCsv(BURN_CSV, rows))}
        >
          <Download className="size-4" aria-hidden /> {copy.tableDownload}
        </Button>
      </div>
      <ChartTable>
        <caption className="sr-only">{copy.tableCaption(scopeLabel)}</caption>
        <TableHeader className={STICKY_HEAD}>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={HEAD}>
              {copy.tableDate}
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, NUM)}>
              {copy.tableSpend}
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, NUM)}>
              {copy.tableCumulative}
            </TableHead>
            {budgeted ? (
              <>
                <TableHead scope="col" className={cn(HEAD, NUM)}>
                  {copy.tableLeft}
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, NUM)}>
                  {copy.tablePace}
                </TableHead>
              </>
            ) : null}
            <TableHead scope="col" className={cn(HEAD, NUM)}>
              {copy.tableLow}
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, NUM)}>
              {copy.tableHigh}
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              {copy.tableSpike}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const projected = r.low !== null
            return (
              <TableRow key={r.date} data-state={r.date === pickedDay ? 'selected' : undefined}>
                <TableHead scope="row" className={ROW_HEAD}>
                  {onPickDay && !projected ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      onClick={() => onPickDay(r.date)}
                    >
                      {fmtShortDay(r.date)}
                    </Button>
                  ) : (
                    <>
                      {fmtShortDay(r.date)}
                      {projected ? (
                        <span className="ml-1 text-muted-foreground">{copy.tableProjected}</span>
                      ) : null}
                    </>
                  )}
                </TableHead>
                <TableCell className={cn(CELL, NUM)}>
                  {projected ? '—' : fmtMoney(r.spend)}
                </TableCell>
                <TableCell className={cn(CELL, NUM)}>
                  {projected ? '—' : money(r.cumulative, atLeast)}
                </TableCell>
                {budgeted ? (
                  <>
                    <TableCell className={cn(CELL, NUM)}>{money(r.left, atMost)}</TableCell>
                    <TableCell className={cn(CELL, NUM)}>{money(r.pace)}</TableCell>
                  </>
                ) : null}
                <TableCell className={cn(CELL, NUM)}>{money(r.low, atLeast)}</TableCell>
                <TableCell className={cn(CELL, NUM)}>{money(r.high, atLeast)}</TableCell>
                <TableCell className={CELL}>{r.spike ? copy.burnSpike : ''}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </ChartTable>
      {floor ? <p className="text-xs text-muted-foreground">{copy.tableFloor}</p> : null}
      {events.length ? (
        <section aria-label={copy.tableEvents} className="space-y-1 text-sm">
          <h3 className="text-xs font-medium text-muted-foreground">{copy.tableEvents}</h3>
          <ul className="space-y-1">
            {events.map((e) => (
              <li key={e.day} className="flex gap-3">
                <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
                  {fmtShortDay(e.day)}
                </span>
                {e.labels.join(' · ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
