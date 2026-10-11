/**
 * Every user-facing string on the agent hub (plans/feat-agent-centric.md PR1a; design and DX amendments give the exact
 * wording). Two words with fixed meanings (DX "Errors"): "not reported" = the server lacks the field; "not recorded"
 * = no record exists.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const sessionsN = (n: number) => plural(n, 'session', 'sessions')

export const copy = {
  section: 'Activity over time',
  notReported: 'not reported',

  bar: {
    compare: 'Compare',
    compareHint: 'Draw the previous window under this one',
    compare24h:
      'Hourly buckets have no previous window to draw: the lane headers show the totals change only.',
    table: 'Table',
    chart: 'Chart',
  },

  lanes: {
    spend: 'Spend',
    requests: 'Requests',
    requestsHint: 'Traced requests (finops operations), not sessions or flows',
    p95: 'p95 latency',
    peakP95: 'peak daily p95',
    peakHourlyP95: 'peak hourly p95',
    saved: 'Tokens saved',
    savedBasis: (basis: string) => `Basis: ${basis}`,
    savedTooltip: 'Fewer tokens, not necessarily better answers.',
    noDailySavings: 'Daily savings not reported yet',
    savedNotReported: 'Tokens saved: not reported',
    zeroRequests: '0 requests',
    truncated: (n: number) =>
      `Showing the first ${n} buckets of this window; pick a shorter window to see the rest.`,
    notDeployedYet: 'Not deployed yet',
    previousWindow: 'Previous window',
    estCost: 'Est. cost (API list price)',
    requestsCount: (n: number) => plural(n, 'request', 'requests'),
  },

  states: {
    notVisible: "You can't see this agent's spend. Ask its owner for access.",
    notVisibleOwner: (owner: string) => `You can't see this agent's spend. Its owner is ${owner}.`,
    savingsError: "Savings couldn't load.",
    retry: 'Retry',
    deleted: 'This agent was deleted, so it has no activity to show.',
    notVisibleSameName:
      "Spend can't be shown: another user's agent has the same name, and the server checks them together.",
    previousError: "The previous window couldn't load, so Compare draws nothing.",
  },

  rail: {
    label: 'Changes',
    showing: 'Showing recorded deploys and the latest crash',
    showingOss: 'Showing recorded builds and versions',
    harness: 'No recorded changes for this harness yet',
    otherLater:
      'Other changes (routing, optimization, tools, restarts) appear when the server records them.',
    noDeploys: 'No deploys in this window.',
    capped: (n: number) => `Latest ${n} build records checked`,
    deploysFailed: "Deploys couldn't load",
    changesFailed: "Changes couldn't load",
    eventsTruncated: 'More changes happened in this window than were read.',
    preview: 'Preview: needs server support',
    previewHint:
      'Restarts, routing, optimization, tool and budget changes come from a proposed event log (mock data).',
    flagLabel: (count: number, first: string, when: string) =>
      count === 1 ? `${first}, ${when}` : `${count} changes, ${when}`,
    approximate: 'approximate time (the build record’s last update)',
  },

  marker: {
    buildDone: 'Build completed',
    buildFailed: 'Build failed',
    versionRecorded: 'Version recorded',
    crashed: 'Crashed',
    openBuild: 'Open build',
    versions: 'Versions',
    by: (actor: string) => `by ${actor}`,
  },

  bucket: {
    title: (name: string) => `Selected: ${name}`,
    close: 'Clear selection',
    sessionsDay: 'Sessions on this day',
    sessionsOn: (date: string) => `Sessions on ${date}`,
    sessionsShared: (name: string, n: number) =>
      `Sessions named ${name} on this day (shared by ${n} agents)`,
    tokenopsDay: (date: string) => `TokenOps for ${date}`,
    olderNote: (days: number) => `Sessions search covers the last ${days} days.`,
    noMarkers: 'No recorded changes in this bucket.',
    announce: (name: string) => `${name} selected`,
    announceCleared: 'Selection cleared',
  },

  table: {
    label: 'Activity by bucket',
    bucket: 'Bucket',
    markers: 'Changes',
    action: 'Action',
    select: 'Select',
  },

  needs: {
    title: 'Needs you',
    clear: 'No issues found in checked data',
    checked: (parts: string[]) => `Checked ${parts.join(', ')}.`,
    partRequests: 'pending requests',
    partStatus: 'its health (rated on the last 7 days)',
    // An empty sample starts at the agent's creation or 7 days back, so it means this agent had none in 7 days (QA).
    partSessions: (checked: number, found: number, scanned: number) =>
      scanned === 0
        ? "this agent's sessions (none in the last 7 days)"
        : found === 0
          ? `the latest ${sessionsN(scanned)} you can see (none of them this agent's)`
          : `${checked} of this agent's ${found} sessions in the latest ${scanned} you can see`,
    unproven: (n: number) =>
      `${n} pending ${n === 1 ? 'request' : 'requests'} can't be tied to your chats yet, so requests aren't fully checked.`,
    shared: '(another visible agent has the same name: some may be its sessions)',
    requests: (n: number) => `${n} ${n === 1 ? 'request is' : 'requests are'} waiting for you`,
    answer: 'Answer',
    statusAction: 'Needs action',
    statusWatch: 'Watch',
    ratedOn: 'rated on the last 7 days',
    sessions: (failed: number, checked: number) =>
      `${failed} of the ${checked} sessions checked failed`,
    openFailed: 'Open failed sessions',
    failed: {
      requests: "Pending requests couldn't load",
      status: "Its health couldn't be rated",
      statusIncomplete: "Its health couldn't be fully rated (a cost input is missing)",
      sessions: "Its sessions couldn't be checked",
    },
  },

  runs: {
    sessions: 'Recent sessions',
    sessionsWindow: 'last 7 days',
    sessionsNone: (scanned: number) =>
      scanned === 0
        ? 'None in the last 7 days.'
        : `None in the latest ${sessionsN(scanned)} checked.`,
    sessionsAll: (name: string) => `Sessions for ${name}`,
    sessionsShared: 'Another visible agent has the same name: these may be its sessions.',
    sessionsError: "Sessions couldn't load",
    flows: 'Flows started by this agent',
    flowsNone: 'No flows started by this agent in this window.',
    flowsNoneCapped: (n: number) => `None in the latest ${n} flows across the fleet.`,
    flowsAll: 'Open Flows',
    flowsError: "Flows couldn't load",
    flowsPartial: "Some flows couldn't load: this list may be missing older ones.",
    failed: 'failed',
  },

  cards: {
    title: 'Layers',
    routing: 'Routing',
    routingNone: 'Not routed: uses the default model',
    routingSetUp: 'Set up routing',
    routingOpen: 'Open LLM router',
    routingPinned: 'pinned',
    tools: 'Tools',
    toolsConnected: (n: number) => `${n} connected`,
    toolsBlocked: (n: number, capped: boolean) =>
      `${n} ${n === 1 ? 'tool' : 'tools'} set to Block${capped ? ' (first connectors checked)' : ''}`,
    toolsNone: 'No tools connected',
    toolsSetUp: 'Connect tools',
    toolsOpen: 'MCP tab',
    optimization: 'Optimization',
    compressOn: 'Token optimization on',
    compressOff: 'Token optimization off',
    historyBy: (name: string) => `History: ${name}`,
    savedIn: (tokens: string, basis: string) => `${tokens} tokens saved in this window (${basis})`,
    optimizationOpen: 'Open Optimization',
    budget: 'Budget',
    budgetUse: (used: string, limit: string) => `${used} of ${limit} this month`,
    budgetNone: 'No budget set',
    budgetSetUp: 'Set a budget',
    budgetUpdated: (rel: string) => `budget use · updated ${rel}`,
  },

  keyboard: 'Arrow keys move between buckets; Enter selects one.',
  bucketButton: (name: string, spend: string, requests: string) => `${name}: ${spend}, ${requests}`,
}
