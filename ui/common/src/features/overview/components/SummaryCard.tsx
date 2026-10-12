import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { OverviewNarrative } from '@/features/narrative/overview'
import type { OptimisationView } from '@/features/tokenops/optimisation'
import type { FleetHealth, HarnessSummary, Spend } from '../api'
import { copy } from '../copy'
import { Harnesses } from './Harnesses'
import { Headline } from './Headline'
import { AgentsTile, RunsTile, SpendTile } from './Kpis'
import { MonthBar } from './MonthBar'
import { Savings } from './Savings'

export function SummaryCard({
  days,
  narrative,
  nothing,
  spend,
  savings,
  fleet,
  harnesses,
}: {
  days: number
  narrative: OverviewNarrative
  nothing: boolean
  spend: Spend
  savings: { view: OptimisationView | undefined; isPending: boolean }
  fleet: FleetHealth
  harnesses: HarnessSummary
}) {
  return (
    <div className="@container/overview">
      <Card
        asChild
        className="gap-0 overflow-hidden p-0 @[1100px]/overview:grid @[1100px]/overview:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]"
      >
        <section aria-labelledby="overview-summary-title">
          <h2 id="overview-summary-title" className="sr-only">
            {copy.summary}
          </h2>
          <div className="flex flex-col justify-center gap-4 p-5">
            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary-text">
              {copy.range.item(days)}
            </Badge>
            <Headline narrative={narrative} nothing={nothing} />
            <MonthBar spend={spend} />
            <Savings view={savings.view} isPending={savings.isPending} />
          </div>
          <div className="grid grid-cols-1 gap-px border-t border-border bg-border *:rounded-none *:border-0 @[560px]/overview:grid-cols-2 @[1100px]/overview:border-t-0 @[1100px]/overview:border-l">
            <SpendTile spend={spend} />
            <RunsTile spend={spend} />
            <AgentsTile fleet={fleet} />
            <Harnesses data={harnesses} days={days} />
          </div>
        </section>
      </Card>
    </div>
  )
}
