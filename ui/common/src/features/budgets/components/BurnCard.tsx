/**
 * The burn card (plan feat-budget-burn F1, design 1B): the kit's burn chart with its daily bars, the Burndown/Burn-up
 * toggle and a Table view in the header. The page's sentence is the chart's accessible summary. A picked day (a bar,
 * or a date in the Table) opens the day's drill-down through the page (`?day=`).
 */
import { X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { BurnChart, type BurnChartPoint } from '@/components/charts/burn-chart'
import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { fmtShortDay } from '@/lib/format'
import { chartModel, tableRows, type BurnMode } from '../burn'
import { stackBars } from '../causes'
import {
  burnAxisMoney,
  burnChartData,
  burnChartLabels,
  withExtraMarkers,
  type ExtraMarker,
} from '../chartData'
import { copy } from '../copy'
import type { Breakdown, Burn } from '../types'
import { BurnTable } from './BurnTable'

export function BurnCard({
  burn,
  mode,
  onMode,
  sentence,
  domainEnd,
  pickedDay,
  onPickDay,
  fileName,
  breakdown,
  share,
  onClearShare,
  footer,
  preview,
  whatIf,
  extraMarkers,
}: {
  burn: Burn
  mode: BurnMode
  onMode: (m: BurnMode) => void
  sentence: string
  /** The x axis's end when it runs past this period (a month budget by quarter). */
  domainEnd?: number
  pickedDay: string | null
  onPickDay: (day: string) => void
  fileName: string
  /** The daily bars stacked by contributor (F3); absent → one series. */
  breakdown?: Breakdown
  /** A picked contributor's cumulative line (design 3B). */
  share?: { name: string; line: BurnChartPoint[] } | null
  onClearShare?: () => void
  /** Under the chart: the contributors list. */
  footer?: ReactNode
  /** A what-if or lever's dashed "Preview, not applied" line (F4, F6). */
  preview?: BurnChartPoint[] | null
  /** The card's last row: What if… (F6). */
  whatIf?: ReactNode
  /** An agent's own changes beside the budget's events (the hub's markers, F1). */
  extraMarkers?: readonly ExtraMarker[]
}) {
  const id = useId()
  const [table, setTable] = useState(false)
  // Without a budget there is nothing to burn down: the chart is burn-up (F1).
  const shown: BurnMode = burn.budget ? mode : 'up'
  const m = chartModel(burn, shown, { end: domainEnd })
  const own = burnChartData(m)
  const base = stackBars(
    extraMarkers ? withExtraMarkers(own, extraMarkers, burn.events) : own,
    breakdown,
  )
  // The share line is spend, so it draws on Burn-up only; Burndown says where to find it.
  const data = share && shown === 'up' ? { ...base, share: share.line } : base
  return (
    <Panel
      title={copy.burnCard}
      labelledBy={id}
      actions={
        <>
          {/* The picked contributor, outside the heading so the panel's name stays "Burn" (review). */}
          {share ? (
            <Badge variant="secondary" className="gap-1 pr-0.5">
              {copy.shareChip(share.name)}
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={copy.shareClearLabel(share.name)}
                onClick={onClearShare}
              >
                <X className="size-3" aria-hidden />
              </Button>
            </Badge>
          ) : null}
          {burn.budget ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={mode}
              onValueChange={(v) => v && onMode(v as BurnMode)}
              aria-label={copy.burnModeLabel}
            >
              <ToggleGroupItem value="down" className="px-3 text-xs">
                {copy.burnDown}
              </ToggleGroupItem>
              <ToggleGroupItem value="up" className="px-3 text-xs">
                {copy.burnUp}
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <Button variant="outline" size="sm" aria-pressed={table} onClick={() => setTable(!table)}>
            {table ? copy.showChart : copy.showTable}
          </Button>
        </>
      }
    >
      {table ? (
        <BurnTable
          rows={tableRows(burn)}
          scopeLabel={burn.label}
          fileName={fileName}
          onPickDay={onPickDay}
          pickedDay={pickedDay}
          floor={burn.unpriced_calls > 0}
          events={data.markers}
        />
      ) : (
        <BurnChart
          data={data}
          labels={{
            ...burnChartLabels(m, { stops: burn.budget?.action === 'stop', summary: sentence }),
            share: share ? copy.shareLine(share.name) : undefined,
          }}
          formatMoney={burnAxisMoney}
          formatDay={(t) => fmtShortDay(t)}
          pickedDay={pickedDay}
          onPickDay={onPickDay}
          preview={preview}
        />
      )}
      {share && shown === 'down' ? (
        <p className="text-xs text-muted-foreground">{copy.shareBurnUpHint(share.name)}</p>
      ) : null}
      {footer}
      {whatIf}
    </Panel>
  )
}
