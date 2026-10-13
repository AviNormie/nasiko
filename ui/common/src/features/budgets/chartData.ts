/**
 * The burn chart's props (plan feat-budget-burn F1): `burn.ts` `chartModel` in the kit's plain shape, with the copy
 * that labels it. Words never cause a bend: event flags name what happened, the chart says nothing about why.
 */
import type { BurnChartData, BurnChartLabels } from '@/components/charts/burn-chart'
import { fmtMoney, fmtMoneyAxis, fmtShortDay } from '@/lib/format'
import type { ChartModel } from './burn'
import { copy } from './copy'
import { DAY_MS } from './projection'
import type { BudgetEvent } from './types'

/** One event's line in a flag's list (design 7B). Unknown kinds (a newer server's) are left out. */
export function eventLabel(e: BudgetEvent): string | null {
  switch (e.kind) {
    case 'threshold':
      return copy.eventThreshold(e.percent ?? 0)
    case 'forecast':
      return copy.eventForecast(e.percent ?? 0, e.crosses_on ? fmtShortDay(e.crosses_on) : '—')
    case 'forecast_cleared':
      return copy.eventForecastCleared(e.percent ?? 0)
    case 'stopped':
      return copy.eventStopped
    case 'resumed':
      return copy.eventResumed
    case 'limit_changed':
      return copy.eventLimit(fmtMoney(e.from_usd ?? 0), fmtMoney(e.to_usd ?? 0))
    case 'action_changed':
      return e.to_action ? copy.eventAction(e.to_action) : null
    case 'period_change_scheduled':
      return copy.eventPeriod(
        e.period ?? '',
        e.effective_from ? fmtShortDay(e.effective_from) : '—',
      )
    case 'fiscal_year_changed':
      return copy.eventFiscal(e.effective_from ? fmtShortDay(e.effective_from) : '—')
    default:
      return null
  }
}

/**
 * A change from outside the budget drawn as a flag on an agent's chart (F1 "Change markers"): the hub's deploys,
 * routing and optimization changes and its latest crash. `budgetStop` marks the event log's own record of a stop.
 */
export interface ExtraMarker {
  at: number
  label: string
  budgetStop?: boolean
}

/** Within this of the budget's own `stopped` event, the event log's stop is the same stop (BG-3 wins, F1). */
const SAME_STOP_MS = 60_000

/**
 * The chart's flags with `extra` merged in, one flag per UTC day (F1: events in a day merge, "+3"). Only changes inside
 * the chart's x axis draw; the event log's stop is dropped when the budget recorded the same stop.
 */
export function withExtraMarkers(
  data: BurnChartData,
  extra: readonly ExtraMarker[],
  events: readonly BudgetEvent[],
): BurnChartData {
  const stops = events.filter((e) => e.kind === 'stopped').map((e) => Date.parse(e.at))
  const byDay = new Map(data.markers.map((m) => [m.day, [...m.labels]]))
  for (const x of extra) {
    if (x.at < data.start || x.at > data.end) continue
    if (x.budgetStop && stops.some((t) => Math.abs(t - x.at) <= SAME_STOP_MS)) continue
    const day = new Date(x.at).toISOString().slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), x.label])
  }
  return {
    ...data,
    markers: [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, labels]) => ({ day, t: Date.parse(`${day}T00:00:00Z`) + DAY_MS / 2, labels })),
  }
}

export function burnChartData(m: ChartModel): BurnChartData {
  return {
    ...m,
    runOut: m.runOut ? { t: m.runOut.at, observed: m.runOut.observed } : null,
    markers: m.markers
      .map((x) => ({
        day: x.day,
        t: x.t,
        labels: x.events.map(eventLabel).filter((l): l is string => l !== null),
      }))
      .filter((x) => x.labels.length > 0),
  }
}

/**
 * The chart's labels. `stops`: the budget stops calls ("ran out" and the stop line appear only there; an alert-only
 * budget "exceeded", design 1C). `summary` is the page's sentence (F12), the chart's accessible description.
 */
export function burnChartLabels(
  m: ChartModel,
  opts: { stops: boolean; summary: string },
): BurnChartLabels {
  const last = m.actual.at(-1)
  const ro = m.runOut
  return {
    actual: m.mode === 'down' && m.limits.length ? copy.burnLeft : copy.burnSpent,
    pace: copy.burnPace,
    band: copy.burnBand,
    limit: copy.burnLimit,
    threshold: copy.burnThreshold,
    thresholds: copy.burnThresholds,
    stop: copy.burnStop,
    over:
      m.mode === 'down' && m.limits.length && last && last.v < 0
        ? (m.floor ? copy.burnOverFloor : copy.burnOver)(fmtMoney(-last.v))
        : null,
    runOut: ro
      ? ro.observed
        ? (opts.stops ? copy.burnRanOut : copy.burnExceeded)(
            fmtShortDay(new Date(ro.at).toISOString()),
          )
        : (m.floor ? copy.burnEstimatedFloor : copy.burnEstimated)(
            fmtShortDay(new Date(ro.at).toISOString()),
          )
      : null,
    preview: copy.burnPreview,
    bars: copy.burnBars,
    spike: copy.burnSpike,
    summary: opts.summary,
  }
}

/** The burn chart's money axis: below $0 reads "−$50", never "$-50" (burndown past the limit, design 5C). */
export const burnAxisMoney = (v: number) => (v < 0 ? `−${fmtMoneyAxis(-v)}` : fmtMoneyAxis(v))
