/**
 * The onboarding card's history timeline (contract v2 `windows`, newest first): the finished windows (the first few,
 * then Show all), the window being read, and one line for the rest, so a 40-window run never draws 40 rows.
 */
import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copy as pageCopy } from '../copy'
import { OLDER_WINDOW_LABEL, SYNC_DONE_WINDOWS_SHOWN } from '../constants'
import { lastMonthIn, type SyncWindow } from '../runs'

const copy = pageCopy.agentsOnboarding

export function WindowTimeline({
  windows,
  device,
}: {
  windows: readonly SyncWindow[]
  device: string
}) {
  const [all, setAll] = useState(false)
  const done = windows.filter((w) => w.status === 'done')
  const running = windows.filter((w) => w.status === 'running')
  const waiting = windows.filter((w) => w.status === 'waiting')
  const hidden = done.length - SYNC_DONE_WINDOWS_SHOWN
  const shownDone = all || hidden <= 0 ? done : done.slice(0, SYNC_DONE_WINDOWS_SHOWN)
  const olderWaiting = waiting.some((w) => w.label === OLDER_WINDOW_LABEL)
  const days = waiting.length - (olderWaiting ? 1 : 0)
  return (
    <div className="flex flex-col gap-1 text-sm">
      <ul aria-label={copy.timelineLabel(device)} className="flex flex-col gap-1">
        {shownDone.map((w) => (
          // Labels are unique within a run (contract v2 `windows`).
          <li key={w.label} className="flex items-center gap-2">
            <Check aria-hidden className="size-4 text-success" />
            <span>{copy.windowDone(w.label, w.sessions)}</span>
          </li>
        ))}
        {running.map((w) => (
          <li key={w.label} className="flex items-center gap-2">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            <span>{copy.windowRunning(w.label)}</span>
          </li>
        ))}
        {waiting.length ? (
          <li className="pl-6 text-muted-foreground">
            {copy.windowsRemaining(days, olderWaiting)}
          </li>
        ) : null}
      </ul>
      {hidden > 0 ? (
        <div>
          <Button
            size="sm"
            variant="link"
            className="h-auto px-0"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
          >
            {all ? copy.showFewerWindows : copy.showAllWindows(done.length)}
          </Button>
        </div>
      ) : null}
      {lastMonthIn(windows) ? <p className="text-muted-foreground">{copy.lastMonthIn}</p> : null}
    </div>
  )
}
