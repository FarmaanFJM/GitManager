import { useEffect, useState } from 'react'
import { Button } from '../../third_party/summa-ui/src/ui'
import type { FileChange } from '../shared/changes'
import type { Repo, RepoStatus } from '../shared/types'
import { api } from './api'
import { KIND_LABEL, summaryLines } from './changesModel'
import { plural } from './util'

/** "Changes, 4 files" on the repository Overview: the first few files and their state, with the full view one click away. */
export function ChangesSummary({ repo, status, reloadKey, onOpen }: { repo: Repo; status: RepoStatus; reloadKey: number; onOpen: () => void }) {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  useEffect(() => {
    if (status.changes.files === 0) { setFiles([]); return }
    let live = true
    void api.changesRead(repo.id).then(r => { if (live && r.ok) setFiles(r.value.files) })
    return () => { live = false }
  }, [repo.id, status.checkedAt, status.changes.files, reloadKey])
  const n = status.changes.files
  const { shown, more } = summaryLines(files ?? [], 5)
  return (
    <section className="gm-ov-changes" aria-label="Changes">
      <header className="gm-ov-changes-head">
        <h2 className="gm-section-h">Changes <span className="muted">{n === 0 ? 'none' : `— ${plural(n, 'file')}`}</span></h2>
        <span className="grow" />
        {n > 0 && <Button variant="ghost" onClick={onOpen}>View all</Button>}
      </header>
      {n > 0 && (
        <ul className="gm-ov-changes-list">
          {shown.map(f => <li key={f.path}><span className="gm-mono truncate" title={f.path}>{f.path}</span><span className="faint">{f.label}</span></li>)}
          {more > 0 && <li><button type="button" className="gm-link" onClick={onOpen}>and {more} more</button></li>}
        </ul>
      )}
    </section>
  )
}

export { KIND_LABEL }
