import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clampToWorkArea, type Rect } from './bounds.ts'
import { HarnessProcess } from './harness.ts'

interface DesktopState {
  workspace?: string
  bounds?: Rect
}

app.setName('Ruobai Harness')

let win: BrowserWindow | undefined
const harness = new HarnessProcess()
let quitting = false
let workspace = ''

function stateFile() {
  return join(app.getPath('userData'), 'desktop.json')
}

function readState(): DesktopState {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as DesktopState
  } catch {
    return {}
  }
}

function writeState(state: DesktopState) {
  try {
    writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`)
  } catch (error) {
    console.error('[desktop] failed to save state', error)
  }
}

let state = readState()

function findHarnessRoot(start: string): string {
  let dir = start
  while (true) {
    if (existsSync(join(dir, 'cordis.yml')) && existsSync(join(dir, 'apps/cli/package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('cordis.yml not found; set RUOBAI_HARNESS_ROOT')
    dir = parent
  }
}

function harnessRoot() {
  const override = process.env.RUOBAI_HARNESS_ROOT
  if (override) return resolve(override)
  // electron-builder copies the deployed runtime to Resources/harness.
  if (app.isPackaged) return join(process.resourcesPath, 'harness')
  return findHarnessRoot(dirname(fileURLToPath(import.meta.url)))
}

/** `electron . <dir>` or `--workspace <dir>`; the last session wins otherwise. */
function initialWorkspace(root: string) {
  const argv = process.argv.slice(1)
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--workspace' && argv[index + 1]) return resolve(argv[index + 1]!)
    if (arg.startsWith('--workspace=')) return resolve(arg.slice('--workspace='.length))
  }

  // Electron's argv also carries its own app path (and Chromium switches), so
  // only a positional that is a real directory and not the app itself counts.
  const appPath = resolve(app.getAppPath())
  for (const arg of argv) {
    if (arg === '--' || arg.startsWith('-')) continue
    const candidate = resolve(arg)
    if (candidate === appPath) continue
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }

  for (const candidate of [process.env.RUOBAI_WORKSPACE, state.workspace]) {
    if (candidate && existsSync(candidate)) return resolve(candidate)
  }
  // The checkout is the workspace in development; an installed app must not
  // write sessions, checkpoints and sandbox roots into its own bundle.
  return app.isPackaged ? app.getPath('documents') : root
}

function withToken(url: string) {
  const token = process.env.RBU_TOKEN
  if (!token) return url
  const target = new URL(url)
  target.searchParams.set('token', token)
  return target.toString()
}

/** Prefer the built UI; fall back to the Vite dev middleware while it is absent. */
function childEnv(root: string): NodeJS.ProcessEnv {
  if (process.env.RUOBAI_DESKTOP_UI === 'dev') return { NODE_ENV: 'development' }
  if (existsSync(join(root, 'packages/ui-app/dist/index.html'))) return { NODE_ENV: 'production' }
  return { NODE_ENV: 'development' }
}

function isHttp(url: string) {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const bounds = clampToWorkArea(state.bounds, area, { width: 1440, height: 900 })

  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101012',
    title: 'Ruobai Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.on('close', () => {
    state = { ...state, bounds: window.getBounds() }
    writeState(state)
  })
  window.on('closed', () => {
    if (win === window) win = undefined
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const current = harness.url
    if (!current) return
    if (new URL(url).origin === new URL(current).origin) return
    event.preventDefault()
    if (isHttp(url)) void shell.openExternal(url)
  })

  return window
}

async function launch(root: string, dir: string) {
  if (quitting) return
  try {
    // A packaged app has no system Node/tsx to borrow: the harness runs on
    // Electron's own Node (ELECTRON_RUN_AS_NODE) against the deployed runtime,
    // and web-static reads the bundled UI from RUOBAI_UI_ROOT.
    const packaged = app.isPackaged
    const url = await harness.start({
      root,
      workspace: dir,
      ...(packaged ? {
        node: process.execPath,
        entry: join(root, 'node_modules/@ruobai/harness-cli/src/bin.ts'),
        env: {
          ...childEnv(root),
          NODE_ENV: 'production',
          ELECTRON_RUN_AS_NODE: '1',
          RUOBAI_UI_ROOT: join(root, 'ui-app'),
        },
      } : { env: childEnv(root) }),
      onLog: line => process.stdout.write(`[harness] ${line}\n`),
      onExit: (code, signal) => {
        if (quitting) return
        const restart = dialog.showMessageBoxSync({
          type: 'error',
          title: 'Harness 已退出',
          message: `后台进程退出（code ${code ?? '-'}, signal ${signal ?? '-'}）`,
          detail: '可以重新启动，或退出桌面端。',
          buttons: ['退出', '重新启动'],
          defaultId: 1,
          cancelId: 0,
        })
        if (restart === 1) void relaunch(root, workspace)
        else app.quit()
      },
    })

    const target = withToken(url)
    if (!win) win = createWindow()
    await win.loadURL(target)
    win.setTitle(`Ruobai Harness — ${basename(dir)}`)

    workspace = dir
    state = { ...state, workspace: dir, bounds: win.getBounds() }
    writeState(state)
  } catch (error) {
    if (quitting) return
    dialog.showErrorBox('Ruobai Harness 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  }
}

async function relaunch(root: string, dir: string) {
  await harness.stop()
  await launch(root, dir)
}

async function chooseWorkspace() {
  const options: OpenDialogOptions = {
    title: '打开工作区',
    defaultPath: workspace,
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const dir = result.filePaths[0]
  if (result.canceled || !dir) return
  await relaunch(harnessRoot(), dir)
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '打开工作区…', accelerator: 'CmdOrCtrl+O', click: () => void chooseWorkspace() },
        {
          label: '在浏览器中打开',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            const url = harness.url
            if (url) void shell.openExternal(withToken(url))
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ role: 'front' as const }] : [{ role: 'close' as const }]),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

function isDesktopLocked() {
  return !app.requestSingleInstanceLock()
}

async function main() {
  if (isDesktopLocked()) {
    app.quit()
    return
  }

  await app.whenReady()

  const root = harnessRoot()
  workspace = initialWorkspace(root)

  // The harness UI needs clipboard write for copy buttons; everything else is
  // denied. File, shell and terminal access stay in the harness process, not
  // in the renderer.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read')
  })

  Menu.setApplicationMenu(buildMenu())

  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('activate', () => {
    if (win) return
    const url = harness.url
    if (url) {
      win = createWindow()
      void win.loadURL(withToken(url))
      return
    }
    void launch(root, workspace)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void harness.stop().finally(() => app.quit())
  })

  // Started from a terminal (or a supervisor): quit through the same path so
  // the harness child and its process group are reaped.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.quit())
  }

  await launch(root, workspace)
}

main().catch(error => {
  dialog.showErrorBox('Ruobai Harness 无法启动', error instanceof Error ? error.message : String(error))
  app.quit()
})
