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
