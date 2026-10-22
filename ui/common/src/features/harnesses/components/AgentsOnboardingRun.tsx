/**
 * One run on the onboarding card: its device and client, the overall bar, the history timeline (v2 windows), the
 * steps and one row per agent, what still waits to be sent, and the turns the server refused with their Retry.
 */
import { AlertTriangle, Check, CircleDashed, Loader2, Minus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { copy as pageCopy } from '../copy'
import type { RetryControl } from '../onboarding'
import { harnessStyle } from '../rollup'
import {
  pendingTurns,
  rejectedTurns,
  runProgress,
  runTotals,
  shownPhase,
  type SyncAgent,
  type SyncRun,
} from '../runs'
import { WindowTimeline } from './AgentsOnboardingWindows'

const copy = pageCopy.agentsOnboarding

/** The known harnesses' own names; anything else keeps the server's. */
const agentName = (a: Pick<SyncAgent, 'id' | 'name'>) => {
  const s = harnessStyle(a.id)
  return s.known ? s.name : a.name
}

/** One device's run: its name and client, the overall bar, the history timeline, then the steps and one row per
 *  agent, what is still waiting to be sent, and the turns the server refused with their Retry. */
export function RunBlock({ run, retry }: { run: SyncRun; retry: RetryControl }) {
  const value = runProgress(run)
  const phase = shownPhase(run)
  const detected = run.agents.filter((a) => a.detected)
  const pastDiscovery = phase !== 'discovering'
  const connected = phase !== 'discovering' && phase !== 'connecting'
  const pending = pendingTurns(run)
  return (
    <div className="flex flex-col gap-2" data-testid="agents-onboarding-run">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{run.device_name}</span>
        <Badge variant="outline">{copy.clientLabel(run.client)}</Badge>
      </div>
      {phase === 'failed' ? null : (
        <Progress
          aria-label={copy.progressLabel(run.device_name)}
          value={value}
          // The shadcn copy keeps `value` off the Radix root, so the number is given to assistive tech here.
          aria-valuenow={value ?? undefined}
          aria-valuetext={value === null ? undefined : `${value}%`}
          className={value === null ? 'animate-pulse motion-reduce:animate-none' : undefined}
        />
      )}
      {run.windows.length && (phase === 'importing' || phase === 'sending') ? (
        <WindowTimeline windows={run.windows} device={run.device_name} />
      ) : null}
      <ul className="flex flex-col gap-1 text-sm">
        <Step done={pastDiscovery}>
          {pastDiscovery && !detected.length ? copy.noneFound : copy.found(detected.map(agentName))}
        </Step>
        {detected.length ? (
          <Step done={connected}>{connected ? copy.connected : copy.connecting}</Step>
        ) : null}
        {connected
          ? run.agents.flatMap((a) => [
              <AgentRow key={a.id} agent={a} />,
              a.import.rejected > 0 ? <RejectedRow key={`${a.id}-rejected`} agent={a} /> : null,
            ])
          : null}
      </ul>
      {pending > 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {copy.sending(pending)}
        </p>
      ) : null}
      {phase === 'done' ? <p className="text-sm">{summary(run)}</p> : null}
      {rejectedTurns(run) > 0 || retry.requested(run) ? (
        <RetrySending run={run} retry={retry} />
      ) : null}
      {phase === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {copy.runFailed(run.error)}
        </p>
      ) : null}
    </div>
  )
}

function summary(run: SyncRun) {
  const t = runTotals(run)
  return copy.summary(t.sessions, t.turns, t.agents.map(agentName))
}

function Step({ done, children }: { done: boolean; children: string }) {
  return (
    <li className="flex items-center gap-2">
      {done ? (
        <Check aria-hidden className="size-4 text-success" />
      ) : (
        <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      )}
      <span>{children}</span>
    </li>
  )
}

function AgentRow({ agent }: { agent: SyncAgent }) {
  const name = agentName(agent)
  const imp = agent.import
  if (!agent.detected) return <Row icon="none" text={copy.notOnComputer(name)} />
  if (!agent.connected) return <Row icon="none" text={copy.notConnected(name)} />
  switch (imp.status) {
    case 'running':
      return <Row icon="busy" text={copy.importing(name, imp.done, imp.total)} />
    case 'done':
      return (
        <Row
          icon="done"
          text={`${copy.imported(name, imp.sessions, imp.turns)}${imp.failed ? copy.unreadable(imp.failed) : ''}`}
        />
      )
    case 'failed':
      return <Row icon="failed" text={copy.agentFailed(name, imp.error)} />
    case 'skipped':
      return <Row icon="none" text={copy.notConnected(name)} />
    case 'waiting':
      return <Row icon="waiting" text={copy.waitingAgent(name)} />
  }
}

/** An agent's refused turns, with how many each reason covers. */
function RejectedRow({ agent }: { agent: SyncAgent }) {
  const imp = agent.import
  return (
    <Row icon="failed" text={copy.rejected(agentName(agent), imp.rejected, imp.rejected_reasons)} />
  )
}

/** Retry for a run's refused turns; once asked, a line saying the computer will resend them (until it does). */
function RetrySending({ run, retry }: { run: SyncRun; retry: RetryControl }) {
  if (retry.requested(run)) return <p className="text-sm">{copy.retryRequested}</p>
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={retry.pending(run)}
          onClick={() => retry.send(run)}
        >
          {copy.retrySend}
        </Button>
      </div>
      {retry.failed(run) ? (
        <p role="alert" className="text-sm text-destructive">
          {copy.retryFailed}
        </p>
      ) : null}
    </div>
  )
}

const ROW_ICONS = {
  done: <Check aria-hidden className="size-4 text-success" />,
  busy: <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />,
  waiting: <CircleDashed aria-hidden className="size-4 text-muted-foreground" />,
  failed: <AlertTriangle aria-hidden className="size-4 text-destructive" />,
  none: <Minus aria-hidden className="size-4 text-muted-foreground" />,
} as const

function Row({ icon, text }: { icon: keyof typeof ROW_ICONS; text: string }) {
  return (
    <li className={`flex items-center gap-2 ${icon === 'none' ? 'text-muted-foreground' : ''}`}>
      {ROW_ICONS[icon]}
      <span>{text}</span>
    </li>
  )
}
