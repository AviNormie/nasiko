/**
 * Previous/Next for a detail view (the trace span panel's pattern): ↑ ↓ buttons, "3 of 18", and J / K
 * (`lib/keys.ts` `stepFromKey`). At either end, or while `blocked`, the buttons stay focusable (aria-disabled),
 * so a press there doesn't drop focus. `blocked` says why stepping is off (unsaved edits) in a tooltip.
 */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { stepFromKey } from '@/lib/keys'
import { cn } from '@/lib/utils'

/**
 * ponytail: a module-level flag, set in a click and consumed by the next PrevNext to mount, if focus fell to <body>
 * within 10 s. A detail route remounts on a step, which drops focus; this puts it back on the arrow used. A step
 * blocked by a leave prompt just expires; a view that doesn't remount clears the flag on the next frame.
 */
const refocus: { which?: 'prev' | 'next'; at: number } = { at: 0 }

/** The view didn't remount (the clicked arrow is still there next frame): nothing fell, so drop the flag. */
function clearIfStayed(btn: HTMLElement) {
  requestAnimationFrame(() => {
    if (btn.isConnected) refocus.which = undefined
  })
}

export function PrevNext({
  noun,
  index,
  count,
  onPrev,
  onNext,
  blocked,
  className,
}: {
  /** What is stepped through, for the labels ("Previous agent"). */
  noun: string
  /** 0-based position in the list. */
  index: number
  count: number
  onPrev: () => void
  onNext: () => void
  blocked?: string
  className?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const prevButton = useRef<HTMLButtonElement>(null)
  const nextButton = useRef<HTMLButtonElement>(null)
  const reasonId = useId()
  const canPrev = !blocked && index > 0
  const canNext = !blocked && index < count - 1
  useEffect(() => {
    const { which, at } = refocus
    refocus.which = undefined
    const fell = !document.activeElement || document.activeElement === document.body
    if (which && fell && Date.now() - at < 10_000)
      (which === 'prev' ? prevButton : nextButton).current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const delta = stepFromKey(e, root.current)
      if (!delta) return
      // Claimed even at an end or while blocked, so a second control can't step (J/K has no default action outside fields).
      e.preventDefault()
      if (delta < 0 && canPrev) onPrev()
      if (delta > 0 && canNext) onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canPrev, canNext, onPrev, onNext])
  const button = 'aria-disabled:opacity-40 pointer-coarse:size-11'
  return (
    <div
      ref={root}
      role="group"
      aria-label={`${noun} ${index + 1} of ${count}`}
      className={cn('flex items-center gap-0.5', className)}
    >
      <span
        aria-hidden
        className="px-1 text-xs text-muted-foreground tabular-nums"
      >{`${index + 1} of ${count}`}</span>
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={prevButton}
            variant="ghost"
            size="icon-sm"
            className={button}
            aria-label={`Previous ${noun}`}
            aria-keyshortcuts="k"
            aria-disabled={!canPrev}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={(e) => {
              if (!canPrev) return
              Object.assign(refocus, { which: 'prev', at: Date.now() })
              onPrev()
              clearIfStayed(e.currentTarget)
            }}
          >
            <ChevronUp className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{blocked ?? `Previous ${noun} (K)`}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={nextButton}
            variant="ghost"
            size="icon-sm"
            className={button}
            aria-label={`Next ${noun}`}
            aria-keyshortcuts="j"
            aria-disabled={!canNext}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={(e) => {
              if (!canNext) return
              Object.assign(refocus, { which: 'next', at: Date.now() })
              onNext()
              clearIfStayed(e.currentTarget)
            }}
          >
            <ChevronDown className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{blocked ?? `Next ${noun} (J)`}</TooltipContent>
      </Tooltip>
    </div>
  )
}
