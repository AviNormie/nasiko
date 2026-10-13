// @vitest-environment node
// budgets-fill (budgets.md §15 step 2): which requests go to the real server, and which the golden mock answers.
import { describe, expect, it } from 'vitest'
import { liveFirst } from './budgetFill'
import { budgetFeatureOf } from './budgetFeatures'

const ORIGIN = 'http://localhost:3000'
const req = (path: string, method = 'GET') => new Request(new URL(path, ORIGIN), { method })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const bare404 = () => new Response(null, { status: 404 })

describe('budgetFeatureOf', () => {
  it.each([
    ['GET', '/api/budgets', 'budgets'],
    ['POST', '/api/budgets', 'budgets'],
    ['GET', '/api/budgets/status', 'budgets'],
    ['GET', '/api/budgets/status?scope=org', 'scope_status'],
    ['GET', '/api/budgets/alerts?kind=all', 'forecast_alerts'],
    ['GET', '/api/budgets/abc', 'versions'],
    ['PUT', '/api/budgets/abc', 'budgets'],
    ['GET', '/api/budgets/abc/versions', 'versions'],
    ['GET', '/api/budgets/burn?scope=org', 'burn'],
    ['GET', '/api/budgets/burn?scope=session&id=s', 'session_budgets'],
    ['GET', '/api/budgets/burn?scope=agent&id=a&contributor=m&by=model', 'contributor'],
    ['GET', '/api/budgets/burn/breakdown?scope=org&by=unit', 'unit_budgets'],
    ['GET', '/api/budgets/burn/breakdown?scope=org&by=agent', 'breakdown'],
    ['GET', '/api/budgets/at-risk?scope=org', 'at_risk'],
  ])('%s %s → %s', (method, path, feature) => {
    expect(budgetFeatureOf(method, new URL(path, ORIGIN))).toBe(feature)
  })
})

describe('liveFirst', () => {
  it('with capabilities: a listed feature goes live, an unlisted one falls back to the mock', async () => {
    const asked: string[] = []
    const fill = liveFirst(async (r) => {
      const u = new URL(r.url)
      asked.push(u.pathname + u.search)
      if (u.pathname === '/api/budgets/capabilities')
        return json({ data: { version: '1.0', features: ['budgets', 'burn'] } })
      return json({ data: 'live' })
    })
    expect(await (await fill(req('/api/budgets/burn?scope=org')))!.json()).toEqual({ data: 'live' })
    expect(await fill(req('/api/budgets/at-risk?scope=org'))).toBeNull()
    // Capabilities are read once.
    await fill(req('/api/budgets'))
    expect(asked.filter((p) => p === '/api/budgets/capabilities')).toHaveLength(1)
    expect(asked).not.toContain('/api/budgets/at-risk?scope=org')
  })

  it('without capabilities: each route is asked, and a bare 404 means the mock answers; a coded 404 is the server’s', async () => {
    const fill = liveFirst(async (r) => {
      const p = new URL(r.url).pathname
      if (p === '/api/budgets') return json({ data: [] })
      if (p === '/api/budgets/zzz')
        return json({ error: 'budget not found', code: 'budget_not_found' }, 404)
      return bare404()
    })
    expect(await fill(req('/api/budgets'))).not.toBeNull()
    expect(await fill(req('/api/budgets/burn?scope=org'))).toBeNull()
    expect((await fill(req('/api/budgets/zzz')))!.status).toBe(404)
    // The capabilities route itself: the mock's when the server has none.
    expect(await fill(req('/api/budgets/capabilities'))).toBeNull()
  })

  it('a server that can’t be reached leaves everything to the mock', async () => {
    const fill = liveFirst(() => Promise.reject(new TypeError('fetch failed')))
    expect(await fill(req('/api/budgets'))).toBeNull()
    expect(await fill(req('/api/budgets/capabilities'))).toBeNull()
  })
})
