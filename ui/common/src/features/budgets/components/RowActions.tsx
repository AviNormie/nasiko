/**
 * An At risk row's actions (plan feat-budget-burn F7, approved row): "Adjust limit", which opens the editor with the
 * limit focused, and a ⋯ menu (Open agent, Edit budget). Both open the same editor in place (F10).
 */
import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LinkButton } from '@/features/router/components/bits'
import { copy } from '../copy'

export function RowActions({
  name,
  agentId,
  onEdit,
}: {
  name: string
  agentId: string | null
  onEdit: () => void
}) {
  return (
    <div className="flex items-center gap-2 lg:justify-end">
      <LinkButton aria-label={copy.adjustLimitFor(name)} onClick={onEdit}>
        {copy.adjustLimit}
      </LinkButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={copy.moreActions(name)}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {agentId ? (
            <DropdownMenuItem asChild>
              <Link to="/agents/$agentId" params={{ agentId }}>
                {copy.openAgent}
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onEdit}>{copy.editBudget}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
