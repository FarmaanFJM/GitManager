import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { API_METHODS } from '../shared/api.js'
import { ValidationError } from '../core/validate.js'
import type { Backend } from './backend.js'

/**
 * Registers one handler per API method. Requests are accepted only from GitManager's own page (checked by frame URL),
 * argument validation errors become ordinary Results, and unexpected exceptions are logged and reported without
 * leaking stack traces to the page.
 */
export function registerIpc(backend: Backend, isTrustedUrl: (url: string) => boolean) {
  const methods = backend as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const name of API_METHODS) {
    ipcMain.handle(`gm:${name}`, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) throw new Error('Rejected request from an untrusted page.')
      try {
        return await methods[name].apply(backend, args)
      } catch (e) {
        if (e instanceof ValidationError) return { ok: false, error: { code: 'INVALID', message: e.message } }
        console.error(`[gitmanager] ${name} failed`, e)
        return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. The operation did not complete.', detail: (e as Error).message } }
      }
    })
  }
}

/** Forwards service events to the window. Log lines are already batched by the ServiceManager. */
export function forwardEvents(backend: Backend, target: () => WebContents | null) {
  const send = (event: string, payload: unknown) => { const wc = target(); if (wc && !wc.isDestroyed()) wc.send(`gm:event:${event}`, payload) }
  backend.services.on('status', s => send('service-status', s))
  backend.services.on('logs', b => send('service-logs', b))
  backend.services.on('logs-cleared', k => send('logs-cleared', k))
}
