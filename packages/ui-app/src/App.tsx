import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useHarness } from './useHarness.ts'
import { useClientPlugins } from './useClientPlugins.ts'
import { api, type PermissionMode, type SkillSummary, type ThemePreference } from './api.ts'
import { PALETTE_COMMANDS } from './command-palette-model.ts'
import {
  isExpandShortcut, isNewSessionShortcut, isPaletteShortcut, isSettingsShortcut, isSidebarShortcut,
  modKeyLabel,
} from './shortcuts.ts'
import { ApprovalCard } from './components/ApprovalCard.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { Composer } from './components/Composer.tsx'
import { editableContextMenu, useContextMenu } from './components/ContextMenu.tsx'
import { DetailsPanel, type FileView } from './components/DetailsPanel.tsx'
import { SessionPanel } from './components/SessionPanel.tsx'
import { BranchIcon, FilePanelIcon, FolderIcon, MenuIcon, MoreIcon, PanelIcon, SearchIcon } from './components/Icons.tsx'
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

function maxDetailsWidth(collapsed: boolean, sessionOpen: boolean) {
  const reserved = (collapsed || matchMedia('(max-width: 760px)').matches ? 0 : 272)
    + (sessionOpen ? 304 : 0)
  return Math.max(320, window.innerWidth - reserved)
}

function loadDetailsWidth() {
  const saved = Number(localStorage.getItem(DETAILS_WIDTH_KEY))
  const width = Number.isFinite(saved) && saved >= 280 ? saved : DETAILS_DEFAULT_WIDTH
  return Math.min(width, maxDetailsWidth(localStorage.getItem(SIDEBAR_KEY) === '1', true))
}

