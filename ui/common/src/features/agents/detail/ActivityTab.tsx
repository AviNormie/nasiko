/**
 * Activity (plan §7.3): 24 h stats, resources, and logs (newest first) with a live tail. Recent sessions moved to the
 * Overview's hub, which reads a bounded 7-day sample (plans/feat-agent-centric.md PR1c, eng "Hub sessions").
 */
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { SearchInput } from '@/components/shared/search-input'
import { LogDrawer } from '@/features/sessions/LogDrawer'
import { fmtInt, fmtLatency, fmtMoney } from '@/lib/format'
import { ApiError } from '@/lib/api/client'
import { useAgentLogs, useAgentResources, useAgentStats } from '../api'
import { ErrorNote, LearnMore, Section } from '../components/bits'
import { copy } from '../copy'
import type { AgentView } from '../normalize'

const LEVELS = ['', 'ERROR', 'WARN', 'INFO'] as const
/** Radix Select items can't have an empty value: "all levels" travels as this key. */
const ALL = 'all'

export function ActivityTab({
  agent,
  tailOpen,
  onTailChange,
}: {
  agent: AgentView
  tailOpen: boolean
  onTailChange: (open: boolean) => void
}) {
  const stats = useAgentStats(agent.id, true)
  const resources = useAgentResources(agent.id, true)
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('')
  const [term, setTerm] = useState('')
  const levelId = useId()
  const logs = useAgentLogs(agent.id, level, true)
  const obsOff = (e: unknown) => e instanceof ApiError && e.status === 503
  const lines = (logs.data ?? []).filter(
    (l) => !term || l.message.toLowerCase().includes(term.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <Section title={copy.stats}>
        {stats.isPending ? (
          <Skeleton className="h-14" />
        ) : stats.isError ? (
          obsOff(stats.error) ? (
            <p className="text-sm text-muted-foreground">{copy.obsOff}</p>
          ) : (
            <ErrorNote error={stats.error} onRetry={() => void stats.refetch()} />
          )
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat
              label={copy.turns}
              value={fmtInt(stats.data.trace_count ?? 0)}
              title={copy.turnsTip}
            />
            <Stat label={copy.cost} value={fmtMoney(stats.data.cost_summary?.total?.cost ?? 0)} />
            <Stat label={copy.latencyP50} value={fmtLatency(stats.data.latency_ms_p50)} />
            <Stat label={copy.latencyP99} value={fmtLatency(stats.data.latency_ms_p99)} />
          </dl>
        )}
      </Section>

      <Section title={copy.resources}>
        {resources.isPending ? (
          <Skeleton className="h-10" />
        ) : resources.isError ? (
          obsOff(resources.error) ? (
            <p className="text-sm text-muted-foreground">{copy.obsOff}</p>
          ) : (
            <ErrorNote error={resources.error} onRetry={() => void resources.refetch()} />
          )
        ) : !resources.data.usage ? (
          <p className="text-sm text-muted-foreground">{copy.noResources}</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Stat
              label={copy.cpu}
              value={
                resources.data.usage.cpu_percent != null
                  ? `${resources.data.usage.cpu_percent.toFixed(1)}%`
                  : '—'
              }
            />
            <Stat label={copy.memory} value={mb(resources.data.usage.memory_usage_bytes)} />
            <Stat label={copy.memoryLimit} value={mb(resources.data.usage.memory_limit_bytes)} />
          </dl>
        )}
      </Section>

      <Section
        title={copy.logs}
        action={
          <div className="flex items-center gap-2">
            <LearnMore href="operate" />
            <Button size="sm" variant="outline" onClick={() => onTailChange(true)}>
              {copy.liveTail}
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Field orientation="horizontal" className="w-auto gap-1">
            <FieldLabel htmlFor={levelId} className="font-normal text-muted-foreground">
              {copy.level}
            </FieldLabel>
            <Select
              value={level || ALL}
              onValueChange={(v) => setLevel(v === ALL ? '' : (v as (typeof LEVELS)[number]))}
            >
              <SelectTrigger id={levelId} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l || ALL} value={l || ALL}>
                    {l || copy.allLevels}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <SearchInput
            aria-label={copy.searchLogs}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={copy.searchLogs}
            className="h-8"
          />
        </div>
        {logs.isPending ? (
          <Skeleton className="h-24" />
        ) : logs.isError ? (
          logs.error instanceof ApiError && logs.error.status === 404 ? (
            <p className="text-sm text-muted-foreground">{copy.noLogs}</p>
          ) : (
            <ErrorNote error={logs.error} onRetry={() => void logs.refetch()} />
          )
        ) : lines.length ? (
          // Newest first, as the server sends them.
          <ol
            className="max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-xs"
            aria-label={copy.logLines}
          >
            {lines.map((l) => (
              <li
                key={`${l.timestamp}|${l.message}`}
                className={
                  l.level === 'ERROR'
                    ? 'text-destructive'
                    : l.level === 'WARN'
                      ? 'text-warning'
                      : ''
                }
              >
                <span className="text-muted-foreground">
                  {l.timestamp.slice(0, 19).replace('T', ' ')}
                </span>{' '}
                {l.level ? `[${l.level}] ` : ''}
                {l.message}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.noLogs}</p>
        )}
      </Section>
      {tailOpen ? (
        <LogDrawer agent={agent.id} label={agent.displayName} open onOpenChange={onTailChange} />
      ) : null}
    </div>
  )
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base tabular-nums">{value}</dd>
    </div>
  )
}

const mb = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v / 1_048_576)} MB`)
