/**
 * The hub's Budget section (plan feat-budget-burn F10, B5; ledger #83): this agent's budget as /budgets draws a scope,
 * minus what only a wider scope has (what-if, At risk, Unbudgeted, alerts). The sentence with one action (Review
 * actions when projected over, else Set or Edit for whoever may write it), the burn card with its bars by model
 * (switchable to operation or session) and the agent's own changes as flags, the strip, and the levers. Without a
 * budget it is the burn-up projection and "Set a budget" (F13). A picked day opens the day panel; the picked
 * contributor and day are the section's own state (the hub's URL keeps its timeline's keys). The hub renders it only
 * once the agent's burn read answered.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PanelError } from '@/components/shared/panel'
import { Button } from '@/components/ui/button'
import { fmtShortDay } from '@/lib/format'
import { budgetV1Query, useBreakdown, useBudgetV1, useBurn, type ScopeRef } from '../api'
import { mayHave, type Availability } from '../availability'
import { expectedLine, type BurnMode } from '../burn'
import { rememberBurnMode, storedBurnMode } from '../burnMode'
import { dimensionsFor, keyLabel, shareLine } from '../causes'
import type { ExtraMarker } from '../chartData'
import { copy } from '../copy'
import { canWrite, toSheetBudget } from '../editing'
import { leverPreview } from '../levers'
import type { Viewer } from '../scope'
import { burnSentence, restOf } from '../sentence'
import type { Burn, Dimension } from '../types'
import { useLevers } from '../useLevers'
import { BudgetSheet, type BudgetMode } from './BudgetSheet'
import { BurnCard } from './BurnCard'
import { BurnStrip } from './BurnStrip'
import { Contributors } from './Contributors'
import { DayPanel } from './DayPanel'
import { LeverAction } from './LeverAction'
import { Levers } from './Levers'
import { ShareStrip } from './ShareStrip'

const NO_BUDGETS: never[] = []
const NO_AGENTS: never[] = []
const noName = () => undefined

export default function AgentBudgetSection({
  burn,
  agent,
  viewer,
  caps,
  markers,
  markersNote,
  applied,
}: {
  burn: Burn
  agent: { id: string; name: string; ownerId: string | null }
  viewer: Viewer
  caps: Availability
  /** The agent's own changes in the period (the hub's markers), drawn beside the budget's events. */
  markers: readonly ExtraMarker[]
  /** One quiet line when only some changes are known (the hub's partial-state rule). */
  markersNote: string | null
  /**
   * The latest change that moves this agent's pace (Token optimization, a model pin) from the hub's event log: its
   * "expected" line (F13). Absent when the event log isn't there (then the write's own announcement is all).
   */
  applied: { at: number } | null
}) {
  const titleId = useId()
  const ref: ScopeRef = { scope: 'agent', id: agent.id }
  const words: 'month' | 'quarter' = burn.period === 'quarter' ? 'quarter' : 'month'
  const sentence = burnSentence(burn, words)
  const [mode, setMode] = useState<BurnMode>(() => storedBurnMode(viewer.id) ?? 'down')
  const shownMode: BurnMode = burn.budget ? mode : 'up'
  const can = (f: Parameters<typeof mayHave>[1]) => mayHave(caps, f)

  // Causes (F3): by model, operation or session; a picked contributor's share; a picked day.
  const dimensions = dimensionsFor('agent')
  const [by, setBy] = useState<Dimension>(dimensions[0] ?? 'model')
  const [picked, setPicked] = useState<string | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const breakdown = useBreakdown(ref, { by, period: words, top: 5 }, can('breakdown'))
  const contributor = useBurn(
    ref,
    { period: words, contributor: picked ? { by, key: picked } : null },
    !!picked && can('contributor'),
  )
  const shareRead = picked && contributor.data?.contributor ? contributor.data : null

  // Levers (F4): one preview at a time, the lever's or a picked contributor's.
  const own = useBudgetV1(burn.budget?.id ?? null, true)
  const levers = useLevers(burn, ref, caps, viewer, true, own.data?.action)
  const [leverId, setLeverId] = useState<string | null>(null)
  const lever =
    picked || levers.list.state !== 'levers'
      ? null
      : ([...levers.list.reduce, ...levers.list.adjust].find((l) => l.id === leverId) ?? null)
  const preview = lever ? leverPreview(burn, shownMode, lever) : null
  const leversRef = useRef<HTMLHeadingElement>(null)
  const expectedPoints = applied ? expectedLine(burn, shownMode, applied.at) : null
  const expected =
    applied && expectedPoints
      ? { line: expectedPoints, label: copy.burnExpected(fmtShortDay(applied.at)) }
      : null
  // A link to `#hub-budget` (Needs you's budget rows) lands here once the section exists: it renders after its reads.
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (window.location.hash === '#hub-budget')
      sectionRef.current?.scrollIntoView({ block: 'start' })
  }, [])

  // Editing in place (F10): the record is read fresh on the click (its `updated_at` guards the PUT).
  const qc = useQueryClient()
  const [editor, setEditor] = useState<BudgetMode | null>(null)
  const who = { kind: 'agent' as const, id: agent.id, name: agent.name }
  const writable = canWrite('agent', agent.ownerId, viewer)
  const edit = async (limit?: number) => {
    if (!burn.budget) return setEditor({ kind: 'create', target: who, limit })
    try {
      const b = await qc.fetchQuery({ ...budgetV1Query(burn.budget.id), staleTime: 0 })
      setEditor({ kind: 'edit', budget: toSheetBudget(b), who, limit })
    } catch {
      toast.error(copy.editLoadFailed)
    }
  }
  const slug = agent.name.replace(/[^\w-]+/g, '-').toLowerCase()
  const date = burn.as_of.slice(0, 10)
  return (
    <>
      <section
        ref={sectionRef}
        id="hub-budget"
        aria-labelledby={titleId}
        className="scroll-mt-16 space-y-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id={titleId} className="text-sm font-semibold">
              {copy.hubTitle}
            </h2>
            <p className="text-lead">{sentence}</p>
          </div>
          {levers.list.state === 'levers' ? (
            <Button
              size="sm"
              onClick={() => {
                leversRef.current?.scrollIntoView({ block: 'start' })
                leversRef.current?.focus()
              }}
            >
              {copy.reviewActions}
            </Button>
          ) : writable ? (
            <Button
              size="sm"
              variant={burn.budget ? 'outline' : 'default'}
              onClick={() => void edit()}
            >
              {burn.budget ? copy.editBudget : copy.setBudget}
            </Button>
          ) : null}
        </div>
        <BurnCard
          burn={burn}
          mode={mode}
          onMode={(m) => {
            rememberBurnMode(viewer.id, m)
            setMode(m)
          }}
          sentence={sentence}
          pickedDay={day}
          onPickDay={setDay}
          fileName={`budget-burn-${slug}-${date}.csv`}
          breakdown={breakdown.data}
          share={
            shareRead?.contributor
              ? {
                  name: keyLabel({ label: shareRead.contributor.label, redacted: false }),
                  line: shareLine(shareRead),
                }
              : null
          }
          onClearShare={() => setPicked(null)}
          preview={preview?.line ?? null}
          extraMarkers={markers}
          expected={expected}
          footer={
            <>
              {markersNote ? <p className="text-xs text-muted-foreground">{markersNote}</p> : null}
              <Contributors
                breakdown={breakdown.data}
                error={breakdown.error}
                pending={breakdown.isPending && breakdown.fetchStatus !== 'idle'}
                missing={!can('breakdown')}
                onRetry={() => void breakdown.refetch()}
                by={by}
                dimensions={dimensions}
                onBy={(d) => {
                  setBy(d)
                  setPicked(null)
                }}
                picked={picked}
                onPick={(key) => {
                  setLeverId(null)
                  setPicked(key === picked ? null : key)
                }}
                fileName={`budget-contributors-${slug}-${date}.csv`}
              />
            </>
          }
        />
        {picked && contributor.isError ? (
          <PanelError
            error={contributor.error}
            onRetry={() => void contributor.refetch()}
            what={copy.shareFailed}
          />
        ) : shareRead ? (
          <ShareStrip scope={burn} read={shareRead} agentId={null} />
        ) : (
          <BurnStrip
            burn={burn}
            kind={words}
            showQuarter={false}
            preview={preview ? { projected: preview.projected, limit: preview.limit } : null}
            onResetPreview={() => setLeverId(null)}
          />
        )}
        {burn.budget ? (
          <Levers
            list={levers.list}
            loading={levers.loading}
            rest={restOf(burn)}
            period={words}
            previewing={lever ? lever.id : null}
            onPreview={(id) => {
              setLeverId(id)
              if (id) setPicked(null)
            }}
            titleRef={leversRef}
            // Who: the agent's owner or a superuser (F4, §5); here that is whoever may write this budget.
            actions={(l) =>
              writable ? (
                <LeverAction
                  lever={l}
                  burn={burn}
                  onRaise={(limit) => {
                    setLeverId(null)
                    void edit(limit)
                  }}
                  onApplied={() => setLeverId(null)}
                />
              ) : null
            }
          />
        ) : null}
        <BudgetSheet
          mode={editor}
          budgets={NO_BUDGETS}
          agents={NO_AGENTS}
          agentName={noName}
          resetsAt={burn.resets_at ?? burn.as_of}
          onClose={() => setEditor(null)}
          quarters={mayHave(caps, 'quarter_periods')}
        />
        <DayPanel
          day={day}
          amount={burn.daily.find((d) => d.date === day)?.cost_usd ?? null}
          scope={ref}
          by={by}
          enabled={{ breakdown: can('breakdown'), hours: can('hours'), traces: can('traces') }}
          onClose={() => setDay(null)}
        />
      </section>
    </>
  )
}
