/**
 * The hairline budget table (DESIGN.md Budgets (R2)): one header row, cells padded on wide screens, stacked with inline
 * labels below 1024 px. The router's budgets table, At risk and Unbudgeted share it (plan feat-budget-burn F7: extend,
 * don't restyle).
 */
export const ROW =
  'text-sm hover:bg-transparent max-lg:grid max-lg:gap-1.5 max-lg:px-4 max-lg:py-2.5'
export const CELL =
  'p-0 whitespace-normal max-lg:block lg:px-1.5 lg:py-2.5 lg:first:pl-4 lg:last:pr-4'
export const HEAD = 'h-auto px-1.5 py-2 text-xs text-muted-foreground first:pl-4 last:pr-4'

/** A cell's name in the stacked layout, where the header row is hidden. */
export const Label = ({ children }: { children: string }) => (
  <span className="text-muted-foreground lg:hidden">{children}: </span>
)

/** The stacked layout at every width, for a narrow column (Home's top 3 At risk, plan F12). */
export const ROW_STACKED = 'grid gap-1 px-3 py-2 text-sm hover:bg-transparent'
export const CELL_STACKED = 'block p-0 whitespace-normal'
export const StackedLabel = ({ children }: { children: string }) => (
  <span className="text-muted-foreground">{children}: </span>
)
