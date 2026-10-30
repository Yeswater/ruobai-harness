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
    // Icons inside text rows must keep their size; flex would otherwise
    // squeeze them to make room for long labels.
    style: { flexShrink: 0 },
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

export function PlayIcon({ size }: IconProps) {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <path d="M8 5.5c0-.6.7-1 1.2-.7l9 6.5c.5.3.5 1 0 1.3l-9 6.5c-.5.4-1.2 0-1.2-.7V5.5Z" />
    </svg>
  )
}

export function SunIcon({ size }: IconProps) {
  return <svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
}

export function MoonIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
}

export function BrandMarkIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <rect width="24" height="24" rx="7.5" fill="var(--accent)" />
      <ellipse cx="12" cy="15" rx="5.8" ry="4.4" fill="#fff" />
      <ellipse cx="9.6" cy="15" rx="1.15" ry="1.5" fill="var(--accent-strong)" />
      <ellipse cx="14.4" cy="15" rx="1.15" ry="1.5" fill="var(--accent-strong)" />
      <path
        d="M9.4 7.8c.6.7 1.3.7 1.9 0M12.7 7.8c.6.7 1.3.7 1.9 0"
        fill="none" stroke="#fff" strokeWidth="1.35" strokeLinecap="round" opacity=".95"
      />
      <path
        d="M17.6 4.1h3.1a1.35 1.35 0 0 0 0-2.7 1.9 1.9 0 0 0-3.6-.4 1.3 1.3 0 0 0 .5 3.1Z"
        fill="#fff" opacity=".9"
      />
    </svg>
  )
}

export function PanelIcon({ size }: IconProps) {
  return <svg {...base(size)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
}

/** Sidebar panel: the divider sits on the left, unlike PanelIcon. */
export function PanelLeftIcon({ size }: IconProps) {
  return <svg {...base(size)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
}

/** Files panel: a rounded frame with an index column, matching CC's toolbar. */
export function FilePanelIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
      <path d="M12.5 9h5.5M12.5 12h5.5M12.5 15h3.5" />
    </svg>
  )
}

export function MoreIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Diagonal arrows pointing outward: expand the panel. */
export function ExpandIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14 4h6v6M20 4l-6 6M10 20H4v-6M4 20l6-6" />
    </svg>
  )
}

/** Diagonal arrows pointing inward: collapse the expanded panel. */
export function CollapseIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 10h-6V4M14 10l6-6M4 14h6v6M10 14l-6 6" />
    </svg>
  )
}

export function MenuIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
}

export function CloseIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>
}

export function CopyIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </svg>
  )
}

export function ExternalLinkIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14 4h6v6M20 4l-8 8" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  )
}

export function WrapTextIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 6h16M4 12h11a3 3 0 0 1 0 6h-4M4 18h4" />
      <path d="M9 15l-2 3 2 3" />
    </svg>
  )
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

export function BrainIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9.5 4.5a2.5 2.5 0 0 0-2.4 1.8 2.7 2.7 0 0 0-1.6 4.6 2.6 2.6 0 0 0 1.2 4.4A2.5 2.5 0 0 0 9.5 19 2 2 0 0 0 12 17.5v-11a2 2 0 0 0-2.5-2Z" />
      <path d="M14.5 4.5a2.5 2.5 0 0 1 2.4 1.8 2.7 2.7 0 0 1 1.6 4.6 2.6 2.6 0 0 1-1.2 4.4A2.5 2.5 0 0 1 14.5 19 2 2 0 0 1 12 17.5" />
    </svg>
  )
}

export function GearIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  )
}

export function FolderIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  )
}

export function ChevronRightIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="m9 6 6 6-6 6" /></svg>
}

export function ChevronLeftIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="m15 6-6 6 6 6" /></svg>
}

export function ChevronDownIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="m6 9 6 6 6-6" /></svg>
}

export function CheckIcon({ size }: IconProps) {
  return <svg {...base(size)}><path d="m5 12 4 4L19 6" /></svg>
}

