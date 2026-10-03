import { type RefObject, useEffect } from 'react'

import type { C2MapHandle } from './c2-map'

// Continuous camera movement while arrow keys are held: speed x elapsed time every animation
// frame, easing in over RAMP_S, instead of one jump per key-repeat event.
const PAN_PX_PER_S = 700
const TURN_DEG_PER_S = 70
const TILT_DEG_PER_S = 45
const RAMP_S = 0.35

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

/** Arrow keys move the map; with Shift they turn (left/right) and tilt (up/down) the camera. */
export function useArrowCamera(mapRef: RefObject<C2MapHandle | null>) {
  useEffect(() => {
    const held = new Set<string>()
    let shift = false
    let frame = 0
    let last = 0
    let heldFor = 0

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000) // cap so a stalled frame does not jump
      last = now
      heldFor += dt
      const ease = Math.min(1, 0.3 + (0.7 * heldFor) / RAMP_S)
      const x = Number(held.has('ArrowRight')) - Number(held.has('ArrowLeft'))
      const y = Number(held.has('ArrowDown')) - Number(held.has('ArrowUp'))
      const map = mapRef.current
      if (shift) {
        if (x) map?.rotate(x * TURN_DEG_PER_S * ease * dt)
        if (y) map?.tilt(-y * TILT_DEG_PER_S * ease * dt)
      } else if (x || y) {
        map?.pan(x * PAN_PX_PER_S * ease * dt, y * PAN_PX_PER_S * ease * dt)
      }
      frame = held.size > 0 ? requestAnimationFrame(tick) : 0
    }

    const onKeyDown = (e: KeyboardEvent) => {
      shift = e.shiftKey
      if (!ARROWS.has(e.key) || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      held.add(e.key)
      if (!frame) {
        last = performance.now()
        heldFor = 0
        frame = requestAnimationFrame(tick)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      shift = e.shiftKey
      held.delete(e.key)
    }
    // Keys released while the window is not focused never send keyup
    const onBlur = () => held.clear()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [mapRef])
}
