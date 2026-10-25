import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useHarness } from './useHarness.ts'
import { useClientPlugins } from './useClientPlugins.ts'
import type { PermissionMode, ThemePreference } from './api.ts'
import { PALETTE_COMMANDS } from './command-palette-model.ts'
import { isNewSessionShortcut, isPaletteShortcut, isSettingsShortcut, isSidebarShortcut, modKeyLabel } from './shortcuts.ts'
import { ApprovalCard } from './components/ApprovalCard.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { Composer } from './components/Composer.tsx'
import { DetailsPanel, type PanelView } from './components/DetailsPanel.tsx'
import { BranchIcon, FolderIcon, FolderTreeIcon, MenuIcon, PanelIcon, SearchIcon } from './components/Icons.tsx'
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

const SIDEBAR_KEY = 'rbh-sidebar-collapsed'
const DETAILS_WIDTH_KEY = 'rbh-details-width'
const DETAILS_DEFAULT_WIDTH = 344

function loadCollapsed() {
  return localStorage.getItem(SIDEBAR_KEY) === '1'
}

function maxDetailsWidth(collapsed: boolean) {
  const reserved = collapsed || matchMedia('(max-width: 760px)').matches ? 0 : 272
  return Math.max(320, window.innerWidth - reserved)
}

function loadDetailsWidth() {
  const saved = Number(localStorage.getItem(DETAILS_WIDTH_KEY))
  const width = Number.isFinite(saved) && saved >= 280 ? saved : DETAILS_DEFAULT_WIDTH
  return Math.min(width, maxDetailsWidth(localStorage.getItem(SIDEBAR_KEY) === '1'))
}

export function App() {
  const harness = useHarness()
  useClientPlugins()
  const [preference, setPreference] = useState<ThemePreference>(initialPreference)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [panelView, setPanelView] = useState<PanelView>('session')
  const [detailsWidth, setDetailsWidth] = useState(loadDetailsWidth)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadCollapsed)
  const [reference, setReference] = useState<{ text: string; token: number } | null>(null)
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
    localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  const resizeDetails = useCallback((next: number) => {
    const clamped = Math.min(maxDetailsWidth(sidebarCollapsed), Math.max(280, Math.round(next)))
    setDetailsWidth(clamped)
    localStorage.setItem(DETAILS_WIDTH_KEY, String(clamped))
  }, [sidebarCollapsed])

  useEffect(() => {
    const clamp = () => setDetailsWidth(current =>
      Math.min(current, maxDetailsWidth(sidebarCollapsed)))
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [sidebarCollapsed])

  const toggleSidebar = useCallback(() => {
    if (matchMedia('(max-width: 760px)').matches) setSidebarOpen(current => !current)
    else setSidebarCollapsed(current => !current)
  }, [])

  const showPanel = useCallback((view: PanelView) => {
    if (detailsOpen && panelView === view) {
      setDetailsOpen(false)
      return
    }
    setPanelView(view)
    setDetailsOpen(true)
  }, [detailsOpen, panelView])

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
      if (isSidebarShortcut(event)) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, toggleSidebar])

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
      case 'show-files':
        showPanel('files')
        break
      case 'show-git':
        showPanel('git')
        break
      case 'toggle-sidebar':
        toggleSidebar()
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
    <div
      className={[
        'app',
        detailsOpen ? '' : 'details-closed',
        sidebarCollapsed ? 'sidebar-collapsed' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--details-width': `${detailsWidth}px` } as CSSProperties}
    >
      <Sidebar
        sessions={harness.sessions}
        activeId={harness.activeId}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
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
          <button className="icon-btn menu-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
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
          <div className="main-tools" role="toolbar" aria-label="面板">
            <button
              className={`icon-btn ${detailsOpen && panelView === 'files' ? 'active' : ''}`}
              onClick={() => showPanel('files')}
              aria-label="文件"
              title="文件"
            >
              <FolderTreeIcon size={16} />
            </button>
            <button
              className={`icon-btn ${detailsOpen && panelView === 'git' ? 'active' : ''}`}
              onClick={() => showPanel('git')}
              aria-label="Git"
              title="Git"
            >
              <BranchIcon size={16} />
            </button>
            <button
              className={`icon-btn ${detailsOpen && panelView === 'session' ? 'active' : ''}`}
              onClick={() => showPanel('session')}
              aria-label="会话"
              title="会话"
            >
              <PanelIcon size={16} />
            </button>
          </div>
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
          reference={reference}
        />
      </main>

      {detailsOpen
        ? (
          <DetailsPanel
            session={harness.session}
            contextInfo={harness.contextInfo}
            view={panelView}
            width={detailsWidth}
            onResize={resizeDetails}
            onClose={() => setDetailsOpen(false)}
            onReferenceFile={(path) => setReference({ text: `@${path} `, token: Date.now() })}
          />
        )
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
