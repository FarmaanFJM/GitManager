import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server needs an inline React refresh preamble and a websocket; the production bundle keeps the strict policy.
const devCsp = (): Plugin => ({
  name: 'gitmanager-dev-csp',
  apply: 'serve',
  transformIndexHtml: html => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws://localhost:5199"),
})

// The renderer is a plain static bundle loaded from disk by Electron (file://), so asset paths are relative.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), devCsp()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome140' },
  server: { port: 5199, strictPort: true },
})
