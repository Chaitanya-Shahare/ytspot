import { createRoot } from 'react-dom/client'
import '@fontsource/figtree/400.css'
import '@fontsource/figtree/700.css'
import '@fontsource/figtree/900.css'
import './styles.css'
import App from './App'
import { Boundary } from './components/ui'

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>
)
