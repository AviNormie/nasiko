/**
 * The burn chart's props (plan feat-budget-burn F1): `burn.ts` `chartModel` in the kit's plain shape, with the copy
 * that labels it. Words never cause a bend: event flags name what happened, the chart says nothing about why.
 */
import type { BurnChartData, BurnChartLabels } from '@/components/charts/burn-chart'
import { fmtMoney, fmtMoneyAxis, fmtShortDay } from '@/lib/format'
import type { ChartModel } from './burn'
import { copy } from './copy'
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
        ? copy.burnOver(fmtMoney(-last.v))
        : null,
    runOut: ro
      ? ro.observed
        ? (opts.stops ? copy.burnRanOut : copy.burnExceeded)(
            fmtShortDay(new Date(ro.at).toISOString()),
          )
        : copy.burnEstimated(fmtShortDay(new Date(ro.at).toISOString()))
      : null,
    preview: copy.burnPreview,
    bars: copy.burnBars,
    spike: copy.burnSpike,
    summary: opts.summary,
  }
}

/** The burn chart's money axis: below $0 reads "−$50", never "$-50" (burndown past the limit, design 5C). */
export const burnAxisMoney = (v: number) => (v < 0 ? `−${fmtMoneyAxis(-v)}` : fmtMoneyAxis(v))
