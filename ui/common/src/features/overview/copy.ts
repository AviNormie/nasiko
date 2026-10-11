/** Every user-facing Overview string (plans/feat-overview.md §13). */
import type { HitlKind } from '@/features/chat/types'
import { fmtShortDay } from '@/lib/format'
import type { Rating, SpikeHit } from './health'
import type { Severity, SourceId } from './needs'

const pct = (v: number) => `${Math.round(v)}%`

export const copy = {
  title: 'Overview',
  loading: 'Loading',
  loadingPage: 'Loading the Overview',
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
      'Deploy an agent from the app, or use the CLI. Cost, health and sessions show up on the Overview once it runs.',
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
    link: 'TokenOps',
    what: "this month's spend",
    rangeWhat: 'spend by agent',
    noSpendYet: 'No spend yet this month',
    forecast: (low: string, high: string) => `Forecast ${low}–${high}`,
    forecastFrom: (day: number) => `Forecast from day ${day}`,
    chartSummary: (days: number, total: string, peakDay: string | null, peak: string) =>
      `Fleet spend per day, last ${days} days: ${total} in all${peakDay ? `, peaking on ${peakDay} at ${peak}` : ''}. The Table view lists every day.`,
    byAgent: (days: number) => `by agent · last ${days} days`,
    vsPrevious: (days: number) => `vs previous ${days} days`,
    chartMode: 'Chart type',
    bars: 'Stacked bars',
    lines: 'Lines',
    avg: (amount: string) => `avg ${amount}/day`,
    other: 'Other',
    otherNote: 'the rest of the fleet',
    showTable: 'Table',
    showChart: 'Chart',
    colDay: 'Day',
    colTotal: 'Total',
    seeSessions: 'See sessions',
    seeDay: 'See that day in TokenOps',
    drivers: (days: number) => `Spend by agent, last ${days} days`,
    driversWhat: 'the top drivers',
    colAgent: 'Agent',
    colShare: 'Share of spend',
    colSpend: 'Spend',
    colAvg: 'Avg / day',
    colChange: 'Change',
    colShow: 'In chart',
    otherAgents: (n: number) => `Other (${n} agent${n === 1 ? '' : 's'})`,
    show: (name: string) => `Show ${name} in the chart`,
    noDrivers: (days: number) => `No spend on agents you can access in the last ${days} days.`,
    // Eng review R2: TokenOps' scope wording (TokenopsPage.tsx), shortened.
    scopeNote: 'The month total is fleet-wide; drivers only include agents you can access.',
  },
  health: {
    title: 'Fleet health',
    link: 'Agents',
    what: 'the agent list',
    costWhat: 'cost data (cost ratings read Unknown)',
    noneDeployed: 'No agent is deployed yet, so there is nothing to rate.',
    noWatch: 'No agents to watch.',
    colAgent: 'Agent',
    colRating: 'Rating',
    colP95: 'p95, 7 days',
    /** Starts with the visible text, so voice control can say it (WCAG 2.5.3); names capped at 3 (/ship review). */
    countLink: (visible: string, names: readonly string[]) => {
      if (!names.length) return `${visible} agents`
      const shown = names.slice(0, 3).join(', ')
      return `${visible}: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
    },
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
