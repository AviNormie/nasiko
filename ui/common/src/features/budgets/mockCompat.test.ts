// The regression contract for moving budgets out of the router group (plans/feat-budget-burn.md eng D2, ledger #55):
// `router` in VITE_NASIKO_MOCK still mocks budgets, and every `router-budgets-*` alias answers as its `budgets-*` name.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readEnv } from '@/lib/env'
import { configureMocks, handlersFor } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'

setupPinnedSeed()
afterEach(() =>
  configureMocks({ seed, now, loggedIn: true, routerVariants: [], budgetVariants: [] }),
)

const paths = (groups: Parameters<typeof handlersFor>[0]) =>
  handlersFor(groups).map((h) => `${h.info.header}`)

const read = async (path: string) => {
  const r = await fetch(new URL(path, globalThis.location.origin))
  return { status: r.status, body: r.ok ? ((await r.json()) as { data: unknown }) : null }
}

describe('router brings budgets along (partial live)', () => {
  it('VITE_NASIKO_MOCK=router,agents,providers mounts the budget handlers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const groups = readEnv({
      VITE_NASIKO_API_MODE: 'live',
      VITE_NASIKO_MOCK: 'router,agents,providers',
      DEV: true,
    }).partialMocks
    expect(groups).toContain('budgets')
    for (const p of [
      'GET /api/budgets',
      'GET /api/budgets/status',
      'GET /api/budgets/alerts',
      'POST /api/budgets',
    ])
      expect(paths(groups)).toContain(p)
    // The router group alone no longer carries them.
    expect(paths(['router'])).not.toContain('GET /api/budgets')
  })
})

describe('router-budgets-* aliases', () => {
  it.each([
    ['budgets-empty', 'router-budgets-empty'],
    ['budgets-fail', 'router-budgets-fail'],
  ] as const)('%s and %s answer the same', async (name, alias) => {
    const answers = []
    for (const v of [name, alias]) {
      configureMocks(
        v.startsWith('router-')
          ? { routerVariants: [v as 'router-budgets-empty'], budgetVariants: [] }
          : { budgetVariants: [v as 'budgets-empty'], routerVariants: [] },
      )
      answers.push([await read('/api/budgets'), (await read('/api/budgets/status')).status])
    }
    expect(answers[1]).toEqual(answers[0])
    if (name === 'budgets-empty')
      expect(answers[0]![0]).toMatchObject({ status: 200, body: { data: [] } })
    else expect(answers[0]![0]).toMatchObject({ status: 500 })
  })
})
