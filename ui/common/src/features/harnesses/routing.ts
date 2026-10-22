/**
 * LLM routing for the desktop app's coding agents: the CLI's `nasiko connect claude|codex|opencode [--config <name>]`
 * from the Coding harnesses page (`ui/desktop-tauri` `coding_agents/routing`). Opt-in, one harness at a time. Only the
 * desktop app answers these paths, same origin, as for its onboarding (desktop.ts):
 *
 *   GET  /__nasiko/coding-agents/routing             {harnesses: [RoutedHarness]}
 *   POST /__nasiko/coding-agents/routing/connect     {agent, config}  config: an LLM config id, or null for the
 *                                                     user's default → {harness, provider, model, notes}
 *   POST /__nasiko/coding-agents/routing/disconnect  {agent}          → {harness, notes}
 *
 * Connecting a harness the CLI connected takes it over; connecting one already connected reconnects it with the new
 * config. A refusal is a 422 `{message}`; 409 means no server is signed in in the app.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { routerKeys } from '@/features/router/api'
import type { AgentRouting, LlmConfig } from '@/features/router/types'
import { apiFetch } from '@/lib/api/client'
import { ROUTING_CHANGE_TIMEOUT_MS } from './constants'

const BASE = '/__nasiko/coding-agents/routing'

const routedHarnessSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  detected: z.boolean(),
  connected_by: z.enum(['desktop', 'cli']).nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  server_url: z.string().nullable(),
  mcp: z.boolean(),
  changed: z.boolean(),
})
export type RoutedHarness = z.infer<typeof routedHarnessSchema>

const routingSchema = z.looseObject({ harnesses: z.array(routedHarnessSchema) })

const changedSchema = z.looseObject({
  harness: routedHarnessSchema,
  provider: z.string().nullish(),
  model: z.string().nullish(),
  notes: z.array(z.string()),
})
export type RoutingChanged = z.infer<typeof changedSchema>

export type RoutingChange =
  | { action: 'connect'; agent: string; config: string | null }
  | { action: 'disconnect'; agent: string }

export const routingKeys = { desktop: ['harnesses', 'routing', 'desktop'] as const }

/** The desktop's routable harnesses. Only asked for once the desktop probe said this is the app. */
export function useDesktopRouting(enabled: boolean) {
  return useQuery({
    queryKey: routingKeys.desktop,
    queryFn: async ({ signal }) =>
      (await apiFetch<z.infer<typeof routingSchema>>(BASE, { signal, schema: routingSchema }))
        .harnesses,
    enabled,
    // A local call: a failure is the app's, and retrying it changes nothing.
    retry: false,
    // The CLI can connect or disconnect a harness while the page is open.
    refetchOnWindowFocus: true,
  })
}

/** Connects or disconnects one harness. Its answer replaces that row; the row's server-side routing is re-read. */
export function useRoutingChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (change: RoutingChange) =>
      apiFetch<RoutingChanged>(`${BASE}/${change.action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          change.action === 'connect'
            ? { agent: change.agent, config: change.config }
            : { agent: change.agent },
        ),
        // A connect can make a real provider round trip (Codex's preflight) on top of its control-plane calls.
        timeout: ROUTING_CHANGE_TIMEOUT_MS,
        schema: changedSchema,
      }),
    onSuccess: (changed) => {
      qc.setQueryData<RoutedHarness[]>(routingKeys.desktop, (rows) =>
        rows?.map((row) => (row.id === changed.harness.id ? changed.harness : row)),
      )
      if (changed.harness.agent_id)
        void qc.invalidateQueries({ queryKey: routerKeys.agent(changed.harness.agent_id) })
    },
  })
}

// ─── Pure rules ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The picker's value for "follow my default config". */
export const DEFAULT_CHOICE = '__default__'

/** What the picker starts on: the config attached to the harness's row, else the default. */
export function initialChoice(routing: AgentRouting | undefined): string {
  return routing?.source === 'attached' && routing.llm_config_id
    ? routing.llm_config_id
    : DEFAULT_CHOICE
}

/** The connect request's `config` for a picker value. */
export const configForChoice = (choice: string): string | null =>
  choice === DEFAULT_CHOICE ? null : choice

/** The user's default config, if they have one. */
export const defaultConfig = (configs: readonly LlmConfig[]): LlmConfig | undefined =>
  configs.find((c) => c.is_default)

/** A config's model, as the router would pick it: its own, else its tiers' (`llm-router` resolver order). */
export function configModel(
  config: Pick<LlmConfig, 'model' | 'tier2_model' | 'tier1_model' | 'tier3_model'>,
) {
  return config.model || config.tier2_model || config.tier1_model || config.tier3_model || null
}

/** What the row's button does: connect it, reconnect it with another config, or nothing new. */
export function connectAction(
  harness: RoutedHarness,
  choice: string,
  routing: AgentRouting | undefined,
): 'connect' | 'apply' | 'take-over' | null {
  if (!harness.detected) return null
  if (harness.connected_by === null) return 'connect'
  if (harness.connected_by === 'cli') return 'take-over'
  // Connected here: only a different choice (or settings changed since) is worth a reconnect.
  return harness.changed || choice !== initialChoice(routing) ? 'apply' : null
}
