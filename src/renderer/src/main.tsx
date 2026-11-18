import { createRoot } from 'react-dom/client'
import '@fontsource/figtree/400.css'
import '@fontsource/figtree/700.css'
import '@fontsource/figtree/900.css'
import './styles.css'
import App from './App'
import { Boundary } from './components/ui'

// Errors outside React's render (event handlers, timers, promises nobody awaited) go to the app
// log too (see main/log.ts), as do connection changes, which explain many of them.
const where = (e: ErrorEvent) => (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '')
// (Chromium's "ResizeObserver loop" notice is harmless and can come many times a second.)
window.addEventListener('error', (e) => !e.message?.startsWith('ResizeObserver loop') && window.ytm.log(`${e.error?.stack ?? e.message}${where(e)}`))
window.addEventListener('unhandledrejection', (e) =>
  window.ytm.log(`unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`)
)
window.addEventListener('online', () => window.ytm.log('online', 'info'))
window.addEventListener('offline', () => window.ytm.log('offline', 'warn'))

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>
)
