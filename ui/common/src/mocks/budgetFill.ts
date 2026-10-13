/**
 * Partial live for budgets (docs/requirements/budgets.md §15 step 2, plan feat-budget-burn #43):
 * `VITE_NASIKO_MOCK=budgets-fill npm run dev:live` draws /budgets from the real server where it serves the feature and
 * from the mock everywhere else, so a backend engineer sees their routes working beside the ones they haven't built.
 *
 * Which answers: when the server has `GET /api/budgets/capabilities`, each route goes live exactly when its feature
 * is listed (§10.1); without it, each request asks the server first and falls back to the mock on a bare 404.
 */
import { budgetFeatureOf } from './budgetFeatures'

/** Fetch a request from the real server, past MSW (`bypass` in the browser; injectable for tests). */
export type LiveFetch = (request: Request) => Promise<Response>

const bare404 = async (r: Response) => {
  if (r.status !== 404) return false
  const text = await r.clone().text()
  if (!text) return true
  try {
    const body = JSON.parse(text) as unknown
    return !(body && typeof body === 'object' && 'code' in body)
  } catch {
    return true
  }
}

/**
 * The fill decision: the live answer to use, or null for the mock. Capabilities are read once per page load; a failed
 * read (network, 5xx) counts as "no capabilities", so routes are probed one by one.
 */
export function liveFirst(fetchLive: LiveFetch) {
  let caps: Promise<string[] | null> | null = null
  const capabilities = (origin: string) =>
    (caps ??= fetchLive(new Request(new URL('/api/budgets/capabilities', origin)))
      .then(async (r) => {
        if (!r.ok) return null
        const body = (await r.json()) as { data?: { features?: unknown } }
        return Array.isArray(body.data?.features) ? (body.data.features as string[]) : null
      })
      .catch(() => null))

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname === '/api/budgets/capabilities') {
      const r = await fetchLive(request.clone()).catch(() => null)
      return r && !(await bare404(r)) ? r : null
    }
    const listed = await capabilities(url.origin)
    if (listed)
      return listed.includes(budgetFeatureOf(request.method, url)) ? fetchLive(request) : null
    const r = await fetchLive(request.clone()).catch(() => null)
    return r && !(await bare404(r)) ? r : null
  }
}
