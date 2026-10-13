/**
 * The /budgets sentence (plan feat-budget-burn F1, F12): one or two templated clauses above the chart, also the
 * chart's accessible summary. "Ran out" and "stopped" only where calls stop (design 1C); with unpriced calls the
 * figures are floors and the allowance a ceiling (F2). No causal words. Pure; `sentence.test.ts`.
 */
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { currentLimit, figures, projection, runOut } from './burn'
import { needsLevers } from './levers'
import { copy } from './copy'
import type { Burn } from './types'

const DAY_MS = 86_400_000
const pct = (v: number) => `${Math.round(v)}%`

export function burnSentence(b: Burn, kind: 'month' | 'quarter'): string {
  const f = figures(b)
  const floor = f.floor
  // The period's last day, "by Oct 31" (the reset is Nov 1 00:00).
  const lastDay = b.resets_at ? fmtShortDay(Date.parse(b.resets_at) - DAY_MS) : null
  if (b.used_usd === 0 && b.unpriced_calls === 0) return copy.sentenceNoSpend(kind)
  if (!b.budget) {
    const used = copy.sentenceNoBudget(`${floor ? 'at least ' : ''}${fmtMoney(b.used_usd)}`, kind)
    const p = projection(b)
    return p && lastDay
      ? `${used} ${copy.sentenceNoBudgetPace(fmtMoney(p.projected), lastDay, floor)}`
      : used
  }
  const limit = currentLimit(b)
  const ro = runOut(b)
  if (b.budget.stopped && ro?.observed && b.resets_at)
    return copy.sentenceStopped(fmtShortDay(ro.at), fmtShortDay(b.resets_at))
  if (limit !== null && b.used_usd >= limit) {
    const over = copy.sentenceOver(fmtMoney(b.used_usd - limit), floor)
    return ro?.observed ? `${over} ${copy.sentenceExceededOn(fmtShortDay(ro.at))}` : over
  }
  const p = projection(b)
  if (!p || !lastDay || f.periodToDate.pct === null)
    return `${copy.sentenceUsed(pct(f.periodToDate.pct ?? 0), floor)} ${copy.sentenceTooEarly}`
  const pace = copy.sentencePace(pct(p.projectedPct ?? 0), lastDay, floor)
  return f.allowance
    ? `${pace} ${copy.sentenceAllowance(fmtMoney(f.allowance.perDay), f.allowance.days, floor)}`
    : pace
}

/** "October" for a month budget, "the period" otherwise: what the lever estimates assume follows the last 7 days. */
export function restOf(b: Burn): string {
  if (b.period !== 'month' || !b.resets_at) return 'the period'
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
    Date.parse(b.resets_at) - 86_400_000,
  )
}

/**
 * Whether a budget needs its reader (F8, the hub's Needs you): stopped or over its limit is action; past an alert mark
 * or projected past its limit before the reset is watch; none without a budget or on track.
 */
export function burnNeed(b: Burn): 'action' | 'watch' | null {
  if (!b.budget) return null
  if (b.budget.stopped || b.budget.state === 'exceeded') return 'action'
  if (b.budget.state === 'warning' || needsLevers(b, projection(b))) return 'watch'
  return null
}
