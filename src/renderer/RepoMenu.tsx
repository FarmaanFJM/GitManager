import { useState } from 'react'
import { Menu, type MenuEntry } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { Repo } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { DeleteRepoDialog } from './DeleteRepoDialog'
import { removeWords } from './deleteText'
import { copyText } from './tools/common'

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

  const items = (r: Repo): MenuEntry[] => [
    { label: 'Open repository', icon: 'folder', onSelect: () => actions.select(r.id) },
    { label: 'Open folder', icon: 'folder-open', onSelect: () => void api.openFolder(r.id).then(x => { if (!x.ok) toast.error(x.error.message) }) },
    { label: 'Copy folder path', icon: 'copy', onSelect: () => void copyText(r.location.path).then(ok => (ok ? toast.success('Path copied') : toast.error('Could not copy the path'))) },
    { type: 'sep' },
    {
      label: 'Remove from GitManager', icon: 'eye-off', disabled: running,
      onSelect: () => void (async () => {
        const yes = await confirm({ title: removeWords.title(r.name), description: 'Only GitManager forgets it. The folder and its files stay where they are, its development profiles are removed, and automatic discovery will not add it again.', confirmLabel: removeWords.confirm, destructive: true, icon: 'eye-off' })
        if (!yes) return
        const res = await api.removeRepo(r.id)
        if (!res.ok) { toast.error(res.error.message); return }
        await settle([r.id]); toast.success(`${r.name} removed from GitManager`)
      })(),
    },
    { label: 'Delete local folder…', icon: 'trash', danger: true, onSelect: () => setDeleting(r) },
  ]

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
