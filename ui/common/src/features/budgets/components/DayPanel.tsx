/**
 * A picked day's drill-down for the scope (plan feat-budget-burn F3, `?day=`): its top contributors (BG-4 for that
 * day), its hours (BG-12) and its most expensive traces inside the scope (BG-4c, server-scoped, never a wider list
 * filtered here). Another user's session is a redacted row: cost and time only, no link, agent or user (§5.2, eng
 * Codex #4). Each section keeps its own error; a route this server lacks says so in one line.
 */
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { PanelError, PanelSkeleton } from '@/components/shared/panel'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useReturnFocus } from '@/features/router/focus'
import { isEndpointAbsent } from '@/lib/api/detect'
import { fmtLongDay, fmtMoney, fmtUtcTime } from '@/lib/format'
import { useBreakdown, useHours, useTraces, type ScopeRef } from '../api'
import { keyLabel } from '../causes'
import { copy } from '../copy'
import type { Dimension } from '../types'

export function DayPanel({
  day,
  amount,
  scope,
  by,
  enabled,
  onClose,
}: {
  day: string | null
  /** The day's spend from the burn read, for the description. */
  amount: number | null
  scope: ScopeRef
  by: Dimension
  enabled: { breakdown: boolean; hours: boolean; traces: boolean }
  onClose: () => void
}) {
  const open = !!day
  const returnFocus = useReturnFocus(open)
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto sm:max-w-130"
        onCloseAutoFocus={returnFocus}
      >
        {day ? (
          <>
            <SheetHeader>
              <SheetTitle>{copy.dayTitle(fmtLongDay(day))}</SheetTitle>
              <SheetDescription>
                {amount === null ? null : copy.dayDescription(fmtMoney(amount))}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-6 px-4 pb-6">
              <DayContributors day={day} scope={scope} by={by} enabled={enabled.breakdown} />
              <DayHours day={day} scope={scope} enabled={enabled.hours} />
              <DayTraces day={day} scope={scope} enabled={enabled.traces} />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function State({
  q,
  what,
  children,
}: {
  q: { isPending: boolean; error: unknown; refetch: () => unknown }
  what: string
  children: ReactNode
}) {
  if (isEndpointAbsent(q.error))
    return <p className="text-xs text-muted-foreground">{copy.dayMissing}</p>
  if (q.error)
    return <PanelError error={q.error} onRetry={() => void q.refetch()} what={what.toLowerCase()} />
  if (q.isPending) return <PanelSkeleton height={80} />
  return <>{children}</>
}

function DayContributors({
  day,
  scope,
  by,
  enabled,
}: {
  day: string
  scope: ScopeRef
  by: Dimension
  enabled: boolean
}) {
  const q = useBreakdown(scope, { by, period: 'month', from: day, to: day, top: 5 }, enabled)
  return (
    <Section title={copy.dayContributors}>
      <State q={q} what={copy.dayContributors}>
        <ul className="divide-y divide-border text-sm">
          {(q.data?.keys ?? []).map((k) => (
            <li key={k.key} className="flex justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate">{keyLabel(k)}</span>
              <span className="tabular-nums">{fmtMoney(k.cost_usd)}</span>
            </li>
          ))}
          {q.data && q.data.other.cost_usd > 0 ? (
            <li className="flex justify-between gap-3 py-1.5 text-muted-foreground">
              <span>{copy.causesOther(q.data.other.contributors)}</span>
              <span className="tabular-nums">{fmtMoney(q.data.other.cost_usd)}</span>
            </li>
          ) : null}
        </ul>
      </State>
    </Section>
  )
}

function DayHours({ day, scope, enabled }: { day: string; scope: ScopeRef; enabled: boolean }) {
  const q = useHours(scope, day, enabled)
  const hours = q.data?.hours ?? []
  const max = Math.max(1e-9, ...hours.map((h) => h.cost_usd))
  return (
    <Section title={copy.dayHours}>
      <State q={q} what={copy.dayHours}>
        <ol className="space-y-0.5 text-xs">
          {hours
            .filter((h) => h.cost_usd > 0 || h.calls > 0)
            .map((h) => (
              <li key={h.hour} className="grid grid-cols-[3rem_1fr_4.5rem] items-center gap-2">
                <span className="text-muted-foreground tabular-nums">{copy.dayHour(h.hour)}</span>
                <span
                  aria-hidden
                  className="h-2 rounded-xs bg-chart-1"
                  style={{ width: `${(h.cost_usd / max) * 100}%` }}
                />
                <span className="text-right tabular-nums">{fmtMoney(h.cost_usd)}</span>
              </li>
            ))}
        </ol>
      </State>
    </Section>
  )
}

function DayTraces({ day, scope, enabled }: { day: string; scope: ScopeRef; enabled: boolean }) {
  const q = useTraces(scope, day, enabled)
  const rows = q.data ?? []
  return (
    <Section title={copy.dayTraces}>
      <State q={q} what={copy.dayTraces}>
        {!rows.length ? (
          <p className="text-sm text-muted-foreground">{copy.dayTracesNone}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-border">
            {rows.map((t) => (
              <li key={t.row_id} className="flex flex-col gap-1 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  {t.redacted ? (
                    <span className="truncate text-muted-foreground">{copy.dayAnother}</span>
                  ) : t.session_id && t.trace_id ? (
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: t.session_id }}
                      search={{ trace: t.trace_id }}
                      className="truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {t.agent_label ?? t.trace_id}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">{t.agent_label ?? copy.dayAnother}</span>
                  )}
                  <span className="font-semibold tabular-nums">{fmtMoney(t.cost_usd)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{`${fmtUtcTime(t.started_at)} UTC`}</span>
                  {!t.redacted && t.user_label ? <span>{t.user_label}</span> : null}
                  {!t.redacted ? <span>{copy.dayCalls(t.calls)}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </State>
    </Section>
  )
}
