/**
 * At risk (plan feat-budget-burn F7, approved row): budgets inside the scope that are exceeded, will reach their limit
 * before the reset, or crossed a mark, in the server's order (BG-6). A row: the linked name with "stops calls" or
 * "alert only" under it, the owner as quiet text (a link to their scope for a superuser, design 7A), used of limit as
 * the R2 bar with the true percent, projected, and when it reaches the limit ("runs out" only where calls stop, 1C).
 * `actions` renders a row's edit controls (the budget editor, B2's next increment).
 */
import { Link } from '@tanstack/react-router'
import { useId, type ReactNode } from 'react'
import { Panel, PanelError, PanelSkeleton } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { isEndpointAbsent } from '@/lib/api/detect'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { copy } from '../copy'
import { Partial } from './Partial'
import type { AtRiskRow } from '../types'
import { CELL, CELL_STACKED, HEAD, Label, ROW, ROW_STACKED, StackedLabel } from './tableStyles'
import { UsedBar } from './UsedBar'

export function AtRisk({
  rows,
  partial,
  missing,
  error,
  pending,
  onRetry,
  resetsAt,
  limitsInside,
  onOwner,
  actions,
}: {
  rows: readonly AtRiskRow[] | undefined
  /** A later page failed: the rows shown are the first ones. */
  partial: boolean
  /** This server doesn't serve the list (F11): one line, never an empty state. */
  missing: boolean
  error: unknown
  pending: boolean
  onRetry: () => void
  /** The scope's reset, for the empty line. */
  resetsAt: string | null
  /** "Limits inside it" (D15), when a direct child shares the period. */
  limitsInside: { usd: number; count: number } | null
  onOwner: ((id: string) => void) | null
  actions?: (row: AtRiskRow) => ReactNode
}) {
  const id = useId()
  return (
    <Panel
      title={copy.atRiskTitle}
      subtitle={
        limitsInside && limitsInside.count > 0
          ? copy.atRiskLimitsInside(fmtMoney(limitsInside.usd), limitsInside.count)
          : undefined
      }
      labelledBy={id}
    >
      {missing ? (
        <p className="text-xs text-muted-foreground">{copy.sectionMissing}</p>
      ) : pending ? (
        <PanelSkeleton height={120} />
      ) : missing || isEndpointAbsent(error) ? (
        <p className="text-xs text-muted-foreground">{copy.sectionMissing}</p>
      ) : error && !rows ? (
        <PanelError error={error} onRetry={onRetry} what={copy.atRiskFailed} />
      ) : !rows?.length ? (
        <p className="text-sm text-muted-foreground">
          {copy.atRiskEmpty(resetsAt ? fmtShortDay(resetsAt) : '')}
        </p>
      ) : (
        <AtRiskTable labelledBy={id} rows={rows} onOwner={onOwner} actions={actions} />
      )}
      {partial ? <Partial onRetry={onRetry} /> : null}
    </Panel>
  )
}

/** An agent budget opens its hub, an owner budget that owner's scope (superuser), a session its ledger. */
function Name({ row, onOwner }: { row: AtRiskRow; onOwner: ((id: string) => void) | null }) {
  const cls =
    'block truncate font-medium underline-offset-4 hover:underline focus-visible:underline'
  if (row.scope === 'agent' && row.target_id)
    return (
      <Link to="/agents/$agentId" params={{ agentId: row.target_id }} className={cls}>
        {row.label}
      </Link>
    )
  if (row.scope === 'session' && row.target_id)
    return (
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: row.target_id }}
        search={{ view: 'ledger' }}
        className={cls}
      >
        {row.label}
      </Link>
    )
  const target = row.target_id
  if (row.scope === 'owner' && target && onOwner)
    return (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 font-medium text-foreground"
        onClick={() => onOwner(target)}
      >
        {row.label}
      </Button>
    )
  return <span className="block truncate font-medium">{row.label}</span>
}

