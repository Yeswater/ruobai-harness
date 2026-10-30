import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AttachmentMeta } from '@ruobai/chat-protocol'
import { useHarness } from './useHarness.ts'
import { useClientPlugins } from './useClientPlugins.ts'
import { browserBus } from './panel-events.ts'
import { api, type ActivitySummary, type PermissionMode, type SkillSummary, type ThemePreference } from './api.ts'
import { PALETTE_COMMANDS } from './command-palette-model.ts'
import {
  isExpandShortcut, isNewSessionShortcut, isPaletteShortcut, isSettingsShortcut, isSidebarShortcut,
  isTerminalShortcut, modKeyLabel,
} from './shortcuts.ts'
import { ApprovalCard } from './components/ApprovalCard.tsx'
import { CommitCard } from './components/CommitCard.tsx'
import { PlanCard } from './components/PlanCard.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { Composer } from './components/Composer.tsx'
import { editableContextMenu, useContextMenu } from './components/ContextMenu.tsx'
import { DetailsPanel, type FileView } from './components/DetailsPanel.tsx'
import { ContextView } from './components/ContextView.tsx'
import { FastTooltips } from './components/FastTooltips.tsx'
import { OpenInMenu } from './components/OpenInMenu.tsx'
import { ChangesView } from './components/ChangesView.tsx'
import { SessionDock } from './components/SessionDock.tsx'
import { TodoPanel } from './components/TodoPanel.tsx'
import { TrajectoryView } from './components/TrajectoryView.tsx'
import { BranchIcon, FilePanelIcon, ListIcon, MenuIcon, MonitorIcon, MoreIcon, SearchIcon, TerminalIcon } from './components/Icons.tsx'
import { SettingsDialog, type SettingsTab } from './components/settings/SettingsDialog.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { FunctionWorkspace } from './components/workspace/FunctionWorkspace.tsx'
import { functionViewInfo, type FunctionView, type ToolTab } from './function-views.ts'
import { Slot } from './components/Slot.tsx'
import { HandoffView } from './components/HandoffView.tsx'
import { Transcript } from './components/Transcript.tsx'
import { WorkspacePicker } from './components/WorkspacePicker.tsx'

type Theme = 'light' | 'dark'
type MainView = 'chat' | 'changes' | 'trajectory' | 'context' | 'handoff'

const MAIN_VIEW_KEY = 'rbh-main-view'
const MAIN_TABS: Array<{ id: MainView; label: string }> = [
  { id: 'chat', label: '会话' },
  { id: 'changes', label: '更改' },
  { id: 'trajectory', label: '轨迹' },
  { id: 'context', label: '上下文' },
  { id: 'handoff', label: '交接包' },
]

function loadMainView(): MainView {
  const saved = localStorage.getItem(MAIN_VIEW_KEY)
  return saved === 'trajectory' || saved === 'context' || saved === 'handoff' ? saved : 'chat'
}

function initialPreference(): ThemePreference {
  const saved = localStorage.getItem('rbh-theme')
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return 'system'
}

const SIDEBAR_KEY = 'rbh-sidebar-collapsed'
const SIDEBAR_WIDTH_KEY = 'rbh-sidebar-width'
const SIDEBAR_DEFAULT_WIDTH = 272
const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 420
const DETAILS_WIDTH_KEY = 'rbh-details-width'
const DETAILS_DEFAULT_WIDTH = 344

function loadCollapsed() {
  return localStorage.getItem(SIDEBAR_KEY) === '1'
}

function maxDetailsWidth(collapsed: boolean) {
  const reserved = collapsed || matchMedia('(max-width: 760px)').matches ? 0 : 272
  return Math.max(320, window.innerWidth - reserved)
}

function loadSidebarWidth() {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (!Number.isFinite(saved) || !saved) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(saved)))
}

function loadDetailsWidth() {
  const saved = Number(localStorage.getItem(DETAILS_WIDTH_KEY))
  const width = Number.isFinite(saved) && saved >= 280 ? saved : DETAILS_DEFAULT_WIDTH
  return Math.min(width, maxDetailsWidth(localStorage.getItem(SIDEBAR_KEY) === '1'))
}

