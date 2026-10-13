/**
 * Which capabilities (docs/requirements/budgets.md §10.1) serve a budgets request; it goes live when any is listed: `budgets-fill` sends a request
 * to the real server exactly when its feature is listed. The 1.0 parameters an R-L10 server ignores (`scope` on
 * status and alerts, `kind=all`) name the feature that adds them.
 */
export function budgetFeatureOf(url: URL): string[] {
  const p = url.pathname.replace(/\/$/, '')
  const q = url.searchParams
  const scope = q.get('scope')
  if (p === '/api/budgets/settings') return ['team_identity', 'fiscal_year']
  if (p === '/api/budgets/prices') return ['prices']
  if (p === '/api/budgets/at-risk') return ['at_risk']
  if (p === '/api/budgets/unbudgeted') return ['unbudgeted']
  if (p === '/api/budgets/burn/breakdown')
    return [q.get('by') === 'unit' ? 'unit_budgets' : 'breakdown']
  if (p === '/api/budgets/burn/changes') return ['changes']
  if (p === '/api/budgets/burn/hours') return ['hours']
  if (p === '/api/budgets/burn/traces') return ['traces']
  if (p === '/api/budgets/burn') {
    if (q.get('contributor')) return ['contributor']
    if (scope === 'session') return ['session_budgets']
    if (scope === 'unit') return ['unit_budgets']
    return ['burn']
  }
  if (p === '/api/budgets/status') return [scope ? 'scope_status' : 'budgets']
  if (p === '/api/budgets/alerts')
    return [q.get('kind') === 'all' ? 'forecast_alerts' : scope ? 'scope_status' : 'budgets']
  if (/^\/api\/budgets\/[^/]+\/versions$/.test(p)) return ['versions']
  if (/^\/api\/budgets\/[^/]+$/.test(p)) return ['budgets']
  return ['budgets']
}