export function App() {
  const harness = useHarness()
  useClientPlugins()
  const contextMenu = useContextMenu()
  const [preference, setPreference] = useState<ThemePreference>(initialPreference)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [fileOpen, setFileOpen] = useState(false)
  const [expandedPanel, setExpandedPanel] = useState<'session' | 'file' | null>(null)
  const [panelView, setPanelView] = useState<FileView>('files')
  const [detailsWidth, setDetailsWidth] = useState(loadDetailsWidth)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadCollapsed)
  const [reference, setReference] = useState<{ path: string; token: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('behavior')
  const openSettings = useCallback((tab: SettingsTab = 'behavior') => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [skills, setSkills] = useState<SkillSummary[]>([])

  useEffect(() => {
    const sessionId = harness.session?.id
    let cancelled = false
    const load = () => {
      api.getSkills(sessionId)
        .then((list) => { if (!cancelled) setSkills(list) })
        .catch(() => { if (!cancelled) setSkills([]) })
    }
    load()
    const timer = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [harness.session?.id])
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
    const clamped = Math.min(maxDetailsWidth(sidebarCollapsed, detailsOpen), Math.max(280, Math.round(next)))
    setDetailsWidth(clamped)
    localStorage.setItem(DETAILS_WIDTH_KEY, String(clamped))
  }, [sidebarCollapsed, detailsOpen])

  useEffect(() => {
    const clamp = () => setDetailsWidth(current =>
      Math.min(current, maxDetailsWidth(sidebarCollapsed, detailsOpen)))
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [sidebarCollapsed, detailsOpen])

  const toggleSidebar = useCallback(() => {
    if (matchMedia('(max-width: 760px)').matches) setSidebarOpen(current => !current)
    else setSidebarCollapsed(current => !current)
  }, [])

  useEffect(() => {
    if (!toolsMenuOpen) return
    const close = () => setToolsMenuOpen(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolsMenuOpen])

  const showFilePanel = useCallback((view: FileView) => {
    if (fileOpen && panelView === view) {
      setFileOpen(false)
      if (expandedPanel === 'file') setExpandedPanel(null)
      return
    }
    setPanelView(view)
    setFileOpen(true)
    if (expandedPanel === 'session') setExpandedPanel(null)
    // The Git workbench needs two columns; open it wide and let the user collapse.
    if (view === 'git' && window.innerWidth > 1120) setExpandedPanel('file')
  }, [fileOpen, panelView, expandedPanel])

  const toggleSessionPanel = useCallback(() => {
    if (detailsOpen) {
      setDetailsOpen(false)
      if (expandedPanel === 'session') setExpandedPanel(null)
      return
    }
    setDetailsOpen(true)
    if (expandedPanel === 'file') setExpandedPanel(null)
  }, [detailsOpen, expandedPanel])

  const toggleExpandPanel = useCallback((panel: 'session' | 'file') => {
    if (window.innerWidth <= 1120) return
    if (expandedPanel === panel) {
      setExpandedPanel(null)
      return
    }
    if (panel === 'session') setDetailsOpen(true)
    else setFileOpen(true)
    setExpandedPanel(panel)
  }, [expandedPanel])

  useEffect(() => {
    const collapseOnNarrow = () => {
      if (window.innerWidth <= 1120) setExpandedPanel(null)
    }
    window.addEventListener('resize', collapseOnNarrow)
    return () => window.removeEventListener('resize', collapseOnNarrow)
  }, [])

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
      if (isExpandShortcut(event)) {
        event.preventDefault()
        if (expandedPanel) setExpandedPanel(null)
        else if (fileOpen) toggleExpandPanel('file')
        else toggleExpandPanel('session')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, toggleSidebar, expandedPanel, fileOpen, toggleExpandPanel])

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
        showFilePanel('files')
        break
      case 'show-git':
        showFilePanel('git')
        break
      case 'toggle-sidebar':
        toggleSidebar()
        break
      case 'expand-panel':
        if (expandedPanel) setExpandedPanel(null)
        else if (fileOpen) toggleExpandPanel('file')
        else toggleExpandPanel('session')
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
        detailsOpen ? 'session-panel-open' : '',
        fileOpen ? 'file-panel-open' : '',
        expandedPanel === 'session' ? 'session-expanded' : '',
        expandedPanel === 'file' ? 'file-expanded' : '',
        sidebarCollapsed ? 'sidebar-collapsed' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--details-width': `${detailsWidth}px` } as CSSProperties}
      onContextMenu={(event) => {
        event.preventDefault()
        const target = event.target as HTMLElement
        const editable = target.closest('input, textarea')
        if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
          contextMenu.open(event, editableContextMenu(editable))
          return
        }
        const selection = window.getSelection()?.toString().trim()
        if (selection) {
          contextMenu.open(event, [{
            label: '复制',
            shortcut: `${modKeyLabel()}C`,
            onSelect: () => { void navigator.clipboard.writeText(selection) },
          }])
        }
      }}
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
          <div className="main-head-left">
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
          </div>

          <div className="main-head-center">
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
          </div>

          <div className="main-head-right">
            <Slot name="header.actions" />
            <div className="main-tools" role="toolbar" aria-label="面板">
              <button
                className={`icon-btn ${detailsOpen ? 'active' : ''}`}
                onClick={toggleSessionPanel}
                aria-label="会话"
                title="会话"
              >
                <PanelIcon size={16} />
              </button>
              <span className="main-tools-sep" />
              <button
                className={`icon-btn ${fileOpen && panelView === 'files' ? 'active' : ''}`}
                onClick={() => showFilePanel('files')}
                aria-label="文件"
                title="文件"
              >
                <FilePanelIcon size={16} />
              </button>
              <button
                className={`icon-btn ${fileOpen && panelView === 'git' ? 'active' : ''}`}
                onClick={() => showFilePanel('git')}
                aria-label="Git"
                title="Git"
              >
                <BranchIcon size={16} />
              </button>
              <span className="main-tools-sep" />
              <button
                className={`icon-btn ${toolsMenuOpen ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setToolsMenuOpen(current => !current)
                }}
                aria-label="更多工具"
                aria-haspopup="menu"
                aria-expanded={toolsMenuOpen}
                title="更多工具"
              >
                <MoreIcon size={16} />
              </button>
              {toolsMenuOpen
                ? (
                  <div className="main-tools-menu" role="menu" onClick={event => event.stopPropagation()}>
                    <button
                      role="menuitem"
                      onClick={() => { setToolsMenuOpen(false); toggleSidebar() }}
                    >
                      切换工作区栏
                      <span className="menu-key">{modKeyLabel()}B</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { setToolsMenuOpen(false); openSettings('behavior') }}
                    >
                      打开设置
                      <span className="menu-key">{modKeyLabel()},</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        setPreference(theme === 'dark' ? 'light' : 'dark')
                      }}
                    >
                      切换主题
                    </button>
                  </div>
                )
                : null}
            </div>
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
          skills={skills}
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
          <SessionPanel
            session={harness.session}
            contextInfo={harness.contextInfo}
            expanded={expandedPanel === 'session'}
            onToggleExpand={() => toggleExpandPanel('session')}
            onClose={() => {
              setDetailsOpen(false)
              if (expandedPanel === 'session') setExpandedPanel(null)
            }}
          />
        )
        : null}

      {fileOpen
        ? (
          <DetailsPanel
            session={harness.session}
            view={panelView}
            width={detailsWidth}
            expanded={expandedPanel === 'file'}
            onToggleExpand={() => toggleExpandPanel('file')}
            onResize={resizeDetails}
            onClose={() => {
              setFileOpen(false)
              if (expandedPanel === 'file') setExpandedPanel(null)
            }}
            onReferenceFile={(path) => setReference({ path, token: Date.now() })}
          />
        )
        : null}

      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        sessionId={harness.session?.id}
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