/** The owner as quiet text; a superuser's opens their scope (design 7A: underlined on hover and focus only). */
export function Owner({
  id,
  label,
  onOwner,
}: {
  id: string | null
  label: string | null
  onOwner: ((id: string) => void) | null
}) {
  if (!id || !label || !onOwner) return <>{label ?? '—'}</>
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 font-normal text-muted-foreground no-underline hover:underline focus-visible:underline"
      onClick={() => onOwner(id)}
    >
      {label}
    </Button>
  )
}

/**
 * The At risk table alone: the page's panel, and Home's Budget burn panel with its top 3 (`compact`: the same columns
 * minus Projected, plan F7).
 */
export function AtRiskTable({
  labelledBy,
  rows,
  onOwner,
  actions,
  compact = false,
}: {
  labelledBy: string
  rows: readonly AtRiskRow[]
  onOwner: ((id: string) => void) | null
  actions?: (row: AtRiskRow) => ReactNode
  compact?: boolean
}) {
  // Narrow (Home's column): the stacked layout at every width, labels inline.
  const ROW_ = compact ? ROW_STACKED : ROW
  const CELL_ = compact ? CELL_STACKED : CELL
  const Label_ = compact ? StackedLabel : Label
  return (
    <div className="rounded-lg border border-border">
      <Table aria-labelledby={labelledBy} className={compact ? 'block' : 'max-lg:block'}>
        <TableHeader className={compact ? 'sr-only' : 'max-lg:sr-only'}>
          <TableRow className="hover:bg-transparent">
            <TableHead className={HEAD}>{copy.colBudget}</TableHead>
            <TableHead className={HEAD}>{copy.colOwner}</TableHead>
            <TableHead className={HEAD}>{copy.colUsed}</TableHead>
            {compact ? null : <TableHead className={HEAD}>{copy.colProjected}</TableHead>}
            <TableHead className={HEAD}>{copy.colReaches}</TableHead>
            {actions ? (
              <TableHead className={HEAD}>
                <span className="sr-only">{copy.colActions}</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody className={compact ? 'block' : 'max-lg:block'}>
          {rows.map((r) => (
            <TableRow key={r.budget_id} data-budget={r.budget_id} className={ROW_}>
              <TableCell className={cn(CELL_, 'min-w-0')}>
                <Name row={r} onOwner={onOwner} />
                <span className="block text-xs text-muted-foreground">
                  {r.action === 'stop' ? copy.atRiskStops : copy.atRiskAlerts}
                </span>
              </TableCell>
              <TableCell className={cn(CELL_, 'text-muted-foreground')}>
                <Label_>{copy.colOwner}</Label_>
                <Owner id={r.owner_id} label={r.owner_label} onOwner={onOwner} />
              </TableCell>
              <TableCell className={CELL_}>
                <div className="flex items-center gap-2">
                  <UsedBar
                    used={r.used_usd}
                    limit={r.limit_usd}
                    state={r.state}
                    stopped={r.stopped}
                  />
                  <span className="whitespace-nowrap">
                    {copy.usedOf(fmtMoney(r.used_usd), fmtMoney(r.limit_usd))}
                  </span>
                  <span
                    className={cn(
                      'text-xs tabular-nums',
                      r.used_usd > r.limit_usd ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {r.limit_usd > 0 ? `${Math.round((r.used_usd / r.limit_usd) * 100)}%` : ''}
                  </span>
                </div>
              </TableCell>
              {compact ? null : (
                <TableCell className={cn(CELL_, 'tabular-nums')}>
                  <Label_>{copy.colProjected}</Label_>
                  {/* A stopped budget spends nothing more until the reset: no projection (#68). */}
                  {r.stopped || r.rank.projected_pct === null
                    ? '—'
                    : `${Math.round(r.rank.projected_pct)}%`}
                </TableCell>
              )}
              <TableCell className={CELL_}>
                <Label_>{copy.colReaches}</Label_>
                {r.rank.reason === 'exceeded'
                  ? r.stopped
                    ? copy.atRiskRanOut
                    : copy.atRiskExceeded
                  : r.rank.runs_out_on
                    ? fmtShortDay(r.rank.runs_out_on)
                    : copy.atRiskNoRunOut}
              </TableCell>
              {actions ? <TableCell className={CELL_}>{actions(r)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
