import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { changedFiles, classifyChange, detectTech, serviceDir, summarizeAffected } from '../../src/core/affected.js'
import type { ChangedFile, ServiceDef } from '../../src/shared/types.js'
import { commit, git, isolateGitConfig, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const svc = (id: string, command: string, cwd = '', name = id): Pick<ServiceDef, 'id' | 'name' | 'command' | 'cwd'> => ({ id, name, command, cwd })
const M = (...p: string[]): ChangedFile[] => p.map(path => ({ status: 'M', path }))

describe('detectTech (from the command only)', () => {
  it.each([
    ['mvnw spring-boot:run', 'jvm', false], ['.\\mvnw.cmd -q spring-boot:run', 'jvm', false], ['./gradlew bootRun', 'jvm', false], ['java -jar target/app.jar', 'jvm', false],
    ['npm run dev', 'dev-server', true], ['pnpm dev', 'dev-server', true], ['yarn dev', 'dev-server', true], ['bun run dev', 'dev-server', true], ['npx vite --port 5173', 'dev-server', true],
    ['next dev', 'dev-server', true], ['webpack serve', 'dev-server', true], ['npm run start:dev', 'node', true],
    ['node server.js', 'node', false], ['nodemon server.js', 'node', true], ['tsx watch src/index.ts', 'node', true], ['tsx src/index.ts', 'node', false], ['node --watch app.js', 'node', true],
    ['uvicorn app:app', 'python', false], ['uvicorn app:app --reload', 'python', true], ['python manage.py runserver', 'python', true], ['flask run', 'python', false],
    ['dotnet run', 'dotnet', false], ['dotnet watch run', 'dotnet', true],
    ['npm start', 'unknown', false], ['./run.sh --port 3000', 'unknown', false], ['', 'unknown', false],
    ['NODE_ENV=dev node a.js', 'node', false], ['cd x && mvn spring-boot:run', 'jvm', false],
  ])('%s', (cmd, tech, watches) => { expect(detectTech(cmd)).toEqual({ tech, watches }) })

  it('ignores port numbers', () => { expect(detectTech('serve -l 8080').tech).toBe('unknown'); expect(detectTech('app --port 8080').tech).toBe('unknown') })
})

describe('serviceDir', () => {
  it('joins, normalizes Windows separators and rejects escapes', () => {
    expect(serviceDir('', '')).toBe('')
    expect(serviceDir('', 'backend')).toBe('backend')
    expect(serviceDir('apps', '.\\web\\ui\\')).toBe('apps/web/ui')
    expect(serviceDir('apps/x', '..\\y')).toBe('apps/y')
    expect(serviceDir('', '..')).toBeNull()
    expect(serviceDir('', 'C:\\other')).toBeNull()
    expect(serviceDir('', '/abs')).toBeNull()
  })
})

describe('classifyChange: JVM', () => {
  const s = svc('api', 'mvnw spring-boot:run', 'backend', 'Backend')
  it('config and descriptors need a restart', () => {
    for (const f of ['backend/src/main/resources/application.yml', 'backend/src/main/resources/application-dev.properties', 'backend/pom.xml', 'backend/build.gradle.kts', 'backend/settings.gradle', 'pom.xml']) {
      expect(classifyChange(M(f), s).verdict, f).toBe('restart-needed')
    }
  })
  it('source is only suggested; tests and docs are none', () => {
    expect(classifyChange(M('backend/src/main/java/A.java'), s)).toMatchObject({ verdict: 'restart-suggested', files: ['backend/src/main/java/A.java'] })
    expect(classifyChange(M('backend/src/test/java/ATest.java', 'backend/README.md', 'docs/x.md'), s).verdict).toBe('none')
  })
  it('the strongest verdict wins and samples at most 5 files', () => {
    const files = [...Array.from({ length: 8 }, (_, i) => `backend/src/main/java/A${i}.java`), 'backend/pom.xml']
    const r = classifyChange(M(...files), s)
    expect(r.verdict).toBe('restart-needed')
    expect(r.files).toEqual(['backend/pom.xml'])
    const many = classifyChange(M(...files.slice(0, 8)), s)
    expect(many.files).toHaveLength(5)
  })
})

describe('classifyChange: dev server, node, python, dotnet, unknown', () => {
  const fe = svc('web', 'npm run dev', 'frontend', 'Frontend')
  it('hot reloads source and assets, restarts for config', () => {
    expect(classifyChange(M('frontend/src/App.tsx', 'frontend/public/logo.svg', 'frontend/src/a.css'), fe).verdict).toBe('hot-reload')
    expect(classifyChange(M('frontend/vite.config.ts'), fe).verdict).toBe('restart-needed')
    expect(classifyChange(M('frontend/.env.local'), fe).verdict).toBe('restart-needed')
    expect(classifyChange(M('frontend/package-lock.json'), fe).verdict).toBe('restart-suggested')
    expect(classifyChange(M('frontend/package.json'), fe).verdict).toBe('restart-suggested')
    expect(classifyChange(M('frontend/tsconfig.json'), fe).verdict).toBe('restart-suggested')
    expect(classifyChange(M('frontend/src/App.test.tsx', 'frontend/README.md'), fe).verdict).toBe('none')
  })
  it('node without a watcher needs a restart, with one it hot reloads', () => {
    expect(classifyChange(M('src/index.js'), svc('n', 'node src/index.js')).verdict).toBe('restart-needed')
    expect(classifyChange(M('src/index.ts'), svc('n', 'tsx watch src/index.ts')).verdict).toBe('hot-reload')
    expect(classifyChange(M('src/index.ts'), svc('n', 'nodemon src/index.ts')).verdict).toBe('hot-reload')
    expect(classifyChange(M('.env'), svc('n', 'nodemon src/index.ts')).verdict).toBe('restart-needed')
  })
  it('python and dotnet', () => {
    expect(classifyChange(M('app/main.py'), svc('p', 'uvicorn app.main:app')).verdict).toBe('restart-needed')
    expect(classifyChange(M('app/main.py'), svc('p', 'uvicorn app.main:app --reload')).verdict).toBe('hot-reload')
    expect(classifyChange(M('requirements.txt'), svc('p', 'uvicorn app.main:app --reload')).verdict).toBe('restart-suggested')
    expect(classifyChange(M('Api/Program.cs'), svc('d', 'dotnet run', 'Api')).verdict).toBe('restart-suggested')
    expect(classifyChange(M('Api/Program.cs'), svc('d', 'dotnet watch run', 'Api')).verdict).toBe('hot-reload')
    expect(classifyChange(M('Api/appsettings.json', 'Api/Api.csproj'), svc('d', 'dotnet run', 'Api')).verdict).toBe('restart-needed')
  })
  it('an unrecognized command is only ever suggested, never needed', () => {
    const r = classifyChange(M('svc/main.go'), svc('u', './run.sh', 'svc'))
    expect(r.verdict).toBe('restart-suggested')
    expect(r.reasons[0]).toMatch(/not recognized/)
    expect(classifyChange(M('svc/README.md'), svc('u', './run.sh', 'svc')).verdict).toBe('none')
  })
})

describe('classifyChange: scope, renames, monorepo, Windows paths', () => {
  it('files outside the service directory are none; sibling services are independent', () => {
    const be = svc('be', 'mvnw spring-boot:run', 'backend'), fe = svc('fe', 'npm run dev', 'frontend')
    const files = M('backend/src/main/java/A.java')
    expect(classifyChange(files, fe).verdict).toBe('none')
    expect(classifyChange(files, be).verdict).toBe('restart-suggested')
  })
  it('an ancestor package.json (workspace root) affects the service; an ancestor README does not', () => {
    const fe = svc('fe', 'pnpm dev', 'apps/web')
    expect(classifyChange(M('package.json', 'pnpm-lock.yaml'), fe).verdict).toBe('restart-suggested')
    expect(classifyChange(M('README.md', 'apps/api/src/x.ts', 'apps/web2/package.json'), fe).verdict).toBe('none')
  })
  it('renames contribute both paths', () => {
    const be = svc('be', 'mvnw spring-boot:run', 'backend')
    const r = classifyChange([{ status: 'R', from: 'backend/src/main/resources/application.yml', path: 'backend/src/main/resources/application-dev.yml' }], be)
    expect(r.verdict).toBe('restart-needed')
    const moved = classifyChange([{ status: 'R', from: 'old/App.java', path: 'backend/src/main/java/App.java' }], be)
    expect(moved.files).toEqual(['backend/src/main/java/App.java'])
  })
  it('deletions count', () => {
    expect(classifyChange([{ status: 'D', path: 'backend/pom.xml' }], svc('be', 'mvn spring-boot:run', 'backend')).verdict).toBe('restart-needed')
  })
  it('handles Windows-style separators in cwd and working dir', () => {
    expect(classifyChange(M('apps/web/src/a.ts'), svc('w', 'npm run dev', '.\\web'), 'apps').verdict).toBe('hot-reload')
    expect(classifyChange(M('backend/pom.xml'), svc('b', 'mvn spring-boot:run', 'backend\\'), '').verdict).toBe('restart-needed')
    expect(classifyChange(M('backend\\pom.xml'), svc('b', 'mvn spring-boot:run', 'backend'), '').verdict).toBe('restart-needed')
  })
  it('a service running outside the repository is none', () => {
    expect(classifyChange(M('a.js'), svc('x', 'node a.js', 'C:\\elsewhere')).verdict).toBe('none')
  })
  it('a truncated change list is at least suggested', () => {
    expect(classifyChange([], svc('x', 'node a.js'), '', { truncated: true }).verdict).toBe('restart-suggested')
  })
})

describe('summarizeAffected', () => {
  const be = svc('be', 'mvnw spring-boot:run', 'backend', 'Backend'), fe = svc('fe', 'npm run dev', 'frontend', 'Frontend'), w = svc('w', 'node w.js', 'worker', 'Worker')
  it('labels one service, several services and nothing', () => {
    expect(summarizeAffected(M('backend/src/main/resources/application.yml'), [be, fe]).text).toBe('Backend updated · Restart')
    expect(summarizeAffected(M('backend/src/main/java/A.java'), [be, fe]).text).toBe('Backend updated · Restart suggested')
    const three = summarizeAffected(M('backend/pom.xml', 'frontend/.env', 'worker/x.js'), [be, fe, w])
    expect(three).toMatchObject({ text: '3 services need attention', needsAttention: 3 })
    expect(summarizeAffected(M('frontend/src/a.ts'), [be, fe])).toMatchObject({ text: '', needsAttention: 0 })
    expect(summarizeAffected(M('README.md'), [be, fe]).text).toBe('')
    expect(summarizeAffected(M('a.txt'), [])).toMatchObject({ services: [], text: '', needsAttention: 0 })
  })
})

describe('changedFiles (real git)', () => {
  it('lists adds, modifications, deletions, renames and binary files', async () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    git(t.dir, 'init', '-q', '-b', 'main', join(t.dir, 'r')); const r = join(t.dir, 'r')
    commit(r, 'keep.txt', 'k'); commit(r, 'old name.txt', 'some long enough content to detect a rename\n'.repeat(5)); commit(r, 'gone.txt', 'g')
    const a = git(r, 'rev-parse', 'HEAD')
    git(r, 'mv', 'old name.txt', 'new name.txt'); git(r, 'rm', '-q', 'gone.txt')
    commit(r, 'bin.dat', '\0\1\2\3', 'binary'); commit(r, 'keep.txt', 'changed', 'edit')
    const b = git(r, 'rev-parse', 'HEAD')
    const res = await changedFiles({ kind: 'native', path: r }, a, b)
    if (!res.ok) throw new Error(res.error.message)
    const byPath = Object.fromEntries(res.value.files.map(f => [f.path, f]))
    expect(byPath['new name.txt']).toMatchObject({ status: 'R', from: 'old name.txt' })
    expect(byPath['gone.txt'].status).toBe('D')
    expect(byPath['bin.dat'].status).toBe('A')
    expect(byPath['keep.txt'].status).toBe('M')
    expect(res.value).toMatchObject({ total: 4, truncated: false })
  })
  it('rejects option-like revisions and reports git errors', async () => {
    expect(await changedFiles({ kind: 'native', path: '.' }, '--output=x', 'abcd')).toMatchObject({ ok: false, error: { code: 'BAD_REV' } })
    expect((await changedFiles({ kind: 'native', path: '.' }, 'deadbeef', 'cafebabe', async () => ({ code: 128, stdout: '', stderr: 'fatal: bad object', timedOut: false }))).ok).toBe(false)
  })
  it('caps very large changes and flags truncation', async () => {
    const out = Array.from({ length: 6000 }, (_, i) => `M\0f${i}.txt\0`).join('')
    const res = await changedFiles({ kind: 'native', path: '.' }, 'abcd', 'beef', async () => ({ code: 0, stdout: out, stderr: '', timedOut: false }))
    expect(res.ok && res.value).toMatchObject({ total: 6000, truncated: true })
    expect(res.ok && res.value.files).toHaveLength(5000)
  })
})
