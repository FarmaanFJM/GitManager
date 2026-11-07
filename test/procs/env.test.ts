import { describe, expect, it } from 'vitest'
import {
  LaunchEnvStore, captureLaunchEnv, configFormatOf, isSensitiveName, isSensitiveValue, parseDotenv, parseProperties, parseYamlFlat, readConfigFiles, redactForLog, runtimeEnvOf, type ConfigFs,
} from '../../src/core/procs/env.js'
import { procKey } from '../../src/core/procs/model.js'
import type { ProcInfo } from '../../src/shared/procs.js'
import { FakeAdapter } from './fakes.js'

describe('sensitivity heuristics', () => {
  it('flags names that usually hold secrets', () => {
    for (const n of ['API_KEY', 'apiKey', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'DB_PASSWD', 'PWD_HASH', 'spring.datasource.password', 'CREDENTIALS', 'PRIVATE_KEY', 'SSH_AUTH_SOCK', 'ConnectionString', 'CONNECTION_STRING', 'MONGODB_URI', 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'jwt', 'x-api-key', 'client_secret', 'SESSION_ID', 'STRIPE_APIKEY'])
      expect(isSensitiveName(n), n).toBe(true)
  })
  it('does not flag ordinary names', () => {
    for (const n of ['PATH', 'HOME', 'PORT', 'NODE_ENV', 'JAVA_HOME', 'AUTHOR', 'KEYBOARD', 'LANG', 'spring.profiles.active', 'server.port', 'PUBLIC_URL', 'API_URL'])
      expect(isSensitiveName(n), n).toBe(false)
  })
  it('flags values with embedded credentials and token formats', () => {
    expect(isSensitiveValue('postgres://app:hunter2@db:5432/x')).toBe(true)
    expect(isSensitiveValue('https://github.com/x/y')).toBe(false)
    expect(isSensitiveValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123')).toBe(true)
    expect(isSensitiveValue('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true)
    expect(isSensitiveValue('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe(true)
    expect(isSensitiveValue('8080')).toBe(false)
  })
})

describe('redactForLog', () => {
  it('masks sensitive assignments, urls, jwt and bearer tokens but leaves the rest', () => {
    const t = 'start PORT=8080 DB_PASSWORD=hunter2 url=postgres://app:hunter2@db/x Authorization: Bearer abcdefghijklmnop token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig export API_KEY="a b c" name=value'
    const r = redactForLog(t)
    expect(r).not.toContain('hunter2'); expect(r).not.toContain('abcdefghijklmnop'); expect(r).not.toContain('eyJhbGci'); expect(r).not.toContain('a b c')
    expect(r).toContain('PORT=8080'); expect(r).toContain('name=value'); expect(r).toContain('postgres://app:***@db/x')
  })
  it('masks private key blocks', () => {
    expect(redactForLog('k\n-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\nafter')).toBe('k\n[private key ***]\nafter')
  })
})

describe('dotenv parsing', () => {
  const p = parseDotenv([
    '# comment', '', 'PLAIN=value', 'export EXPORTED=yes', 'SPACED = padded value  ', 'INLINE=abc # trailing comment', 'HASH=a#b',
    'DQ="line1\\nline2 \\"q\\" \\\\ # not comment"', "SQ='raw \\n # kept'", 'MULTI="first', 'second', 'third"  # after', 'EMPTY=', 'DUP=1', 'DUP=2',
    'SECRET_TOKEN=abc', 'not a valid line', 'BAD="unterminated', 'AFTER=ok',
  ].join('\n'))
  const get = (n: string) => p.entries.filter(e => e.name === n)
  it('handles comments, export, spacing and inline comments', () => {
    expect(get('PLAIN')[0]).toMatchObject({ value: 'value', line: 3 })
    expect(get('EXPORTED')[0].value).toBe('yes')
    expect(get('SPACED')[0].value).toBe('padded value')
    expect(get('INLINE')[0].value).toBe('abc')
    expect(get('HASH')[0].value).toBe('a#b')
    expect(get('EMPTY')[0].value).toBe('')
  })
  it('handles quotes, escapes and multi-line values', () => {
    expect(get('DQ')[0].value).toBe('line1\nline2 "q" \\ # not comment')
    expect(get('SQ')[0].value).toBe('raw \\n # kept')
    expect(get('MULTI')[0]).toMatchObject({ value: 'first\nsecond\nthird', line: 10 })
    expect(get('AFTER')[0].value).toBe('ok')
  })
  it('marks overridden duplicates, sensitivity and reports bad lines', () => {
    expect(get('DUP').map(e => [e.value, !!e.overridden])).toEqual([['1', true], ['2', false]])
    expect(get('SECRET_TOKEN')[0].sensitive).toBe(true)
    expect(p.parseErrors.map(e => e.line)).toEqual(expect.arrayContaining([17, 18]))
    expect(get('BAD')).toHaveLength(1)
  })
  it('never truncates values', () => {
    const long = 'x'.repeat(5000)
    expect(parseDotenv(`BIG=${long}`).entries[0].value).toBe(long)
  })
})

describe('Spring properties and yaml', () => {
  it('parses properties: separators, comments, continuation, escapes', () => {
    const r = parseProperties(['# c', '! c2', 'server.port=8080', 'spring.datasource.url = jdbc:mysql://h/db', 'spring.datasource.password:s3cret', 'key with space value', 'multi=a\\', '   b', 'uni=\\u0041\\tB', 'empty='].join('\n'))
    const m = Object.fromEntries(r.entries.map(e => [e.name, e.value]))
    expect(m).toEqual({ 'server.port': '8080', 'spring.datasource.url': 'jdbc:mysql://h/db', 'spring.datasource.password': 's3cret', key: 'with space value', multi: 'ab', uni: 'A\tB', empty: '' })
    expect(r.entries.find(e => e.name === 'spring.datasource.password')!.sensitive).toBe(true)
  })
  it('flattens yaml mappings, lists, block scalars, quotes and multiple documents', () => {
    const y = [
      'server:', '  port: 8081  # comment', 'spring:', '  datasource:', '    url: "jdbc:postgresql://h:5432/db"', `    password: 'it''s'`, '    hikari:', '      maximum-pool-size: 5',
      '  profiles:', '    include:', '      - dev', '      - local', 'management:', '  endpoints:', '    web:', '      exposure:', '        include: health,info',
      'servers:', '  - name: a', '    port: 1', '  - name: b', '    port: 2', 'script: |', '  line1', '  line2', 'folded: >', '  a', '  b', 'empty:', 'last: x',
      '---', 'spring:', '  config:', '    activate:', '      on-profile: prod', 'server:', '  port: 9000',
    ].join('\n')
    const r = parseYamlFlat(y)
    const m = Object.fromEntries(r.entries.filter(e => !e.overridden).map(e => [e.name, e.value]))
    expect(m['server.port']).toBe('9000')
    expect(m['spring.datasource.url']).toBe('jdbc:postgresql://h:5432/db')
    expect(m['spring.datasource.password']).toBe("it's")
    expect(m['spring.datasource.hikari.maximum-pool-size']).toBe('5')
    expect(m['spring.profiles.include[0]']).toBe('dev'); expect(m['spring.profiles.include[1]']).toBe('local')
    expect(m['management.endpoints.web.exposure.include']).toBe('health,info')
    expect(m['servers[0].name']).toBe('a'); expect(m['servers[1].port']).toBe('2')
    expect(m.script).toBe('line1\nline2'); expect(m.folded).toBe('a b'); expect(m.empty).toBe(''); expect(m.last).toBe('x')
    expect(m['spring.config.activate.on-profile']).toBe('prod')
    expect(r.entries.filter(e => e.name === 'server.port').map(e => !!e.overridden)).toEqual([true, false])
    expect(r.parseErrors).toEqual([])
  })
  it('reports unsupported syntax instead of guessing', () => {
    const r = parseYamlFlat('base: &b\n  a: 1\nother: *b\n\tbad: 1')
    expect(r.parseErrors.length).toBeGreaterThanOrEqual(1)
  })
})

describe('readConfigFiles', () => {
  const files: Record<string, string> = {
    '/svc/.env': 'A=1', '/svc/.env.local': 'B=2', '/svc/.env.development': 'C=3', '/svc/.env.production.local': 'D=4', '/svc/.env.example': 'X=template', '/svc/readme.md': '# x',
    '/svc/src/main/resources/application.properties': 'server.port=8080', '/svc/src/main/resources/application-dev.yml': 'a:\n  b: 1', '/svc/config/application.yaml': 'c: d',
  }
  const fs: ConfigFs = {
    async listDir(d) { const pre = d.replace(/\/$/, '') + '/'; const names = Object.keys(files).filter(f => f.startsWith(pre) && !f.slice(pre.length).includes('/')).map(f => f.slice(pre.length)); return names.length ? names : null },
    async readFile(f) { return files[f] ?? null },
  }
  it('finds dotenv and Spring files, skips templates, and marks them as not runtime', async () => {
    const r = await readConfigFiles('/svc', undefined, fs)
    expect(r.map(f => f.path)).toEqual(expect.arrayContaining(['/svc/.env', '/svc/.env.local', '/svc/.env.development', '/svc/.env.production.local', '/svc/config/application.yaml', '/svc/src/main/resources/application.properties', '/svc/src/main/resources/application-dev.yml']))
    expect(r.map(f => f.path)).not.toContain('/svc/.env.example')
    for (const f of r) { expect(f.kind).toBe('config-file'); expect(f.note).toMatch(/not what a running process resolved/); expect(f.note).toMatch(/does not update a process that is already running/) }
    expect(r.find(f => f.path.endsWith('application-dev.yml'))).toMatchObject({ format: 'yaml', entries: [{ name: 'a.b', value: '1' }] })
  })
  it('honours explicit names, including templates', async () => {
    const r = await readConfigFiles('/svc', ['.env.example'], fs)
    expect(r.map(f => f.path)).toEqual(['/svc/.env.example'])
  })
  it('classifies file names', () => {
    expect(configFormatOf('.env')).toBe('dotenv'); expect(configFormatOf('application-prod.yaml')).toBe('yaml'); expect(configFormatOf('application.properties')).toBe('properties')
    expect(configFormatOf('.envrc')).toBeNull(); expect(configFormatOf('.env.sample')).toBeNull(); expect(configFormatOf('pom.xml')).toBeNull()
  })
})

describe('launch environment', () => {
  it('captures exactly the merged environment: base < env file < service', () => {
    expect(captureLaunchEnv({ PATH: '/bin', A: 'base', U: undefined }, { A: 'svc', S: '1' }, { A: 'file', F: '2' })).toEqual({ PATH: '/bin', A: 'svc', S: '1', F: '2' })
  })
  it('bounds memory and returns copies', () => {
    const s = new LaunchEnvStore(3)
    const env = { A: '1' }
    for (let i = 0; i < 5; i++) s.record(`svc${i}`, i, env)
    env.A = 'changed'
    expect(s.size).toBe(3)
    expect(s.get('svc0', 0)).toBeUndefined()
    expect(s.get('svc4', 4)!.env.A).toBe('1')
    s.record('svc4', 9, { A: 'new' })
    expect(s.latest('svc4')!.pid).toBe(9)
    s.forget('svc4'); expect(s.latest('svc4')).toBeUndefined()
  })
})

describe('runtimeEnvOf', () => {
  const info = (p: Partial<ProcInfo>): ProcInfo => ({ key: 'native:7', context: { kind: 'native' }, pid: 7, name: 'x', command: 'x', ports: [], owner: 'external', canStop: true, ...p })
  it('uses the launch environment for managed processes, full values and sensitive flags', async () => {
    const store = new LaunchEnvStore(); store.record('p:s', 7, { PORT: '8080', DB_PASSWORD: 'p'.repeat(300) })
    const s = await runtimeEnvOf(info({ owner: 'gitmanager', serviceKey: 'p:s' }), { launchEnv: store })
    expect(s.source).toBe('runtime-launch')
    expect(s.entries).toEqual([{ name: 'DB_PASSWORD', value: 'p'.repeat(300), sensitive: true }, { name: 'PORT', value: '8080', sensitive: false }])
  })
  it('uses ownership launchEnv, and falls back to the service latest launch for descendants', async () => {
    const own = { managedPids: () => new Map([[procKey({ kind: 'native' }, 7), { serviceKey: 'p:s', repoId: 'r', launchEnv: { A: '1' } }]]) }
    expect((await runtimeEnvOf(info({ owner: 'gitmanager', serviceKey: 'p:s' }), { ownership: own })).entries).toEqual([{ name: 'A', value: '1', sensitive: false }])
    const store = new LaunchEnvStore(); store.record('p:s', 1, { ROOT: 'yes' })
    const child = await runtimeEnvOf(info({ pid: 8, key: 'native:8', owner: 'gitmanager', serviceKey: 'p:s' }), { launchEnv: store })
    expect(child).toMatchObject({ source: 'runtime-launch', entries: [{ name: 'ROOT' }] })
    expect(child.note).toMatch(/inherits/)
  })
  it('reads live environments of external unix processes', async () => {
    const a = new FakeAdapter({ kind: 'native' }); a.env = { ok: true, entries: [{ name: 'Z', value: '1' }, { name: 'A_TOKEN', value: 't' }], note: 'live' }
    const s = await runtimeEnvOf(info({}), { adapter: a })
    expect(s).toMatchObject({ source: 'runtime-live', note: 'live', entries: [{ name: 'A_TOKEN', sensitive: true }, { name: 'Z', sensitive: false }] })
  })
  it('is unavailable with an honest reason otherwise', async () => {
    const a = new FakeAdapter({ kind: 'native' }, [], 'windows'); a.env = { ok: false, reason: 'Windows does not expose another process environment without elevation or a debugger.' }
    const s = await runtimeEnvOf(info({}), { adapter: a })
    expect(s).toMatchObject({ source: 'unavailable', entries: [], reason: 'Windows does not expose another process environment without elevation or a debugger.' })
    expect((await runtimeEnvOf(info({}), {})).source).toBe('unavailable')
  })
})
