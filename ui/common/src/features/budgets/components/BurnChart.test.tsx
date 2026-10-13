// The kit's burn chart (plan feat-budget-burn F1) on golden reads: picking a day works from a tap (no hover first), the
// axis is UTC whatever the viewer's zone, merged flags show their count, and hover at a reset reads the old period.
// The Table view lists the flags' events (design 6B parity).
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BurnChart } from '@/components/charts/burn-chart'
import { burn as engineBurn, worldFromScenario } from '@/mocks/budgetEngine'
import { budgetScenario, GOLDEN_ANCHOR, SCENARIO_IDS as I } from '@/mocks/seed-budgets'
import { chartModel, tableRows, type BurnMode } from '../burn'
import { burnAxisMoney, burnChartData, burnChartLabels } from '../chartData'
import type { Burn } from '../types'
import { BurnTable } from './BurnTable'

// jsdom has no layout: give the plot a fixed size. 700 wide = 56 left margin + 580 plot + 64 right margin.
vi.mock('@visx/responsive', () => ({
  ParentSize: ({ children }: { children: (s: { width: number; height: number }) => ReactNode }) =>
    children({ width: 700, height: 320 }),
}))

const PLOT_LEFT = 56
const PLOT_W = 580
const DAY = 86_400_000

const read = (scope: string, id: string | null, extra: Record<string, string> = {}) =>
  engineBurn(
    worldFromScenario(budgetScenario(), { adminId: 'admin', edition: 'ee' }),
    { id: 'admin', superuser: true },
    { scope, id, ...extra },
    Date.parse(GOLDEN_ANCHOR),
  )

function draw(b: Burn, mode: BurnMode, onPickDay = vi.fn()) {
  const m = chartModel(b, mode)
  const view = render(
    <BurnChart
      data={burnChartData(m)}
      labels={burnChartLabels(m, { stops: b.budget?.action === 'stop', summary: 'summary' })}
      formatMoney={burnAxisMoney}
      formatDay={(t) => new Date(t).toISOString()}
      onPickDay={onPickDay}
    />,
  )
  const svg = view.container.querySelector('svg')!
  const clientX = (t: number) => PLOT_LEFT + ((t - m.start) / (m.end - m.start)) * PLOT_W
  return { svg, clientX, onPickDay }
}

const zone = process.env.TZ
afterEach(() => {
  process.env.TZ = zone
})

describe('BurnChart', () => {
  it('a tap picks the day under it with no hover first; the projected future picks nothing', () => {
    const { svg, clientX, onPickDay } = draw(read('agent', I.reviewer), 'down')
    fireEvent.click(svg, { clientX: clientX(Date.UTC(2026, 9, 9, 12)) })
    expect(onPickDay).toHaveBeenCalledWith('2026-10-09')
    onPickDay.mockClear()
    fireEvent.click(svg, { clientX: clientX(Date.UTC(2026, 9, 20, 12)) })
    expect(onPickDay).not.toHaveBeenCalled()
  })

  it('ticks fall on UTC midnights in any time zone', () => {
    process.env.TZ = 'Asia/Kolkata'
    const { svg } = draw(read('agent', I.pricing), 'down')
    const ticks = [...svg.querySelectorAll('text')]
      .map((t) => t.textContent ?? '')
      .filter((t) => /^\d{4}-\d\d-\d\dT/.test(t))
    expect(ticks.length).toBeGreaterThan(1)
    for (const t of ticks) expect(t).toMatch(/T00:00:00\.000Z$/)
  })

  it('a flag with two events reads "+2"', () => {
    draw(read('agent', I.reviewer), 'up')
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0)
    expect(screen.queryByText('+1')).toBeNull()
  })

  it('hovering the last day before a reset reads that period’s spend, not the new period’s $0', () => {
    const b = read('agent', I.pricing, { include_previous: 'true', from: '2026-09-01' })
    const daily = b.daily.map((d) => (d.date === '2026-09-30' ? { ...d, cost_usd: 30 } : d))
    const { svg, clientX } = draw({ ...b, daily }, 'up')
    fireEvent.pointerMove(svg, { clientX: clientX(Date.UTC(2026, 8, 30) + DAY / 2) })
    expect(screen.getAllByText('$30').length).toBeGreaterThan(1)
  })
})

describe('BurnTable', () => {
  it('lists the flags’ events under the table and writes over-limit as −$', () => {
    const b = read('agent', I.reviewer)
    render(
      <BurnTable
        rows={tableRows(b)}
        scopeLabel="Code Reviewer"
        fileName="burn.csv"
        events={burnChartData(chartModel(b, 'down')).markers}
      />,
    )
    expect(screen.getByRole('region', { name: 'Events' })).toHaveTextContent('Calls resumed')
    expect(screen.getByText('−$2.00')).toBeInTheDocument()
  })
})
