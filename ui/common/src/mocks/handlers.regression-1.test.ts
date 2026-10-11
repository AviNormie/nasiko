// Regression: ISSUE-004 — `?mock=onboarding-done,home-budgets-absent` still served budgets: only the list's first
// degraded-state variant counted, so the documented state couldn't be reached on the home (which needs onboarding-done)
// Found by /qa on 2026-10-11
// Report: .gstack/qa-reports/qa-report-localhost-2026-10-11-pr2b.md
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureMocks } from './handlers'

const url = (p: string) => new URL(p, globalThis.location.origin)
let before = ''

beforeEach(() => {
  configureMocks({ loggedIn: true, variant: null })
  before = globalThis.location.href
})
afterEach(() => globalThis.history.replaceState(null, '', before))

describe('home-budgets-absent in a comma list (ISSUE-004)', () => {
  it('answers a bare 404 on both budgets reads even after another variant', async () => {
    globalThis.history.replaceState(null, '', '/?mock=onboarding-done,home-budgets-absent')
    for (const path of ['/api/budgets', '/api/budgets/status']) {
      const res = await fetch(url(path))
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
    }
  })

  it('leaves budgets answering without it', async () => {
    globalThis.history.replaceState(null, '', '/?mock=onboarding-done')
    expect((await fetch(url('/api/budgets'))).status).toBe(200)
  })
})
