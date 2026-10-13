/**
 * /budgets (plan feat-budget-burn F10, F12, B2): the scope's burn, top to bottom: header with the scope and period
 * switches and the coverage line, the sentence, the burn card, the strip. A server without budgets says so; the nav
 * item is hidden there (`_app`). Every read is the scope's own (§4: never a wider series filtered here).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { PageHeader } from '@/components/shared/page-header'
import { PageLoader } from '@/components/shared/page-loader'
import { PanelError, PanelSkeleton } from '@/components/shared/panel'
import { StateCard } from '@/components/shared/state-card'
import { useUsers } from '@/features/agents/api'
import { meQuery } from '@/lib/api/auth'
import { useSetSearch } from '@/lib/search'
import { useReturnTick } from '@/lib/useReturnTick'
import { useBurn } from './api'
import { capabilitiesQuery, mayHave } from './availability'
import { quarterOf, type BurnMode } from './burn'
import { rememberBurnMode, storedBurnMode } from './burnMode'
import { BurnCard } from './components/BurnCard'
import { BurnStrip } from './components/BurnStrip'
import { ScopeSwitch } from './components/ScopeSwitch'
import { copy } from './copy'
import { resolveScope, scopeParam, scopeRef, type PageScope } from './scope'
import type { BudgetsSearch } from './search'
import { burnSentence } from './sentence'
import type { Burn } from './types'

export function BudgetsPage({ search }: { search: BudgetsSearch }) {
  const me = useQuery(meQuery)
  const caps = useQuery(capabilitiesQuery)
  if (me.isPending || caps.isPending) return <PageLoader />
  if (caps.isError)
    return (
      <Frame>
        <PanelError error={caps.error} onRetry={() => void caps.refetch()} what={copy.pageFailed} />
      </Frame>
    )
  if (caps.data.kind === 'absent')
    return (
      <Frame>
        <StateCard title={copy.pageMissing}>{copy.pageMissingBody}</StateCard>
      </Frame>
    )
  if (!me.data) return <PageLoader />
  return (
    <Page
      search={search}
      viewer={{ id: me.data.sub, superuser: me.data.is_superuser }}
      burnAvailable={mayHave(caps.data, 'burn')}
    />
  )
}

function Frame({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-page flex-col gap-4">
      <PageHeader title={copy.pageTitle} actions={actions} />
      {children}
    </div>
  )
}

function Page({
  search,
  viewer,
  burnAvailable,
}: {
  search: BudgetsSearch
  viewer: { id: string; superuser: boolean }
  burnAvailable: boolean
}) {
  const setSearch = useSetSearch<BudgetsSearch>('/budgets')
  const qc = useQueryClient()
  // No polling, no focus refetch: coming back after a minute re-reads the page's budget reads (plan §5).
  const tick = useReturnTick()
  useEffect(() => {
    if (tick) void qc.invalidateQueries({ queryKey: ['budgets', 'v1'] })
  }, [tick, qc])

  const scope = resolveScope(search.scope, viewer)
  const ref = scopeRef(scope, viewer)
  const kind = search.period
  const burn = useBurn(ref, { period: kind }, burnAvailable)
  const b = burn.data
  // Month budgets show a quarter-end figure: the same scope read from the quarter's first day.
  const quarterRead = useBurn(
    ref,
    { period: 'quarter' },
    burnAvailable && kind === 'month' && !!b?.budget && b.period === 'month',
  )
  const users = useUsers(viewer.superuser)
  const [stored, setStored] = useState(() => storedBurnMode(viewer.id))
  const mode: BurnMode = search.burn ?? stored ?? 'down'
  const setMode = (m: BurnMode) => {
    rememberBurnMode(viewer.id, m)
    setStored(m)
    setSearch({ burn: m }, { replace: true })
  }
  const setScope = (s: PageScope) =>
    setSearch(
      { scope: scopeParam(s), day: undefined, contributor: undefined, by: undefined },
      { replace: true },
    )

  return (
    <Frame
      actions={
        <ScopeSwitch
          scope={scope}
          superuser={viewer.superuser}
          owners={ownerOptions(users.data, viewer.id, scope, b)}
          onScope={setScope}
          period={kind}
          onPeriod={(p) => setSearch({ period: p, day: undefined }, { replace: true })}
        />
      }
    >
      {!burnAvailable ? (
        <StateCard title={copy.pageMissing}>{copy.pageMissingBody}</StateCard>
      ) : burn.isPending ? (
        <div aria-busy className="space-y-4">
          <PanelSkeleton height={24} />
          <PanelSkeleton height={340} />
        </div>
      ) : burn.isError ? (
        <PanelError error={burn.error} onRetry={() => void burn.refetch()} what={copy.burnFailed} />
      ) : (
        <Body
          burn={burn.data}
          kind={kind}
          quarterRead={quarterRead.data ?? null}
          mode={mode}
          onMode={setMode}
          pickedDay={search.day ?? null}
          onPickDay={(day) => setSearch({ day })}
        />
      )}
    </Frame>
  )
}

function Body({
  burn,
  kind,
  quarterRead,
  mode,
  onMode,
  pickedDay,
  onPickDay,
}: {
  burn: Burn
  kind: 'month' | 'quarter'
  quarterRead: Burn | null
  mode: BurnMode
  onMode: (m: BurnMode) => void
  pickedDay: string | null
  onPickDay: (day: string) => void
}) {
  const sentence = burnSentence(burn, kind)
  const coverage = burn.budget
    ? burn.covers === 'all_priced'
      ? copy.coverageAll
      : copy.coverageRouted(burn.budget.action === 'stop')
    : copy.coverageNone(burn.covers === 'all_priced')
  // A month budget viewed by quarter draws the whole quarter (its months as steps, F1 Period).
  const domainEnd =
    kind === 'quarter' && burn.period === 'month'
      ? quarterOf(Date.parse(burn.as_of)).end
      : undefined
  return (
    <>
      <p className="-mt-3 text-xs text-muted-foreground">{coverage}</p>
      <h2 className="text-lead">{sentence}</h2>
      <BurnCard
        burn={burn}
        mode={mode}
        onMode={onMode}
        sentence={sentence}
        domainEnd={domainEnd}
        pickedDay={pickedDay}
        onPickDay={onPickDay}
        fileName={`budget-burn-${burn.label.replace(/[^\w-]+/g, '-').toLowerCase()}-${burn.as_of.slice(0, 10)}.csv`}
      />
      <BurnStrip burn={burn} kind={kind} quarterRead={quarterRead} />
    </>
  )
}

/**
 * The owner picker's choices: other users by name, plus the shown owner when the user list doesn't have them (a link
 * to an owner outside the first page, or a server without /api/users), named by the read itself.
 */
function ownerOptions(
  names: ReadonlyMap<string, string> | undefined,
  self: string,
  scope: PageScope,
  shown: Burn | undefined,
) {
  const out = [...(names ?? new Map<string, string>())]
    .filter(([id]) => id !== self)
    .map(([id, name]) => ({ id, name }))
  if (scope.kind === 'owner' && !out.some((o) => o.id === scope.id) && shown?.scope === 'owner')
    out.unshift({ id: scope.id, name: shown.label })
  return out
}
