/** The home's numbers (plans/feat-agent-centric.md DX: caps and sizes live in the feature's `tuning.ts`). */
export { RETURN_REFRESH_MS } from '@/features/overview/tuning'
/** Skeleton rows while the persona or the directory is pending (R2-12: neutral, never an empty state). */
export const SKELETON_ROWS = 6
/** Height of one skeleton row while the table loads. */
export const SKELETON_ROW_PX = 40
/** Savings rows asked for (the server's maximum; its default of 25 would leave most agents "not reported"). */
export const SAVINGS_ROWS = 200
/** A touch-sized target on coarse pointers (DESIGN.md: 44 px). */
export const TOUCH = 'pointer-coarse:min-h-11'
/** Budget use is re-read this often while the tab is visible (PR2 "Live budgets"; TanStack pauses it when hidden). */
export const BUDGET_POLL_MS = 60_000
/** Per-row reads (sparkline series, build records) in flight at once (eng "Home execution table"). */
export const ROW_READS = 4
/** A row's series and builds stay fresh this long, so scrolling back doesn't read them again. */
export const ROW_READ_STALE_MS = 5 * 60_000
/** The budget column's "updated …" stamp moves this often. */
export const STAMP_TICK_MS = 30_000
