import { useEffect, useState } from 'react'
import { useHarness } from './useHarness.ts'
import { useClientPlugins } from './useClientPlugins.ts'
import { ApprovalCard } from './components/ApprovalCard.tsx'
import { Composer } from './components/Composer.tsx'
import { DetailsPanel } from './components/DetailsPanel.tsx'
import { MenuIcon, PanelIcon } from './components/Icons.tsx'
import { SettingsDialog } from './components/SettingsDialog.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Slot } from './components/Slot.tsx'
import { Transcript } from './components/Transcript.tsx'

type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const saved = localStorage.getItem('rbh-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function App() {
  const harness = useHarness()
  useClientPlugins()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const pendingApprovals = harness.approvals.filter(item => item.sessionId === harness.activeId)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('rbh-theme', theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        harness.createSession()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [harness.createSession])

  return (
    <div className={`app ${detailsOpen ? '' : 'details-closed'}`}>
      <Sidebar
        sessions={harness.sessions}
        activeId={harness.activeId}
        connected={harness.connected}
        open={sidebarOpen}
        theme={theme}
        onSelect={(id) => {
          harness.select(id)
          setSidebarOpen(false)
        }}
        onCreate={() => {
          harness.createSession()
          setSidebarOpen(false)
        }}
        onToggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        <header className="main-head">
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <MenuIcon />
          </button>
          <div className="main-title">
            <h1>{harness.session?.title ?? 'New session'}</h1>
            <div className="main-sub">
              {harness.session
                ? [
                    `${harness.session.messages.length} messages`,
                    harness.session.model,
                    harness.modes.find(item => item.id === harness.session?.mode)?.name ?? harness.session.mode,
                  ].filter(Boolean).join(' · ')
                : 'loading…'}
            </div>
          </div>
          <Slot name="header.actions" />
          <button className="icon-btn" onClick={() => setDetailsOpen(current => !current)} aria-label="Toggle details">
            <PanelIcon />
          </button>
        </header>

        {harness.error
          ? (
            <div className="error-bar">
              <span>{harness.error}</span>
              <button onClick={harness.dismissError} aria-label="Dismiss">×</button>
            </div>
          )
          : null}

        <Transcript session={harness.session} onSuggestion={harness.send} />

        {pendingApprovals.length
          ? (
            <div className="approval-stack">
              {pendingApprovals.map(request => (
                <ApprovalCard
                  key={request.id}
                  request={request}
                  onResolve={decision => harness.resolveApproval(request.id, decision)}
                />
              ))}
            </div>
          )
          : null}

        <Composer
          disabled={!harness.session}
          streaming={harness.session?.streaming ?? false}
          model={harness.session?.model ?? 'ruobai-chat'}
          modes={harness.modes}
          mode={harness.session?.mode ?? harness.defaultMode}
          onModeChange={harness.setMode}
          onSend={harness.send}
          onStop={harness.stop}
        />
      </main>

      {detailsOpen ? <DetailsPanel session={harness.session} onClose={() => setDetailsOpen(false)} /> : null}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {sidebarOpen
        ? <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />
        : null}
    </div>
  )
}
