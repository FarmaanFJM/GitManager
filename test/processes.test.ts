import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LineSplitter, ServiceManager, serviceSpec, stripAnsi } from '../src/core/processes.js'
import type { Launch } from '../src/core/profiles.js'
import { probePort } from '../src/core/readiness.js'
import type { Readiness, ServiceState } from '../src/shared/types.js'

const FIXTURE = join(__dirname, 'fixtures', 'service.cjs')
const node = (args: string) => `"${process.execPath}" "${FIXTURE}" ${args}`

async function freePort(): Promise<number> {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
}
import { readFileSync } from 'node:fs'
/** A zombie counts as dead: some containers run a PID 1 that never reaps orphans, which a desktop OS does. */
const alive = (pid: number) => {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

function launch(command: string, readiness: Readiness = { type: 'none' }, extra: Partial<Launch> = {}): Launch {
  return { key: 'p:s', repoId: 'r', profileId: 'p', serviceId: 's', name: 'svc', runtime: { kind: 'native' }, dir: __dirname, command, env: {}, readiness, readyTimeout: 20, ...extra }
}

function until(m: ServiceManager, key: string, states: ServiceState[], ms = 15000): Promise<ServiceState> {
  return new Promise((resolve, reject) => {
    const cur = m.get(key)?.state
    if (cur && states.includes(cur)) return resolve(cur)
    const t = setTimeout(() => { m.off('status', h); reject(new Error(`timed out waiting for ${states.join('/')}, last ${m.get(key)?.state}`)) }, ms)
    const h = (s: { key: string; state: ServiceState }) => { if (s.key === key && states.includes(s.state)) { clearTimeout(t); m.off('status', h); resolve(s.state) } }
    m.on('status', h)
  })
}

const managers: ServiceManager[] = []
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(managers.map(m => m.stopAll()))
  managers.length = 0
  await Promise.all(servers.map(s => new Promise(r => s.close(r))))
  servers.length = 0
})
const manager = (o = {}) => { const m = new ServiceManager({ pollMs: 100, graceMs: 3000, ...o }); managers.push(m); return m }
const textOf = (m: ServiceManager, key = 'p:s') => m.logs(key).map(l => l.text).join('\n')

