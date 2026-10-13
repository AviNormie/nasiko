/**
 * The burn strip (plan feat-budget-burn F2): today, this week so far, the period to date, the projected period and
 * quarter ends, and the daily allowance, as Home's strip (`KpiTile` + `Delta`, design 5D). Unpriced calls make spend
 * a floor ("≥") and the allowance a ceiling ("at most"). A figure the read can't support says why, never "$0".
 */
import { Delta } from '@/components/shared/delta'
import { Button } from '@/components/ui/button'
import { KpiTile } from '@/components/shared/kpi-tile'
import { fmtMoney, fmtMoneyFloor, fmtUtcTime } from '@/lib/format'
import { currentLimit, figures, quarterInput } from '../burn'
import { copy } from '../copy'
import type { Burn } from '../types'

const pct = (v: number | null) => (v === null ? null : `${Math.round(v)}%`)
const change = (now: number, then: number | null) =>
  then === null || then === 0 ? null : ((now - then) / then) * 100

export function BurnStrip({
  burn,
  kind,
  quarterRead,
  showQuarter = true,
  preview,
  onResetPreview,
}: {
  burn: Burn
  kind: 'month' | 'quarter'
  /** The same scope read from the quarter's first day (month budgets): feeds the quarter figure. */
  quarterRead?: Burn | null
  /** The quarter figure can be read at all (not on an R-L10 server, which has this month only). */
  showQuarter?: boolean
  /** A lever or what-if preview (F4: "on the chart and in the strip"), with Reset. */
  preview?: { projected: number; limit: number } | null
  onResetPreview?: () => void
}) {
  const quarter = kind === 'month' && quarterRead ? quarterInput(quarterRead) : null
  const f = figures(burn, { quarter })
  const floor = f.floor
  const limit = currentLimit(burn)
  const money = (v: number) => fmtMoneyFloor(v, floor)
  const range = (low: number, high: number) => copy.stripProjectedRange(money(low), fmtMoney(high))
  return (
    <section aria-label={copy.stripLabel} className="space-y-1">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0">
        <KpiTile
          label={copy.stripToday}
          aside={
            f.today.avg7 ? (
              <Delta changePct={change(f.today.used, f.today.avg7)} polarity="down-good" />
            ) : null
          }
          value={money(f.today.used)}
        >
          {f.today.avg7 !== null ? (
            <span className="text-xs text-muted-foreground">
              {copy.stripTodayVs(fmtMoney(f.today.avg7))}
            </span>
          ) : null}
        </KpiTile>
        <KpiTile
          label={copy.stripWeek}
          aside={
            // Nothing to compare against: no arrow (a $0 week has no percent change, never "new").
            f.week.usedCompleteDays !== null && f.week.sameDaysLastWeek ? (
              <Delta
                changePct={change(f.week.usedCompleteDays, f.week.sameDaysLastWeek)}
                polarity="down-good"
              />
            ) : null
          }
          value={f.week.used === null ? '—' : money(f.week.used)}
        >
          <span className="text-xs text-muted-foreground">
            {f.week.sameDaysLastWeek !== null
              ? copy.stripWeekVs(fmtMoney(f.week.sameDaysLastWeek))
              : copy.stripWeekNoCompare}
          </span>
        </KpiTile>
        <KpiTile label={copy.stripToDate(kind)} value={money(f.periodToDate.used)}>
          {limit !== null && f.periodToDate.pct !== null ? (
            <span className="text-xs text-muted-foreground">
              {copy.stripOfLimit(pct(f.periodToDate.pct) ?? '', fmtMoney(limit))}
            </span>
          ) : null}
        </KpiTile>
        <KpiTile
          label={copy.stripProjected(kind)}
          value={f.projected ? range(f.projected.low, f.projected.high) : '—'}
        >
          <span className="text-xs text-muted-foreground">
            {!f.projected
              ? copy.stripNoProjection
              : f.projected.highPct !== null
                ? copy.stripProjectedRange(
                    pct(f.projected.lowPct) ?? '',
                    pct(f.projected.highPct) ?? '',
                  )
                : null}
          </span>
          {preview ? (
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-primary-text">
              {copy.previewNotApplied(
                fmtMoney(preview.projected),
                `${Math.round((preview.projected / preview.limit) * 100)}%`,
              )}
              {onResetPreview ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={onResetPreview}
                >
                  {copy.previewReset}
                </Button>
              ) : null}
            </span>
          ) : null}
        </KpiTile>
        {kind === 'month' && burn.budget && showQuarter ? (
          <KpiTile
            label={copy.stripQuarter}
            value={f.quarter ? range(f.quarter.low, f.quarter.high) : '—'}
          >
            <span className="text-xs text-muted-foreground">
              {f.quarter
                ? f.quarter.highPct !== null
                  ? `${copy.stripProjectedRange(pct(f.quarter.lowPct) ?? '', pct(f.quarter.highPct) ?? '')} · ${copy.stripQuarterNote}`
                  : copy.stripQuarterNote
                : copy.stripNoProjection}
            </span>
          </KpiTile>
        ) : null}
        {f.allowance ? (
          <KpiTile
            label={copy.stripAllowance}
            value={
              f.allowance.none
                ? copy.stripAllowanceNone
                : floor
                  ? copy.stripAtMost(fmtMoney(f.allowance.perDay))
                  : fmtMoney(f.allowance.perDay)
            }
          >
            {!f.allowance.none ? (
              <span className="text-xs text-muted-foreground">
                {copy.stripAllowanceFor(f.allowance.days)}
              </span>
            ) : null}
          </KpiTile>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {copy.stripAsOf(fmtUtcTime(burn.as_of))}
        {burn.unpriced_calls > 0 ? ` · ${copy.stripUnpriced(burn.unpriced_calls)}` : null}
      </p>
    </section>
  )
}
