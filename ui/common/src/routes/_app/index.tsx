import { createFileRoute } from '@tanstack/react-router'
import { useGuide, useGuideState } from '@/features/onboarding/api'
import { GuideHost } from '@/features/onboarding/GuideHost'
import { HomePage } from '@/features/home/HomePage'
import { homeSearchSchema, type HomeSearch } from '@/features/home/search'
import { useSetSearch } from '@/lib/search'

export const Route = createFileRoute('/_app/')({
  validateSearch: homeSearchSchema,
  component: OverviewRoute,
})

function OverviewRoute() {
  const setSearch = useSetSearch<HomeSearch>(Route.fullPath, true)
  const search = Route.useSearch()
  const { due } = useGuide()
  const state = useGuideState()
  // A first-time user gets the guide instead of the home (spec §2); skipping or finishing shows it.
  const firstRun = due || (state.open && state.firstRun)
  return (
    <>
      {firstRun ? null : <HomePage search={search} setSearch={setSearch} />}
      <GuideHost />
    </>
  )
}
