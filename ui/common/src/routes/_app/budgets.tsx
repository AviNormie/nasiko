import { createFileRoute } from '@tanstack/react-router'
import { BudgetsPage } from '@/features/budgets/BudgetsPage'
import { budgetsSearchSchema } from '@/features/budgets/search'

// Observe → Budgets (plans/feat-budget-burn.md F10): every signed-in user; a member reads their own scope.
export const Route = createFileRoute('/_app/budgets')({
  validateSearch: budgetsSearchSchema,
  component: RouteComponent,
})

function RouteComponent() {
  return <BudgetsPage search={Route.useSearch()} />
}
