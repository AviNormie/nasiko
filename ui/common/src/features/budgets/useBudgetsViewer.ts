/**
 * Who reads /budgets (plan feat-budget-burn B6; budgets.md §5): `me`, and in an edition with an org (EE) the role the
 * `budgetsOrgRole` slot reports, the units `homeOrgScope` lists for this viewer (the server already limits them: all for
 * an admin, a lead's subtrees), and whether the org lets its unit leads write (`unit_leads_write`, §7 Q4). OSS: the
 * superuser flag alone. `pending` until every read it needs answered; a failed org read leaves the viewer at what `me`
 * says (never wider).
 */
import { useQuery } from '@tanstack/react-query'
import { useSlots } from '@/app/edition-context'
import { meQuery } from '@/lib/api/auth'
import { budgetSettingsQuery } from './api'
import type { Viewer } from './scope'

const NO_QUERY = { queryKey: ['budgets', 'org', 'none'], queryFn: async () => null }

export function useBudgetsViewer(): { viewer: Viewer | null; pending: boolean } {
  const me = useQuery(meQuery)
  const slots = useSlots()
  const roleSlot = slots.budgetsOrgRole
  const levelsSlot = slots.homeOrgScope
  const sub = me.data?.sub ?? ''
  // The viewer is in every key: a cached role or unit list never serves another account.
  const role = useQuery({
    ...(roleSlot?.query ?? NO_QUERY),
    queryKey: [...(roleSlot?.query.queryKey ?? NO_QUERY.queryKey), sub],
    enabled: !!roleSlot && !!sub,
  })
  const levels = useQuery({
    ...(levelsSlot?.levels.query ?? NO_QUERY),
    queryKey: [...(levelsSlot?.levels.query.queryKey ?? NO_QUERY.queryKey), sub],
    enabled: !!levelsSlot && !!sub,
  })
  const settings = useQuery({ ...budgetSettingsQuery, enabled: !!roleSlot && !!sub })
  if (!me.data) return { viewer: null, pending: me.isPending }
  const base: Viewer = { id: me.data.sub, superuser: me.data.is_superuser }
  if (!roleSlot) return { viewer: base, pending: false }
  if (role.isPending || (levelsSlot && levels.isPending) || settings.isPending)
    return { viewer: null, pending: true }
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
  }
}
