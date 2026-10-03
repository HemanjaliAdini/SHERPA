import type { ReactNode } from 'react'

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
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="border-grey-500 text-content-fourth rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none">
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

type Props = {
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  onClear: () => void
  hasSelection: boolean
}

export const MapControls = ({ onZoomIn, onZoomOut, onReset, onClear, hasSelection }: Props) => (
  <div className="flex flex-col gap-2">
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
