import { describe, expect, it } from 'vitest'
import { buildReport, isSelfHostedRequest, matchRunners, parseRunsOn } from '../../src/core/runners/workflows.js'
import { reconcile } from '../../src/core/runners/model.js'
import { github, local } from './model.test.js'

const WF = `name: CI
on: [push]
jobs:
  build:
    runs-on: [self-hosted, linux, gpu]
    steps:
      - run: make
  hosted:
    runs-on: ubuntu-latest
  block:
    runs-on:
      - self-hosted
      - Windows
  grouped:
    runs-on:
      group: gpu-pool
      labels: [self-hosted, linux]
  dynamic:
    runs-on: \${{ matrix.os }}
  quoted:
    runs-on: "self-hosted"
`

describe('runs-on reading', () => {
  it('reads scalar, inline list, block list, group mapping, expression and quoted forms', () => {
    const jobs = parseRunsOn(WF)
    expect(jobs.map(j => j.job)).toEqual(['build', 'hosted', 'block', 'grouped', 'dynamic', 'quoted'])
    expect(jobs[0].runsOn).toEqual(['self-hosted', 'linux', 'gpu'])
    expect(jobs[1].runsOn).toEqual(['ubuntu-latest'])
    expect(jobs[2].runsOn).toEqual(['self-hosted', 'Windows'])
    expect(jobs[3]).toMatchObject({ group: 'gpu-pool', runsOn: ['self-hosted', 'linux'] })
    expect(jobs[4].dynamic).toBe(true)
    expect(jobs[5].runsOn).toEqual(['self-hosted'])
    expect(parseRunsOn('on: push\n')).toEqual([])
  })
  it('tells self-hosted requests from GitHub-hosted ones', () => {
    expect(isSelfHostedRequest(['ubuntu-latest'])).toBe(false)
    expect(isSelfHostedRequest(['self-hosted', 'linux'])).toBe(true)
    expect(isSelfHostedRequest(['my-custom'])).toBe(true)
    expect(isSelfHostedRequest([])).toBe(false)
  })
  it('matches runners by all requested labels, case-insensitively, within the repository or its organization, from GitHub-confirmed labels only', () => {
    const repoRunner = reconcile([local()], [github()])[0]
    const orgRunner = reconcile([], [github({ id: 2, name: 'org-box', scope: { kind: 'org', org: 'acme' }, labels: [{ name: 'self-hosted', type: 'read-only' }, { name: 'Linux', type: 'read-only' }] })])[0]
    const other = reconcile([], [github({ id: 3, name: 'elsewhere', scope: { kind: 'repo', owner: 'other', repo: 'x' } })])[0]
    const localOnly = reconcile([local({ path: '/opt/b', key: 'k2', agentId: null, scope: { kind: 'repo', owner: 'acme', repo: 'app' } })], [])[0]
    const scope = { kind: 'repo' as const, owner: 'acme', repo: 'app' }
    expect(matchRunners(['self-hosted', 'linux', 'gpu'], [repoRunner, orgRunner, other, localOnly], scope).map(r => r.name)).toEqual(['runner-a'])
    expect(matchRunners(['self-hosted', 'LINUX'], [repoRunner, orgRunner, other, localOnly], scope).map(r => r.name).sort()).toEqual(['org-box', 'runner-a'])
    expect(matchRunners(['self-hosted', 'windows'], [repoRunner, orgRunner], scope)).toEqual([])
  })
  it('builds a report with matches, problems, unmatched labels and idle runners, and never claims authorization', () => {
    const runners = [reconcile([local()], [github()])[0], reconcile([], [github({ id: 9, name: 'spare', labels: [{ name: 'self-hosted', type: 'read-only' }, { name: 'Linux', type: 'read-only' }, { name: 'spare', type: 'custom' }] })])[0]]
    const rep = buildReport('acme/app', 'local', [{ path: '.github/workflows/ci.yml', text: WF }], runners)
    const jobs = rep.files[0].jobs
    expect(rep.files[0].name).toBe('CI')
    expect(jobs.find(j => j.job === 'build')!.matched).toEqual([runners[0].key])
    expect(jobs.find(j => j.job === 'hosted')!.problem).toMatch(/GitHub-hosted/)
    expect(jobs.find(j => j.job === 'block')!.problem).toMatch(/No known runner/)
    expect(jobs.find(j => j.job === 'dynamic')!.problem).toMatch(/expression/)
    expect(rep.unmatched).toEqual(expect.arrayContaining(['Windows']))
    expect(rep.idleRunners).toEqual([])
    expect(rep.note).toMatch(/do not by themselves authorize/)
  })
})
