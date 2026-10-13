/**
 * A lever's write (plan feat-budget-burn F4): one click behind a confirm that names its effect, for the agent's owner
 * or a superuser (stop and raise: whoever may write the budget, §5); everyone else sees the list only. Token
 * optimization goes through the agents' own write; a cheaper model pins only that agent through the router's plan,
 * from a fresh read of its routing (eng D4); stop is a guarded PUT of a fresh budget record; raise opens the editor.
 * The confirm's default focus is Cancel (Radix AlertDialog); the button stays busy until the write settles, and the
 * result is announced through the page's live region or shown in the dialog.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAnnounce } from '@/components/shared/announce'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useTurnOnCompression } from '@/features/agents/api'
import { routingQuery, useRoutingPlan } from '@/features/router/api'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { budgetKeys, budgetV1Query, useSaveBudget } from '../api'
import { withStopMark } from '../budgets'
import { copy } from '../copy'
import { budgetError } from '../errors'
import type { Lever } from '../levers'
import type { Burn } from '../types'

type ReduceKind = 'compression' | 'model' | 'stop'

export function LeverAction({
  lever,
  burn,
  onRaise,
  onApplied,
}: {
  lever: Lever
  burn: Burn
  onRaise: (limit: number) => void
  /** After a write lands: the page drops this lever's preview. */
  onApplied: () => void
}) {
  if (lever.kind === 'raise')
    return (
      <Button size="sm" variant="outline" onClick={() => onRaise(lever.limit)}>
        {copy.leverDo.raise}
      </Button>
    )
  if (lever.kind === 'compression') return <Compression lever={lever} onApplied={onApplied} />
  if (lever.kind === 'model') return <Model lever={lever} onApplied={onApplied} />
  return <Stop lever={lever} burn={burn} onApplied={onApplied} />
}

function Confirm({
  kind,
  title,
  body,
  run,
}: {
  kind: ReduceKind
  title: string
  body: string
  /** The write: resolves with the announcement, or throws (shown in the dialog). */
  run: () => Promise<string>
}) {
  const announce = useAnnounce()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      announce(await run())
      setOpen(false)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const err = error ? budgetError(error) : null
  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <Button
        size="sm"
        variant="outline"
        aria-label={copy.leverDoLabel(title)}
        disabled={busy}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        {copy.leverDo[kind]}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {err ? (
          <p role="alert" className="text-sm text-destructive">
            {err.problem} {err.action}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{copy.cancel}</AlertDialogCancel>
          <Button
            variant={kind === 'stop' ? 'destructive' : 'default'}
            disabled={busy}
            onClick={() => void go()}
          >
            {busy ? `${copy.leverDo[kind]}…` : copy.leverDo[kind]}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Compression({
  lever,
  onApplied,
}: {
  lever: Extract<Lever, { kind: 'compression' }>
  onApplied: () => void
}) {
  const qc = useQueryClient()
  const turnOn = useTurnOnCompression()
  return (
    <Confirm
      kind="compression"
      title={copy.leverConfirmCompression(lever.agent.name)}
      body={copy.leverConfirmCompressionBody}
      run={async () => {
        const out = await turnOn.mutateAsync({ ids: [lever.agent.id] })
        if (out.failed[0]) throw out.failed[0].error
        await qc.invalidateQueries({ queryKey: budgetKeys.all })
        onApplied()
        return copy.leverApplied.compression(lever.agent.name)
      }}
    />
  )
}

function Model({
  lever,
  onApplied,
}: {
  lever: Extract<Lever, { kind: 'model' }>
  onApplied: () => void
}) {
  const qc = useQueryClient()
  const plan = useRoutingPlan(lever.agent.id)
  return (
    <Confirm
      kind="model"
      title={copy.leverConfirmModel(lever.agent.name)}
      body={copy.leverConfirmModelBody(lever.agent.name, lever.from.model, lever.to.model)}
      run={async () => {
        // A fresh read: a plan built on a stale route could undo a change made elsewhere (router eng).
        const current = await qc.fetchQuery({ ...routingQuery(lever.agent.id), staleTime: 0 })
        const out = await plan.mutateAsync({
          current: { llm_config_id: current.llm_config_id, pinned_model: current.pinned_model },
          desired: { llm_config_id: current.llm_config_id, pinned_model: lever.to.model },
        })
        if (out.failed) throw out.failed.error
        await qc.invalidateQueries({ queryKey: budgetKeys.all })
        onApplied()
        return copy.leverApplied.model(lever.agent.name, lever.to.model)
      }}
    />
  )
}

function Stop({
  lever,
  burn,
  onApplied,
}: {
  lever: Extract<Lever, { kind: 'stop' }>
  burn: Burn
  onApplied: () => void
}) {
  const qc = useQueryClient()
  const save = useSaveBudget()
  const reset = burn.resets_at ? fmtShortDay(burn.resets_at) : ''
  const id = burn.budget?.id
  return (
    <Confirm
      kind="stop"
      title={copy.leverConfirmStop}
      body={
        lever.immediate
          ? copy.leverConfirmStopNow(reset)
          : copy.leverConfirmStopBody(fmtMoney(lever.limit), reset)
      }
      run={async () => {
        if (!id) throw new Error(copy.leverFailed)
        // The record read fresh: its `updated_at` guards the PUT (a change made elsewhere is refused, not overwritten).
        const b = await qc.fetchQuery({ ...budgetV1Query(id), staleTime: 0 })
        await save.mutateAsync({
          mode: 'update',
          id,
          body: {
            limit_usd: b.limit_usd,
            thresholds: withStopMark(b.thresholds, 'stop'),
            action: 'stop',
            expected_updated_at: b.updated_at,
          },
        })
        onApplied()
        return copy.leverApplied.stop
      }}
    />
  )
}
