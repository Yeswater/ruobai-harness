import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ConfirmProvider } from './components/ConfirmDialog.tsx'
import { ContextMenuProvider } from './components/ContextMenu.tsx'
import { PromptProvider } from './components/PromptDialog.tsx'
import { applySkin, loadSkin } from './preferences.ts'
import './slots.ts'
import './styles.css'
import './panels.css'
import './design-system.css'

applySkin(loadSkin())

// The desktop shell hides the OS title bar and lets the UI stand in for it.
// Detect the shell rather than passing a flag: the same bundle is served to
// browsers, where none of this applies.
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('desktop-shell')
  if (navigator.userAgent.includes('Mac OS X')) document.documentElement.classList.add('desktop-mac')
}

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing')

createRoot(root).render(
  <StrictMode>
    <ContextMenuProvider>
      <ConfirmProvider>
        <PromptProvider>
          <App />
        </PromptProvider>
      </ConfirmProvider>
    </ContextMenuProvider>
  </StrictMode>,
)
