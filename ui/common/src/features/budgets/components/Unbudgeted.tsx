/**
 * Unbudgeted (plan feat-budget-burn F7): agents inside the scope with spend this period and no agent budget, by spend.
 * A fleet, unit or owner budget still covers them in total; the list names them. A harness with no routed calls can't
 * take a budget that would count anything, so it says why instead of offering one. `actions` renders "Set a budget"
 * (the budget editor, B2's next increment).
 */
import { Link } from '@tanstack/react-router'
import { useId, type ReactNode } from 'react'
import { Panel, PanelError, PanelSkeleton } from '@/components/shared/panel'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { isEndpointAbsent } from '@/lib/api/detect'
import { fmtMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { copy } from '../copy'
import type { UnbudgetedRow } from '../types'
import { Owner } from './AtRisk'
import { CELL, HEAD, Label, ROW } from './tableStyles'

export function Unbudgeted({
  rows,
  error,
  pending,
  onRetry,
  onOwner,
  actions,
}: {
  rows: readonly UnbudgetedRow[] | undefined
  error: unknown
  pending: boolean
  onRetry: () => void
  onOwner: ((id: string) => void) | null
  actions?: (row: UnbudgetedRow) => ReactNode
}) {
  const id = useId()
  return (
    <Panel title={copy.unbudgetedTitle} subtitle={copy.unbudgetedSubtitle} labelledBy={id}>
      {pending ? (
        <PanelSkeleton height={96} />
      ) : isEndpointAbsent(error) ? (
        <p className="text-xs text-muted-foreground">{copy.sectionMissing}</p>
      ) : error && !rows ? (
        <PanelError error={error} onRetry={onRetry} what={copy.unbudgetedFailed} />
      ) : !rows?.length ? (
        <p className="text-sm text-muted-foreground">{copy.unbudgetedEmpty}</p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table aria-labelledby={id} className="max-lg:block">
            <TableHeader className="max-lg:sr-only">
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>{copy.colAgent}</TableHead>
                <TableHead className={HEAD}>{copy.colOwner}</TableHead>
                <TableHead className={HEAD}>{copy.colSpend}</TableHead>
                <TableHead className={HEAD}>{copy.colSplit}</TableHead>
                <TableHead className={HEAD}>
                  <span className="sr-only">{copy.colActions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-lg:block">
              {rows.map((r) => (
                <TableRow key={r.agent_id} data-agent={r.agent_id} className={ROW}>
                  <TableCell className={cn(CELL, 'min-w-0')}>
                    <Link
                      to="/agents/$agentId"
                      params={{ agentId: r.agent_id }}
                      className="block truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {r.label}
                    </Link>
                  </TableCell>
                  <TableCell className={cn(CELL, 'text-muted-foreground')}>
                    <Label>{copy.colOwner}</Label>
                    <Owner id={r.owner_id} label={r.owner_label} onOwner={onOwner} />
                  </TableCell>
                  <TableCell className={cn(CELL, 'tabular-nums')}>
                    <Label>{copy.colSpend}</Label>
                    {r.unpriced_calls > 0 ? '≥ ' : ''}
                    {fmtMoney(r.used_usd)}
                  </TableCell>
                  <TableCell className={cn(CELL, 'text-xs text-muted-foreground tabular-nums')}>
                    <Label>{copy.colSplit}</Label>
                    {[r.routed_usd, r.traced_usd, r.harness_estimate_usd].map(fmtMoney).join(' · ')}
                  </TableCell>
                  <TableCell className={cn(CELL, 'text-xs text-muted-foreground')}>
                    {r.harness && r.routed_calls === 0
                      ? copy.unbudgetedHarness
                      : actions
                        ? actions(r)
                        : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  )
}
