/**
 * Previous/Next for a detail view (the trace span panel's pattern): ↑ ↓ buttons, "3 of 18", and J / K
 * (`lib/keys.ts` `stepFromKey`). At either end, or while `blocked`, the buttons stay focusable (aria-disabled),
 * so a press there doesn't drop focus. `blocked` says why stepping is off (unsaved edits) in the tooltip.
 */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { stepFromKey } from '@/lib/keys'
import { cn } from '@/lib/utils'

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
  const canPrev = !blocked && index > 0
  const canNext = !blocked && index < count - 1
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const delta = stepFromKey(e, root.current)
      if (!delta) return
      e.preventDefault()
      if (delta < 0 && canPrev) onPrev()
      if (delta > 0 && canNext) onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canPrev, canNext, onPrev, onNext])
  const button = 'aria-disabled:opacity-40 pointer-coarse:size-11'
  return (
    <div ref={root} className={cn('flex items-center gap-0.5', className)}>
      <span className="px-1 text-xs text-muted-foreground tabular-nums">{`${index + 1} of ${count}`}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        className={button}
        aria-label={`Previous ${noun}`}
        aria-keyshortcuts="k"
        aria-disabled={!canPrev}
        title={blocked ?? `Previous ${noun} (K)`}
        onClick={() => {
          if (canPrev) onPrev()
        }}
      >
        <ChevronUp className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={button}
        aria-label={`Next ${noun}`}
        aria-keyshortcuts="j"
        aria-disabled={!canNext}
        title={blocked ?? `Next ${noun} (J)`}
        onClick={() => {
          if (canNext) onNext()
        }}
      >
        <ChevronDown className="size-4" aria-hidden />
      </Button>
    </div>
  )
}
