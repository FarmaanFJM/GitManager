import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Readiness } from '../shared/types.js'

/**
 * One readiness probe. HTTP: any response below 500 counts (a 404 from a backend root still proves it is serving).
 * Port: a TCP connection is accepted. Probes run from Windows (the main process), so for WSL services a success also
 * proves the service is reachable through localhost forwarding, which is what the browser needs.
 */
export function probe(r: Readiness, timeoutMs = 2000): Promise<boolean> {
  if (r.type === 'none') return Promise.resolve(false)
  if (r.type === 'port') return probePort(r.host || 'localhost', r.port, timeoutMs)
  return new Promise(resolve => {
    let url: URL
    try { url = new URL(r.url) } catch { resolve(false); return }
    const mod = url.protocol === 'https:' ? https : http
    // Reachability only: a development server's self-signed certificate must not make it look down. Nothing is trusted or read.
    const req = mod.request(url, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false, headers: { 'user-agent': 'GitManager readiness check' } }, res => {
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

export function probePort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, timeout: timeoutMs, autoSelectFamily: true })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

export function describeReadiness(r: Readiness): string {
  if (r.type === 'http') return r.url
  if (r.type === 'port') return `${r.host || 'localhost'}:${r.port}`
  return ''
}
