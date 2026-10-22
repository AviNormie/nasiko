/**
 * The desktop app's sync bar (syncStatus.ts): a slim strip under the top bar on every page while coding-agent data
 * syncs, with one line, a bar and a Details link to Harnesses. Nothing in a browser or while idle. Its polite live
 * region speaks only when syncing starts and when it ends, never on each tick.
 */
import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useAnnounce } from '@/components/shared/announce'
import { Announcer } from '@/components/shared/announcer'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { copy as pageCopy } from '../copy'
import { useDesktopState } from '../desktop'
import { desktopSync, syncLine, type DesktopSync } from '../syncStatus'

const copy = pageCopy.syncBar

export function SyncBar() {
  const { data } = useDesktopState()
  // In a browser nothing renders, not even the live region: a page's own `status` stays the only one.
  if (!data) return null
  return (
    <Announcer testId="sync-bar-announcer">
      <Bar sync={desktopSync(data)} />
    </Announcer>
  )
}

function Bar({ sync }: { sync: DesktopSync }) {
  useStartAndFinish(sync.syncing)
  if (!sync.syncing) return null
  const { value } = sync
  return (
    <div
      data-testid="sync-bar"
      className="sticky top-(--topbar-h) z-20 border-b border-border bg-background"
    >
      <div className="flex items-center gap-3 px-2 py-1 text-xs md:px-4">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{syncLine(sync)}</span>
        <Button asChild variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs">
          <Link to="/harnesses" aria-label={copy.detailsLabel}>
            {copy.details}
          </Link>
        </Button>
      </div>
      <Progress
        aria-label={copy.label}
        value={value}
        // The shadcn copy keeps `value` off the Radix root, so the number is given to assistive tech here.
        aria-valuenow={value ?? undefined}
        aria-valuetext={value === null ? undefined : `${value}%`}
        className={cn(
          'h-0.5 rounded-none motion-reduce:*:transition-none',
          value === null && 'animate-pulse motion-reduce:animate-none',
        )}
      />
    </div>
  )
}

/** Speaks when syncing starts and when it ends; the first answer is the baseline (the bar shows it already). */
function useStartAndFinish(syncing: boolean) {
  const announce = useAnnounce()
  const last = useRef<boolean | null>(null)
  useEffect(() => {
    const before = last.current
    last.current = syncing
    if (before === null || before === syncing) return
    announce(syncing ? copy.started : copy.finished)
  }, [syncing, announce])
}
