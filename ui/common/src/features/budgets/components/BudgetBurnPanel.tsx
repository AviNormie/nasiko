/**
 * Home's Budget burn panel (plan feat-budget-burn F10, F12; approved mockup B; ledger #79): the chart band's first row,
 * full width. The sentence, the compact chart (no daily bars) beside the scope's top 3 At risk rows (the same columns
 * minus Projected), then four figures: today, this week, the month to date (with its % of the limit) and the most per
 * day that keeps it within budget. On Yours the budget's population is named: "Calls billed to you", beside "Your
 * agents' spend" (they differ when you use others' agents or they use yours), then what's outside the budget. The
 * Burndown/Burn-up choice is the one /budgets remembers. Home renders it only once the burn read answered (D13). A unit
 * has no Open budgets link until /budgets has unit scopes (B6).
 */
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { BurnChart } from '@/components/charts/burn-chart'
import { Delta } from '@/components/shared/delta'
import { KpiTile } from '@/components/shared/kpi-tile'
import { Panel, PanelError, PanelSkeleton } from '@/components/shared/panel'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isEndpointAbsent } from '@/lib/api/detect'
import { fmtMoney, fmtMoneyFloor, fmtShortDay } from '@/lib/format'
import { useAtRisk, type ScopeRef } from '../api'
import { chartModel, currentLimit, figures, type BurnMode } from '../burn'
import { rememberBurnMode, storedBurnMode } from '../burnMode'
import { burnAxisMoney, burnChartData, burnChartLabels } from '../chartData'
import { copy } from '../copy'
import { burnSentence } from '../sentence'
import type { Burn } from '../types'
import { AtRiskTable } from './AtRisk'

const TOP = 3

export default function BudgetBurnPanel({
  burn,
  scopeRef,
  scopeName,
  scopeParam,
  yours,
  viewerId,
  atRisk: atRiskAvailable,
}: {
  burn: Burn
  scopeRef: ScopeRef
  /** "Fleet", "Yours" or a unit's name. */
  scopeName: string
  /** The /budgets `?scope=` that opens the same scope; none (a unit) hides the link. */
  scopeParam: string | undefined
  yours: boolean
  viewerId: string
  /** The server has At risk (F11). */
  atRisk: boolean
}) {
  const id = useId()
  const atRiskId = useId()
  const [mode, setMode] = useState<BurnMode>(() => storedBurnMode(viewerId) ?? 'down')
  const shown: BurnMode = burn.budget ? mode : 'up'
  const m = chartModel(burn, shown)
  const sentence = burnSentence(burn, 'month')
  const f = figures(burn)
  const floor = f.floor
  const limit = currentLimit(burn)
  const risk = useAtRisk(scopeRef, atRiskAvailable)
  const top = risk.data?.rows.slice(0, TOP) ?? []
  const change = (now: number, then: number | null) => (then ? ((now - then) / then) * 100 : null)
  return (
    <Panel
      title={copy.homeTitle(scopeName)}
      labelledBy={id}
      className="@[880px]/overview:col-span-2"
      actions={
        <>
          {burn.budget ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={mode}
              onValueChange={(v) => {
                if (v !== 'down' && v !== 'up') return
                rememberBurnMode(viewerId, v)
                setMode(v)
              }}
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
          {scopeParam ? (
            <Link
              to="/budgets"
              search={{ scope: scopeParam }}
              aria-label={copy.homeOpenLabel(scopeName)}
              className="text-xs font-medium text-primary-text underline-offset-4 hover:underline focus-visible:underline"
            >
              {copy.homeOpen} <span aria-hidden>→</span>
            </Link>
          ) : null}
        </>
      }
    >
      <p className="text-sm">{sentence}</p>
      <div className="grid gap-4 @[1024px]/overview:grid-cols-[3fr_2fr]">
        <BurnChart
          compact
          data={burnChartData(m)}
          labels={burnChartLabels(m, { stops: burn.budget?.action === 'stop', summary: sentence })}
          formatMoney={burnAxisMoney}
          formatDay={(t) => fmtShortDay(t)}
        />
        <section aria-labelledby={atRiskId} className="min-w-0 space-y-2">
          <h3 id={atRiskId} className="text-xs font-medium text-muted-foreground">
            {copy.homeAtRisk}
          </h3>
          {!atRiskAvailable || isEndpointAbsent(risk.error) ? (
            <p className="text-xs text-muted-foreground">{copy.sectionMissing}</p>
          ) : risk.isPending ? (
            <PanelSkeleton height={96} />
          ) : risk.isError ? (
            <PanelError
              error={risk.error}
              onRetry={() => void risk.refetch()}
              what={copy.atRiskFailed}
            />
          ) : top.length ? (
            <AtRiskTable labelledBy={atRiskId} rows={top} onOwner={null} compact />
          ) : (
            <p className="text-sm text-muted-foreground">{copy.homeAtRiskNone}</p>
          )}
        </section>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0">
        <KpiTile
          compact
          label={copy.stripToday}
          aside={
            f.today.avg7 ? (
              <Delta changePct={change(f.today.used, f.today.avg7)} polarity="down-good" />
            ) : null
          }
          value={fmtMoneyFloor(f.today.used, floor)}
        />
        <KpiTile
          compact
          label={copy.stripWeek}
          value={f.week.used === null ? '—' : fmtMoneyFloor(f.week.used, floor)}
        />
        <KpiTile
          compact
          label={yours && burn.budget ? copy.homeBilled : copy.stripToDate('month')}
          value={fmtMoneyFloor(f.periodToDate.used, floor)}
        >
          {limit !== null && f.periodToDate.pct !== null ? (
            <span className="text-xs text-muted-foreground">
              {copy.stripOfLimit(`${Math.round(f.periodToDate.pct)}%`, fmtMoney(limit))}
            </span>
          ) : null}
        </KpiTile>
        {yours && burn.owned_agents ? (
          <KpiTile
            compact
            label={copy.homeAgents}
            value={fmtMoneyFloor(burn.owned_agents.used_usd, burn.owned_agents.unpriced_calls > 0)}
          >
            <span className="text-xs text-muted-foreground">{copy.homeAgentsNote}</span>
          </KpiTile>
        ) : null}
        {f.allowance ? (
          <KpiTile
            compact
            label={copy.homeAtMost}
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
      {yours &&
      burn.outside &&
      (burn.outside.traced_usd > 0 || burn.outside.harness_estimate_usd > 0) ? (
        <p className="text-xs text-muted-foreground">
          {copy.homeOutside(
            fmtMoney(burn.outside.traced_usd),
            fmtMoney(burn.outside.harness_estimate_usd),
          )}
        </p>
      ) : null}
    </Panel>
  )
}
