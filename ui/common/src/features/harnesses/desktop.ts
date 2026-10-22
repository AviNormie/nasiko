/**
 * The desktop app's own coding-agent onboarding (contract v3): the Nasiko desktop app serves the web app and answers
 * `/__nasiko/coding-agents/*` itself, same origin, so consent and progress never go through the server.
 *
 *   GET  /__nasiko/coding-agents/state    {desktop: true, consent, signed_in, run}
 *   POST /__nasiko/coding-agents/start    consent granted, discovery + import start   → 202 the state
 *   POST /__nasiko/coding-agents/decline  consent declined                            → 200 the state
 *   POST /__nasiko/coding-agents/retry    resend refused turns (or restart a failed run) → 202 the state
 *
 * In a browser the same path is the server's 404 or the SPA's index.html, so only a 200 JSON body that passes the
 * schema with `desktop: true` means "this is the desktop app"; anything else, a network error included, is a browser.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/lib/api/client'
import { DESKTOP_STATE_POLL_MS } from './constants'
import { isActivePhase, localRunSchema, shownPhase } from './runs'

const BASE = '/__nasiko/coding-agents'

export const desktopStateSchema = z.looseObject({
  desktop: z.literal(true),
  consent: z.enum(['unasked', 'granted', 'declined']),
  signed_in: z.boolean(),
  run: localRunSchema.nullable(),
})
export type DesktopState = z.infer<typeof desktopStateSchema>
export type DesktopAction = 'start' | 'decline' | 'retry'

export const desktopKeys = { state: ['harnesses', 'onboarding', 'desktop'] as const }

/** The desktop app's state, or null in a browser. Every failure (404, the SPA's HTML, a body that isn't the desktop's,
 *  a network error) means "not the desktop"; only a cancelled read is rethrown. */
async function probeDesktop(signal: AbortSignal): Promise<DesktopState | null> {
  try {
    const parsed = desktopStateSchema.safeParse(
      await apiFetch<unknown>(`${BASE}/state`, { signal }),
    )
    return parsed.success ? parsed.data : null
  } catch (err) {
    if (signal.aborted) throw err
    return null
  }
}

/** The desktop probe, refreshed every `DESKTOP_STATE_POLL_MS` while a run is active (a local call, no network). */
export function useDesktopState(enabled = true) {
  return useQuery({
    queryKey: desktopKeys.state,
    queryFn: ({ signal }) => probeDesktop(signal),
    enabled,
    // A probe that never fails (a browser answers null), so there is nothing to retry.
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    refetchInterval: (q) => {
      const run = q.state.data?.run
      return run && isActivePhase(shownPhase(run)) ? DESKTOP_STATE_POLL_MS : false
    },
  })
}

/** One of the desktop's POSTs. Its answer is the new state, shown at once; a mutation, never retried. */
export function useDesktopAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (action: DesktopAction) =>
      desktopStateSchema.parse(
        await apiFetch<DesktopState>(`${BASE}/${action}`, {
          method: 'POST',
          schema: desktopStateSchema,
        }),
      ),
    onSuccess: (state) => qc.setQueryData(desktopKeys.state, state),
  })
}
