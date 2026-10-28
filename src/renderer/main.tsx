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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
)
