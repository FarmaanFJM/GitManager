// Runs in the sandboxed preload context: it may require only 'electron'. It exposes exactly the methods in
// src/shared/api.ts as window.gitmanager, each a plain request to the main process. No Node API reaches the page.
import { contextBridge, ipcRenderer } from 'electron'
import type { GitManagerApi } from '../shared/api.js'

// Kept in sync with API_METHODS (test/ipc.test.ts checks this file against it).
const METHODS = [
  'platform', 'state', 'pickFolder', 'addRepo', 'removeRepo', 'selectRepo', 'status', 'checkRemote', 'fetch', 'pull', 'branches',
  'switchBranch', 'trackBranch', 'log', 'compare', 'openFolder', 'openEditor', 'openUrl', 'wslDistros', 'addRoot', 'removeRoot',
  'scanRoot', 'addRepos', 'draftProfile', 'saveProfile', 'removeProfile', 'selectProfile', 'previewLaunch', 'trustProfile',
  'startServices', 'stopServices', 'restartService', 'logs', 'clearLogs', 'saveSettings', 'startupState',
  'discoveryStatus', 'rescan', 'unignoreRepo', 'branchOverview', 'branchDetail', 'setCompareBase',
]
const EVENTS = ['service-status', 'service-logs', 'logs-cleared', 'discovery-status', 'repo-added']

const api: Record<string, unknown> = {}
for (const m of METHODS) api[m] = (...args: unknown[]) => ipcRenderer.invoke(`gm:${m}`, ...args)
api.on = (event: string, cb: (payload: unknown) => void) => {
  if (!EVENTS.includes(event)) throw new Error(`unknown event ${event}`)
  const listener = (_e: unknown, payload: unknown) => cb(payload)
  ipcRenderer.on(`gm:event:${event}`, listener)
  return () => { ipcRenderer.removeListener(`gm:event:${event}`, listener) }
}

contextBridge.exposeInMainWorld('gitmanager', api as unknown as GitManagerApi)
