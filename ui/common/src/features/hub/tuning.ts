/** The agent hub's numbers (plans/feat-agent-centric.md DX: caps and sizes live in the feature's `tuning.ts`). */

/** `GET /api/builds/agent/{id}` returns the newest 20 records (build/routes.rs `list_builds`); the hub reads no more. */
export const BUILDS_READ = 20
/** Height of one lane (design: 72 px), and of the marker rail above the first lane (20 px). */
export const LANE_HEIGHT = 72
export const RAIL_HEIGHT = 20
/** Sessions search covers the last 7 days of traces (Tempo's 168 h limit): older days link to TokenOps instead. */
export const SESSIONS_DAYS = 7
/** The proposed event log is read for the window, at most this many events (the server's own cap is a written ask). */
export const EVENTS_READ = 200
