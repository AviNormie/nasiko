/**
 * The burn card (plan feat-budget-burn F1, design 1B): the kit's burn chart with its daily bars, the Burndown/Burn-up
 * toggle and a Table view in the header. The page's sentence is the chart's accessible summary. A picked day (a bar,
 * or a date in the Table) opens the day's drill-down through the page (`?day=`).
 */
import { useId, useState } from 'react'
import { BurnChart } from '@/components/charts/burn-chart'
import { Panel } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { fmtShortDay } from '@/lib/format'
import { chartModel, tableRows, type BurnMode } from '../burn'
import { burnAxisMoney, burnChartData, burnChartLabels } from '../chartData'
import { copy } from '../copy'
import type { Burn } from '../types'
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
}) {
  const id = useId()
  const [table, setTable] = useState(false)
  // Without a budget there is nothing to burn down: the chart is burn-up (F1).
  const shown: BurnMode = burn.budget ? mode : 'up'
  const m = chartModel(burn, shown, { end: domainEnd })
  const data = burnChartData(m)
  return (
    <Panel
      title={copy.burnCard}
      labelledBy={id}
      actions={
        <>
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
          labels={burnChartLabels(m, { stops: burn.budget?.action === 'stop', summary: sentence })}
          formatMoney={burnAxisMoney}
          formatDay={(t) => fmtShortDay(t)}
          pickedDay={pickedDay}
          onPickDay={onPickDay}
        />
      )}
    </Panel>
  )
}
