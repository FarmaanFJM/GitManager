import { useCallback, useEffect, useState } from 'react'
import { Tag } from '../../../third_party/summa-ui/src/ui'
import type { ArtifactClass, StorageState } from '../../shared/storage'
import { api } from '../api'

/** The stored scan and settings, kept current by the main process's events. */
export function useStorageState() {
  const [state, setState] = useState<StorageState | null>(null)
  const reload = useCallback(async () => { setState(await api.storageState()) }, [])
  useEffect(() => {
    void reload().then(() => api.storageAuth()).then(() => reload())
    const offChanged = api.on('storage-changed', () => { void reload() })
    const offStatus = api.on('storage-status', p => setState(s => (s ? { ...s, ...p } : s)))
    return () => { offChanged(); offStatus() }
  }, [reload])
  return { state, reload }
}

export const CLASS_LABEL: Record<ArtifactClass, string> = {
  protected: 'Protected', keep: 'Keep', review: 'Review', 'delete-candidate': 'Delete candidate', expired: 'Expired',
}

/** Colour carries meaning only for what the user can act on: emerald for reclaimable, amber for needs-a-decision. */
export const CLASS_COLOR: Record<ArtifactClass, string> = {
  protected: 'var(--text-2)', keep: 'var(--text-3)', review: 'var(--warn)', 'delete-candidate': 'var(--accent)', expired: 'var(--s4)',
}

export function ClassTag({ cls }: { cls: ArtifactClass }) {
  return <Tag color={CLASS_COLOR[cls]}>{CLASS_LABEL[cls]}</Tag>
}

export const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown')
export const dateTimeText = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never')

export const CATEGORY_LABEL = { installer: 'Installers', build: 'Builds', report: 'CI reports', logs: 'Logs', evidence: 'Evidence', other: 'Other' } as const
