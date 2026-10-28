// Summa-UI, pinned at guidance-v0.1.0: tokens and presets from the vendored bundle, shared component CSS from the
// reference implementation (both verified by npm run verify:summa-ui). GitManager's own layout comes last.
import '../../third_party/summa-ui/guidance/css/tokens.css'
import '../../third_party/summa-ui/src/styles/base.css'
import '../../third_party/summa-ui/guidance/css/presets.css'
import './app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfirmProvider, ToastProvider } from '../../third_party/summa-ui/src/presets'
import { App } from './App'

// Windows (src/main/chrome.ts): the page draws the title bar area around Windows' caption buttons (app.css, "title bar").
// The window loads hidden (until ready, or in the tray when started minimized), and the overlay only reports itself
// visible once the window is shown, so the layout follows its geometrychange event rather than a check at load.
const wco = (navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean } }).windowControlsOverlay
const syncTitlebar = () => {
  if (wco?.visible) document.documentElement.dataset.titlebar = 'overlay'
  else delete document.documentElement.dataset.titlebar
}
syncTitlebar()
wco?.addEventListener('geometrychange', syncTitlebar)
document.addEventListener('visibilitychange', syncTitlebar)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <div className="gm-titlebar" aria-hidden="true" />
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
)
