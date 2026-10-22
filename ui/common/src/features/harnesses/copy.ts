const plural = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? noun : `${noun}s`}`

/** One reason as is; several with their counts. */
const reasonList = (reasons: readonly { reason: string; count: number }[]) =>
  reasons.length === 1
    ? reasons[0].reason
    : reasons.map((r) => `${r.reason} (${r.count.toLocaleString('en-US')})`).join('; ')

/**
 * Every user-facing string on the Harnesses page (plan §6). Each notice says what
 * happened, why, and one thing to do about it (X4).
 */
export const copy = {
  title: 'Coding harnesses',
  subtitle: 'Coding harnesses connected to OpenRuntime',
  loading: 'Loading harness usage',
  registered: 'Registered',
  registeredTip:
    'A harness is registered when its agent row exists: `nasiko agents install` creates it, and so does `nasiko connect`, `use` or `auth login` for every harness found on the machine. Uninstalling keeps the row, so registered can overstate real use.',
  estCost: 'Est. cost',
  estCostTip:
    'Tokens × the model list price. Harness seats are usually billed per seat, so this is not an invoice.',
  csvCostHeader: 'Estimated cost (API list price, USD)',
  unpriced: 'unpriced',
  unpricedTip: 'Most of these turns used a model with no price, so no cost is shown.',
  unpricedCount: (n: number) => `${n.toLocaleString('en-US')} unpriced`,
  idle: 'idle',
  notConnected: 'Not connected',

  // Page status line (at most one). The org levels' own lines live in the EE layer.
  serverMissing: {
    problem:
      'Full harness usage is not available on this server (endpoint missing or not reachable).',
    // The proposed endpoint: docs/designs/openruntime-harness-recommendations.md (not shown to users).
    action: 'Showing your own usage from existing endpoints.',
  },
  previewBadge: 'preview (mock)',
  refreshFailed:
    "Couldn't refresh harness usage; the numbers below are from the last successful load.",

  // Footnotes.
  overlap: (n: number) =>
    `${n} ${n === 1 ? 'developer is' : 'developers are'} counted in more than one unit; the totals count everyone once.`,
  removedHarnesses: "Activity from removed harnesses isn't shown here.",
  sessionsOwnOnly: 'Only your own sessions open in Sessions.',
  lastSessions: (n: number) => `Last ${n} sessions`,
  noRecentSessions: 'No harness sessions yet.',
  showAllSessions: (n: number) => `Show all ${n}`,
  partialSort: (loaded: number, total: number) =>
    `Sorted within the ${loaded} loaded of ${total}; load more to include the rest.`,

  // Empty / not visible.
  noActivity: (windowLabel: string) => `No harness activity in the ${windowLabel.toLowerCase()}.`,
  widen: 'Try 30 days',
  noDevelopers: 'No developers in this unit.',
  noUnits: 'No units to show.',
  noDevelopersInScope: 'No developers in this scope.',
  notVisible: 'Not found or not visible.',
  notVisibleHint: "This usage doesn't exist, or it isn't shared with you.",
  noHarnesses: 'No harnesses connected to OpenRuntime yet.',
  deltaUnavailable: 'Δ unavailable',

  // Onboarding (viewer only).
  connectSteps: (server: string, harness: string) => [
    `nasiko connect ${server}`,
    'nasiko auth login',
    `nasiko agents install ${harness}`,
  ],
  connectHint:
    'The harness must be installed on this machine. `nasiko auth login` registers every harness it finds; `agents install` is the fallback.',
  askToConnect: (name: string, harness: string) => `Ask ${name} to connect ${harness}.`,

  // Coding-agent onboarding card (consent + discovery/import progress, reported by a local client).
  agentsOnboarding: {
    title: 'Bring in your coding agents?',
    body: 'Nasiko can find Claude Code, Codex, OpenCode and Cursor on your computer, report their new sessions and import your past ones.',
    yes: 'Yes, find my agents',
    notNow: 'Not now',
    declined: 'You chose not to bring in your coding agents.',
    findMyAgents: 'Find my agents',
    idle: 'Your coding agents are not being imported right now.',
    // Browser: running the command is the consent.
    commandTitle: 'Bring in your coding agents',
    commandBody: 'To discover your coding agents and load your previous sessions, run:',
    command: 'nasiko agents setup',
    copyCommand: 'Copy command',
    thisComputer: 'This computer',
    actionFailed: (detail: string | null) =>
      `Couldn't reach the Nasiko desktop app${detail ? `: ${detail}` : '.'} Try again.`,
    tryAgain: 'Try again',
    runningTitle: 'Bringing in your coding agents',
    doneTitle: 'Your coding agents are in',
    failedTitle: "Some coding agents didn't come in",
    clientLabel: (client: string) =>
      client === 'cli' ? 'CLI' : client === 'desktop' ? 'desktop' : client,
    progressLabel: (device: string) => `Import progress on ${device}`,
    found: (names: string[]) =>
      names.length ? `Found ${names.join(', ')}` : 'Looking for coding agents…',
    noneFound: 'No coding agents found on this computer',
    connected: 'Connected',
    connecting: 'Connecting…',
    importing: (name: string, done: number, total: number) =>
      `Importing ${name}… ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`,
    imported: (name: string, sessions: number, turns: number) =>
      `${name}: ${sessions.toLocaleString('en-US')} ${sessions === 1 ? 'session' : 'sessions'}, ${turns.toLocaleString('en-US')} ${turns === 1 ? 'turn' : 'turns'}`,
    unreadable: (n: number) => ` (${n.toLocaleString('en-US')} couldn't be read)`,
    waitingAgent: (name: string) => `${name}: waiting`,
    notOnComputer: (name: string) => `${name}: not on this computer`,
    notConnected: (name: string) => `${name}: not connected`,
    agentFailed: (name: string, error: string | null | undefined) =>
      `${name}: import failed${error ? ` (${error})` : ''}`,
    summary: (sessions: number, turns: number, names: string[]) =>
      names.length
        ? `Imported ${sessions.toLocaleString('en-US')} ${sessions === 1 ? 'session' : 'sessions'} and ${turns.toLocaleString('en-US')} ${turns === 1 ? 'turn' : 'turns'} from ${names.join(', ')}.`
        : 'Nothing new to import.',
    runFailed: (error: string | null | undefined) =>
      `The import stopped${error ? `: ${error}` : '.'}`,
    // v2: the history timeline, delivery and refused turns.
    timelineLabel: (device: string) => `History read on ${device}, newest first`,
    windowDone: (label: string, sessions: number) =>
      sessions ? `${label} · ${plural(sessions, 'session')}` : label,
    windowRunning: (label: string) => `Importing ${label}…`,
    windowsRemaining: (days: number, older: boolean) =>
      days
        ? `then ${days.toLocaleString('en-US')} more ${days === 1 ? 'day' : 'days'}${older ? ' and older history' : ''}`
        : 'then older history',
    showAllWindows: (n: number) => `Show all ${n.toLocaleString('en-US')} finished`,
    showFewerWindows: 'Show fewer',
    lastMonthIn: 'Your last month is in. Older history is still loading.',
    sending: (turns: number) => `Waiting to send ${plural(turns, 'turn')} · retrying automatically`,
    rejected: (
      name: string,
      turns: number,
      reasons: readonly { reason: string; count: number }[],
    ) =>
      `${name}: ${plural(turns, 'turn')} couldn't be sent${reasons.length ? `: ${reasonList(reasons)}` : ''}`,
    retrySend: 'Retry',
    retryRequested: 'Retry requested — your computer will resend them shortly',
    retryFailed: "Couldn't ask your computer to resend them. Try again.",
    rejectedTitle: "Some turns couldn't be sent",
    announce: {
      sending: (device: string) => `${device}: sending imported turns.`,
      discovering: (device: string) => `${device}: looking for coding agents.`,
      connecting: (device: string) => `${device}: connecting coding agents.`,
      importing: (device: string) => `${device}: importing past sessions.`,
      done: (device: string) => `${device}: import finished.`,
      failed: (device: string) => `${device}: import failed.`,
    },
  },
  // The desktop app's sync bar, on every page while coding-agent data syncs (components/SyncBar.tsx).
  syncBar: {
    title: 'Syncing coding agents',
    label: 'Coding agent sync progress',
    discovering: 'Looking for agents',
    connecting: 'Connecting',
    sent: (turns: number) => `${plural(turns, 'turn')} sent`,
    waiting: (turns: number) => `${turns.toLocaleString('en-US')} waiting`,
    details: 'Details',
    detailsLabel: 'Coding agent sync details',
    started: 'Syncing coding agents.',
    finished: 'Coding agents synced.',
  },
} as const
