import { useEffect, useState } from 'react'

/**
 * True once the element is on screen, false again when it leaves. Without IntersectionObserver (old engines) every
 * row counts as on screen, so the cells still fill in.
 */
export function useOnScreen<E extends Element>(): [(el: E | null) => void, boolean] {
  const [el, setEl] = useState<E | null>(null)
  const [on, setOn] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setOn(e.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [el])
  return [setEl, on]
}
