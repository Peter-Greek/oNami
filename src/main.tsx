import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installBrowserOnami } from './browserOnami'

async function bootstrap() {
  await installBrowserOnami()
  if (new URLSearchParams(window.location.search).get('headless') === '1') return
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
