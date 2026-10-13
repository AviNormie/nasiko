/**
 * What changed (plan feat-budget-burn F3): spike days inside the shown period first, each opening its day's
 * drill-down, then this week so far against the same hours last week, by contributor, as the server ranks them over
 * every contributor (BG-4b). Priced spend only: unpriced calls are counted in a line, never in a delta (eng D5).
 */
import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { Panel, PanelError, PanelSkeleton } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import { isEndpointAbsent } from '@/lib/api/detect'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Spike } from '../burn'
import { changeRows, type ChangeRow } from '../causes'
import { copy } from '../copy'
import type { Changes, Dimension } from '../types'

export function WhatChanged({
  spikes,
  changes,
  error,
  pending,
  noWeek,
  onRetry,
  by,
  onPickDay,
  onOwner,
}: {
  spikes: readonly Spike[]
  changes: Changes | undefined
  error: unknown
  pending: boolean
  /** No full week of spend to compare against yet (or Monday 00:00). */
  noWeek: boolean
  onRetry: () => void
  by: Dimension
  onPickDay: (day: string) => void
  /** Opens an owner's scope (superuser), or null when owners aren't links. */
  onOwner: ((id: string) => void) | null
}) {
  const id = useId()
  const rows = changes ? changeRows(changes) : []
  const unpriced = changes ? changes.unpriced_calls + changes.compare_unpriced_calls : 0
  return (
    <Panel title={copy.changesTitle} subtitle={copy.changesSubtitle} labelledBy={id}>
      <div className="space-y-3 text-sm">
        {spikes.length ? (
          <ul className="space-y-1" aria-label={copy.changesSpikeLabel}>
            {[...spikes].reverse().map((s) => (
              <li key={s.date}>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-warning"
                  onClick={() => onPickDay(s.date)}
                >
                  {copy.changesSpike(
                    fmtShortDay(s.date),
                    fmtMoney(s.cost),
                    s.ratio === null ? null : s.ratio.toFixed(1),
                  )}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {noWeek ? (
          <p className="text-muted-foreground">{copy.changesEmpty}</p>
        ) : pending ? (
          <PanelSkeleton height={120} />
        ) : isEndpointAbsent(error) ? (
          <p className="text-xs text-muted-foreground">{copy.changesMissing}</p>
        ) : error ? (
          <PanelError error={error} onRetry={onRetry} what={copy.changesFailed} />
        ) : !rows.length ? (
          <p className="text-muted-foreground">{copy.changesNothing}</p>
        ) : (
          <ol className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-3 py-1.5">
                <Name row={r} by={by} onOwner={onOwner} />
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
                    r.delta > 0 ? 'text-destructive' : 'text-success',
                  )}
                >
                  {`${r.delta > 0 ? '+' : '−'}${fmtMoney(Math.abs(r.delta))}`}{' '}
                  <span className="text-xs text-muted-foreground">
                    (
                    {r.pct === null
                      ? copy.changesNew
                      : `${r.pct > 0 ? '+' : '−'}${Math.abs(Math.round(r.pct))}%`}
                    )
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {changes?.truncated ? (
          <p className="text-xs text-muted-foreground">{copy.changesTruncated}</p>
        ) : null}
        {unpriced > 0 ? (
          <p className="text-xs text-muted-foreground">{copy.changesUnpriced(unpriced)}</p>
        ) : null}
      </div>
    </Panel>
  )
}

/** A contributor links to where it's managed: an agent to its hub, an owner to their scope, a model to the router. */
function Name({
  row,
  by,
  onOwner,
}: {
  row: ChangeRow
  by: Dimension
  onOwner: ((id: string) => void) | null
}) {
  const plain = <span className="min-w-0 truncate">{row.label}</span>
  if (row.redacted)
    return <span className="min-w-0 truncate text-muted-foreground">{row.label}</span>
  if (by === 'agent')
    return (
      <Link
        to="/agents/$agentId"
        params={{ agentId: row.key }}
        className="min-w-0 truncate underline-offset-4 hover:underline focus-visible:underline"
      >
        {row.label}
      </Link>
    )
  if (by === 'owner' && onOwner)
    return (
      <Button
        variant="link"
        size="sm"
        className="h-auto min-w-0 justify-start truncate p-0 text-foreground"
        onClick={() => onOwner(row.key)}
      >
        {row.label}
      </Button>
    )
  if (by === 'model')
    return (
      <Link
        to="/router"
        className="min-w-0 truncate underline-offset-4 hover:underline focus-visible:underline"
      >
        {row.label}
      </Link>
    )
  return plain
}
