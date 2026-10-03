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
  // Iconoir "rotate camera left" (MIT licence)
  camera: (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22.0028 3V7.49704C22.0028 7.77482 21.7776 8 21.4998 8V8C21.2999 8 21.12 7.88104 21.034 7.70059C19.4262 4.32948 15.9866 2 12.0028 2C6.81746 2 2.55391 5.94668 2.05219 11" />
      <path d="M6 16.4V9.39365C6 9.06228 6.26863 8.79365 6.6 8.79365H7.77283C7.97677 8.79365 8.16674 8.69006 8.2772 8.51863L9.7228 6.27502C9.83326 6.10359 10.0232 6 10.2272 6H13.7728C13.9768 6 14.1667 6.10359 14.2772 6.27502L15.7228 8.51863C15.8333 8.69006 16.0232 8.79365 16.2272 8.79365H17.4C17.7314 8.79365 18 9.06228 18 9.39365V16.4C18 16.7314 17.7314 17 17.4 17H6.6C6.26863 17 6 16.7314 6 16.4Z" />
      <path d="M12 14C13.1046 14 14 13.1046 14 12C14 10.8954 13.1046 10 12 10C10.8954 10 10 10.8954 10 12C10 13.1046 10.8954 14 12 14Z" />
      <path d="M2.05078 21V16.503C2.05078 16.2252 2.27596 16 2.55374 16V16C2.75366 16 2.93357 16.119 3.01963 16.2994C4.62737 19.6705 8.06703 22 12.0508 22C17.2361 22 21.4997 18.0533 22.0014 13" />
    </svg>
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

type Props = {
  /** Whether the camera can turn and tilt (3D); 2D shows the camera hint greyed out */
  cameraControls: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  onClear: () => void
  hasSelection: boolean
}

export const MapControls = ({
  cameraControls,
  onZoomIn,
  onZoomOut,
  onReset,
  onClear,
  hasSelection,
}: Props) => (
  <div className="pointer-events-auto flex w-[176px] flex-col gap-2">
    {/* One instruction for the whole camera: Shift + arrows turn and tilt it */}
    <div
      className={`bg-grey-900/95 border-grey-600 text-content-primary flex h-9 items-center justify-center gap-2 rounded-lg border text-xs font-medium shadow-lg ${cameraControls ? '' : 'opacity-40'}`}
      title="Camera: Shift + Left/Right turns, Shift + Up/Down tilts. Shift + Up twice looks straight down, Shift + Down twice goes back."
    >
      {ICONS.camera}
      <Kbd>Shift + arrows</Kbd>
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
