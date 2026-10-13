/**
 * The budgets mock's routes (docs/requirements/budgets.md 1.0): every route answers from the engine
 * (`budgetEngine.ts`) over the active world. Errors are the contract's `{error, code}` JSON.
 *
 * Variants (`handlers.ts` `BUDGETS_PAGE_VARIANTS`): `budgets-absent` (and the older `home-budgets-absent`) answer every
 * budgets route with a bare 404, a server without budgets; `budgets-rl10-only` keeps R-L10's routes and answers the
 * 1.0 ones with a bare 404 (F11's fallback detection); `budgets-fail` answers every read with a 500. With `fill`
 * (`budgets-fill`), requests the real server serves go there first (`budgetFill.ts`).
 */
import { http, HttpResponse, type HttpHandler } from 'msw'
import { MockHttpError } from './aggregate'
import {
  activatePending,
  alertsList,
  atRisk,
  breakdown,
  budgetsList,
  budgetView,
  burn,
  capabilities,
  changes,
  createBudget,
  deleteBudget,
  getBudget,
  hours,
  pricesList,
  settingsView,
  statusList,
  traces,
  unbudgeted,
  updateBudget,
  updateSettings,
  versionsList,
  type Viewer,
  type World,
} from './budgetEngine'

export interface BudgetMockCtx {
  loggedIn: () => boolean
  now: () => number
  world: () => World
  viewer: () => Viewer
  /** A server without any budget route. */
  absent: () => boolean
  /** A server with R-L10 only (no 1.0 route). */
  rl10Only: () => boolean
  /** Every read fails with a 500. */
  failing: () => boolean
  unauthorized: () => Response
  /** `budgets-fill`: the real server's answer for a request it serves, else null (the mock answers). */
  fill?: (request: Request) => Promise<Response | null>
}

const bare404 = () => new HttpResponse(null, { status: 404 })
const internal = () =>
  HttpResponse.json({ error: 'internal error', code: 'internal' }, { status: 500 })

