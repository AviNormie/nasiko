/**
 * Token optimization for all of the viewer's coding harnesses at once, on the import card once they are in (in place
 * of the old Optimize button): the agent Settings switch (agents/detail/TokenOptimization.tsx) as one row, over every
 * harness they own. On writes `compress_enabled: true` to each
 * one that has it off, off writes `false` to each one that has it on (`PUT /api/agents/{id}`, the bulk write the
 * Optimization page uses), then the re-read lists decide. Saved on flip, like the agent's; failures toast with the
 * server's reason. Nothing renders until the viewer owns a harness.
 */
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { toast } from 'sonner'
import { BetaBadge } from '@/components/shared/beta-badge'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useOwnedAgents, useSetCompressionFor } from '@/features/agents/api'
import { copy as agentsCopy } from '@/features/agents/copy'
import { isHarness } from '@/features/agents/status'
import { meQuery } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/client'
import { copy as pageCopy } from '../copy'

const copy = pageCopy.optimization

export function HarnessOptimization() {
  const sub = useQuery(meQuery).data?.sub
  const owned = useOwnedAgents(sub)
  const set = useSetCompressionFor()
  const id = useId()
  const harnesses = (owned.data ?? []).filter(isHarness)
  if (!harnesses.length) return null
  const on = harnesses.filter((a) => a.compress_enabled === true)
  // While a save runs the switch shows what was asked; after it the re-read list decides.
  const checked =
    set.isPending && set.variables ? set.variables.enabled : on.length === harnesses.length
  const flip = (next: boolean) => {
    if (set.isPending) return
    const ids = harnesses.filter((a) => (a.compress_enabled === true) !== next).map((a) => a.id)
    set.mutate(
      { ids, enabled: next },
      {
        onSuccess: ({ failed }) => {
          const first = failed[0]?.error
          if (first !== undefined) toast.error(copy.failed(failed.length, reasonOf(first)))
        },
        onError: (e) => toast.error(copy.failed(ids.length, reasonOf(e))),
      },
    )
  }
  return (
    // A row at the foot of the import card, a hairline above it: the step after the agents came in.
    <Field orientation="horizontal" className="gap-6 border-t pt-4">
      <FieldContent>
        <FieldLabel htmlFor={id} className="gap-2">
          {agentsCopy.tokenOptimization}
          <BetaBadge />
        </FieldLabel>
        <FieldDescription id={`${id}-hint`}>
          {copy.hint}
          {/* Mixed: the switch reads off, so say how many are on. */}
          {on.length > 0 && on.length < harnesses.length
            ? ` ${copy.some(on.length, harnesses.length)}`
            : null}
        </FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        aria-label={copy.label}
        aria-describedby={`${id}-hint`}
        // Not `disabled` while saving: that would drop keyboard focus mid-save. Extra flips wait for the save.
        aria-busy={set.isPending}
        onCheckedChange={flip}
      />
    </Field>
  )
}

const reasonOf = (e: unknown) =>
  (e instanceof ApiError && e.serverMessage) || (e instanceof Error ? e.message : String(e))
