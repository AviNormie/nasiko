/**
 * Who reads budgets (plan feat-budget-burn B6; budgets.md §5): `me`, and in an edition with an org (EE) the role the
 * `budgetsOrgRole` slot reports, the units `homeOrgScope` lists for this viewer (the server already limits them: all for
 * an admin, a lead's subtrees), and whether the org lets its unit leads write (`unit_leads_write`, §7 Q4). OSS: the
 * superuser flag alone. The org reads share their callers' keys (the Access nav's context, Home's levels), so nothing
 * is read twice, and run only while `enabled` (a server with budgets). `pending` until every read it needs answered; a
 * failed role read is `error` (the page says so) and leaves the viewer at what `me` says, never wider.
 */
import { useQuery } from '@tanstack/react-query'
import { useSlots } from '@/app/edition-context'
import { meQuery } from '@/lib/api/auth'
import { budgetSettingsQuery } from './api'
import type { Viewer } from './scope'

const NO_QUERY = { queryKey: ['budgets', 'org', 'none'], queryFn: async () => null }

export interface BudgetsViewer {
  viewer: Viewer | null
  pending: boolean
  /** The org role couldn't be read: the viewer is `me`'s alone until Retry. */
  error: unknown
  retry: () => void
}

export function useBudgetsViewer(enabled = true): BudgetsViewer {
  const me = useQuery(meQuery)
  const slots = useSlots()
  const roleSlot = enabled ? slots.budgetsOrgRole : null
  const levelsSlot = slots.homeOrgScope
  const sub = me.data?.sub ?? ''
  // The Access nav's own key for the context; Home's own key (the account appended) for the units.
  const role = useQuery({ ...(roleSlot?.query ?? NO_QUERY), enabled: !!roleSlot && !!sub })
  const levels = useQuery({
    ...(levelsSlot?.levels.query ?? NO_QUERY),
    queryKey: [...(levelsSlot?.levels.query.queryKey ?? NO_QUERY.queryKey), sub],
    enabled: !!roleSlot && !!levelsSlot && !!sub,
  })
  const settings = useQuery({ ...budgetSettingsQuery, enabled: !!roleSlot && !!sub })
  const retry = () => {
    void role.refetch()
    if (levels.isError) void levels.refetch()
  }
  if (!me.data) return { viewer: null, pending: me.isPending, error: null, retry }
  const base: Viewer = { id: me.data.sub, superuser: me.data.is_superuser }
  if (!roleSlot) return { viewer: base, pending: false, error: null, retry }
  if (role.isPending || (levelsSlot && levels.isPending) || settings.isPending)
    return { viewer: null, pending: true, error: null, retry }
  if (role.isError) return { viewer: base, pending: false, error: role.error, retry }
  const r = role.data ? roleSlot.role(role.data) : null
  const units = levelsSlot && levels.data !== undefined ? levelsSlot.levels.list(levels.data) : []
  // The org context speaks for the account (it carries `is_superuser` too); `me` only when it didn't answer.
  const admin = r ? r.admin : base.superuser
  const leadsWrite = !!settings.data?.unit_leads_write
  return {
    viewer: {
      id: r?.id ?? base.id,
      superuser: admin,
      finance: !admin && !!r?.finance,
      units,
      // An admin writes every unit; a lead the units they may read (their subtrees) while the org allows it.
      writeUnits: new Set(admin || (leadsWrite && r?.leads.length) ? units.map((u) => u.id) : []),
    },
    pending: false,
    error: null,
    retry,
  }
}
