/** Every tuning number of budgets (plan feat-budget-burn §5). */

/** A new budget's alert marks, in percent of the limit (R-L10 default). */
export const DEFAULT_THRESHOLDS = [50, 80, 100] as const
/** R-L10 lists (budgets, status, alerts) count as fresh this long before a focus refetch, as the router's lists. */
export const LIST_STALE_MS = 10_000
