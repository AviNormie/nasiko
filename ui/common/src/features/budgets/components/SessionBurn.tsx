/**
 * The session ledger's budget (plan feat-budget-burn F9, B5; ledger #85): the session's own burn on its turns. The
 * sentence, the kit chart on a turn axis (`sessionTurnModel`: the actual line, the limit and its marks, no even pace,
 * band or run-out), then three figures: this session's spend (with % of its limit), per turn over the last 5 against
 * the session's average, and what's left of the limit (or how far over). The session's owner or a superuser sets or
 * changes its limit here ("Set a session limit", BG-10), in the shared sheet. The ledger renders it only once the
 * session's burn read answered.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { BurnChart } from '@/components/charts/burn-chart'
import { Delta } from '@/components/shared/delta'
import { KpiTile } from '@/components/shared/kpi-tile'
import { Panel } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { fmtMoney, fmtMoneyFloor } from '@/lib/format'
import { budgetV1Query } from '../api'
import { currentLimit, figures, sessionTurnModel, type BurnMode } from '../burn'
import { rememberBurnMode, storedBurnMode } from '../burnMode'
import { burnAxisMoney, burnChartData, burnChartLabels } from '../chartData'
import { copy } from '../copy'
import { toSheetBudget } from '../editing'
import { sessionSentence } from '../sentence'
import type { Burn } from '../types'
import { BudgetSheet, type BudgetMode } from './BudgetSheet'

const NO_BUDGETS: never[] = []
const NO_AGENTS: never[] = []
const noName = () => undefined

export default function SessionBurn({
  burn,
  sessionId,
  sessionName,
  viewerId,
  writable,
}: {
  burn: Burn
  sessionId: string
  /** The session's title, for the sheet. */
  sessionName: string
  viewerId: string
  /** The session's owner or a superuser (budgets.md §5), on a session that hasn't ended (400 `session_ended`). */
  writable: boolean
}) {
  const id = useId()
  const [mode, setMode] = useState<BurnMode>(() => storedBurnMode(viewerId) ?? 'down')
  const shown: BurnMode = burn.budget ? mode : 'up'
  const m = sessionTurnModel(burn, shown)
  const sentence = sessionSentence(burn)
  const f = figures(burn)
  const floor = f.floor
  const limit = currentLimit(burn)
  const left = limit === null ? null : limit - burn.used_usd

  // Editing in place (F10): the record is read fresh on the click (its `updated_at` guards the PUT).
  const qc = useQueryClient()
  const [editor, setEditor] = useState<BudgetMode | null>(null)
  const who = { kind: 'session' as const, id: sessionId, name: sessionName }
  const edit = async () => {
    if (!burn.budget) return setEditor({ kind: 'create', target: who })
    try {
      const b = await qc.fetchQuery({ ...budgetV1Query(burn.budget.id), staleTime: 0 })
      setEditor({ kind: 'edit', budget: toSheetBudget(b), who })
    } catch {
      toast.error(copy.editLoadFailed)
    }
  }
  if (!m) return null
  return (
    <Panel
      title={copy.sessionTitle}
      labelledBy={id}
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
          {writable ? (
            <Button
              size="sm"
              variant={burn.budget ? 'outline' : 'default'}
              onClick={() => void edit()}
            >
              {burn.budget ? copy.editSessionLimit : copy.setSessionLimit}
            </Button>
          ) : null}
        </>
      }
    >
      <p className="text-sm">{sentence}</p>
      <BurnChart
        compact
        axis="turns"
        data={burnChartData(m)}
        labels={burnChartLabels(m, { stops: burn.budget?.action === 'stop', summary: sentence })}
        formatMoney={burnAxisMoney}
        formatDay={(t) => (t === 0 ? copy.sessionStart : copy.sessionTurn(t))}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border *:rounded-none *:border-0">
        <KpiTile compact label={copy.sessionUsedLabel} value={fmtMoneyFloor(burn.used_usd, floor)}>
          {limit !== null && f.periodToDate.pct !== null ? (
            <span className="text-xs text-muted-foreground">
              {copy.stripOfLimit(`${Math.round(f.periodToDate.pct)}%`, fmtMoney(limit))}
            </span>
          ) : null}
        </KpiTile>
        <KpiTile
          compact
          label={copy.sessionPerTurn}
          aside={
            f.perTurn && f.perTurn.average > 0 ? (
              <Delta
                changePct={((f.perTurn.last5 - f.perTurn.average) / f.perTurn.average) * 100}
                polarity="down-good"
              />
            ) : null
          }
          value={f.perTurn ? fmtMoneyFloor(f.perTurn.last5, floor) : '—'}
        >
          {f.perTurn ? (
            <span className="text-xs text-muted-foreground">
              {copy.sessionPerTurnVs(fmtMoney(f.perTurn.average))}
            </span>
          ) : null}
        </KpiTile>
        {left !== null ? (
          <KpiTile
            compact
            label={left < 0 ? copy.sessionOverBy : copy.sessionLeft}
            // With unpriced calls spend is a floor: what's left is a ceiling, an overage a floor (F2).
            value={
              left < 0
                ? fmtMoneyFloor(-left, floor)
                : floor
                  ? copy.stripAtMost(fmtMoney(left))
                  : fmtMoney(left)
            }
          />
        ) : null}
      </div>
      <BudgetSheet
        mode={editor}
        budgets={NO_BUDGETS}
        agents={NO_AGENTS}
        agentName={noName}
        resetsAt={burn.session?.ended_at ?? burn.as_of}
        onClose={() => setEditor(null)}
      />
    </Panel>
  )
}
