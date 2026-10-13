/**
 * The /budgets header switches (plan feat-budget-burn F12): scope (Fleet · Yours · an owner, superuser only; EE adds
 * units in B6) and period (Month · Quarter), as `ToggleGroup`s; owners are a `Select` beside the toggle.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { copy } from '../copy'
import type { PageScope } from '../scope'

export function ScopeSwitch({
  scope,
  superuser,
  owners,
  onScope,
  period,
  onPeriod,
}: {
  scope: PageScope
  superuser: boolean
  /** Other users, for the owner picker (superuser). */
  owners: readonly { id: string; name: string }[]
  onScope: (s: PageScope) => void
  period: 'month' | 'quarter'
  onPeriod: (p: 'month' | 'quarter') => void
}) {
  return (
    <>
      {superuser ? (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={scope.kind === 'owner' ? '' : scope.kind}
            onValueChange={(v) => {
              if (v === 'fleet' || v === 'yours') onScope({ kind: v })
            }}
            aria-label={copy.scopeLabel}
          >
            <ToggleGroupItem value="fleet" className="px-3 text-xs">
              {copy.scopeFleet}
            </ToggleGroupItem>
            <ToggleGroupItem value="yours" className="px-3 text-xs">
              {copy.scopeYours}
            </ToggleGroupItem>
          </ToggleGroup>
          {owners.length ? (
            <Select
              value={scope.kind === 'owner' ? scope.id : ''}
              onValueChange={(id) => onScope({ kind: 'owner', id })}
            >
              <SelectTrigger size="sm" className="w-40 text-xs" aria-label={copy.scopeOwnerPick}>
                <SelectValue placeholder={copy.scopeOwner} />
              </SelectTrigger>
              <SelectContent>
                {owners.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </>
      ) : null}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={period}
        onValueChange={(v) => {
          if (v === 'month' || v === 'quarter') onPeriod(v)
        }}
        aria-label={copy.periodLabel}
      >
        <ToggleGroupItem value="month" className="px-3 text-xs">
          {copy.periodMonth}
        </ToggleGroupItem>
        <ToggleGroupItem value="quarter" className="px-3 text-xs">
          {copy.periodQuarter}
        </ToggleGroupItem>
      </ToggleGroup>
    </>
  )
}
