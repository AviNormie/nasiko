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
  alertsTitle: 'Alerts',
  alertsSubtitle: 'In-app, one per budget per mark per month. Email and webhooks are server work.',
  noAlerts: 'No alerts this month or last',
  alertCrossed: (label: string, pct: number, amount: string, stopped: boolean) =>
    `${label} crossed ${pct}% (${amount})${stopped ? ' · calls stopped' : ''}`,
  viewBudget: 'View budget',
  alertOwner: 'Your budget',

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
  burnRanOut: (day: string) => `Ran out ${day}`,
  burnExceeded: (day: string) => `Exceeded ${day}`,
  burnPreview: 'Preview, not applied',
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
  tableLow: 'Projection low (30-day rate)',
  tableHigh: 'Projection high (7-day pace)',
  tableSpike: 'Spike',
  tableProjected: 'projected',
  tableDownload: 'Download CSV',
  tableCaption: (scope: string) => `Daily spend and projection for ${scope}`,
}
