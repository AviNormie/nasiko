/**
 * The budgets golden scenario as SQL (docs/requirements/budgets.md §14.8, plan feat-budget-burn #45): what
 * `seed:live` writes so a server that has built budgets answers the same world as the UI's `budgets-golden` mock.
 *
 * A server's own watermarks and one-time instants (`budget_watermarks`, `budget_meta`) are only written when absent
 * (a fresh contract database), never overwritten or removed: they aren't the seed's rows.
 *
 * Every statement sits inside one guarded block: it runs only when the server has the contract's tables
 * (`budget_calls` first), so on today's servers the seed only says it skipped them. Rows use ids `5eed0017-*` (users
 * get `seed-budget-*` names, no password: they can't sign in) and `--reset` removes them the same way.
 *
 * Import-free apart from the scenario (Node runs it with type stripping).
 */
import { budgetScenario, SCENARIO_IDS } from '../../common/src/mocks/seed-budgets.ts'

const ADMIN = '00000000-0000-4000-8000-00000000ad00'
const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)
const ts = (t: number | null) =>
  t === null ? 'NULL' : `${q(new Date(t).toISOString())}::timestamptz`
const arr = (xs: number[]) => `ARRAY[${xs.join(',')}]::int[]`
/** The scenario's admin is the server's superuser, read in the block. */
const who = (id: string) => (id === ADMIN ? 'admin_id' : `${q(id)}::uuid`)
const guard = (body: string[]) => `DO $$
DECLARE admin_id uuid;
BEGIN
  IF to_regclass('public.budget_calls') IS NULL THEN
    RAISE NOTICE 'nasiko-ui-lab seed: this server has no budget tables (budgets.md P-1); the budgets scenario is skipped';
    RETURN;
  END IF;
  admin_id := (SELECT id FROM users WHERE is_superuser AND deleted_at IS NULL ORDER BY created_at LIMIT 1);
${body.map((s) => `  ${s.replace(/\n/g, '\n  ')}`).join('\n')}
END $$;`

/** Removes the scenario's rows (also run before inserting, so a re-seed re-anchors). */
export const BUDGET_RESET: string[] = [
  `DO $$ BEGIN
  IF to_regclass('public.budget_calls') IS NULL THEN RETURN; END IF;
  DELETE FROM budget_versions WHERE budget_id::text LIKE '5eed0017-%';
  DELETE FROM budgets WHERE id::text LIKE '5eed0017-%';
  DELETE FROM budget_calls WHERE call_id::text LIKE '5eed0017-%';
  IF to_regclass('public.org_unit_member_history') IS NOT NULL THEN
    DELETE FROM org_unit_member_history WHERE unit_id::text LIKE '5eed0017-%';
    DELETE FROM org_unit_parent_history WHERE unit_id::text LIKE '5eed0017-%';
    DELETE FROM org_unit_members WHERE unit_id::text LIKE '5eed0017-%';
    DELETE FROM org_units WHERE id::text LIKE '5eed0017-%';
  END IF;
  DELETE FROM session_traces WHERE session_id LIKE '5eed0017-%';
  DELETE FROM chat_sessions WHERE session_id LIKE '5eed0017-%';
  DELETE FROM token_usage WHERE request_id LIKE '5eed0017-%';
  DELETE FROM agents WHERE id::text LIKE '5eed0017-%';
  DELETE FROM users WHERE id::text LIKE '5eed0017-%';
END $$;`,
]

