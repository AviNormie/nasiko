/** An alert row's sentence (plan feat-budget-burn F5), or null for a kind this UI doesn't know (a newer server's). */
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { copy } from './copy'
import type { AlertV1 } from './types'

export function alertText(a: AlertV1): string | null {
  if (a.kind === 'threshold')
    return copy.alertThreshold(a.label, a.percent, fmtMoney(a.amount_usd), a.stopped)
  if (a.kind === 'forecast')
    return copy.alertForecast(
      a.label,
      a.percent,
      a.crosses_on ? fmtShortDay(a.crosses_on) : null,
      fmtShortDay(a.at),
    )
  if (a.kind === 'forecast_cleared') return copy.alertForecastCleared(a.label, a.percent)
  return null
}
