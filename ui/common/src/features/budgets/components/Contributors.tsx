/**
 * The contributors beside the daily bars (plan feat-budget-burn F3, design 6B parity): the dimension switch, then each
 * contributor with its spend and share, in the stack's colours. A name is a button that opens its share view
 * (`?contributor=`); redacted rows (§5.2) can't be picked. The list downloads as CSV (X8).
 */
import { Download } from 'lucide-react'
import { PanelError, PanelSkeleton } from '@/components/shared/panel'
import { Swatch } from '@/components/shared/chart-marks'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { downloadCsv, toCsv } from '@/features/tokenops/csv'
import { isEndpointAbsent } from '@/lib/api/detect'
import { OTHER_SERIES, seriesAt } from '@/lib/chart'
import { fmtMoney } from '@/lib/format'
import { keyLabel } from '../causes'
import { copy } from '../copy'
import { CONTRIBUTORS_CSV } from '../csv'
import type { Breakdown, Dimension } from '../types'

export function Contributors({
  breakdown,
  error,
  pending,
  missing,
  onRetry,
  by,
  dimensions,
  onBy,
  picked,
  onPick,
  fileName,
}: {
  breakdown: Breakdown | undefined
  error: unknown
  pending: boolean
  /** This server doesn't serve the breakdown (F11). */
  missing: boolean
  onRetry: () => void
  by: Dimension
  dimensions: readonly Dimension[]
  onBy: (d: Dimension) => void
  picked: string | null
  onPick: (key: string) => void
  fileName: string
}) {
  const total = breakdown
    ? breakdown.keys.reduce((s, k) => s + k.cost_usd, 0) + breakdown.other.cost_usd
    : 0
  const rows = (breakdown?.keys ?? []).map((k) => ({
    ...k,
    name: keyLabel(k),
    share: total > 0 ? Math.round((k.cost_usd / total) * 100) : null,
  }))
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{copy.causesBy}</span>
          {dimensions.length > 1 ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={by}
              onValueChange={(v) => v && onBy(v as Dimension)}
              aria-label={copy.causesBy}
            >
              {dimensions.map((d) => (
                <ToggleGroupItem key={d} value={d} className="px-3 text-xs">
                  {copy.dimension[d] ?? d}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <span className="text-xs font-medium">{copy.dimension[by] ?? by}</span>
          )}
        </div>
        {rows.length ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(fileName, toCsv(CONTRIBUTORS_CSV, rows))}
          >
            <Download className="size-4" aria-hidden /> {copy.contributorsCsv}
          </Button>
        ) : null}
      </div>
      {missing || isEndpointAbsent(error) ? (
        <p className="text-xs text-muted-foreground">{copy.contributorsMissing}</p>
      ) : pending ? (
        <PanelSkeleton height={96} />
      ) : error ? (
        <PanelError error={error} onRetry={onRetry} what={copy.contributorsTitle.toLowerCase()} />
      ) : !rows.length ? (
        <p className="text-xs text-muted-foreground">{copy.contributorsNone}</p>
      ) : (
        <ul
          aria-label={copy.contributorsTitle}
          className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2"
        >
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-2">
              <Swatch series={seriesAt(i)} />
              {r.redacted ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.name}</span>
              ) : (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto min-w-0 flex-1 justify-start truncate p-0"
                  aria-pressed={picked === r.key}
                  aria-label={copy.contributorsPick(r.name)}
                  onClick={() => onPick(r.key)}
                >
                  {r.name}
                </Button>
              )}
              <span className="tabular-nums">{fmtMoney(r.cost_usd)}</span>
              <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
                {r.share === null ? '' : copy.contributorsShare(`${r.share}%`)}
              </span>
            </li>
          ))}
          {breakdown && breakdown.other.cost_usd > 0 ? (
            <li className="flex items-center gap-2">
              <Swatch series={OTHER_SERIES} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {copy.causesOther(breakdown.other.contributors)}
              </span>
              <span className="tabular-nums">{fmtMoney(breakdown.other.cost_usd)}</span>
              <span className="w-24" />
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}
