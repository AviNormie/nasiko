/**
 * /budgets (plan feat-budget-burn F10, F12, B2): the scope's burn, top to bottom: header with the scope and period
 * switches and the coverage line, the sentence, the burn card, the strip. A server without budgets says so; the nav
 * item is hidden there (`_app`). Every read is the scope's own (§4: never a wider series filtered here).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Announcer } from '@/components/shared/announcer'
import { useAnnounce } from '@/components/shared/announce'
import { PageHeader } from '@/components/shared/page-header'
import { PageLoader } from '@/components/shared/page-loader'
import { Button } from '@/components/ui/button'
import { LinkButton } from '@/features/router/components/bits'
import { toast } from 'sonner'
import { PanelError, PanelSkeleton } from '@/components/shared/panel'
import { StateCard } from '@/components/shared/state-card'
import { useUsers } from '@/features/agents/api'
import { meQuery } from '@/lib/api/auth'
import { fmtMoney, fmtShortDay } from '@/lib/format'
import { useSetSearch } from '@/lib/search'
import { useReturnTick } from '@/lib/useReturnTick'
import {
  useAtRisk,
  useBreakdown,
  budgetV1Query,
  useBudgetV1,
  useBurn,
  useChanges,
  useScopeAlerts,
  useUnbudgeted,
  type ScopeRef,
} from './api'
import { capabilitiesQuery, mayHave, type Availability } from './availability'
import { figures, previewLine, projection, quarterOf, spikes, type BurnMode } from './burn'
import { rememberBurnMode, storedBurnMode } from './burnMode'
import { BurnCard } from './components/BurnCard'
import { BurnStrip } from './components/BurnStrip'
import { AtRisk } from './components/AtRisk'
import { BudgetSheet, type BudgetMode } from './components/BudgetSheet'
import { Contributors } from './components/Contributors'
import { RowActions } from './components/RowActions'
import { DayPanel } from './components/DayPanel'
import { ScopeAlerts } from './components/ScopeAlerts'
import { ShareStrip } from './components/ShareStrip'
import { Unbudgeted } from './components/Unbudgeted'
import { WhatChanged } from './components/WhatChanged'
import { WhatIfPanel } from './components/WhatIf'
import { ScopeSwitch } from './components/ScopeSwitch'
import { copy } from './copy'
import { canWrite, scopeWho, toSheetBudget, whoForBudget } from './editing'
import { resolveScope, scopeParam, scopeRef, type PageScope, type Viewer } from './scope'
import type { BudgetsSearch } from './search'
import { changesWindow, dimensionsFor, keyLabel, pickDimension, shareLine } from './causes'
import { burnSentence } from './sentence'
import { WHAT_IF_CLOSED, whatIfInputs, type WhatIfState } from './whatIf'
import type { Budget, Burn } from './types'

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
      caps={caps.data}
    />
  )
}

function Frame({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    // The page's one polite live region: previews and saves announce through it (F1 parity).
    <Announcer testId="budgets-announcer">
      <div className="mx-auto flex w-full max-w-page flex-col gap-4">
        <PageHeader title={copy.pageTitle} actions={actions} />
        {children}
      </div>
    </Announcer>
  )
}

function Page({
  search,
  viewer,
  caps,
}: {
  search: BudgetsSearch
  viewer: { id: string; superuser: boolean }
  caps: Availability
}) {
  const burnAvailable = mayHave(caps, 'burn')
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
          scopeRef={ref}
          kind={kind}
          quarterRead={quarterRead.data ?? null}
          mode={mode}
          onMode={setMode}
          search={search}
          setSearch={setSearch}
          caps={caps}
          viewer={viewer}
          pageScope={scope}
          onOwner={viewer.superuser ? (id) => setScope({ kind: 'owner', id }) : null}
        />
      )}
    </Frame>
  )
}

function Body({
  burn,
  scopeRef: ref,
  kind,
  quarterRead,
  mode,
  onMode,
  search,
  setSearch,
  caps,
  viewer,
  pageScope,
  onOwner,
}: {
  burn: Burn
  scopeRef: ScopeRef
  kind: 'month' | 'quarter'
  quarterRead: Burn | null
  mode: BurnMode
  onMode: (m: BurnMode) => void
  search: BudgetsSearch
  setSearch: (patch: Partial<BudgetsSearch>, opts?: { replace?: boolean }) => void
  caps: Availability
  viewer: Viewer
  pageScope: PageScope
  onOwner: ((id: string) => void) | null
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

  // What's causing it (F3): the bars by contributor, a picked contributor's share, What changed, the picked day.
  const dimensions = dimensionsFor(ref.scope)
  const by = pickDimension(ref.scope, search.by)
  const breakdown = useBreakdown(ref, { by, period: kind, top: 5 }, mayHave(caps, 'breakdown'))
  const picked = search.contributor ?? null
  const contributor = useBurn(
    ref,
    { period: kind, contributor: picked ? { by, key: picked } : null },
    !!picked && mayHave(caps, 'contributor'),
  )
  const shareRead = picked && contributor.data?.contributor ? contributor.data : null

  // What-if (F6): one preview at a time, so starting it clears a picked contributor and picking one closes it (4A).
  const announce = useAnnounce()
  const [whatIfState, setWhatIfState] = useState<WhatIfState>(WHAT_IF_CLOSED)
  const preview = whatIfInputs(burn, whatIfState)
  const lastDay = burn.resets_at ? fmtShortDay(Date.parse(burn.resets_at) - 86_400_000) : ''
  const onWhatIf = (next: WhatIfState) => {
    setWhatIfState(next)
    const inputs = whatIfInputs(burn, next)
    if (inputs && picked) setSearch({ contributor: undefined }, { replace: true })
    const p = projection(burn)
    if (inputs && p)
      announce(
        copy.whatIfAnnounce(
          fmtMoney(burn.used_usd + p.pace * (1 + inputs.paceChange) * p.daysLeft),
          lastDay,
        ),
      )
  }
  const previewPoints = preview
    ? previewLine(
        burn,
        burn.budget ? mode : 'up',
        (projection(burn)?.pace ?? 0) * (1 + preview.paceChange),
        preview.limit ?? undefined,
      )
    : null

  // At risk, Unbudgeted and the alerts (F5, F7): the scope's own lists.
  const atRisk = useAtRisk(ref, mayHave(caps, 'at_risk'))
  const unbudgeted = useUnbudgeted(ref, kind, mayHave(caps, 'unbudgeted'))
  const alerts = useScopeAlerts(ref, mayHave(caps, 'budgets'))
  const own = useBudgetV1(burn.budget?.id ?? null, true)
  const limitsInside =
    own.data?.limits_inside_usd != null && own.data.limits_inside_count
      ? { usd: own.data.limits_inside_usd, count: own.data.limits_inside_count }
      : null
  const pending = (q: { isPending: boolean; fetchStatus: string }) =>
    q.isPending && q.fetchStatus !== 'idle'

  // Editing in place (F10): the router's sheet, opened on this page and closing back to it.
  const qc = useQueryClient()
  const [editor, setEditor] = useState<BudgetMode | null>(null)
  // The record is read fresh on the click (its `updated_at` guards the PUT), never from a stale list.
  const openEdit = async (budgetId: string, label: string, limit?: number) => {
    try {
      const b = await qc.fetchQuery({ ...budgetV1Query(budgetId), staleTime: 0 })
      setEditor({
        kind: 'edit',
        budget: toSheetBudget(b),
        who: whoForBudget(b, label, viewer) ?? undefined,
        limit,
      })
    } catch {
      toast.error(copy.editLoadFailed)
    }
  }
  const scopeOwner = pageScope.kind === 'fleet' ? null : ref.id
  const writable = canWrite(ref.scope, scopeOwner, viewer)
  const editOwn = (limit?: number) =>
    burn.budget
      ? void openEdit(burn.budget.id, burn.label, limit)
      : setEditor({ kind: 'create', target: scopeWho(pageScope, burn.label), limit })
  const week = changesWindow(burn)
  const changes = useChanges(ref, week ? { by, ...week } : null, mayHave(caps, 'changes'))
  const noWeek = !week || figures(burn).week.sameDaysLastWeek === null
  const slug = burn.label.replace(/[^\w-]+/g, '-').toLowerCase()
  const date = burn.as_of.slice(0, 10)
  const pickDay = (day: string) => setSearch({ day })
  return (
    <>
      <p className="-mt-3 text-xs text-muted-foreground">{coverage}</p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lead">{sentence}</h2>
        {writable ? (
          <Button size="sm" variant={burn.budget ? 'outline' : 'default'} onClick={() => editOwn()}>
            {burn.budget
              ? copy.editBudget
              : pageScope.kind === 'fleet'
                ? copy.setFleetBudget
                : pageScope.kind === 'yours'
                  ? copy.setYourBudget
                  : copy.setBudget}
          </Button>
        ) : null}
      </div>
      <BurnCard
        burn={burn}
        mode={mode}
        onMode={onMode}
        sentence={sentence}
        domainEnd={domainEnd}
        pickedDay={search.day ?? null}
        onPickDay={pickDay}
        fileName={`budget-burn-${slug}-${date}.csv`}
        breakdown={breakdown.data}
        share={
          shareRead?.contributor
            ? {
                name: keyLabel({ label: shareRead.contributor.label, redacted: false }),
                line: shareLine(shareRead),
              }
            : null
        }
        onClearShare={() => setSearch({ contributor: undefined }, { replace: true })}
        preview={previewPoints}
        whatIf={
          <WhatIfPanel
            burn={burn}
            state={whatIfState}
            onChange={onWhatIf}
            footer={
              writable
                ? (limit) => (
                    <Button size="sm" variant="outline" onClick={() => editOwn(limit)}>
                      {copy.useThisLimit}
                    </Button>
                  )
                : undefined
            }
          />
        }
        footer={
          <Contributors
            breakdown={breakdown.data}
            error={breakdown.error}
            pending={breakdown.isPending && breakdown.fetchStatus !== 'idle'}
            onRetry={() => void breakdown.refetch()}
            by={by}
            dimensions={dimensions}
            onBy={(d) => setSearch({ by: d, contributor: undefined }, { replace: true })}
            picked={picked}
            onPick={(key) => {
              setWhatIfState((w) => (w.open ? { ...w, limit: '', pace: 0 } : w))
              setSearch({ contributor: key === picked ? undefined : key })
            }}
            fileName={`budget-contributors-${slug}-${date}.csv`}
          />
        }
      />
      {shareRead ? (
        <ShareStrip scope={burn} read={shareRead} agentId={by === 'agent' ? picked : null} />
      ) : (
        <BurnStrip burn={burn} kind={kind} quarterRead={quarterRead} />
      )}
      <WhatChanged
        spikes={spikes(burn).filter((x) => x.date >= burn.period_start.slice(0, 10))}
        changes={changes.data}
        error={changes.error}
        pending={changes.isPending && changes.fetchStatus !== 'idle'}
        noWeek={noWeek}
        onRetry={() => void changes.refetch()}
        by={by}
        onPickDay={pickDay}
        onOwner={onOwner}
      />
      <AtRisk
        rows={atRisk.data}
        error={atRisk.error}
        pending={pending(atRisk)}
        onRetry={() => void atRisk.refetch()}
        resetsAt={burn.resets_at}
        limitsInside={limitsInside}
        onOwner={onOwner}
        actions={(r) =>
          canWrite(r.scope, r.scope === 'owner' ? r.target_id : r.owner_id, viewer) ? (
            <RowActions
              name={r.label}
              agentId={r.scope === 'agent' ? r.target_id : null}
              onEdit={() => void openEdit(r.budget_id, r.label)}
            />
          ) : null
        }
      />
      <Unbudgeted
        rows={unbudgeted.data}
        error={unbudgeted.error}
        pending={pending(unbudgeted)}
        onRetry={() => void unbudgeted.refetch()}
        onOwner={onOwner}
        actions={(r) =>
          canWrite('agent', r.owner_id, viewer) ? (
            <LinkButton
              aria-label={copy.setBudgetFor(r.label)}
              onClick={() =>
                setEditor({
                  kind: 'create',
                  target: { kind: 'agent', id: r.agent_id, name: r.label },
                })
              }
            >
              {copy.setBudget}
            </LinkButton>
          ) : null
        }
      />
      <ScopeAlerts
        alerts={alerts.data}
        error={alerts.error}
        pending={pending(alerts)}
        onRetry={() => void alerts.refetch()}
        actions={(a) =>
          // Units and sessions aren't edited here (B5, B6).
          (viewer.superuser || pageScope.kind === 'yours') &&
          a.scope !== 'unit' &&
          a.scope !== 'session' ? (
            <LinkButton
              className="text-xs"
              aria-label={copy.viewBudgetFor(a.label)}
              onClick={() => void openEdit(a.budget_id, a.label)}
            >
              {copy.viewBudget}
            </LinkButton>
          ) : null
        }
      />
      <BudgetSheet
        mode={editor}
        budgets={NO_BUDGETS}
        agents={NO_AGENTS}
        agentName={noName}
        resetsAt={burn.resets_at ?? burn.as_of}
        onClose={() => setEditor(null)}
      />
      <DayPanel
        day={search.day ?? null}
        amount={burn.daily.find((d) => d.date === search.day)?.cost_usd ?? null}
        scope={ref}
        by={by}
        enabled={{
          breakdown: mayHave(caps, 'breakdown'),
          hours: mayHave(caps, 'hours'),
          traces: mayHave(caps, 'traces'),
        }}
        onClose={() => setSearch({ day: undefined })}
      />
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

const NO_BUDGETS: readonly Budget[] = []
const NO_AGENTS: readonly { id: string; name: string }[] = []
const noName = () => undefined
