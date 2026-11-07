import { useToast } from '../../third_party/summa-ui/src/presets'
import type { Repo } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { copyText } from './tools/common'

/**
 * The quick repository operations shared by the overview rows, the context menu and the workspace header.
 * Each one reports its outcome in a word or two ("Fetched", "Pulled 3", "Synced") or the concise reason it failed;
 * detail stays in the workspace. They use the existing backend operations, so every Git safeguard still applies.
 */
export function useRepoOps(actions: Actions, model?: Model) {
  const toast = useToast()
  const fetch = async (repo: Repo) => {
    const r = await api.fetch(repo.id)
    if (r.ok) { actions.markFetched(repo.id); toast.success('Fetched') } else toast.error(r.error.message)
    await actions.refresh(repo.id, { remote: r.ok })
  }
  const pull = async (repo: Repo) => {
    const r = await api.pull(repo.id)
    if (r.ok) {
      actions.markFetched(repo.id)
      actions.setRestartHint(repo.id, r.value.affected)
      toast.success(`Pulled ${r.value.commits}`)
    } else toast.error(r.error.message)
    await actions.refresh(repo.id, { remote: r.ok })
  }
  const copyPath = async (repo: Repo) => {
    const text = repo.location.path
    if (await copyText(text)) toast.success('Path copied'); else toast.error('Could not copy')
  }
  const openFolder = async (repo: Repo) => { const r = await api.openFolder(repo.id); if (!r.ok) toast.error(r.error.message) }
  const terminal = (repo: Repo) => actions.openTerminal({ type: 'repo', repoId: repo.id })
  /** Restarts exactly the services the last pull flagged (not everything), verifying each; the hint clears only when all came back. */
  const restartAffected = async (repoId: string) => {
    const hint = actions.restartHints[repoId]
    if (!hint || !model) return
    const failed: string[] = []
    for (const a of hint.services.filter(x => x.verdict === 'restart-needed' || x.verdict === 'restart-suggested')) {
      const profile = model.data.profiles.find(p => p.repoId === repoId && p.services.some(sv => sv.id === a.serviceId))
      if (!profile) { failed.push(a.serviceName); continue }
      const r = await api.restartService(profile.id, a.serviceId)
      if (!r.ok) failed.push(a.serviceName)
    }
    if (failed.length) toast.error(`${failed.join(', ')} failed`)
    else { actions.setRestartHint(repoId, null); toast.success('Restarted') }
  }
  return { fetch, pull, copyPath, openFolder, terminal, restartAffected, sync: (repo: Repo) => actions.sync(repo.id) }
}
