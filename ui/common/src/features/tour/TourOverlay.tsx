/**
 * The open tour (lazy, `index.ts`): a spotlight that glides from target to target over the dimmed page, and the step's
 * card beside it. The card is a modal Radix Popover, so focus stays in it, the page under it is inert and hidden from
 * screen readers, and Esc ends the tour; ←/→ step. The card goes on the step's side of the target, else the first side
 * with room for it; a target that leaves room on no side (a long list) docks the card at the bottom of the screen.
 *
 * Effects (CLAUDE.md, Aceternity effects): the spotlight's edge is our CSS take on Aceternity's Moving Border (a glint
 * on `--animate-orbit`, as the waitlist badge's) and each title is Aceternity's Text Generate Effect. Both are
 * decorative and stand still under reduced motion, where the spotlight also jumps instead of gliding.
 */
import { m, useReducedMotion } from 'motion/react'
import { use, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { TextGenerateEffect } from '@/components/aceternity/text-generate-effect'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { transitions } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { copy } from './copy'
import type { LayerTour } from '@/app/edition'
import type { TourStep } from '@/lib/tour'
import type { TourId } from './logic'
import { stepsFor, TOURS } from './tours'

/** Room between the target and the spotlight's edge. */
const PAD = 6

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The first element for a target that takes up room on screen (not `display: none`, not a hidden tab). */
function findTarget(target: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour~="${target}"]`)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

/** A centred step's spotlight: a point a third of the way down, so the card below it sits near the middle. */
const centre = (): Box => ({ x: innerWidth / 2, y: innerHeight / 3, width: 0, height: 0 })

/** Keeps the spotlight inside the screen: a target taller or wider than it is lit only where it shows. */
const EDGE = 4
function clampToScreen(b: Box): Box {
  const x = Math.max(b.x, EDGE)
  const y = Math.max(b.y, EDGE)
  return {
    x,
    y,
    width: Math.max(0, Math.min(b.x + b.width, innerWidth - EDGE) - x),
    height: Math.max(0, Math.min(b.y + b.height, innerHeight - EDGE) - y),
  }
}

type Side = NonNullable<TourStep['side']>
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
/** What the card needs beside a target: its size (320 × up to ~240) plus the gap and the screen margin. */
const ROOM = { across: 270, beside: 350 }

/** The step's side if the card fits there, else its opposite, else the other axis; null when no side has room. */
function sideFor(spot: Box, wanted: Side): Side | null {
  const room: Record<Side, number> = {
    top: spot.y,
    bottom: innerHeight - spot.y - spot.height,
    left: spot.x,
    right: innerWidth - spot.x - spot.width,
  }
  const across = wanted === 'top' || wanted === 'bottom'
  const others: Side[] = across ? ['right', 'left'] : ['bottom', 'top']
  return (
    [wanted, OPPOSITE[wanted], ...others].find(
      (side) => room[side] >= (side === 'top' || side === 'bottom' ? ROOM.across : ROOM.beside),
    ) ?? null
  )
}

/** Where a card with nowhere beside its target goes: the bottom middle of the screen, over the target. */
const dock = (): Box => ({ x: innerWidth / 2, y: innerHeight - 16, width: 0, height: 0 })

/**
 * The target's box, followed while its step is open: the page may scroll, reflow or animate under it. Brings the
 * target into view first. Null when the target is gone (the step shows centred).
 * ponytail: one rect read per frame while a tour is open; ResizeObserver + scroll listeners if that ever shows up.
 */
function useTargetBox(target: string | undefined, reduced: boolean): Box | null {
  const [seen, setSeen] = useState<{ target: string; box: Box | null } | null>(null)
  useEffect(() => {
    if (!target) return
    const el = findTarget(target)
    const r = el?.getBoundingClientRect()
    if (el && r && (r.top < 0 || r.bottom > innerHeight)) {
      el.scrollIntoView({
        // A target taller than most of the screen shows its top, the rest its middle.
        block: r.height > innerHeight * 0.6 ? 'start' : 'center',
        behavior: reduced ? 'auto' : 'smooth',
      })
    }
    let last = ''
    let frame = requestAnimationFrame(function tick() {
      const box = findTarget(target)?.getBoundingClientRect()
      const key = box ? `${box.x} ${box.y} ${box.width} ${box.height}` : ''
      if (key !== last) {
        last = key
        setSeen({
          target,
          box: box
            ? {
                x: box.x - PAD,
                y: box.y - PAD,
                width: box.width + 2 * PAD,
                height: box.height + 2 * PAD,
              }
            : null,
        })
      }
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [target, reduced])
  return target && seen?.target === target ? seen.box : null
}

/**
 * A layer's steps, loaded once per tour and kept: `use()` needs the same promise on every render. A failed load is
 * dropped, so the next try loads again, and reads as no steps (the tour ends at once).
 */
const layerSteps = new Map<string, Promise<readonly TourStep[]>>()
function stepsOf(layer: LayerTour): Promise<readonly TourStep[]> {
  let p = layerSteps.get(layer.id)
  if (!p) {
    p = layer.steps().catch(() => {
      layerSteps.delete(layer.id)
      return []
    })
    layerSteps.set(layer.id, p)
  }
  return p
}

export function TourOverlay({
  id,
  layer,
  withApp,
  offerOptOut,
  onEnd,
  onOptOut,
}: {
  /** A core tour (`TourId`), or the layer's when `layer` is set. */
  id: string
  /** A layer's own page (the `tours` slot): its steps load first (the overlay waits in Suspense meanwhile). */
  layer: LayerTour | null
  /** The app tour's steps (the sidebar) come first (`stepsFor`). */
  withApp: boolean
  /** A first-time user's first tour: its first card offers No thanks, which turns automatic tours off. */
  offerOptOut: boolean
  onEnd(): void
  onOptOut(): void
}) {
  // The steps this page can show now (tours.ts), read once when the tour opens: a later re-render never drops one.
  const page = layer ? use(stepsOf(layer)) : (TOURS[id as TourId] ?? [])
  const [steps] = useState(() =>
    stepsFor(page, withApp).filter((s) => !s.target || findTarget(s.target)),
  )
  // Nothing to show (a layer's steps failed to load): end at once rather than hold the page under an empty tour.
  const empty = steps.length === 0
  useEffect(() => {
    if (empty) onEnd()
  }, [empty, onEnd])
  const [index, setIndex] = useState(0)
  const step = steps[index]
  const reduced = useReducedMotion() ?? false
  const target = useTargetBox(step?.target, reduced)
  const spot = target ? clampToScreen(target) : centre()
  const side = target ? sideFor(spot, step?.side ?? 'bottom') : 'bottom'
  // The card hangs off the spotlight, or off the dock when there is no room beside it.
  const anchor = side ? spot : dock()
  const glide = reduced ? { duration: 0 } : transitions.spotlight
  const titleId = useId()
  const bodyId = useId()
  const primary = useRef<HTMLButtonElement>(null)
  if (!step) return null

  const last = index === steps.length - 1
  const optOut = offerOptOut && index === 0
  const next = () => (last ? onEnd() : setIndex(index + 1))
  const back = () => setIndex(Math.max(0, index - 1))
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') next()
    else if (e.key === 'ArrowLeft') back()
    else return
    e.preventDefault()
  }

  return (
    <Popover open modal onOpenChange={(open) => (open ? undefined : onEnd())}>
      {createPortal(
        <>
          <m.div
            aria-hidden
            data-testid="tour-spotlight"
            // The dim is the spotlight's own shadow (the dialog overlay's black at 50%), so the hole moves with it.
            className={cn(
              'pointer-events-none fixed top-0 left-0 z-50 rounded-lg shadow-[0_0_0_200vmax_rgb(0_0_0/0.5)]',
              target && 'ring-2 ring-primary',
            )}
            initial={false}
            animate={{ x: spot.x, y: spot.y, width: spot.width, height: spot.height }}
            transition={glide}
          >
            {target ? <MovingBorder /> : null}
          </m.div>
          <PopoverAnchor asChild>
            <m.div
              aria-hidden
              className="pointer-events-none fixed top-0 left-0"
              initial={false}
              animate={{ x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }}
              transition={glide}
            />
          </PopoverAnchor>
        </>,
        document.body,
      )}
      <PopoverContent
        side={side ?? 'top'}
        sideOffset={target && side ? 12 : 0}
        collisionPadding={16}
        // Re-placed every frame: the anchor glides.
        updatePositionStrategy="always"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        // A click on the dimmed page doesn't end the tour; Skip and Esc do.
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          primary.current?.focus()
        }}
        onKeyDown={onKeyDown}
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        {/* Stays mounted across steps, so a screen reader hears each new step while focus stays on Next. */}
        <div aria-live="polite" className="flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground tabular-nums">
              {copy.step(index + 1, steps.length)}
            </p>
            <Dots count={steps.length} index={index} />
          </div>
          {/* Keyed by step: the title's words arrive again on every step. */}
          <div key={index} className="flex flex-col gap-1.5">
            <h2 id={titleId} className="text-base font-semibold text-balance">
              <TextGenerateEffect words={step.title} />
            </h2>
            <p id={bodyId} className="text-sm text-pretty text-muted-foreground">
              {step.body}
            </p>
            {optOut ? <p className="text-xs text-muted-foreground">{copy.noThanksHint}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-3">
          {optOut ? (
            <Button variant="ghost" size="sm" className="-ml-2" onClick={onOptOut}>
              {copy.noThanks}
            </Button>
          ) : last ? null : (
            <Button variant="ghost" size="sm" className="-ml-2" onClick={onEnd}>
              {copy.skip}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {index > 0 ? (
              <Button variant="outline" size="sm" onClick={back}>
                {copy.back}
              </Button>
            ) : null}
            <Button ref={primary} size="sm" onClick={next}>
              {optOut ? copy.start : last ? copy.done : copy.next}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Our CSS take on Aceternity's Moving Border: a glint circling the spotlight's 2 px edge. Hidden under reduced motion. */
function MovingBorder() {
  return (
    <span className="absolute -inset-0.5 overflow-hidden rounded-[inherit] p-0.5 [mask:linear-gradient(black_0_0)_content-box_exclude,linear-gradient(black_0_0)] motion-reduce:hidden">
      <span className="absolute top-1/2 left-1/2 aspect-square w-[max(200%,200vh)] -translate-1/2 animate-orbit bg-[conic-gradient(from_0deg,transparent_0deg_250deg,var(--primary)_330deg,var(--primary-foreground)_350deg,transparent_360deg)]" />
    </span>
  )
}

/** Where the tour is, as a row of dots; the current one stretches. The "Step n of m" line says it in words. */
function Dots({ count, index }: { count: number; index: number }) {
  return (
    <span aria-hidden className="flex items-center gap-1">
      {Array.from({ length: count }, (_, n) => (
        <m.span
          key={n}
          className={cn('h-1.5 rounded-full', n === index ? 'bg-primary' : 'bg-border')}
          initial={false}
          animate={{ width: n === index ? 16 : 6 }}
          transition={transitions.fade}
        />
      ))}
    </span>
  )
}
