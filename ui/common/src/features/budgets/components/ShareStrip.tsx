/**
 * A picked contributor's figures (plan feat-budget-burn F3, design 3B), in place of the strip while its share view is
 * open: its spend this period, its share of the scope's, and its projected period end. No allowance or run-out: those
 * belong to a budget; an agent links to its hub, where its own budget is.
 */
import { Link } from '@tanstack/react-router'
import { KpiTile } from '@/components/shared/kpi-tile'
import { fmtMoney, fmtMoneyFloor } from '@/lib/format'
import { projection } from '../burn'
import { contributorBurn } from '../causes'
import { copy } from '../copy'
import type { Burn } from '../types'

export function ShareStrip({
  scope,
  read,
  agentId,
}: {
  scope: Burn
  read: Burn
  /** The contributor is an agent: its hub, where its own budget lives (B5). */
  agentId: string | null
}) {
  const c = contributorBurn(read)
  if (!c) return null
  const floor = c.unpriced_calls > 0
  const share = scope.used_usd > 0 ? (c.used_usd / scope.used_usd) * 100 : null
  const p = projection(c)
  return (
    <section aria-label={copy.stripLabel}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0">
        <KpiTile label={copy.shareSpend(c.label)} value={fmtMoneyFloor(c.used_usd, floor)}>
          <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {share !== null ? <span>{copy.shareOf(`${Math.round(share)}%`)}</span> : null}
            {agentId ? (
              <Link
                to="/agents/$agentId"
                params={{ agentId }}
                className="underline-offset-4 hover:underline focus-visible:underline"
              >
                {copy.shareOpenAgent}
              </Link>
            ) : null}
          </span>
        </KpiTile>
        <KpiTile
          label={copy.stripProjected(scope.period === 'quarter' ? 'quarter' : 'month')}
          value={p ? fmtMoneyFloor(p.projected, floor) : '—'}
        >
          {p ? null : (
            <span className="text-xs text-muted-foreground">{copy.stripNoProjection}</span>
          )}
        </KpiTile>
        <KpiTile
          label={copy.stripToDate(scope.period === 'quarter' ? 'quarter' : 'month')}
          value={fmtMoney(scope.used_usd)}
        >
          <span className="text-xs text-muted-foreground">{scope.label}</span>
        </KpiTile>
      </div>
    </section>
  )
}
