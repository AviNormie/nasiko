/** Every tuning number of budgets (plan feat-budget-burn §5). */

/** A new budget's alert marks, in percent of the limit (R-L10 default). */
export const DEFAULT_THRESHOLDS = [50, 80, 100] as const
/** R-L10 lists (budgets, status, alerts) count as fresh this long before a focus refetch, as the router's lists. */
export const LIST_STALE_MS = 10_000
/** A projection needs this many complete days of the period (budgets.md §4.6). */
export const MIN_COMPLETE_DAYS = 3
/** The pace is the mean of at most this many trailing complete days (§4.6). */
export const PACE_DAYS = 7
/** After a change that moves the pace, its "expected" line shows until this many complete days of new data (F13). */
export const EXPECTED_DAYS = 3
/** A budgets list read follows at most this many more pages (100 rows each). */
export const MAX_PAGES = 50
/** Spike day (plan §5): a day over this many times the trailing pace … */
export const SPIKE_FACTOR = 2
/** … and at least this much. */
export const SPIKE_MIN_USD = 1
/** The trailing pace a spike day is compared with needs this many complete days before it. */
export const SPIKE_WINDOW_DAYS = 7
/** The band's low edge: the trailing 30 complete days' average (or the period so far when shorter). */
export const LOW_RATE_DAYS = 30
/** What-if's pace change, as a fraction either way (plan F6: −50% to +50%). */
export const WHATIF_PACE_LIMIT = 0.5
/** What-if's largest limit (USD): anything above is a typo, not a plan. */
export const WHATIF_MAX_LIMIT = 1e9
