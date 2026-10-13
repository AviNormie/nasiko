/**
 * Alerts for the scope (plan feat-budget-burn F5, F10; moved from the router's budgets section): thresholds crossed and
 * forecasts, every budget inside the scope, newest first (§8.4, `kind=all`). A forecast keeps the date the server
 * projected when it fired ("projected on Oct 12 for around Oct 24"); the chart's run-out is recomputed live and may
 * differ. A kind this UI doesn't know is left out. Alerts are records: editing a budget never rewrites them.
 */
import { useId, type ReactNode } from 'react'
import { Panel, PanelError, PanelSkeleton } from '@/components/shared/panel'
import { isEndpointAbsent } from '@/lib/api/detect'
import { fmtShortDay } from '@/lib/format'
import { alertText } from '../alerts'
import { copy } from '../copy'
import { Partial } from './Partial'
import type { AlertV1 } from '../types'

export function ScopeAlerts({
  alerts,
  partial,
  missing = false,
  error,
  pending,
  onRetry,
  actions,
}: {
  alerts: readonly AlertV1[] | undefined
  partial: boolean
  /** An R-L10 server's alerts lack 1.0's fields (label, kind, percent): one line instead (F11). */
  missing?: boolean
  error: unknown
  pending: boolean
  onRetry: () => void
  actions?: (a: AlertV1) => ReactNode
}) {
  const id = useId()
  const rows = (alerts ?? []).flatMap((a) => {
    const text = alertText(a)
    return text ? [{ a, text }] : []
  })
  return (
    <Panel title={copy.alertsTitleV1} subtitle={copy.alertsSubtitleV1} labelledBy={id}>
      {missing ? (
        <p className="text-xs text-muted-foreground">{copy.sectionMissing}</p>
      ) : pending ? (
        <PanelSkeleton height={80} />
      ) : isEndpointAbsent(error) ? (
        <p className="text-xs text-muted-foreground">{copy.sectionMissing}</p>
      ) : error && !alerts ? (
        <PanelError error={error} onRetry={onRetry} what={copy.alertsFailed} />
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">{copy.alertsEmpty}</p>
      ) : (
        <ul aria-labelledby={id} className="divide-y divide-border rounded-lg border border-border">
          {rows.map(({ a, text }) => (
            <li
              key={a.id}
              data-kind={a.kind}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
            >
              <span className="min-w-0 flex-1">{text}</span>
              <time dateTime={a.at} className="text-xs text-muted-foreground">
                {fmtShortDay(a.at)}
              </time>
              {actions ? actions(a) : null}
            </li>
          ))}
        </ul>
      )}
      {partial ? <Partial onRetry={onRetry} /> : null}
    </Panel>
  )
}
