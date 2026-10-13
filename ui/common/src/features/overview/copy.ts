/** Every user-facing Overview string (plans/feat-overview.md §13). */
import type { HitlKind } from '@/features/chat/types'
import { fmtShortDay } from '@/lib/format'
import type { Rating, SpikeHit } from './health'
import type { Severity, SourceId } from './needs'

const pct = (v: number) => `${Math.round(v)}%`

export const copy = {
  title: 'Home',
  loading: 'Loading',
  loadingPage: 'Loading Home',
  meFailed: "Couldn't reach OpenRuntime to load your account.",
  checkStatus: 'Check server status',
  retry: 'Retry',
  couldntLoad: (what: string) => `Couldn't load ${what}.`,
  couldntCheck: (what: string) => `Couldn't check ${what}`,
  range: {
    label: 'Range',
    item: (days: number) => `Last ${days} days`,
  },
  setup: {
    button: 'Setup guide',
    title: 'Set up OpenRuntime',
    intro:
      'Deploy an agent from the app, or use the CLI. Cost, health and sessions show up on Home once it runs.',
  },
  needs: {
    title: 'Needs you',
    what: 'what needs you',
    waiting: 'Waiting for you',
    checked: (ago: string) => `Checked ${ago}`,
    /** The header's counts by severity, in severity order. */
    count: {
      action: (n: number) => `${n} need action`,
      watch: (n: number) => `${n} to watch`,
      waiting: (n: number) => `${n} waiting`,
    } satisfies Record<Severity, (n: number) => string>,
    nothing: 'Nothing needs you right now.',
    more: (n: number) => `${n} more below: scroll the list`,
    source: {
      requests: 'waiting requests',
      agents: 'agent health',
      budgets: 'budgets',
      sessions: 'recent sessions',
    } satisfies Record<SourceId, string>,
    request: (kind: HitlKind, n: number) => {
      const what =
        {
          tool_approval: 'Approve a tool call',
          input_required: 'Input needed',
          auth_required: 'Sign-in needed',
        }[kind] ?? 'Request waiting'
      return n > 1 ? `${what} (+${n - 1} more)` : what
    },
    untitledChat: 'Untitled chat',
    review: 'Review',
    reviewLabel: (chat: string) => `Review the request in ${chat}`,
    outside: (n: number) => `${n} request${n === 1 ? '' : 's'} outside Chat`,
    outsideDetail: 'From workflows or tools, not a chat',
    openChat: 'Open Chat',
    // Accessible names start with the visible text (WCAG 2.5.3).
    openWaiting: 'Open Chat: the requests waiting outside Chat',
    seeFailing: 'See sessions: the failing ones',
    openAgent: 'Open agent',
    openAgentLabel: (name: string) => `Open ${name}`,
    budgets: 'Budgets',
    budgetsLabel: (name: string) => `Budgets for ${name}`,
    anAgent: 'An agent',
    yourBudget: 'Your monthly',
    budget: (label: string, state: 'warning' | 'exceeded', crossed: number | null) =>
      state === 'exceeded'
        ? `${label} budget is over its limit`
        : `${label} budget is at ${crossed ?? 0}%`,
    budgetDetail: 'This month, routed calls',
    // plans/feat-budget-burn.md F8: how much over and whether calls stop; when it reaches its limit ("runs out" only
    // where calls stop, design 1C).
    budgetStopped: (label: string) => `${label} budget ran out: calls are stopped`,
    budgetOverBy: (amount: string, until: string | null) =>
      until ? `Over by ${amount} · calls stopped until ${until}` : `Over by ${amount} this period`,
    budgetRunsOut: (label: string, day: string, stops: boolean) =>
      stops
        ? `${label} budget runs out around ${day}`
        : `${label} budget exceeds its limit around ${day}`,
    budgetProjected: 'Projected from the last 7 days',
    budgetStoppedUntil: (until: string | null) =>
      until ? `Calls stopped until ${until}` : 'Calls stopped',
    sessions: (failed: number, checked: number) =>
      `${failed} of the ${checked} latest sessions checked failed`,
    seeSessions: 'See sessions',
    unknownAgent: 'Unknown agent',
  },
  firstRun: {
    title: 'Deploy your first agent',
    link: 'Agents',
    after: 'Once it is running, cost, health and sessions show up here.',
    headline: 'Deploy your first agent to see cost, health and sessions here.',
    cli: (n: number) => `Or use the CLI (${n} commands)`,
  },
  /** The first run's preview of the cards a deploy brings: what each will show, never a number. */
  preview: {
    title: 'After your first deploy',
    needs: 'Agents that need action, requests waiting for you and failed sessions, worst first.',
    spend:
      "Fleet spend for the range against the previous one, by agent, with this month's forecast.",
    health:
      'Every agent rated Healthy, Watch or Needs action on reliability, cost, activity and latency.',
  },
  spend: {
    title: 'Spend',
  },
  health: {
    title: 'Fleet health',
  },
  rating: {
    healthy: 'Healthy',
    watch: 'Watch',
    action: 'Needs action',
    unknown: 'Unknown',
  } satisfies Record<Rating, string>,
  reason: {
    status: (raw: string) => (raw === 'failed' ? 'deployment failed' : 'crashed'),
    stuckDeploying: 'stuck deploying',
    budgetStopped: 'budget stopped: calls are refused',
    overBudget: 'over budget this month',
    spike: (s: SpikeHit) => `drove a ${s.factor.toFixed(1)}× spend spike on ${fmtShortDay(s.date)}`,
    costUp: (rise: number) => `cost ↑ ${pct(rise)} vs last week`,
    costPerOp: (factor: number) => `cost per turn ${factor.toFixed(1)}× its 30-day average`,
    idle: 'idle 7 days while deployed',
    activityDown: (drop: number) => `activity ↓ ${pct(drop)} vs last week`,
    p95Up: (rise: number) => `p95 latency ↑ ${pct(rise)} vs last week`,
  },
} as const