export function SlidersIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  )
}

export function FolderPlusIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5Z" />
      <path d="M11 12v4M9 14h4" />
    </svg>
  )
}

export function FolderTreeIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h2.7l1.5 1.6h4.8A1.5 1.5 0 0 1 15 9.1v1.4" />
      <path d="M9 12.5A1.5 1.5 0 0 1 10.5 11h2.7l1.5 1.6h4.8A1.5 1.5 0 0 1 21 14.1v4.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 18.5Z" />
    </svg>
  )
}

export function ListIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="4.5" cy="7" r=".9" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r=".9" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="17" r=".9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function GripIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M8 8h.01M8 12h.01M8 16h.01M16 8h.01M16 12h.01M16 16h.01" strokeWidth="2.4" />
    </svg>
  )
}

export function ClockIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  )
}

export function ArchiveIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 8h16v10.5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h15A1.5 1.5 0 0 1 21 4.5v2A1.5 1.5 0 0 1 19.5 8h-15A1.5 1.5 0 0 1 3 6.5Z" />
      <path d="M10 12h4" />
    </svg>
  )
}

export function ChatIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" />
    </svg>
  )
}

export function TrashIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />
    </svg>
  )
}

export function TerminalIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  )
}

export function MonitorIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  )
}

export function BranchIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="8.5" r="2" />
      <path d="M6 7.5v9M18 10.5c0 3-3 4-6.5 5.5" />
    </svg>
  )
}

export function FileTextIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  )
}

export function ImageIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-5-5L5 20" />
    </svg>
  )
}

export function ShieldIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z" />
    </svg>
  )
}

export function EyeIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function WrenchIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14.5 6.5a4 4 0 0 0 5 5L9 22l-3.5-3.5L16 8Z" />
      <path d="M18 3.5 20.5 6 18 8.5 15.5 6Z" />
    </svg>
  )
}

export function BotIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4v4M8.5 13h.01M15.5 13h.01M9 16.5h6" />
    </svg>
  )
}

export function CommandIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 9V6a2 2 0 1 0-2 2h2Zm0 0v6m0-6h6m-6 6H6a2 2 0 1 0 2 2v-2Zm6-6h3a2 2 0 1 0-2-2v2Zm0 0v6m0 0h3a2 2 0 1 1-2 2v-2Zm0 0H9" />
    </svg>
  )
}

export function PlugIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4" />
    </svg>
  )
}

export function PuzzleIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 4a2 2 0 0 1 4 0c0 .6-.2 1-.5 1.5H16v3.5c.4-.3.8-.5 1.5-.5a2 2 0 1 1 0 4c-.7 0-1.1-.2-1.5-.5V16h-3.5c.3.4.5.8.5 1.5a2 2 0 1 1-4 0c0-.7.2-1.1.5-1.5H5V8h3.5C8.2 7.6 8 7.2 8 6.5A2 2 0 0 1 9 4Z" />
    </svg>
  )
}

export function AtIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />
    </svg>
  )
}

export function AlertIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3 2.5 20h19Z" />
      <path d="M12 9v5M12 17h.01" />
    </svg>
  )
}

export function RefreshIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  )
}

export function WalletIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a3 3 0 0 1 3 3v9a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5Z" />
      <path d="M3 8h15" />
      <path d="M16 12.5h2.5" />
    </svg>
  )
}

export function SyncIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 9a8 8 0 0 1 13.4-4.2L20 7" />
      <path d="M20 3v4h-4" />
      <path d="M20 15a8 8 0 0 1-13.4 4.2L4 17" />
      <path d="M4 21v-4h4" />
    </svg>
  )
}

export function ArrowDownIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 4v14" />
      <path d="M6 13l6 6 6-6" />
      <path d="M5 21h14" />
    </svg>
  )
}

export function ArrowUpIcon({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 20V6" />
      <path d="M6 11l6-6 6 6" />
      <path d="M5 3h14" />
    </svg>
  )
}



