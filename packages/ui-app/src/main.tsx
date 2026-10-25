import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ContextMenuProvider } from './components/ContextMenu.tsx'
import './slots.ts'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing')

createRoot(root).render(
  <StrictMode>
    <ContextMenuProvider>
      <App />
    </ContextMenuProvider>
  </StrictMode>,
)
