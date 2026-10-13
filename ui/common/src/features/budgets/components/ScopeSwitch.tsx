/**
 * The /budgets header switches (plan feat-budget-burn F12): scope (Fleet · Yours · an owner, for a fleet reader; EE's
 * units for whoever may read them, B6) and period (Month · Quarter), as `ToggleGroup`s; owners and units are `Select`s
 * beside the toggle.
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
import type { HomeLevel } from '@/app/edition'
import type { PageScope } from '../scope'

export function ScopeSwitch({
  scope,
  fleet,
  owners,
  units,
  onScope,
  period,
  onPeriod,
}: {
  scope: PageScope
  /** Fleet and the owner picker: a superuser or org admin, or finance. */
  fleet: boolean
  /** Other users, for the owner picker (a fleet reader). */
  owners: readonly { id: string; name: string }[]
  /** Units the viewer may read (EE), in tree order. */
  units: readonly HomeLevel[]
  onScope: (s: PageScope) => void
  period: 'month' | 'quarter'
  onPeriod: (p: 'month' | 'quarter') => void
}) {
  return (
    <>
      {fleet || units.length ? (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={scope.kind === 'owner' || scope.kind === 'unit' ? '' : scope.kind}
            onValueChange={(v) => {
              if (v === 'fleet' || v === 'yours') onScope({ kind: v })
            }}
            aria-label={copy.scopeLabel}
          >
            {fleet ? (
              <ToggleGroupItem value="fleet" className="px-3 text-xs">
                {copy.scopeFleet}
              </ToggleGroupItem>
            ) : null}
            <ToggleGroupItem value="yours" className="px-3 text-xs">
              {copy.scopeYours}
            </ToggleGroupItem>
          </ToggleGroup>
          {units.length ? (
            <Select
              value={scope.kind === 'unit' ? scope.id : ''}
              onValueChange={(id) => onScope({ kind: 'unit', id })}
            >
              <SelectTrigger
                size="sm"
                className="w-44 text-xs"
                aria-label={
                  scope.kind === 'unit'
                    ? `${copy.scopeUnitPick}: ${units.find((u) => u.id === scope.id)?.path ?? ''}`
                    : copy.scopeUnitPick
                }
              >
                <SelectValue placeholder={copy.scopeUnit} />
              </SelectTrigger>
              <SelectContent>
                {units.map((u) => (
                  <SelectItem key={u.id} value={u.id} aria-label={u.path}>
                    <span style={{ paddingLeft: `${u.depth * 0.75}rem` }}>{u.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {fleet && owners.length ? (
            <Select
              value={scope.kind === 'owner' ? scope.id : ''}
              onValueChange={(id) => onScope({ kind: 'owner', id })}
            >
              <SelectTrigger
                size="sm"
                className="w-40 text-xs"
                aria-label={
                  scope.kind === 'owner'
                    ? `${copy.scopeOwnerPick}: ${owners.find((o) => o.id === scope.id)?.name ?? ''}`
                    : copy.scopeOwnerPick
                }
              >
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
