import { useState } from 'react'
import { Menu, type MenuEntry } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { Repo } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { DeleteRepoDialog } from './DeleteRepoDialog'
import { removeWords } from './deleteText'
import { useRepoOps } from './repoOps'

/** Where the menu was opened: a point (right-click) or the row's corner (keyboard), and the repository it is about. */
export type RepoMenuTarget = { repoId: string; x: number; y: number }

/**
 * The context menu of a repository row. It acts on the row it was opened for and never changes the selected repository, except
 * "Open repository" (which selects) and a deletion or removal of the selected repository (which selects its neighbour).
 */
export function RepoMenu({ model, actions, target, onClose }: { model: Model; actions: Actions; target: RepoMenuTarget | null; onClose: () => void }) {
  const confirm = useConfirm()
  const toast = useToast()
  const [deleting, setDeleting] = useState<Repo | null>(null)
  const repos = model.data.repos
  const repo = target ? repos.find(r => r.id === target.repoId) ?? null : null
  const running = repo ? Object.values(model.services).some(s => s.pid !== null && s.repoId === repo.id) : false

  /** After a repository leaves the list: if it was the selected one, select the repository that took its place in the list. */
  const settle = async (removed: string[]) => {
    const wasSelected = !!model.data.ui.selectedRepoId && removed.includes(model.data.ui.selectedRepoId)
    const idx = repos.findIndex(r => removed.includes(r.id))
    const next = repos.filter(r => !removed.includes(r.id))
    await actions.reload()
    if (wasSelected && next.length) actions.select(next[Math.min(Math.max(idx, 0), next.length - 1)].id)
  }

  const ops = useRepoOps(actions)
  const items = (r: Repo): MenuEntry[] => {
    const st = model.statuses[r.id]?.status
    const hasRemote = !st || st.remotes.length > 0
    const canPull = !!st && (st.sync === 'behind' || st.sync === 'diverged')
    return [
      { label: 'Open', icon: 'folder', onSelect: () => actions.select(r.id) },
      { label: 'Open Terminal', icon: 'terminal', onSelect: () => ops.terminal(r) },
      { type: 'sep' },
      { label: 'Fetch', icon: 'refresh', disabled: !hasRemote, onSelect: () => void ops.fetch(r) },
      { label: 'Pull', icon: 'arrow-down', disabled: !canPull, onSelect: () => void ops.pull(r) },
      { label: 'Sync with Remote', icon: 'repeat', disabled: !hasRemote, onSelect: () => ops.sync(r) },
      { type: 'sep' },
      { label: 'Branches', icon: 'list', onSelect: () => actions.openRepo(r.id, 'branches') },
      { label: 'Worktrees', icon: 'layers', onSelect: () => actions.openRepo(r.id, 'worktrees') },
      { type: 'sep' },
      { label: 'Copy Path', icon: 'copy', onSelect: () => void ops.copyPath(r) },
      { label: 'Open Folder', icon: 'folder-open', onSelect: () => void ops.openFolder(r) },
      { type: 'sep' },
      {
        label: 'Remove from GitManager', icon: 'eye-off', disabled: running,
        onSelect: () => void (async () => {
          const yes = await confirm({ title: removeWords.title(r.name), description: 'Only GitManager forgets it.', target: r.location.path, consequences: ['Files stay on disk', 'Its profiles are removed', 'Discovery will not add it again'], confirmLabel: removeWords.confirm, destructive: true })
          if (!yes) return
          const res = await api.removeRepo(r.id)
          if (!res.ok) { toast.error(res.error.message); return }
          await settle([r.id]); toast.success(`${r.name} removed`)
        })(),
      },
      { label: 'Delete Local Repository', icon: 'trash', danger: true, onSelect: () => setDeleting(r) },
    ]
  }

  return (
    <>
      <Menu anchor={target && repo ? { x: target.x, y: target.y } : null} open={!!target && !!repo} onClose={onClose} items={repo ? items(repo) : []} label={repo ? `Actions for ${repo.name}` : 'Repository actions'} placement="bottom-start" />
      <DeleteRepoDialog repo={deleting} onClose={() => setDeleting(null)} onDeleted={(message, notes, removed) => {
        setDeleting(null)
        void settle(removed).then(() => toast.success(message.length > 140 ? `Moved to the trash: ${deleting?.name ?? 'folder'}` : message))
        for (const n of notes) toast.info(n)
      }} />
    </>
  )
}
