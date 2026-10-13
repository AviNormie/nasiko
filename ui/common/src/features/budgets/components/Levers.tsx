/**
 * Levers (plan feat-budget-burn F4, design 4A): two groups, Reduce projected spend (each with its estimated effect and
 * its basis) and Adjust the budget (the new limit and the share already used, never a saving). Preview toggles the
 * dashed line on the chart and a line in the strip before anything is written; one preview at a time (the page clears
 * the others). `actions` renders a lever's write (B3's next increment); without it, people see the list only.
 */
import { useId, type ReactNode, type Ref } from 'react'
import { Panel, PanelSkeleton } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import { fmtMoney } from '@/lib/format'
import { copy } from '../copy'
import type { Lever, LeverList } from '../levers'

export function Levers({
  list,
  loading,
  rest,
  period,
  previewing,
  onPreview,
  actions,
  titleRef,
}: {
  list: LeverList
  loading: boolean
  /** "October" (or "the quarter"): what the estimates assume follows the last 7 days. */
  rest: string
  period: 'month' | 'quarter'
  previewing: string | null
  onPreview: (id: string | null) => void
  actions?: (lever: Lever) => ReactNode
  titleRef?: Ref<HTMLHeadingElement>
}) {
  const id = useId()
  return (
    <Panel
      title={copy.leversTitle}
      subtitle={list.state === 'levers' ? copy.leversAssume(rest) : undefined}
      labelledBy={id}
      focusableTitle
      titleRef={titleRef}
    >
      {loading ? (
        <PanelSkeleton height={120} />
      ) : list.state === 'no_budget' ? (
        <p className="text-sm text-muted-foreground">{copy.leversNoBudget}</p>
      ) : list.state === 'no_projection' ? (
        <p className="text-sm text-muted-foreground">{copy.leversNoProjection}</p>
      ) : list.state === 'on_track' ? (
        <p className="text-sm text-muted-foreground">{copy.leversOnTrack}</p>
      ) : !list.reduce.length && !list.adjust.length ? (
        <p className="text-sm text-muted-foreground">{copy.leversNone}</p>
      ) : (
        <div className="space-y-4">
          {list.reduce.length ? (
            <Group title={copy.leversReduce}>
              {list.reduce.map((l) => (
                <Row
                  key={l.id}
                  lever={l}
                  period={period}
                  previewing={previewing === l.id}
                  onPreview={onPreview}
                  action={actions?.(l)}
                />
              ))}
            </Group>
          ) : null}
          {list.adjust.length ? (
            <Group title={copy.leversAdjust}>
              {list.adjust.map((l) => (
                <Row
                  key={l.id}
                  lever={l}
                  period={period}
                  previewing={previewing === l.id}
                  onPreview={onPreview}
                  action={actions?.(l)}
                />
              ))}
            </Group>
          ) : null}
        </div>
      )}
    </Panel>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  )
}

function Row({
  lever,
  period,
  previewing,
  onPreview,
  action,
}: {
  lever: Lever
  period: 'month' | 'quarter'
  previewing: boolean
  onPreview: (id: string | null) => void
  action?: ReactNode
}) {
  const { title, basis } = describe(lever)
  // A lever without a number has nothing to draw.
  const previewable = lever.kind === 'raise' || lever.estimate !== null
  return (
    <li
      data-lever={lever.id}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          {lever.kind === 'raise'
            ? basis
            : `${lever.estimate === null ? copy.leverNoEstimate : copy.leverEstimate(fmtMoney(lever.estimate), period)} · ${basis}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {previewable ? (
          <Button
            variant={previewing ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={previewing}
            aria-label={copy.leverPreviewLabel(title)}
            onClick={() => onPreview(previewing ? null : lever.id)}
          >
            {copy.leverPreview}
          </Button>
        ) : null}
        {action}
      </div>
    </li>
  )
}

function describe(l: Lever): { title: string; basis: string } {
  switch (l.kind) {
    case 'compression':
      return {
        title: copy.leverCompression(l.agent.name),
        basis:
          l.basisAgents && l.estimate !== null
            ? copy.leverCompressionBasis(l.basisAgents)
            : copy.leverCompressionNoBasis,
      }
    case 'model':
      return {
        title: copy.leverModel(l.agent.name),
        basis: copy.leverModelBasis(l.from.model, l.to.model),
      }
    case 'stop':
      return {
        title: copy.leverStop,
        basis: l.immediate ? copy.leverStopNow : copy.leverStopBasis(fmtMoney(l.limit)),
      }
    case 'raise':
      return {
        title: copy.leverRaise(fmtMoney(l.limit)),
        basis: copy.leverRaiseBasis(`${Math.round(l.usedPct)}%`),
      }
  }
}
