/**
 * Monitor's note while coding agents are being brought in: their spend is still arriving, so the page says so, with
 * the import's progress. The desktop app's own run (the card's Yes, find my agents), or in a browser a run that
 * `nasiko agents setup` reports to the server (re-read on focus, as the viewer comes back from the terminal). Only while
 * an import run is active: a background delivery of hook turns is the desktop sync bar's alone.
 */
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { copy as pageCopy } from '../copy'
import { SYNC_POLL_MS } from '../constants'
import { useDesktopState } from '../desktop'
import { useSyncRuns } from '../onboarding'
import { isActivePhase, shownPhase, type LocalRun } from '../runs'
import { desktopSync, syncLine } from '../syncStatus'

const copy = pageCopy.importNotice

const importing = (run: LocalRun | null | undefined) => !!run && isActivePhase(shownPhase(run))

export function ImportNotice() {
  const desktop = useDesktopState()
  const runs = useSyncRuns({
    enabled: desktop.isSuccess && !desktop.data,
    interval: (r) => (r?.some(importing) ? SYNC_POLL_MS : false),
  })
  // ponytail: one device's run in a browser (the first importing); per-device lines live on Harnesses' card.
  const source = desktop.data ?? { run: runs.data?.find(importing) ?? null, backlog: null }
  if (!importing(source.run)) return null
  const sync = desktopSync(source)
  return (
    // The sync bar's live region already speaks start and finish: this is a note, not a second announcement.
    <Alert role="note" data-testid="import-notice" className="p-3">
      <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p className="max-w-prose">{copy.body}</p>
        <Progress
          aria-label={copy.label}
          value={sync.value}
          aria-valuenow={sync.value ?? undefined}
          aria-valuetext={sync.value === null ? undefined : `${sync.value}%`}
          className={cn(
            'h-1 max-w-md motion-reduce:*:transition-none',
            sync.value === null && 'animate-pulse motion-reduce:animate-none',
          )}
        />
        <div className="flex flex-wrap items-center gap-x-3 text-xs">
          <span>{syncLine(sync)}</span>
          <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
            <Link to="/harnesses">{copy.details}</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
