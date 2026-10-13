/** Every tuning number of budgets (plan feat-budget-burn §5). */

/** A new budget's alert marks, in percent of the limit (R-L10 default). */
export const DEFAULT_THRESHOLDS = [50, 80, 100] as const
/** R-L10 lists (budgets, status, alerts) count as fresh this long before a focus refetch, as the router's lists. */
export const LIST_STALE_MS = 10_000
/** A projection needs this many complete days of the period (budgets.md §4.6). */
export const MIN_COMPLETE_DAYS = 3
/** The pace is the mean of at most this many trailing complete days (§4.6). */
export const PACE_DAYS = 7
/** A budgets list read follows at most this many more pages (100 rows each). */
export const MAX_PAGES = 50
