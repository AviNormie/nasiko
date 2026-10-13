/** A list that kept its first pages when a later one failed (plan feat-budget-burn F13): it says so, with Retry. */
import { LinkButton } from '@/features/router/components/bits'
import { copy } from '../copy'

export function Partial({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="text-xs text-warning">
      {copy.listPartial}{' '}
      <LinkButton className="text-xs" onClick={onRetry}>
        {copy.retry}
      </LinkButton>
    </p>
  )
}
