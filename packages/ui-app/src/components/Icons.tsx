interface IconProps {
  size?: number
}

function base(size = 16) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

export function PlusIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>
}

export function SendIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
}

export function StopIcon({ size }: IconProps) {
  return <svg {...base(size)} fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
}

export function SunIcon({ size }: IconProps) {
  return <svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
}

export function MoonIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
}

export function PanelIcon({ size }: IconProps) {
  return <svg {...base(size)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
}

export function MenuIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
}

export function CloseIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>
}

export function SearchIcon({ size }: IconProps) {
  return <svg {...base(size)}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
}

export function ToolIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M14.5 6.5a3.5 3.5 0 0 0-4.9 4.4L4 16.5V20h3.5l5.6-5.6a3.5 3.5 0 0 0 4.4-4.9l-2.4 2.4-2.3-.4-.4-2.3 2.1-2.7Z" /></svg>
}

export function SparkIcon({ size }: IconProps) {
  return <svg {...base(size)} fill="currentColor" stroke="none"><path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z" /><path d="M18.5 15.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" opacity=".6" /></svg>
}

export function GearIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  )
}
