import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHarness } from './useHarness.ts'
import { useClientPlugins } from './useClientPlugins.ts'
import type { PermissionMode, ThemePreference } from './api.ts'
import { PALETTE_COMMANDS } from './command-palette-model.ts'
import { isNewSessionShortcut, isPaletteShortcut, isSettingsShortcut, modKeyLabel } from './shortcuts.ts'
import { ApprovalCard } from './components/ApprovalCard.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { Composer } from './components/Composer.tsx'
import { DetailsPanel } from './components/DetailsPanel.tsx'
import { MenuIcon, PanelIcon, FolderIcon, SearchIcon } from './components/Icons.tsx'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Slot } from './components/Slot.tsx'
import { Transcript } from './components/Transcript.tsx'
import { WorkspacePicker } from './components/WorkspacePicker.tsx'

type Theme = 'light' | 'dark'

function initialPreference(): ThemePreference {
  const saved = localStorage.getItem('rbh-theme')
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return 'system'
}

export function App() {
  const harness = useHarness()
  useClientPlugins()
  const [preference, setPreference] = useState<ThemePreference>(initialPreference)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('behavior')
  const openSettings = useCallback((tab: SettingsTab = 'behavior') => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const pendingApprovals = harness.approvals
  // Shortcuts live outside React's render cycle; a ref keeps them current.
  const settingsOpenRef = useRef(settingsOpen)
  settingsOpenRef.current = settingsOpen

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('rbh-theme', preference)
  }, [theme, preference])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K / Ctrl+K: the global search palette, toggled from anywhere.
      if (isPaletteShortcut(event)) {
        event.preventDefault()
        setPaletteOpen(current => !current)
        return
      }
      // ⌘, / Ctrl+, opens settings from anywhere (and keeps the current tab).
      if (isSettingsShortcut(event)) {
        event.preventDefault()
        setPaletteOpen(false)
        if (!settingsOpenRef.current) openSettings('behavior')
        return
      }
      if (isNewSessionShortcut(event)) {
        event.preventDefault()
        setWorkspacePickerOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings])

  // Commands that need runtime state (nothing streaming, nothing to stop) drop out.
  const paletteCommands = useMemo(
    () => PALETTE_COMMANDS.filter(command => command.id !== 'stop-turn' || harness.session?.streaming),
    [harness.session?.streaming],
  )

  const runPaletteCommand = (id: string) => {
    switch (id) {
      case 'new-session':
        setWorkspacePickerOpen(true)
        break
      case 'settings':
        openSettings('behavior')
        break
      case 'providers':
        openSettings('providers')
        break
      case 'connectors':
        openSettings('mcp')
        break
      case 'permissions':
        openSettings('permissions')
        break
      case 'toggle-details':
        setDetailsOpen(current => !current)
        break
      case 'toggle-theme':
        setPreference(theme === 'dark' ? 'light' : 'dark')
        break
      case 'stop-turn':
        harness.stop()
        break
      default:
        break
    }
  }

  return (
    <div className={`app ${detailsOpen ? '' : 'details-closed'}`}>
      <Sidebar
        sessions={harness.sessions}
        activeId={harness.activeId}
        open={sidebarOpen}
        onSelect={(id) => {
          harness.select(id)
          setSidebarOpen(false)
        }}
        onCreate={() => {
          setWorkspacePickerOpen(true)
          setSidebarOpen(false)
        }}
        onCreateIn={(workspace) => {
          harness.createSession(workspace)
          setSidebarOpen(false)
        }}
        onRename={harness.renameSession}
        onFork={(id) => {
          harness.forkSession(id)
          setSidebarOpen(false)
        }}
        onArchive={harness.archiveSession}
        onDelete={harness.deleteSession}
        onOpenSettings={() => openSettings('behavior')}
      />

      <main className="main">
        <header className="main-head">
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <MenuIcon />
          </button>
          <div className="main-title">
            <h1>{harness.session?.title ?? 'New session'}</h1>
            <div className="main-sub">
              {harness.session?.workspace ? (
                <span className="workspace-chip" title={harness.session.workspace}>
                  <FolderIcon size={11} />
                  {nameOf(harness.session.workspace)}
                </span>
              ) : null}
              <span>
                {harness.session
                  ? [
                      `${harness.session.messages.length} messages`,
                      harness.session.model,
                      harness.modes.find(item => item.id === harness.session?.mode)?.name ?? harness.session.mode,
                    ].filter(Boolean).join(' · ')
                  : 'loading…'}
              </span>
            </div>
          </div>
          <Slot name="header.actions" />
          <button
            className="palette-trigger"
            onClick={() => setPaletteOpen(true)}
            aria-label="全局搜索"
            title={`全局搜索 (${modKeyLabel()}K)`}
          >
            <SearchIcon size={13} />
            <span>搜索</span>
            <span className="keycap">{modKeyLabel()}K</span>
          </button>
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
          sessionId={harness.session?.id}
          provider={harness.session?.provider}
          model={harness.session?.model ?? 'ruobai-chat'}
          models={harness.models}
          modes={harness.modes}
          mode={harness.session?.mode ?? harness.defaultMode}
          permission={(harness.session?.permission as PermissionMode | undefined) ?? 'workspace-write'}
          commandPrefix={harness.commandPrefix}
          contextInfo={harness.contextInfo}
          stats={harness.session?.stats ?? null}
          onModeChange={harness.setMode}
          onModelChange={harness.setModel}
          onPermissionChange={harness.setPermission}
          onSend={harness.send}
          onStop={harness.stop}
          onNewSession={() => setWorkspacePickerOpen(true)}
          onOpenConnectors={() => openSettings('mcp')}
        />
      </main>

      {detailsOpen
        ? <DetailsPanel session={harness.session} contextInfo={harness.contextInfo} onClose={() => setDetailsOpen(false)} />
        : null}

      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        themePreference={preference}
        onThemeChange={setPreference}
        onSaved={() => { void harness.refreshSettings() }}
        onClose={() => setSettingsOpen(false)}
      />

      <WorkspacePicker
        open={workspacePickerOpen}
        recent={harness.recentWorkspaces}
        onClose={() => setWorkspacePickerOpen(false)}
        onPick={(path) => {
          setWorkspacePickerOpen(false)
          harness.createSession(path)
        }}
      />

      <CommandPalette
        open={paletteOpen}
        sessions={harness.sessions}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
        onSelectSession={(id) => {
          harness.select(id)
          setSidebarOpen(false)
        }}
        onRunCommand={runPaletteCommand}
      />

      {sidebarOpen
        ? <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />
        : null}
    </div>
  )
}

function nameOf(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
