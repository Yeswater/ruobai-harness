import type { ReactNode } from 'react'
import { ChevronDownIcon } from './Icons.tsx'

interface InfoCardProps {
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
  className?: string
}

/** Collapsible section used by the session side panel. */
export function InfoCard({ title, open, onToggle, children, className }: InfoCardProps) {
  return (
    <section className={`info-card ${className ?? ''}`}>
      <button
        type="button"
        className="info-card-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="info-card-title">{title}</span>
        <span className={`info-card-chevron ${open ? 'open' : ''}`}>
          <ChevronDownIcon size={14} />
        </span>
      </button>
      {open ? <div className="info-card-body">{children}</div> : null}
    </section>
  )
}