export function App() {
  const harness = useHarness()
  useClientPlugins()
  const contextMenu = useContextMenu()
  const [preference, setPreference] = useState<ThemePreference>(initialPreference)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  const [fileOpen, setFileOpen] = useState(false)
  const [fileRequest, setFileRequest] = useState<{ path: string; token: number } | null>(null)
  const [expandedPanel, setExpandedPanel] = useState<'file' | null>(null)
  const [panelView, setPanelView] = useState<FileView>('files')
  const [detailsWidth, setDetailsWidth] = useState(loadDetailsWidth)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [sessionDockOpen, setSessionDockOpen] = useState(true)
  const [reference, setReference] = useState<{ path: string; token: number } | null>(null)
  const [restoredDrop, setRestoredDrop] = useState<{
    text: string
    attachments?: AttachmentMeta[]
    token: number
  } | null>(null)
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
  const [mainView, setMainView] = useState<MainView>(loadMainView)
  const [functionView, setFunctionView] = useState<FunctionView | null>(null)
  const [toolsTab, setToolsTab] = useState<ToolTab>('skills')
  const [activity, setActivity] = useState<ActivitySummary | null>(null)

  // A draft has no host session yet, so server-bound props use its future id.
  const sessionId = harness.activeId ?? undefined

  // A session that nobody has typed into yet: no messages in the log and no
  // function workspace on screen. The empty screen keeps its own chrome.
  const emptySession = Boolean(
    !functionView && mainView === 'chat' && harness.session && harness.session.messages.length === 0,
  )

  // A new session opens with the empty screen alone: no side panel left over
  // from the conversation the user came from.
  useEffect(() => {
    if (emptySession) setFileOpen(false)
  }, [emptySession])

  // The agent opened a page: show it in the preview panel, mirroring the model.
  useEffect(() => {
    return browserBus.subscribe((event) => {
      if (event.kind !== 'open' || !event.fresh) return
      if (!harness.activeId || event.sessionId !== harness.activeId) return
      setPanelView('preview')
      setFileOpen(true)
      setExpandedPanel(null)
    })
  }, [harness.activeId])

  useEffect(() => {
    if (!emptySession) return
    let cancelled = false
    api.getActivity()
      .then((next) => { if (!cancelled) setActivity(next) })
      .catch(() => { if (!cancelled) setActivity(null) })
    return () => { cancelled = true }
  }, [emptySession, harness.session?.id, harness.sessions.length])

  useEffect(() => {
    localStorage.setItem(MAIN_VIEW_KEY, mainView)
  }, [mainView])

  useEffect(() => {
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
  }, [sessionId])
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

  /**
   * The session list is the user's own column: dragging it reports a width, which
   * is clamped and persisted like the file panel's.
   */
  const resizeSidebar = useCallback((next: number) => {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(next)))
    setSidebarWidth(clamped)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped))
  }, [])

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

  // Opening the file panel squeezes the transcript enough that the dock has to
  // give way; it stays collapsed until the user opens it again, and closing the
  // panel restores it.
  const previousFileOpen = useRef(fileOpen)
  useEffect(() => {
    if (fileOpen !== previousFileOpen.current) {
      setSessionDockOpen(!fileOpen)
      previousFileOpen.current = fileOpen
    }
  }, [fileOpen])

  const showFilePanel = useCallback((view: FileView) => {
    if (fileOpen && panelView === view) {
      setFileOpen(false)
      setExpandedPanel(null)
      return
    }
    setPanelView(view)
    setFileOpen(true)
  }, [fileOpen, panelView])

  const toggleExpandPanel = useCallback(() => {
    if (window.innerWidth <= 1120) return
    if (expandedPanel === 'file') {
      setExpandedPanel(null)
      return
    }
    setFileOpen(true)
    setExpandedPanel('file')
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
        else if (fileOpen) toggleExpandPanel()
      }
      if (isTerminalShortcut(event)) {
        event.preventDefault()
        showFilePanel('terminal')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, toggleSidebar, expandedPanel, fileOpen, toggleExpandPanel, showFilePanel])

  // Commands that need runtime state (nothing streaming, nothing to stop) drop out.
  const paletteCommands = useMemo(
    () => PALETTE_COMMANDS.filter((command) => {
      if (command.id === 'stop-turn') return harness.session?.streaming === true
      if (command.id === 'export-session') return Boolean(harness.session?.messages.length)
      return true
    }),
    [harness.session?.streaming, harness.session?.messages.length],
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
        setToolsTab('connectors')
        setFunctionView('tools')
        break
      case 'wiki':
        setFunctionView('wiki')
        break
      case 'skills':
        setToolsTab('skills')
        setFunctionView('tools')
        break
      case 'experts':
        setToolsTab('experts')
        setFunctionView('tools')
        break
      case 'permissions':
        openSettings('permissions')
        break
      case 'export-session':
        if (harness.session) {
          window.open(`/api/export/session/${encodeURIComponent(harness.session.id)}.md`, '_blank', 'noopener')
        }
        break
      case 'show-files':
        showFilePanel('files')
        break
      case 'show-git':
        showFilePanel('git')
        break
      case 'preview':
        showFilePanel('preview')
        break
      case 'session-info':
        setSessionDockOpen(value => !value)
        break
      case 'changes':
        setFunctionView(null)
        setMainView('changes')
        break
      case 'terminal':
        showFilePanel('terminal')
        break
      case 'toggle-sidebar':
        toggleSidebar()
        break
      case 'expand-panel':
        if (expandedPanel) setExpandedPanel(null)
        else if (fileOpen) toggleExpandPanel()
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

  const activeFunction = functionView ? functionViewInfo(functionView) : null

  return (
    <div
      className={[
        'app',
        fileOpen ? 'file-panel-open' : '',
        expandedPanel === 'file' ? 'file-expanded' : '',
        sidebarCollapsed ? 'sidebar-collapsed' : '',
      ].filter(Boolean).join(' ')}
      style={{
        '--details-width': `${detailsWidth}px`,
        '--sidebar-width': `${sidebarWidth}px`,
      } as CSSProperties}
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
          setFunctionView(null)
          harness.select(id)
          setSidebarOpen(false)
        }}
        onCreate={() => {
          setWorkspacePickerOpen(true)
          setSidebarOpen(false)
        }}
        onCreateIn={(workspace) => {
          setFunctionView(null)
          setMainView('chat')
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
        functionView={functionView}
        onOpenFunction={(view) => {
          setFunctionView(view)
          setSidebarOpen(false)
        }}
        width={sidebarWidth}
        onResize={resizeSidebar}
      />

      <main className={`main ${emptySession ? 'empty-session' : ''}`}>
        <header className={emptySession ? 'main-head minimal' : 'main-head'}>
          <div className="main-head-left">
            <button className="icon-btn menu-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
              <MenuIcon />
            </button>
            {emptySession
              ? null
              : (
                <div className="main-title">
                  {activeFunction
                    ? (
                      <>
                        <div className="main-title-row">
                          <h1>{activeFunction.label}</h1>
                          <button className="function-back" onClick={() => setFunctionView(null)}>
                            返回会话
                          </button>
                        </div>
                        <p className="main-sub">{activeFunction.description}</p>
                      </>
                    )
                    : (
                      <>
                        <h1>{harness.session?.title ?? 'New session'}</h1>
                        <nav className="main-tabs" role="tablist" aria-label="对话视图">
                          {MAIN_TABS.map(tab => (
                            <button
                              key={tab.id}
                              type="button"
                              role="tab"
                              aria-selected={mainView === tab.id}
                              className={mainView === tab.id ? 'active' : ''}
                              onClick={() => {
                                setFunctionView(null)
                                setMainView(tab.id)
                              }}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </nav>
                      </>
                    )}
                </div>
              )}
          </div>

          {emptySession
            ? null
            : (
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
            )}

          {emptySession
            ? null
            : (
              <div className="main-head-right">
                <Slot name="header.actions" props={{ sessionId }} />
                <div className="main-tools" role="toolbar" aria-label="面板">
                  <OpenInMenu sessionId={sessionId} workspace={harness.session?.workspace} />
                  <span className="main-tools-sep" />
                  <button
                    className={`icon-btn ${sessionDockOpen ? 'active' : ''}`}
                    onClick={() => setSessionDockOpen(value => !value)}
                    aria-label="会话信息"
                    aria-expanded={sessionDockOpen}
                    title={sessionDockOpen ? '收起会话栏' : '展开会话栏'}
                  >
                    <ListIcon size={16} />
                  </button>
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
                  <button
                    className={`icon-btn ${fileOpen && panelView === 'preview' ? 'active' : ''}`}
                    onClick={() => showFilePanel('preview')}
                    aria-label="预览"
                    title="预览本地服务器"
                  >
                    <MonitorIcon size={16} />
                  </button>
                  <button
                    className={`icon-btn ${fileOpen && panelView === 'terminal' ? 'active' : ''}`}
                    onClick={() => showFilePanel('terminal')}
                    aria-label="终端"
                    title={`终端 (${modKeyLabel()}J)`}
                  >
                    <TerminalIcon size={16} />
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
            )}
        </header>
        {harness.error
          ? (
            <div className="error-bar">
              <span>{harness.error}</span>
              <button onClick={harness.dismissError} aria-label="Dismiss">×</button>
            </div>
          )
          : null}

        {functionView
          ? (
            <FunctionWorkspace
              view={functionView}
              toolTab={toolsTab}
              onToolTabChange={setToolsTab}
              sessionId={harness.session?.id}
              onBack={() => setFunctionView(null)}
            />
          )
          : mainView === 'chat'
          ? (
            <div className="main-body">
              <div className="main-content">
              <Transcript
                session={harness.session}
                activity={activity}
                asks={harness.asks}
                onAnswerAsk={harness.answerAsk}
                onEditQueued={(queuedId) => {
                  const session = harness.session
                  if (!session) return
                  void harness.withdrawQueued(session.id, queuedId).then((taken) => {
                    if (!taken) return
                    setRestoredDrop({
                      text: taken.text,
                      ...(taken.attachments?.length ? { attachments: taken.attachments } : {}),
                      token: Date.now(),
                    })
                  })
                }}
                onWithdrawQueued={(queuedId) => {
                  const session = harness.session
                  if (session) void harness.withdrawQueued(session.id, queuedId)
                }}
              />

              <TodoPanel todo={harness.todo} />

              {harness.planProposal
                ? (
                  <div className="approval-stack">
                    <PlanCard
                      proposal={harness.planProposal}
                      onAccept={() => harness.decidePlan(harness.planProposal!.id, 'accept')}
                      onRevise={feedback => harness.decidePlan(harness.planProposal!.id, 'revise', feedback)}
                    />
                  </div>
                )
                : null}

              {harness.commitProposal
                ? (
                  <div className="approval-stack">
                    <CommitCard
                      proposal={harness.commitProposal}
                      onCommit={message => harness.commitChanges(harness.commitProposal!.id, message)}
                      onDismiss={() => harness.dismissCommit(harness.commitProposal!.id)}
                    />
                  </div>
                )
                : null}

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
                sessionId={sessionId}
                workspace={harness.session?.workspace}
                provider={harness.session?.provider}
                model={harness.session?.model || 'ruobai-chat'}
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
                restore={restoredDrop}
                onNewSession={() => setWorkspacePickerOpen(true)}
                onOpenConnectors={() => {
                  setToolsTab('connectors')
                  setFunctionView('tools')
                }}
                reference={reference}
              />
              </div>
              {emptySession
                ? null
                : (
                  <SessionDock
                    session={harness.session}
                    open={sessionDockOpen}
                    onOpenContext={() => {
                      setFunctionView(null)
                      setMainView('context')
                    }}
                    onOpenGit={() => {
                      setPanelView('git')
                      setFileOpen(true)
                    }}
                    onOpenFile={(path) => {
                      setFileRequest({ path, token: Date.now() })
                      setPanelView('files')
                      setFileOpen(true)
                    }}
                    onOpenSettings={() => openSettings('behavior')}
                    onOpenChanges={() => {
                      setFunctionView(null)
                      setMainView('changes')
                    }}
                  />
                )}
            </div>
          )
          : mainView === 'changes'
            ? <ChangesView session={harness.activeId ? harness.session : null} />
            : mainView === 'trajectory'
              ? <TrajectoryView session={harness.activeId ? harness.session : null} />
            : mainView === 'handoff'
              ? <HandoffView session={harness.activeId ? harness.session : null} />
            : (
              <ContextView
                session={harness.activeId ? harness.session : null}
                context={harness.contextInfo}
                onRefresh={harness.refreshContext}
              />
            )}
      </main>

      {fileOpen
        ? (
          <DetailsPanel
            session={harness.session}
            view={panelView}
            width={detailsWidth}
            expanded={expandedPanel === 'file'}
            onToggleExpand={toggleExpandPanel}
            onResize={resizeDetails}
            onClose={() => {
              setFileOpen(false)
              if (expandedPanel === 'file') setExpandedPanel(null)
            }}
            onReferenceFile={(path) => setReference({ path, token: Date.now() })}
            openPath={fileRequest ?? undefined}
            onOpenGit={() => {
              setPanelView('git')
              setFileOpen(true)
            }}
          />
        )
        : null}

      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        sessionId={sessionId}
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
          setFunctionView(null)
          setMainView('chat')
          // The empty session on screen already is the new session; choosing
          // its folder again should return to it, not replace it.
          if (!harness.session?.messages.length && harness.session?.workspace === path) return
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
      <FastTooltips />
    </div>
  )
}