export function budgetHandlers(ctx: BudgetMockCtx): HttpHandler[] {
  /** Run a route: auth, availability, failure, then the engine; a thrown MockHttpError becomes its JSON error. */
  const run = (fn: () => Response, opts: { v1?: boolean; read?: boolean } = {}): Response => {
    if (!ctx.loggedIn()) return ctx.unauthorized()
    if (ctx.absent() || (opts.v1 && ctx.rl10Only())) return bare404()
    if (opts.read !== false && ctx.failing()) return internal()
    // A scheduled period change takes effect at its boundary, whenever the next request comes.
    activatePending(ctx.world(), ctx.now())
    try {
      return fn()
    } catch (err) {
      if (err instanceof MockHttpError)
        return err.body === undefined
          ? HttpResponse.json({ error: err.message, code: 'error' }, { status: err.status })
          : HttpResponse.json(err.body as never, { status: err.status })
      throw err
    }
  }
  const qs = (request: Request) => {
    const p = new URL(request.url).searchParams
    const get = (k: string) => p.get(k)
    return { get, scope: get('scope'), id: get('id') }
  }
  const one = (data: unknown, status = 200) => HttpResponse.json({ data }, { status })
  const body = async (request: Request) =>
    (await request.json().catch(() => null)) as Record<string, unknown> | null
  const unparseable = () =>
    HttpResponse.json({ error: 'invalid JSON body', code: 'invalid_body' }, { status: 422 })

  // budgets-fill: the real server first; a resolver that returns nothing falls through to the mock routes below.
  const fill: HttpHandler[] = ctx.fill
    ? ['/api/budgets', '/api/budgets/*'].map((path) =>
        http.all(path, async ({ request }) => (await ctx.fill!(request)) ?? undefined),
      )
    : []

  return [
    ...fill,
    http.get('/api/budgets/capabilities', () =>
      run(() => one(capabilities(ctx.world())), { v1: true }),
    ),
    http.get('/api/budgets/settings', () =>
      run(() => one(settingsView(ctx.world())), { v1: true }),
    ),
    http.put('/api/budgets/settings', async ({ request }) => {
      const b = await body(request)
      return run(
        () => (b ? one(updateSettings(ctx.world(), ctx.viewer(), b, ctx.now())) : unparseable()),
        {
          v1: true,
          read: false,
        },
      )
    }),
    http.get('/api/budgets/prices', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return HttpResponse.json(
            pricesList(ctx.world(), { limit: q.get('limit'), cursor: q.get('cursor') }),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/burn', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return one(
            burn(
              ctx.world(),
              ctx.viewer(),
              {
                ...q,
                period: q.get('period'),
                from: q.get('from'),
                include_previous: q.get('include_previous'),
                contributor: q.get('contributor'),
                by: q.get('by'),
              },
              ctx.now(),
            ),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/burn/breakdown', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return one(
            breakdown(
              ctx.world(),
              ctx.viewer(),
              {
                ...q,
                by: q.get('by'),
                period: q.get('period'),
                from: q.get('from'),
                to: q.get('to'),
                top: q.get('top'),
              },
              ctx.now(),
            ),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/burn/changes', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return one(
            changes(
              ctx.world(),
              ctx.viewer(),
              {
                ...q,
                by: q.get('by'),
                from: q.get('from'),
                to: q.get('to'),
                compare_from: q.get('compare_from'),
                compare_to: q.get('compare_to'),
                top: q.get('top'),
              },
              ctx.now(),
            ),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/burn/hours', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return one(hours(ctx.world(), ctx.viewer(), { ...q, date: q.get('date') }, ctx.now()))
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/burn/traces', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return HttpResponse.json(
            traces(
              ctx.world(),
              ctx.viewer(),
              { ...q, date: q.get('date'), limit: q.get('limit'), cursor: q.get('cursor') },
              ctx.now(),
            ),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/at-risk', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return HttpResponse.json(
            atRisk(
              ctx.world(),
              ctx.viewer(),
              { ...q, limit: q.get('limit'), cursor: q.get('cursor') },
              ctx.now(),
            ),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/unbudgeted', ({ request }) =>
      run(
        () => {
          const q = qs(request)
          return HttpResponse.json(
            unbudgeted(
              ctx.world(),
              ctx.viewer(),
              { ...q, period: q.get('period'), limit: q.get('limit'), cursor: q.get('cursor') },
              ctx.now(),
            ),
          )
        },
        { v1: true },
      ),
    ),
    // R-L10's routes: an R-L10-only server ignores the 1.0 parameters (scope, kind).
    http.get('/api/budgets/status', ({ request }) =>
      run(() => {
        const q = qs(request)
        const scoped = ctx.rl10Only() ? { scope: null, id: null } : q
        return HttpResponse.json(
          statusList(
            ctx.world(),
            ctx.viewer(),
            { ...scoped, limit: q.get('limit'), cursor: q.get('cursor') },
            ctx.now(),
          ),
        )
      }),
    ),
    http.get('/api/budgets/alerts', ({ request }) =>
      run(() => {
        const q = qs(request)
        const v1 = !ctx.rl10Only()
        return HttpResponse.json(
          alertsList(
            ctx.world(),
            ctx.viewer(),
            {
              ...(v1 ? q : { scope: null, id: null }),
              kind: v1 ? q.get('kind') : null,
              from: v1 ? q.get('from') : null,
              limit: q.get('limit'),
              cursor: q.get('cursor'),
            },
            ctx.now(),
          ),
        )
      }),
    ),
    http.get('/api/budgets', ({ request }) =>
      run(() => {
        const q = qs(request)
        const scoped = ctx.rl10Only() ? { scope: null, id: null } : q
        return HttpResponse.json(
          budgetsList(
            ctx.world(),
            ctx.viewer(),
            { ...scoped, limit: q.get('limit'), cursor: q.get('cursor') },
            ctx.now(),
          ),
        )
      }),
    ),
    http.post('/api/budgets', async ({ request }) => {
      const b = await body(request)
      return run(
        () => {
          if (!b) return unparseable()
          const w = ctx.world()
          return one(budgetView(w, createBudget(w, ctx.viewer(), b, ctx.now()), ctx.now()), 201)
        },
        { read: false },
      )
    }),
    http.get('/api/budgets/:id/versions', ({ params, request }) =>
      run(
        () => {
          const q = qs(request)
          return HttpResponse.json(
            versionsList(ctx.world(), ctx.viewer(), String(params.id), ctx.now(), {
              limit: q.get('limit'),
              cursor: q.get('cursor'),
            }),
          )
        },
        { v1: true },
      ),
    ),
    http.get('/api/budgets/:id', ({ params }) =>
      run(
        () => {
          const w = ctx.world()
          return one(budgetView(w, getBudget(w, ctx.viewer(), String(params.id)), ctx.now()))
        },
        { v1: true },
      ),
    ),
    http.put('/api/budgets/:id', async ({ params, request }) => {
      const b = await body(request)
      return run(
        () => {
          if (!b) return unparseable()
          const w = ctx.world()
          return one(
            budgetView(
              w,
              updateBudget(w, ctx.viewer(), String(params.id), b, ctx.now()),
              ctx.now(),
            ),
          )
        },
        { read: false },
      )
    }),
    http.delete('/api/budgets/:id', ({ params }) =>
      run(
        () => {
          deleteBudget(ctx.world(), ctx.viewer(), String(params.id), ctx.now())
          return new HttpResponse(null, { status: 204 })
        },
        { read: false },
      ),
    ),
  ]
}