/** The scenario's rows with every time shifted so its anchor is `anchor` (budgets.md §14.8: the seeding hour). */
export function budgetSeedSql(anchor: number): string[] {
  const sc = budgetScenario(anchor, ADMIN)
  const body: string[] = []
  body.push(
    `INSERT INTO users (id, username, email, display_name, role) VALUES
${sc.users
  .filter((u) => u.role === 'member')
  .map(
    (u) =>
      `(${who(u.id)}, ${q(`seed-budget-${u.name.toLowerCase()}`)}, ${q(`seed-budget-${u.name.toLowerCase()}@example.invalid`)}, ${q(u.name)}, 'member')`,
  )
  .join(',\n')};`,
    `INSERT INTO agents (id, name, display_name, owner_id, description, tags) VALUES
${sc.agents
  .map(
    (a) =>
      `(${q(a.id)}::uuid, ${q(`seed-budget-${a.name.toLowerCase().replace(/ /g, '-')}`)}, ${q(a.name)}, ${who(a.owner_id)}, 'Seeded by nasiko-ui-lab (budgets scenario)', ${a.harness ? "ARRAY['coding-agent']" : 'ARRAY[]::text[]'})`,
  )
  .join(',\n')};`,
    ...sc.sessions.map(
      (s) =>
        `INSERT INTO chat_sessions (session_id, user_id, agent_id, title, created_at, updated_at) VALUES (${q(s.id)}, ${who(s.user_id)}, ${q(s.agent_id)}, ${q(s.title)}, ${ts(s.started_at)}, ${ts(s.ended_at)});`,
    ),
    `INSERT INTO session_traces (session_id, trace_id, agent_id, created_at) VALUES
${sc.calls
  .filter((c) => c.chat_session_id && c.flow_id)
  .map((c) => `(${q(c.chat_session_id)}, ${q(c.flow_id)}, ${q(c.agent_id)}, ${ts(c.at)})`)
  .join(',\n')};`,
    // The router's rows: request_id is the call id (P-1), metadata.source tells them from coding-agent rows.
    `INSERT INTO token_usage (user_id, agent_id, operation_type, request_id, session_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, metadata, created_at) VALUES
${sc.calls
  .filter((c) => c.source === 'routed')
  .map((c) => {
    const [provider, model] = c.model.split('/')
    return `(${who(c.billed_user_id!)}, ${q(c.agent_id)}::uuid, 'chat', ${q(c.call_id)}, ${q(c.flow_id)}, ${q(provider!)}, ${q(model!)}, ${c.input_tokens}, ${c.output_tokens}, ${c.input_tokens + c.output_tokens}, ${c.cost_usd ?? 'NULL'}, '{"key_source": "platform", "source": "router"}'::jsonb, ${ts(c.at)})`
  })
  .join(',\n')};`,
    `INSERT INTO budget_calls (call_id, at, source, agent_id, billed_user_id, flow_id, chat_session_id, turn_id, provider, model, operation, input_tokens, output_tokens, cost_usd, routed) VALUES
${sc.calls
  .map((c) => {
    const [provider, model] = c.model.split('/')
    return `(${q(c.call_id)}::uuid, ${ts(c.at)}, ${q(c.source)}, ${c.agent_id ? `${q(c.agent_id)}::uuid` : 'NULL'}, ${c.billed_user_id ? who(c.billed_user_id) : 'NULL'}, ${q(c.flow_id)}, ${q(c.chat_session_id)}, ${q(c.turn_id)}, ${q(provider!)}, ${q(model!)}, ${q(c.operation)}, ${c.input_tokens}, ${c.output_tokens}, ${c.cost_usd ?? 'NULL'}, ${c.routed})`
  })
  .join(',\n')};`,
    `INSERT INTO budgets (id, scope, agent_id, unit_id, session_id, owner_id, created_at, updated_at, next_period, next_period_from, next_period_set_by, deleted_at) VALUES
${sc.budgets
  .map(
    (b) =>
      `(${q(b.id)}::uuid, ${q(b.scope)}, ${b.agent_id ? `${q(b.agent_id)}::uuid` : 'NULL'}, ${b.unit_id ? `${q(b.unit_id)}::uuid` : 'NULL'}, ${q(b.session_id)}, ${b.owner_id ? who(b.owner_id) : 'NULL'}, ${ts(b.created_at)}, ${ts(b.versions.at(-1)!.effective_from)}, NULL, NULL, NULL, NULL)`,
  )
  .join(',\n')};`,
    `INSERT INTO budget_versions (budget_id, version, effective_from, set_by, period, limit_usd, thresholds, forecast_thresholds, action) VALUES
${sc.budgets
  .flatMap((b) =>
    b.versions.map(
      (v) =>
        `(${q(b.id)}::uuid, ${v.version}, ${ts(v.effective_from)}, ${who(v.set_by)}, ${q(v.period)}, ${v.limit_usd}, ${arr(v.thresholds)}, ${arr(v.forecast_thresholds)}, ${q(v.action)})`,
    ),
  )
  .join(',\n')};`,
    `INSERT INTO budget_meta (key, value) VALUES ('exact_dedupe_from', ${ts(sc.meta.exact_dedupe_from)}), ('membership_history_from', ${ts(sc.meta.membership_history_from)})
ON CONFLICT (key) DO NOTHING;`,
    `INSERT INTO budget_watermarks (source, complete_to) VALUES ('routed', ${ts(anchor)}), ('traced', ${ts(anchor)}), ('harness_estimate', ${ts(anchor)})
ON CONFLICT (source) DO NOTHING;`,
    // EE: units, then membership and ancestry history (P-4), when this server has them.
    `IF to_regclass('public.org_unit_member_history') IS NOT NULL THEN
  INSERT INTO org_units (id, name, source) VALUES
${sc.units.map((u) => `    (${q(u.id)}::uuid, ${q(u.name)}, 'manual')`).join(',\n')};
  INSERT INTO org_unit_members (user_id, unit_id, source)
    VALUES ${sc.members
      .filter((m) => m.to === null)
      .map((m) => `(${who(m.user_id)}, ${q(m.unit_id)}::uuid, 'manual')`)
      .join(', ')};
  INSERT INTO org_unit_member_history (unit_id, user_id, valid_from, valid_to)
    VALUES ${sc.members.map((m) => `(${q(m.unit_id)}::uuid, ${who(m.user_id)}, ${ts(m.from)}, ${ts(m.to)})`).join(', ')};
  INSERT INTO org_unit_parent_history (unit_id, parent_id, valid_from, valid_to)
    VALUES ${sc.parents.map((p) => `(${q(p.unit_id)}::uuid, ${p.parent_id ? `${q(p.parent_id)}::uuid` : 'NULL'}, ${ts(p.from)}, ${ts(p.to)})`).join(', ')};
END IF;`,
  )
  return [
    ...BUDGET_RESET,
    guard(body),
    `-- budgets: the golden scenario anchored at ${new Date(anchor).toISOString()} (${sc.calls.length} calls, ${sc.budgets.length} budgets; dedupe call ${SCENARIO_IDS.dedupeCall})`,
  ]
}
