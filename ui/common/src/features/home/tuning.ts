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
