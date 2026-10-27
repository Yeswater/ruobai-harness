import type { ReactNode } from 'react'

export function SettingsScroll({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className ? `settings-panel-scroll ${className}` : 'settings-panel-scroll'}>
      {children}
    </div>
  )
}

export function SettingsGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {label ? (
        <div className="settings-group-head">
          <span className="settings-group-label">{label}</span>
        </div>
      ) : null}
      <div className="settings-group-card">{children}</div>
    </section>
  )
}

export function SettingRow({ title, description, children }: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-copy">
        <div className="setting-row-title">{title}</div>
        {description ? <div className="setting-row-desc">{description}</div> : null}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  )
}
