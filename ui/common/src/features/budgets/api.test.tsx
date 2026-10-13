// The R-L10 hooks read every page of the 1.0 list envelope (B0 /review, Codex #7): Home and the hub must see a
// budget on the 51st agent too.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { server } from '@/test/setup'
import { useBudgets, useBudgetStatus } from './api'

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)
const row = (n: number) => ({ id: `b${n}`, budget_id: `b${n}` })

describe('budget hooks follow next_cursor', () => {
  it('useBudgets and useBudgetStatus return every page, and keep the status covers', async () => {
    const pages = (path: string) =>
      http.get(path, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        return cursor
          ? HttpResponse.json({
              data: [row(101)],
              has_more: false,
              next_cursor: null,
              prev_cursor: 'p',
            })
          : HttpResponse.json({
              data: Array.from({ length: 100 }, (_, i) => row(i + 1)),
              has_more: true,
              next_cursor: 'o100',
              prev_cursor: null,
              covers: 'routed_calls',
            })
      })
    server.use(pages('/api/budgets'), pages('/api/budgets/status'))
    const list = renderHook(() => useBudgets(), { wrapper })
    const status = renderHook(() => useBudgetStatus(true), { wrapper })
    await waitFor(() => expect(list.result.current.data).toHaveLength(101))
    await waitFor(() => expect(status.result.current.data?.data).toHaveLength(101))
    expect(status.result.current.data?.covers).toBe('routed_calls')
  })

  it('a server without paging fields answers once (R-L10)', async () => {
    let calls = 0
    server.use(
      http.get('/api/budgets', () => {
        calls++
        return HttpResponse.json({ data: [row(1)] })
      }),
    )
    const list = renderHook(() => useBudgets(), { wrapper })
    await waitFor(() => expect(list.result.current.data).toHaveLength(1))
    expect(calls).toBe(1)
  })
})
