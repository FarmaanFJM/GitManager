// Development: Vite dev server for the renderer (hot reload), the main process compiled once, Electron pointed at Vite.
// Restart this script after changing files in src/main, src/core or src/shared.
import { spawn, execSync } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

execSync('npx tsc -p tsconfig.main.json', { stdio: 'inherit' })
const server = await createServer({ configFile: 'vite.config.mts' })
await server.listen()
const url = `http://localhost:${server.config.server.port}/`
const electron = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, GITMANAGER_DEV_URL: url } })
electron.on('exit', async code => { await server.close(); process.exit(code ?? 0) })
