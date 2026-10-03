import { type ReactNode, useEffect, useRef } from 'react'

import { TURN_DEG_PER_S } from './use-arrow-camera'

// Large, labelled controls with their keyboard shortcut printed on them: usable when tired,
// with gloves, or without knowing the app.

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const ICONS = {
  plus: (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  minus: (
    <Icon>
      <path d="M5 12h14" />
    </Icon>
  ),
  reset: (
    <Icon>
      <path d="M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5" />
    </Icon>
  ),
  clear: (
    <Icon>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  ),
  rotateLeft: (
    <Icon>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 3v4h4" />
    </Icon>
  ),
  rotateRight: (
    <Icon>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 3v4h-4" />
    </Icon>
  ),
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="border-grey-500 text-content-fourth whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none">
    {children}
  </kbd>
)

type ControlProps = {
  icon: ReactNode
  label: string
  shortcut: string
  onClick: () => void
  disabled?: boolean
}

const Control = ({ icon, label, shortcut, onClick, disabled }: ControlProps) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={`${label} (${shortcut})`}
    className="bg-grey-900/95 border-grey-600 text-content-primary hover:bg-grey-700 flex h-14 w-[176px] items-center gap-3 whitespace-nowrap rounded-lg border px-3 text-sm font-medium shadow-lg disabled:opacity-40"
  >
    {icon}
    <span className="flex-1 text-left">{label}</span>
    <Kbd>{shortcut}</Kbd>
  </button>
)

// A short click turns this much at once; holding turns continuously like Shift+arrows
const CLICK_TURN_DEG = 10

/** Turns the camera while held down (smoothly, every animation frame), and a little on a click. */
const RotateControl = ({
  icon,
  label,
  shortcut,
  direction,
  onRotate,
}: {
  icon: ReactNode
  label: string
  shortcut: string
  direction: 1 | -1
  onRotate?: (degrees: number) => void
}) => {
  const frame = useRef(0)
  const stop = () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
  }
  // Stop turning if the button unmounts mid-hold (e.g. switching to 2D)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const start = () => {
    if (!onRotate || frame.current) return
    onRotate(direction * CLICK_TURN_DEG)
    let last = performance.now()
    const tick = (now: number) => {
      onRotate(direction * TURN_DEG_PER_S * Math.min(0.05, (now - last) / 1000))
      last = now
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }

  return (
    <button
      type="button"
      disabled={!onRotate}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Keyboard activation (Enter / Space on a focused button) turns one step
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onRotate?.(direction * CLICK_TURN_DEG)
      }}
      title={
        onRotate
          ? `${label}: hold to keep turning (Shift+${direction < 0 ? 'Left' : 'Right'} arrow)`
          : `${label} (3D only)`
      }
      className="bg-grey-900/95 border-grey-600 text-content-primary hover:bg-grey-700 flex h-14 min-w-0 flex-1 touch-none select-none items-center justify-center gap-2 rounded-lg border px-2 text-sm font-medium shadow-lg disabled:opacity-40"
    >
      {icon}
      <Kbd>{shortcut}</Kbd>
    </button>
  )
}

type Props = {
  /** Undefined when the view cannot rotate (2D) */
  onRotate?: (degrees: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  onClear: () => void
  hasSelection: boolean
}

export const MapControls = ({
  onRotate,
  onZoomIn,
  onZoomOut,
  onReset,
  onClear,
  hasSelection,
}: Props) => (
  <div className="pointer-events-auto flex w-[176px] flex-col gap-2">
    <div className="flex gap-2">
      <RotateControl
        icon={ICONS.rotateLeft}
        label="Rotate left"
        shortcut={'\u21e7\u2190'}
        direction={-1}
        onRotate={onRotate}
      />
      <RotateControl
        icon={ICONS.rotateRight}
        label="Rotate right"
        shortcut={'\u21e7\u2192'}
        direction={1}
        onRotate={onRotate}
      />
    </div>
    <Control icon={ICONS.plus} label="Zoom in" shortcut="+" onClick={onZoomIn} />
    <Control icon={ICONS.minus} label="Zoom out" shortcut="-" onClick={onZoomOut} />
    <Control icon={ICONS.reset} label="Reset view" shortcut="R" onClick={onReset} />
    <Control
      icon={ICONS.clear}
      label="Clear"
      shortcut="Esc"
      onClick={onClear}
      disabled={!hasSelection}
    />
  </div>
)
