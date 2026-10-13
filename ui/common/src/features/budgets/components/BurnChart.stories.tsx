// The burn chart (plans/feat-budget-burn.md F1, B1) in every state the plan names, drawn from the golden scenario
// (docs/requirements/budgets.md §14) through the mock engine, so each story is real data with known numbers.
// `npm run test:stories` runs each with axe.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { BurnChart } from '@/components/charts/burn-chart'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import {
  breakdown as engineBreakdown,
  burn as engineBurn,
  worldFromScenario,
} from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import {
  chartModel,
  expectedLine,
  previewLine,
  projection,
  tableRows,
  type BurnMode,
} from '../burn'
import { shareLine, stackBars } from '../causes'
import { burnAxisMoney, burnChartData, burnChartLabels } from '../chartData'
import { BurnTable } from './BurnTable'

const meta: Meta = { title: 'Budgets/Burn chart' }
export default meta

const NOW = Date.parse(GOLDEN_ANCHOR)
const read = (scope: string, id: string | null, now = NOW) =>
  engineBurn(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    { id: 'admin', superuser: true },
    { scope, id },
    now,
  )

function Story({
  scope,
  id,
  mode,
  summary,
  now,
  preview,
  expected,
}: {
  scope: string
  id: string | null
  mode: BurnMode
  summary: string
  now?: number
  preview?: (b: ReturnType<typeof read>) => { t: number; v: number }[]
  expected?: (b: ReturnType<typeof read>) => { t: number; v: number }[] | null
}) {
  const b = read(scope, id, now)
  const m = chartModel(b, mode)
  return (
    <div className="max-w-3xl rounded-lg border border-border bg-card p-4">
      <BurnChart
        data={burnChartData(m)}
        labels={{
          ...burnChartLabels(m, { stops: b.budget?.action === 'stop', summary }),
          expected: 'Expected without the Oct 12 change',
        }}
        formatMoney={burnAxisMoney}
        formatDay={(t) => fmtShortDay(new Date(t).toISOString())}
        preview={preview?.(b) ?? null}
        expected={expected?.(b) ?? null}
        pickedDay="2026-10-09"
      />
    </div>
  )
}

export const BurndownProjectedOver: StoryObj = {
  render: () => (
    <Story
      scope="agent"
      id={I.pricing}
      mode="down"
      summary="On pace to use 186% by Oct 31. To stay within budget: $1.06 a day for the next 18 days."
    />
  ),
}

export const RanOutStopped: StoryObj = {
  render: () => (
    <Story
      scope="agent"
      id={I.reviewer}
      mode="down"
      summary="Ran out Oct 13; calls are stopped until Nov 1."
    />
  ),
}

export const BurnUpSteppedLimit: StoryObj = {
  render: () => (
    <Story
      scope="agent"
      id={I.reviewer}
      mode="up"
      summary="Ran out Oct 13 after its limit was raised from $40 to $50 on Oct 10."
    />
  ),
}

export const NoBudget: StoryObj = {
  render: () => (
    <Story
      scope="owner"
      id={I.ana}
      mode="up"
      summary="Ana has no budget: $34 spent this month so far."
    />
  ),
}

export const FleetAlertOnly: StoryObj = {
  render: () => (
    <Story
      scope="org"
      id={null}
      mode="down"
      summary="The fleet is on pace for 74% of its $500 by Oct 31."
    />
  ),
}

export const PreviewLine: StoryObj = {
  render: () => (
    <Story
      scope="agent"
      id={I.pricing}
      mode="down"
      summary="Preview, not applied: at half the pace, projected spend is $133.50."
      preview={(b) => previewLine(b, 'down', (projection(b)?.pace ?? 0) / 2)}
    />
  ),
}

/** After a change that moved the pace (F13): where spend was going before it, until 3 days of new data. */
export const ExpectedAfterChange: StoryObj = {
  render: () => (
    <Story
      scope="agent"
      id={I.pricing}
      mode="up"
      summary="Expected without the Oct 12 change: spend at the pace before it."
      expected={(b) => expectedLine(b, 'up', Date.parse('2026-10-12T10:00:00Z'))}
    />
  ),
}

export const TooEarly: StoryObj = {
  render: () => (
    <Story
      scope="agent"
      id={I.pricing}
      mode="up"
      now={Date.UTC(2026, 9, 2, 12)}
      summary="A projection needs 3 days of spend."
    />
  ),
}

export const TableView: StoryObj = {
  render: () => {
    const b = read('agent', I.reviewer)
    return (
      <div className="max-w-3xl rounded-lg border border-border bg-card p-4">
        <BurnTable
          rows={tableRows(b)}
          scopeLabel="Code Reviewer"
          fileName="burn.csv"
          onPickDay={() => {}}
          floor={b.unpriced_calls > 0}
          events={burnChartData(chartModel(b, 'down')).markers}
        />
        <p className="mt-2 text-xs text-muted-foreground">Used {fmtMoney(b.used_usd)}</p>
      </div>
    )
  },
}

export const StackedWithShare: StoryObj = {
  render: () => {
    const w = worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' })
    const viewer = { id: 'admin', superuser: true }
    const b = engineBurn(
      w,
      viewer,
      { scope: 'org', id: null, contributor: I.reviewer, by: 'agent' },
      NOW,
    )
    const br = engineBreakdown(w, viewer, { scope: 'org', id: null, by: 'agent' }, NOW)
    const m = chartModel(b, 'up')
    return (
      <div className="max-w-3xl rounded-lg border border-border bg-card p-4">
        <BurnChart
          data={{ ...stackBars(burnChartData(m), br), share: shareLine(b) }}
          labels={{
            ...burnChartLabels(m, {
              stops: false,
              summary: 'The fleet by agent, Code Reviewer picked.',
            }),
            share: 'Code Reviewer, cumulative',
          }}
          formatMoney={burnAxisMoney}
          formatDay={(t) => fmtShortDay(new Date(t).toISOString())}
        />
      </div>
    )
  },
}
