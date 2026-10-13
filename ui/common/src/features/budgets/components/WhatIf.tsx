/**
 * What-if (plan feat-budget-burn F6), in the burn card's footer, collapsed: a limit and a pace change (−50% to +50%)
 * redraw a dashed preview line with its run-out and allowance, by the same rules (`burn.ts` `whatIf`). Nothing is
 * saved; "Use this limit" (the budget editor, pre-filled) lands with the editor. One preview at a time: the page clears
 * a picked contributor when this one starts (design 4A).
 */
import { useId, type ReactNode } from 'react'
import { Disclosure } from '@/components/shared/disclosure'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { parseLimit } from '../budgets'
import { projection, whatIf, whatIfProblem } from '../burn'
import { WHAT_IF_CLOSED, type WhatIfState } from '../whatIf'
import { copy } from '../copy'
import type { Burn } from '../types'

const DAY_MS = 86_400_000

export function WhatIfPanel({
  burn,
  state,
  onChange,
  footer,
}: {
  burn: Burn
  state: WhatIfState
  onChange: (s: WhatIfState) => void
  /** "Use this limit", when the editor is available. */
  footer?: (limit: number) => ReactNode
}) {
  const ids = useId()
  const typed = state.limit.trim() ? parseLimit(state.limit) : null
  const problem = whatIfProblem(typed, state.pace / 100)
  const result = problem ? null : whatIf(burn, { limit: typed, paceChange: state.pace / 100 })
  const lastDay = burn.resets_at ? fmtShortDay(Date.parse(burn.resets_at) - DAY_MS) : ''
  const stops = burn.budget?.action === 'stop'
  return (
    <Disclosure
      id={`whatif-${ids}`}
      title={copy.whatIfTitle}
      hint={copy.whatIfHint}
      open={state.open}
      onToggle={() => onChange(state.open ? WHAT_IF_CLOSED : { ...state, open: true })}
    >
      {!burn.budget ? (
        <p className="pb-3 text-sm text-muted-foreground">{copy.whatIfNeedsBudget}</p>
      ) : !projection(burn) ? (
        <p className="pb-3 text-sm text-muted-foreground">{copy.whatIfNeedsProjection}</p>
      ) : (
        <div className="grid gap-4 pb-3 md:grid-cols-[12rem_1fr_auto] md:items-start">
          <Field data-invalid={problem?.startsWith('limit') || undefined}>
            <FieldLabel htmlFor={`${ids}-limit`}>{copy.whatIfLimit}</FieldLabel>
            <Input
              id={`${ids}-limit`}
              inputMode="decimal"
              placeholder={result ? result.limit.toFixed(2) : ''}
              value={state.limit}
              aria-invalid={problem?.startsWith('limit') || undefined}
              onChange={(e) => onChange({ ...state, limit: e.target.value })}
            />
            {problem?.startsWith('limit') ? (
              <FieldError>{copy.whatIfProblem[problem]}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-pace`}>
              {copy.whatIfPace}: {copy.whatIfPaceValue(state.pace)}
            </FieldLabel>
            <Slider
              id={`${ids}-pace`}
              aria-label={copy.whatIfPace}
              aria-valuetext={copy.whatIfPaceValue(state.pace)}
              min={-50}
              max={50}
              step={5}
              value={[state.pace]}
              onValueChange={([v]) => onChange({ ...state, pace: v ?? 0 })}
              className="mt-3"
            />
          </Field>
          <div className="flex items-center gap-2 md:pt-6">
            {footer && result && typed !== null ? footer(result.limit) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ open: true, limit: '', pace: 0 })}
            >
              {copy.whatIfReset}
            </Button>
          </div>
          {result ? (
            <ul className="space-y-0.5 text-sm md:col-span-3">
              <li>{copy.whatIfProjected(fmtMoney(result.projected), lastDay)}</li>
              <li>
                {result.runOut
                  ? copy.whatIfRunsOut(fmtShortDay(result.runOut), stops)
                  : copy.whatIfWithin}
              </li>
              <li className="text-muted-foreground">
                {result.allowance.none
                  ? copy.whatIfAllowanceNone
                  : copy.whatIfAllowance(fmtMoney(result.allowance.perDay), result.allowance.days)}
              </li>
            </ul>
          ) : null}
        </div>
      )}
    </Disclosure>
  )
}
