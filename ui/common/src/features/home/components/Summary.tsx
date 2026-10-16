/**
 * The home's summary as a bento (the Overview redesign's lead, feat/ui-prev-next): the sentence in the lead card (the
 * page's one effect area, as on TokenOps and Optimization) beside the roll-up tiles, 2×2 from 1100 px of content and
 * stacked below (tiles 2 across from 560 px). Three tiles (no own budget) let the last one span its row, so the grid
 * never shows a hole. It enters once with the `enter` stagger; later scope or range changes re-render in place.
 */
import { SpotlightCard } from '@/components/aceternity/spotlight-card'
import { KpiTile } from '@/components/shared/kpi-tile'
import { Reveal, RevealItem } from '@/components/shared/reveal'
import { Badge } from '@/components/ui/badge'
import { emphasize } from '@/features/overview/emphasize'
import { copy as overviewCopy } from '@/features/overview/copy'
import { fmtLocalTime, fmtMoney, fmtMoneyFloor, fmtTokens } from '@/lib/format'
import { cn } from '@/lib/utils'
import { budgetsShown, type HomeBudgets, type SourceStatus } from '../api'
import { copy } from '../copy'
import { budgetMonth, type totals } from '../rows'
import type { Scope } from '../search'
import { useBudgetStamp } from '../useBudgetStamp'

const TILE = 'flex *:flex-1'

export function Summary({
  sentence,
  days,
  totals: t,
  member,
  scope,
  asOf,
  unpriced,
  savedStatus,
  savedCapped,
  budgets,
}: {
  sentence: string | null
  days: number
  totals: ReturnType<typeof totals>
  member: boolean
  scope: Scope | null
  asOf: number
  unpriced: boolean
  savedStatus: SourceStatus
  savedCapped: boolean
  budgets: HomeBudgets
}) {
  const savedKnown = savedStatus === 'ok' || savedStatus === 'stale'
  // Yours shows the viewer's own monthly budget; Fleet has no authoritative fleet budget to show, and owner and agent
  // budgets overlap, so they are never summed into one (design "Home scope semantics").
  const own = scope === 'yours' && budgetsShown(budgets.state) ? budgets.own : null
  const stamp = useBudgetStamp(budgets.updatedAt)
  return (
    <section aria-label={copy.strip.label} data-tour="overview-summary">
      <Reveal className="grid gap-3 @[1100px]/overview:grid-cols-12">
        <RevealItem className={`${TILE} @[1100px]/overview:col-span-6`}>
          <SpotlightCard>
            <div className="relative flex flex-1 flex-col justify-between gap-5 p-5">
              <div className="flex flex-col items-start gap-3">
                <Badge
                  variant="outline"
                  className="border-primary/30 bg-primary/10 text-primary-text"
                >
                  {overviewCopy.range.item(days)}
                </Badge>
                {sentence ? (
                  <p className="m-0 max-w-[48ch] text-xl leading-8 text-pretty text-foreground @[1100px]/overview:text-2xl @[1100px]/overview:leading-10">
                    {emphasize(sentence)}
                  </p>
                ) : null}
              </div>
              {/* One note for both layouts: the table header's badge and stamp aren't announced, and phones have no
                  header. */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <p
                  className="m-0"
                  role={
                    budgets.state === 'failed' || budgets.state === 'stale' ? 'status' : undefined
                  }
                >
                  {budgets.state === 'off'
                    ? copy.budget.off
                    : budgets.state === 'failed'
                      ? copy.budget.failed
                      : budgets.state === 'stale'
                        ? `${copy.budget.stale} · ${(budgets.preview ? copy.budget.note : copy.budget.liveNote)(stamp)}`
                        : (budgets.preview ? copy.budget.note : copy.budget.liveNote)(stamp)}
                </p>
                {asOf ? <p className="m-0">{copy.strip.asOf(fmtLocalTime(asOf))}</p> : null}
              </div>
            </div>
          </SpotlightCard>
        </RevealItem>
        <div className="grid grid-cols-1 gap-3 @[560px]/overview:grid-cols-2 @[1100px]/overview:col-span-6">
          <RevealItem className={TILE}>
            <KpiTile
              label={copy.strip.spend}
              aside={
                member && scope !== 'yours' ? (
                  <span className="text-xs text-muted-foreground">{copy.strip.spendVisible}</span>
                ) : null
              }
              value={t.spend === null ? '—' : fmtMoneyFloor(t.spend, unpriced)}
            >
              {unpriced ? (
                <span className="text-xs text-muted-foreground">{copy.strip.unpriced}</span>
              ) : null}
              {t.spendHasEstimates ? (
                <span className="text-xs text-muted-foreground">{copy.strip.estimates}</span>
              ) : null}
            </KpiTile>
          </RevealItem>
          <RevealItem className={TILE}>
            <KpiTile
              label={copy.strip.saved}
              title={copy.strip.savedTooltip}
              value={
                !savedKnown || t.saved === null ? (
                  '—'
                ) : (
                  <>
                    {savedCapped ? '≥ ' : ''}
                    {fmtTokens(t.saved)}{' '}
                    <span className="text-sm font-normal text-muted-foreground">
                      {copy.strip.tokens}
                    </span>
                  </>
                )
              }
            >
              {savedKnown && t.saved === null ? (
                <span className="text-xs text-muted-foreground">{copy.strip.notReported}</span>
              ) : null}
              {savedKnown && t.savedBasis ? (
                <span className="text-xs text-muted-foreground">
                  {copy.strip.basis(t.savedBasis)}
                </span>
              ) : null}
            </KpiTile>
          </RevealItem>
          {own ? (
            <RevealItem className={TILE}>
              <KpiTile
                label={copy.budget.own}
                aside={
                  budgets.preview ? (
                    <Badge variant="outline" className="text-3xs">
                      {copy.budget.preview}
                    </Badge>
                  ) : null
                }
                // Floored, so 99.6% never reads as a full 100% while under the limit; a floor (≥) with unpriced calls.
                value={
                  own.limit > 0
                    ? copy.budget.pct(Math.floor((own.used / own.limit) * 100), own.unpriced)
                    : '—'
                }
              >
                <span className="text-xs text-muted-foreground">
                  {copy.budget.use(
                    fmtMoneyFloor(own.used, own.unpriced),
                    fmtMoney(own.limit),
                    budgetMonth(own.resetsAt),
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{copy.budget.ownHint}</span>
              </KpiTile>
            </RevealItem>
          ) : null}
          <RevealItem className={cn(TILE, !own && '@[560px]/overview:col-span-2')}>
            <KpiTile
              label={copy.strip.needs}
              value={t.needing === null ? '—' : String(t.needing)}
            />
          </RevealItem>
        </div>
      </Reveal>
    </section>
  )
}
