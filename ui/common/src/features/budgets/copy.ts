/**
 * Every user-facing string of budgets (plan feat-budget-burn §5, F12). The R-L10 strings moved here from the router
 * (eng D1); the few generic ones the budget sheet shares with the router's sheets come from the router's copy.
 */
import { copy as routerCopy } from '@/features/router/copy'

export const copy = {
  agentsTitle: routerCopy.agentsTitle,
  colActions: routerCopy.colActions,
  retry: routerCopy.retry,
  save: routerCopy.save,
  saving: routerCopy.saving,
  cancel: routerCopy.cancel,
  required: routerCopy.required,

  // Budgets (R2, plan §5.1; proposed R-L10 contract, mocked)
  budgetsTitle: 'Budgets',
  budgetsSubtitle: (reset: string) =>
    `Router-metered spend this UTC month (token_usage). Covers routed calls only · resets ${reset}`,
  newBudget: 'New budget',
  noBudgets: 'No budgets yet',
  noBudgetsText:
    'A budget alerts you as spend crosses its marks, and can stop an agent’s calls at 100%.',
  createFirstBudget: 'Create a budget',
  budgetsFailed: 'Couldn’t load budgets',
  budgetsMissing: 'Budgets need a newer OpenRuntime server',
  budgetsMissingBody:
    'This section uses the proposed /api/budgets endpoints, which this server doesn’t have yet. Set VITE_NASIKO_MOCK=budgets,agents to preview it with mock data.',
  unpriced: (n: string) => `${n} calls with no price count as $0`,
  stopKeeps100: 'Stop calls always alerts at 100%.',
  budgetChanged:
    'This budget changed elsewhere. Close the sheet and open it again to see the latest.',
  budgetStatusFailed: 'Couldn’t read this month’s spend for these budgets.',
  colScope: 'Scope',
  colUsedOfLimit: 'Used of limit',
  usedOf: (used: string, limit: string) => `${used} of ${limit}`,
  colForecast: 'Forecast',
  colState: 'State',
  colAt100: 'At 100%',
  budgetOwner: 'You',
  budgetOwnerHint: 'All calls billed to you',
  budgetOwnerOption: 'You (all calls billed to you)',
  budgetUnknownAgent: (id: string) => `Agent ${id.slice(0, 8)}… (not listed)`,
  budgetOk: 'OK',
  budgetWarning: (pct: number) => `Warning · ${pct}%`,
  budgetExceeded: 'Exceeded',
  forecastBand: (low: string, high: string) => (low === high ? high : `${low} – ${high}`),
  forecastTooEarly: 'Too early',
  forecastNoSpend: 'No spend yet',
  forecastStopped: 'Stopped at the limit',
  forecastNote:
    'Forecast: a month-end range from this month’s daily spend (median and mean daily rates), from day 3.',
  forecastOver: 'over the limit',
  actionAlert: 'Alert only',
  actionStop: 'Stop calls',
  stoppedUntil: (date: string) => `Calls get an error until ${date}`,
  raiseLimit: 'Raise limit',
  switchToAlert: 'Switch to Alert only',
  switchedToAlert: (name: string | null) =>
    `${name ? `${name} is` : 'Your budget is'} on Alert only. Calls resume within about a minute.`,
  viewBudget: 'View budget',
  routerMovedToBudgets: 'Burn charts, causes and alerts are on the Budgets page.',
  openBudgets: 'Open Budgets',

  // Budget sheet
  budgetNew: 'New budget',
  budgetEdit: (name: string | null) => `Budget · ${name ?? 'You (calls billed to you)'}`,
  budgetDescription:
    'A monthly limit on router-metered spend, with alerts as it crosses each mark.',
  budgetStatusLine: (used: string, limit: string, reset: string) =>
    `${used} used of ${limit} this month · resets ${reset} · router-metered`,
  budgetScope: 'Applies to',
  budgetScopeAgentHint: 'An agent budget counts every call to that agent, whoever is billed.',
  budgetScopeOwnerHint:
    'Your budget counts every routed call billed to you, including your chats with other people’s agents.',
  budgetNoScopes: 'Every agent you own already has a budget, and so do you.',
  monthlyLimit: 'Monthly limit (USD)',
  // A session budget (BG-10, plan F9): one period, the session itself.
  sessionLimit: 'Session limit (USD)',
  budgetDescriptionSession:
    'A limit on this session’s routed spend, with alerts as it crosses each mark. It lasts until the session ends.',
  stopHintSession: 'The router refuses this session’s calls until it ends.',
  stopConsequenceSession:
    'Calls in this session get an error from then on. The session can’t continue until it ends or the limit is raised.',
  limitPositive: 'Enter an amount above $0.',
  alertAt: 'Alert at',
  alertAtHint: 'One in-app alert each time spend crosses a mark.',
  addThreshold: 'Add threshold',
  thresholdPlaceholder: 'e.g. 90',
  removeThreshold: (pct: number) => `Remove ${pct}%`,
  thresholdsRequired: 'Keep at least one mark.',
  thresholdRange: 'Use whole percents from 1 to 100.',
  thresholdDuplicate: 'That mark is already set.',
  at100: 'At 100%',
  alertOnlyHint: 'You get an alert; calls continue.',
  stopHint: 'The router refuses the calls this budget counts until the month resets.',
  stopConsequenceAgent: (agent: string, date: string) =>
    `Calls from ${agent} get an error until ${date}. Its callers see the agent’s normal error.`,
  stopConsequenceUser: (name: string, date: string) =>
    `Every routed call billed to ${name} gets an error until ${date}, including their chats with other people’s agents.`,
  budgetFleet: 'Fleet',
  budgetDescriptionFleet:
    'A monthly limit on all priced spend (routed calls, other traced calls and harness estimates), with alerts as it crosses each mark.',
  budgetFleetAlertOnly:
    'A fleet budget alerts only: much of its spend isn’t routed, so it can’t be stopped.',
  budgetFor: 'Applies to',
  stopConsequenceOwner: (date: string) =>
    `Every routed call billed to you gets an error until ${date}, including your chats with other people’s agents.`,
  budgetTiming: 'Limit changes apply within about a minute.',
  deleteBudget: 'Remove budget',
  deleteBudgetTitle: (name: string | null) =>
    name ? `Remove the budget for ${name}?` : 'Remove your budget?',
  deleteBudgetBody: 'Alerts stop and, if calls were stopped, they resume.',
  budgetSaved: (name: string | null) =>
    name ? `Budget saved for ${name}.` : 'Your budget is saved.',
  budgetDeleted: (name: string | null) =>
    name ? `Budget removed for ${name}.` : 'Your budget is removed.',

  // The /budgets page (plan feat-budget-burn F10, F12). Templated sentences, no causal words (the hub's rule).
  pageTitle: 'Budgets',
  pageFailed: 'budgets',
  pageMissing: 'Budgets need a newer OpenRuntime server',
  rl10NoBudget:
    'This server shows burn only for your own budget, and you don’t have one yet. Set one on the LLM router page.',
  pageMissingBody:
    'This page uses the /api/budgets endpoints, which this server doesn’t have yet. Set VITE_NASIKO_MOCK=budgets,agents to preview it with mock data.',
  scopeLabel: 'Scope',
  scopeFleet: 'Fleet',
  scopeYours: 'Yours',
  scopeOwner: 'Owner…',
  scopeOwnerPick: 'Choose an owner',
  periodLabel: 'Period',
  periodMonth: 'Month',
  periodQuarter: 'Quarter',
  burnModeLabel: 'Chart',
  burnDown: 'Burndown',
  burnUp: 'Burn-up',
  showTable: 'Table',
  showChart: 'Chart',
  coverageRouted: (stops: boolean) => `Routed calls · ${stops ? 'Stops at limit' : 'Alert only'}`,
  coverageAll: 'All priced spend · Alert only · Includes estimates',
  coverageNone: (all: boolean) =>
    all ? 'All priced spend · No budget' : 'Routed calls · No budget',
  burnCard: 'Burn',
  burnFailed: 'the burn chart',
  periodWord: (p: 'month' | 'quarter') => p,
  sentenceNoSpend: (p: 'month' | 'quarter') => `No spend yet this ${p}.`,
  sentenceNoBudget: (used: string, p: 'month' | 'quarter') =>
    `No budget: ${used} spent this ${p} so far.`,
  sentenceNoBudgetPace: (amount: string, day: string, floor: boolean) =>
    `On pace for ${floor ? 'at least ' : ''}${amount} by ${day}.`,
  sentenceStopped: (day: string, reset: string) =>
    `Ran out ${day}; calls are stopped until ${reset}.`,
  sentenceOver: (amount: string, floor: boolean) => `Over by ${floor ? 'at least ' : ''}${amount}.`,
  sentenceExceededOn: (day: string) => `Exceeded its limit ${day}.`,
  sentencePace: (pct: string, day: string, floor: boolean) =>
    `On pace to use ${floor ? 'at least ' : ''}${pct} by ${day}.`,
  sentenceAllowance: (perDay: string, days: number, floor: boolean) =>
    `To stay within budget: ${floor ? 'at most ' : ''}${perDay} a day for the next ${days} ${days === 1 ? 'day' : 'days'}.`,
  sentenceUsed: (pct: string, floor: boolean) => `${floor ? 'At least ' : ''}${pct} used.`,
  sentenceTooEarly: 'A projection needs 3 days of spend.',
  // The strip (F2)
  stripLabel: 'Burn figures',
  stripToday: 'Today so far',
  stripTodayVs: (avg: string) => `vs ${avg} a day (7-day average)`,
  stripWeek: 'This week so far',
  stripWeekVs: (last: string) => `vs ${last} the same days last week`,
  stripWeekNoCompare: 'No full week to compare yet',
  stripToDate: (p: 'month' | 'quarter') => `${p === 'month' ? 'Month' : 'Quarter'} to date`,
  stripOfLimit: (pct: string, limit: string) => `${pct} of ${limit}`,
  stripProjected: (p: 'month' | 'quarter') => `Projected ${p} end`,
  stripProjectedRange: (low: string, high: string) => (low === high ? low : `${low} to ${high}`),
  stripQuarter: 'Projected quarter end',
  stripQuarterNote: 'Assumes this month’s limit for the months ahead',
  stripAllowance: 'Daily allowance left',
  stripAllowanceNone: 'None left',
  stripAllowanceFor: (days: number) => `for the next ${days} ${days === 1 ? 'day' : 'days'}`,
  stripAtMost: (v: string) => `at most ${v}`,
  stripNoProjection: 'Needs 3 days of spend',
  stripAsOf: (time: string) => `As of ${time} UTC`,
  stripUnpriced: (n: number) =>
    `${n} ${n === 1 ? 'call has' : 'calls have'} no price yet: spend is at least this`,

  // What's causing the burn (F3)
  causesBy: 'Daily spend by',
  dimension: {
    agent: 'Agent',
    owner: 'Owner',
    unit: 'Unit',
    model: 'Model',
    operation: 'Operation',
    session: 'Session',
    source: 'Source',
  } as Record<string, string>,
  causesOther: (n: number) => (n ? `Other (${n})` : 'Other'),
  causesRedacted: 'Another user’s session',
  contributorsTitle: 'Contributors this period',
  contributorsShare: (pct: string) => `${pct} of spend`,
  contributorsPick: (name: string) => `Show ${name}’s share`,
  contributorsCsv: 'Download CSV',
  contributorsNone: 'No spend by contributor yet.',
  contributorsMissing: 'Contributors need a newer OpenRuntime server.',
  shareChip: (name: string) => `${name}`,
  shareClear: 'Clear',
  shareClearLabel: (name: string) => `Clear ${name}’s share view`,
  shareBurnUpHint: (name: string) => `Burn-up draws ${name}’s line beside the total.`,
  shareSpend: (name: string) => `${name} this period`,
  shareOf: (pct: string) => `${pct} of the scope’s spend`,
  shareLine: (name: string) => `${name}, cumulative`,
  shareOpenAgent: 'Open agent',
  changesTitle: 'What changed',
  changesSubtitle: 'This week so far vs the same hours last week',
  changesSpike: (day: string, amount: string, ratio: string | null) =>
    ratio ? `${day}: ${amount}, ${ratio}× the 7-day pace` : `${day}: ${amount}, a spike day`,
  changesSpikeLabel: 'Spike day',
  changesNew: 'new',
  changesEmpty: 'Comparisons start after a full week of spend.',
  changesNothing: 'Nothing changed by more than a cent.',
  changesUnpriced: (n: number) =>
    `${n} ${n === 1 ? 'call without a price isn’t' : 'calls without a price aren’t'} compared.`,
  changesTruncated: 'More contributors changed than are shown.',
  changesFailed: 'what changed',
  changesMissing: 'Comparisons need a newer OpenRuntime server.',
  dayTitle: (day: string) => `${day}`,
  dayDescription: (amount: string) => `${amount} spent this day`,
  dayContributors: 'Top contributors',
  dayHours: 'By hour (UTC)',
  dayTraces: 'Most expensive traces',
  dayTracesNone: 'No traces this day.',
  dayAnother: 'Another user’s session',
  dayCalls: (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`,
  dayFailed: (what: string) => what,
  dayMissing: 'This view needs a newer OpenRuntime server.',
  dayHour: (h: number) => `${String(h).padStart(2, '0')}:00`,

  // What-if (F6): nothing is saved.
  whatIfTitle: 'What if…',
  whatIfHint: 'Try a different limit or pace',
  whatIfLimit: 'Limit',
  whatIfPace: 'Pace change',
  whatIfPaceValue: (pct: number) =>
    pct === 0 ? 'Same pace' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`,
  whatIfProjected: (amount: string, day: string) => `Projected spend ${amount} by ${day}`,
  whatIfRunsOut: (day: string, stops: boolean) =>
    stops ? `Runs out around ${day}` : `Exceeds the limit around ${day}`,
  whatIfWithin: 'Stays within the limit to the reset',
  whatIfAlreadyOver: (stops: boolean) =>
    stops ? 'Already over this limit: calls would stop now' : 'Already over this limit',
  whatIfAllowance: (perDay: string, days: number) =>
    `${perDay} a day for the next ${days} ${days === 1 ? 'day' : 'days'}`,
  whatIfAllowanceNone: 'No allowance left',
  whatIfNeedsProjection: 'What-if needs a projection: 3 days of spend.',
  whatIfNeedsBudget: 'What-if needs a budget to compare against.',
  whatIfReset: 'Reset',
  whatIfAnnounce: (amount: string, day: string) =>
    `Preview, not applied: projected spend ${amount} by ${day}.`,
  whatIfProblem: {
    limit_required: 'Enter a limit in dollars.',
    limit_positive: 'The limit must be more than $0.',
    limit_too_large: 'The limit must be $1,000,000,000 or less.',
    pace_out_of_range: 'The pace change must be between −50% and +50%.',
  },

  // At risk and Unbudgeted (F7)
  atRiskTitle: 'At risk',
  atRiskFailed: 'at risk budgets',
  atRiskEmpty: (reset: string) => `Nothing exceeds its limit before ${reset}.`,
  atRiskLimitsInside: (amount: string, n: number) =>
    `${amount} in limits set on ${n} ${n === 1 ? 'budget' : 'budgets'} inside it (routed calls only)`,
  colBudget: 'Budget',
  colOwner: 'Owner',
  colUsed: 'Used of limit',
  colProjected: 'Projected',
  colReaches: 'Reaches the limit',
  atRiskStops: 'stops calls',
  atRiskAlerts: 'alert only',
  atRiskRanOut: 'Ran out',
  atRiskExceeded: 'Exceeded',
  atRiskNoRunOut: 'Not before the reset',
  atRiskSession: 'Session',
  unbudgetedTitle: 'Unbudgeted',
  unbudgetedSubtitle: 'Agents with spend this period and no agent budget',
  unbudgetedFailed: 'unbudgeted agents',
  unbudgetedEmpty: 'Every agent with spend this period has a budget.',
  colAgent: 'Agent',
  colSpend: 'Spend',
  colSplit: 'Routed · traced · harness est.',
  unbudgetedHarness: 'Its calls don’t go through the router',
  sectionMissing: 'This list needs a newer OpenRuntime server.',
  listPartial: 'Some rows couldn’t load.',
  viewsMissing: (what: string) => `Some budget views need a newer OpenRuntime server: ${what}.`,
  viewNames: {
    breakdown: 'causes',
    changes: 'comparisons',
    hours: 'hours',
    traces: 'traces',
    contributor: 'shares',
    at_risk: 'at risk',
    unbudgeted: 'unbudgeted agents',
  } as Record<string, string>,

  // Alerts (F5; moved from the router)
  alertsTitleV1: 'Alerts',
  alertsSubtitleV1: 'Thresholds crossed and forecasts, newest first',
  alertsFailed: 'alerts',
  alertsEmpty: 'No alerts this period.',
  alertThreshold: (label: string, pct: number, amount: string, stopped: boolean) =>
    stopped
      ? `${label} reached ${pct}% (${amount}); calls stopped`
      : `${label} crossed ${pct}% (${amount})`,
  alertForecast: (label: string, pct: number, crosses: string | null, at: string) =>
    crosses
      ? `${label} will pass ${pct}% around ${crosses} (projected on ${at})`
      : `${label} is projected to pass ${pct}% (projected on ${at})`,
  alertForecastCleared: (label: string, pct: number) => `${label}’s forecast for ${pct}% cleared`,

  // Levers (F4, design 4A): estimates, never outcomes; "projected spend", never "landing".
  leversTitle: 'Levers',
  leversAssume: (rest: string) => `Estimates assume the rest of ${rest} follows the last 7 days.`,
  leversReduce: 'Reduce projected spend',
  leversAdjust: 'Adjust the budget',
  leverCompression: (name: string) => `Turn on token optimization for ${name}`,
  leverCompressionBasis: (n: number) =>
    `Measured on ${n} ${n === 1 ? 'agent' : 'agents'} with it on`,
  leverCompressionNoBasis: 'No measured savings yet, so no estimate',
  leverModel: (name: string) => `Route ${name} to a cheaper model`,
  leverModelBasis: (from: string, to: string) => `${from} → ${to}, only this agent`,
  leverStop: 'Stop calls at the limit',
  leverStopBasis: (limit: string) => `Routed calls stop at ${limit} until the reset`,
  leverStopNow: 'It’s already over: calls would stop now',
  leverRaise: (limit: string) => `Raise the limit to ${limit}`,
  leverRaiseBasis: (pct: string) => `${pct} of it used so far`,
  leverEstimate: (amount: string, period: string) => `≈ −${amount} projected spend this ${period}`,
  leverNoEstimate: 'No estimate',
  leverPreview: 'Preview',
  leverPreviewLabel: (what: string) => `Preview: ${what}`,
  leversOnTrack: 'Nothing to change: on track.',
  leversNoBudget: 'Levers compare against a budget. Set one to see them.',
  leversNoProjection: 'Levers need a projection: 3 days of spend.',
  leversNone: 'Nothing OpenRuntime can change for this budget.',
  leverDo: {
    compression: 'Turn on',
    model: 'Switch model',
    stop: 'Stop at the limit',
    raise: 'Raise',
  },
  leverDoLabel: (what: string) => `Apply: ${what}`,
  leverConfirmCompression: (name: string) => `Turn on token optimization for ${name}?`,
  leverConfirmCompressionBody:
    'It also compresses this agent’s LLM-router payloads and asks it for concise answers. You can turn it off on the agent’s Settings tab.',
  leverConfirmModel: (name: string) => `Route ${name} to a cheaper model?`,
  leverConfirmModelBody: (name: string, from: string, to: string) =>
    `${name}: ${from} → ${to}, only this agent. Its shared config doesn’t change; the router pins this agent’s model.`,
  leverConfirmStop: 'Stop calls at the limit?',
  leverConfirmStopBody: (limit: string, reset: string) =>
    `Routed calls this budget counts get an error once spend reaches ${limit}, until ${reset}.`,
  leverConfirmStopNow: (reset: string) =>
    `It’s already over its limit: routed calls this budget counts get an error now, until ${reset}.`,
  leverApplied: {
    compression: (name: string) => `Token optimization is on for ${name}.`,
    model: (name: string, to: string) => `${name} now routes to ${to}.`,
    stop: 'Calls now stop at the limit.',
  },
  leverFailed: 'That didn’t apply.',
  leverModelProvider: (now: string, to: string) =>
    `This agent now routes through a ${now} config, so a ${to} model can’t be pinned. Nothing changed.`,
  leverModelAlready: (name: string, model: string) =>
    `${name} already routes to ${model}. Nothing changed.`,
  previewNotApplied: (amount: string, pct: string) => `Preview, not applied: ${amount} (${pct})`,
  previewReset: 'Reset',
  reviewActions: 'Review actions',

  // Home's Budget burn panel (F10, F12, ledger #79)
  homeTitle: (scope: string) => `Budget burn · ${scope}`,
  // The session ledger's budget (B5, F9).
  sessionTitle: 'Session budget',
  sessionNoLimit: (used: string, turns: number) =>
    `${used} over ${turns} ${turns === 1 ? 'turn' : 'turns'}; no session limit.`,
  sessionUsed: (used: string, limit: string, pct: number, turns: number) =>
    `${used} of its ${limit} session limit used (${pct}%) over ${turns} ${turns === 1 ? 'turn' : 'turns'}.`,
  sessionOver: (limit: string, over: string) => `Over its ${limit} session limit by ${over}.`,
  sessionStopped: (limit: string) =>
    `Reached its ${limit} session limit; calls are stopped for this session.`,
  sessionTurn: (n: number) => `Turn ${n}`,
  sessionStart: 'Start',
  sessionUsedLabel: 'This session',
  sessionPerTurn: 'Per turn, last 5',
  sessionPerTurnVs: (avg: string) => `vs ${avg} the session’s average`,
  sessionLeft: 'Left of the limit',
  sessionOverBy: 'Over by',
  setSessionLimit: 'Set a session limit',
  editSessionLimit: 'Edit session limit',
  // The hub's Budget section (B5).
  hubTitle: 'Budget',
  homeOpen: 'Open budgets',
  homeOpenLabel: (scope: string) => `Open budgets: ${scope}`,
  homeAtRisk: 'At risk',
  homeAtRiskNone: 'Nothing reaches its limit before the reset.',
  homeBilled: 'Calls billed to you',
  homeAgents: 'Your agents’ spend',
  homeAgentsNote: 'Every caller, this month',
  homeOutside: (traced: string, harness: string) =>
    `Outside this budget this month: ${traced} traced, ${harness} harness estimates`,
  homeAtMost: 'At most a day',

  // Editing in place (F10)
  editBudget: 'Edit budget',
  adjustLimit: 'Adjust limit',
  adjustLimitFor: (name: string) => `Adjust limit: ${name}`,
  moreActions: (name: string) => `More actions: ${name}`,
  openAgent: 'Open agent',
  setBudgetFor: (name: string) => `Set a budget: ${name}`,
  viewBudgetFor: (name: string) => `View budget: ${name}`,
  useThisLimit: 'Use this limit',
  editLoadFailed: 'Couldn’t open the budget. Try again.',
  setYourBudget: 'Set your budget',

  setBudget: 'Set a budget',
  setFleetBudget: 'Set a fleet budget',

  // Budget burn (plan feat-budget-burn F1, design 4B, 5C, 1C)
  burnLeft: 'Left of the limit',
  burnSpent: 'Spent',
  burnPace: 'Even pace',
  burnBand: 'Projection from recent spending rates',
  burnBandHint: 'The 30-day and 7-day averages',
  burnLimit: 'Limit',
  burnThreshold: (pct: number) => `${pct}%`,
  burnThresholds: 'Alert marks',
  burnStop: 'Calls stop',
  burnOver: (amount: string) => `−${amount} over`,
  burnEstimated: (day: string) => `Estimated to exceed around ${day}`,
  // Unpriced calls make spend a floor, so the run-out can only come sooner (plan F2).
  burnEstimatedFloor: (day: string) => `Estimated to exceed by ${day} or earlier`,
  burnOverFloor: (amount: string) => `At least −${amount} over`,
  burnRanOut: (day: string) => `Ran out ${day}`,
  burnExceeded: (day: string) => `Exceeded ${day}`,
  burnPreview: 'Preview, not applied',
  // The "expected" line after a change that moved the pace (F13): where spend was going before it.
  burnExpected: (day: string) => `Expected without the ${day} change`,
  burnBars: 'Daily spend',
  burnSpike: 'Spike day',
  // Event flags (BG-3 events; design 7B lists them on hover).
  eventThreshold: (pct: number) => `Crossed ${pct}%`,
  eventForecast: (pct: number, day: string) => `Forecast to pass ${pct}% around ${day}`,
  eventForecastCleared: (pct: number) => `Forecast for ${pct}% cleared`,
  eventStopped: 'Calls stopped',
  eventResumed: 'Calls resumed',
  eventLimit: (from: string, to: string) => `Limit ${from} → ${to}`,
  eventAction: (to: 'alert' | 'stop') =>
    to === 'stop' ? 'Set to stop calls' : 'Set to alert only',
  eventPeriod: (period: string, day: string) => `Becomes ${period}ly from ${day}`,
  eventFiscal: (day: string) => `Fiscal year changes from ${day}`,
  // Table view (F1, design 6B)
  tableDate: 'Date',
  tableSpend: 'Spend',
  tableCumulative: 'Cumulative',
  tableLeft: 'Left',
  tablePace: 'Even pace',
  // Neutral: which rate is lower changes from read to read (the band swaps), so the headers never name one.
  tableLow: 'Projection low',
  tableHigh: 'Projection high',
  tableSpike: 'Spike',
  tableProjected: 'projected',
  tableDownload: 'Download CSV',
  tableCaption: (scope: string) => `Daily spend and projection for ${scope}`,
  tableFloor:
    'Some calls have no price yet: spend is at least what is shown, and what is left at most.',
  tableEvents: 'Events',
}