describe('process lifecycle', () => {
  it('is starting until the port answers, then ready; stop ends the whole tree and frees the port', async () => {
    const [port, childPort] = [await freePort(), await freePort()]
    const m = manager()
    const st = await m.start(launch(node(`${port} --child ${childPort} --delay 700`), { type: 'port', port }))
    expect(st.state).toBe('starting')
    expect(await until(m, 'p:s', ['ready', 'failed'])).toBe('ready')
    expect(await probePort('127.0.0.1', childPort)).toBe(true)
    const childPid = Number(/child pid (\d+)/.exec(textOf(m))?.[1])
    const pid = m.get('p:s')!.pid!
    expect(textOf(m)).toContain('starting pid') // ANSI colour codes removed
    expect(textOf(m)).not.toContain('\x1b[')

    await m.stop('p:s')
    expect(m.get('p:s')!.state).toBe('stopped')
    await new Promise(r => setTimeout(r, 200))
    expect(alive(pid)).toBe(false)
    expect(alive(childPid)).toBe(false)
    expect(await probePort('127.0.0.1', port)).toBe(false)
    expect(await probePort('127.0.0.1', childPort)).toBe(false)
  })

  it('refuses to start when another process already uses the readiness port, and leaves that process alone', async () => {
    const port = await freePort()
    const other = http.createServer((q, s) => s.end('other')); servers.push(other)
    await new Promise<void>(r => other.listen(port, '127.0.0.1', () => r()))
    const m = manager()
    const st = await m.start(launch(node(`${port}`), { type: 'http', url: `http://127.0.0.1:${port}/` }))
    expect(st.state).toBe('failed')
    expect(st.message).toMatch(/already in use/)
    expect(st.pid).toBeNull()
    expect(await probePort('127.0.0.1', port)).toBe(true)
  })

  it('stopping one service does not affect an unrelated process', async () => {
    const [port, otherPort] = [await freePort(), await freePort()]
    const other = http.createServer((q, s) => s.end('other')); servers.push(other)
    await new Promise<void>(r => other.listen(otherPort, '127.0.0.1', () => r()))
    const m = manager()
    await m.start(launch(node(`${port}`), { type: 'http', url: `http://127.0.0.1:${port}/` }))
    expect(await until(m, 'p:s', ['ready', 'failed'])).toBe('ready')
    await m.stop('p:s')
    expect(await probePort('127.0.0.1', otherPort)).toBe(true)
  })

  it('reports a failing command with its exit code and stderr', async () => {
    const m = manager()
    await m.start(launch(node('0 --fail 3')))
    expect(await until(m, 'p:s', ['failed', 'stopped'])).toBe('failed')
    expect(m.get('p:s')).toMatchObject({ exitCode: 3, message: 'Exited with code 3.' })
    expect(m.logs('p:s').some(l => l.stream === 'err' && l.text.includes('boom'))).toBe(true)
  })

  it('without a readiness check a live process is running, never ready', async () => {
    const m = manager()
    await m.start(launch(node('0')))
    expect(m.get('p:s')!.state).toBe('running')
    await m.stop('p:s')
    expect(m.get('p:s')!.state).toBe('stopped')
  })

  it('fails when the readiness check never passes, but keeps the process for the user to stop', async () => {
    const port = await freePort()
    const m = manager()
    await m.start(launch(node('0'), { type: 'port', port }, { readyTimeout: 1 }))
    expect(await until(m, 'p:s', ['failed', 'ready'], 8000)).toBe('failed')
    expect(m.get('p:s')!.message).toMatch(/Not reachable/)
    expect(m.isAlive('p:s')).toBe(true)
    await m.stop('p:s')
    expect(m.isAlive('p:s')).toBe(false)
  })

  it('forces a process that ignores the graceful signal after the grace period', async () => {
    const m = manager({ graceMs: 800 })
    await m.start(launch(node('0 --ignore-term')))
    await new Promise(r => setTimeout(r, 300))
    const pid = m.get('p:s')!.pid!
    await m.stop('p:s')
    expect(m.get('p:s')!.state).toBe('stopped')
    expect(alive(pid)).toBe(false)
  })

  it('restarts with a new process and becomes ready again', async () => {
    const port = await freePort()
    const m = manager()
    await m.start(launch(node(`${port}`), { type: 'port', port }))
    await until(m, 'p:s', ['ready'])
    const first = m.get('p:s')!.pid
    await m.restart('p:s')
    expect(await until(m, 'p:s', ['ready', 'failed'])).toBe('ready')
    expect(m.get('p:s')!.pid).not.toBe(first)
  })

  it('runs several services concurrently with independent states', async () => {
    const [a, b] = [await freePort(), await freePort()]
    const m = manager()
    await m.start(launch(node(`${a} --delay 200`), { type: 'port', port: a }, { key: 'p:front', serviceId: 'front' }))
    await m.start(launch(node(`${b} --delay 1500`), { type: 'port', port: b }, { key: 'p:back', serviceId: 'back' }))
    expect(await until(m, 'p:front', ['ready'])).toBe('ready')
    expect(m.get('p:back')!.state).toBe('starting')
    expect(await until(m, 'p:back', ['ready'])).toBe('ready')
    expect(m.activeForRepo('r')).toHaveLength(2)
    await m.stop('p:front')
    expect(m.get('p:back')!.state).toBe('ready')
    expect(m.activeForRepo('r')).toHaveLength(1)
  })
})

describe('log lines and launch commands', () => {
  it('collapses carriage-return progress and strips colours', () => {
    const lines: string[] = []
    const s = new LineSplitter(l => lines.push(l))
    s.push('\x1b[1mBuild\x1b[22m 10%\r20%\r100%\nnext li'); s.push('ne\r\n'); s.push('tail'); s.flush()
    expect(lines).toEqual(['100%', 'next line', 'tail'])
    expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain')
  })

  it('runs WSL services in their distribution as a separate process group', () => {
    const spec = serviceSpec(launch('./mvnw spring-boot:run', { type: 'none' }, { runtime: { kind: 'wsl', distro: 'Ubuntu' }, dir: '/home/me/app/backend', env: { SPRING_PROFILES_ACTIVE: 'dev' } }), 'windows')
    expect(spec.file).toBe('wsl.exe')
    expect(spec.args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/app/backend', '--exec', 'env'])
    expect(spec.args).toContain('SPRING_PROFILES_ACTIVE=dev')
    expect(spec.args.slice(-5, -1)).toEqual(['setsid', '-w', 'bash', '-lc'])
    expect(spec.args.at(-1)).toMatch(/GM_PGID %s.*"\$\$"; \.\/mvnw spring-boot:run$/)
    expect(spec.cwd).toBeUndefined()
  })

  it('runs native Windows services through cmd.exe in the service directory', () => {
    const spec = serviceSpec(launch('npm run dev', { type: 'none' }, { dir: 'C:\\code\\app\\frontend' }), 'windows')
    expect(spec.args).toEqual(['/d', '/s', '/c', '"npm run dev"'])
    expect(spec.windowsVerbatimArguments).toBe(true)
    expect(spec.cwd).toBe('C:\\code\\app\\frontend')
  })
})
