/**
 * Every user-facing string on the agent hub (plans/feat-agent-centric.md PR1a; design and DX amendments give the exact
 * wording). Two words with fixed meanings (DX "Errors"): "not reported" = the server lacks the field; "not recorded"
 * = no record exists.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

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

  keyboard: 'Arrow keys move between buckets; Enter selects one.',
  bucketButton: (name: string, spend: string, requests: string) => `${name}: ${spend}, ${requests}`,
}
