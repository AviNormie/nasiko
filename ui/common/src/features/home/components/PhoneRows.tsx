/**
 * The home's rows below 640 px (plans/feat-agent-centric.md design "Responsive"): two lines each, name · kind · health,
 * then spend · budget use, so nothing scrolls sideways (QA ISSUE-002). Same rows, order and groups as the table; the
 * table's other columns (saved, last change) are one tap away on the agent's hub.
 */
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { fmtMoney } from '@/lib/format'
import { copy } from '../copy'
import { ownerLine, rowGroups, type HomeRow } from '../rows'
import { BudgetUse } from './RowCells'
import { GroupLabel, Health, type RowsProps } from './RowsTable'

export function PhoneRows(p: RowsProps) {
  const groups = rowGroups(p.rows, p.grouped, p.ownerName)
  return (
    <section aria-label={copy.table.label} className="flex flex-col gap-3">
      {groups ? (
        groups.map((g) => (
          <section key={g.key} aria-label={g.label} className="flex flex-col gap-1">
            <h3 className="m-0 text-xs font-medium">
              <GroupLabel group={g} />
            </h3>
            <List {...p} rows={g.rows} />
          </section>
        ))
      ) : (
        <List {...p} />
      )}
    </section>
  )
}

function List({ rows, ...p }: RowsProps) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border border-border p-0">
      {rows.map((r) => (
        <li key={r.id} data-testid="home-phone-row" className="flex flex-col gap-1 px-3 py-2">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to="/agents/$agentId"
              params={{ agentId: r.id }}
              className="py-2 font-medium underline-offset-4 hover:underline"
            >
              {r.displayName}
            </Link>
            {r.harness ? <Badge variant="outline">{copy.table.harness}</Badge> : null}
            {r.needs ? <Badge variant="destructive">{copy.phone.needs(r.needs)}</Badge> : null}
            <Health row={r} pending={p.ratingsPending} />
          </span>
          <span className="flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums">
            <Spend row={r} days={p.days} />
            {p.budgets.state === 'ok' && r.budget ? (
              <BudgetUse row={r} state={p.budgets.state} />
            ) : null}
          </span>
          {p.grouped ? null : (
            <span className="text-xs text-muted-foreground">{ownerLine(r, p.ownerName)}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

function Spend({ row, days }: { row: HomeRow; days: number }) {
  return (
    <span>
      <span className="text-muted-foreground">{copy.table.spend(days)} </span>
      {row.spend === null ? '—' : fmtMoney(row.spend)}
      {row.harness && (row.spend ?? 0) > 0 ? (
        <span className="ml-1 text-xs text-muted-foreground">{copy.table.estimate}</span>
      ) : null}
    </span>
  )
}
