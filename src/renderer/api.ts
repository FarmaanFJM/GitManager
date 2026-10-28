import type { GitManagerApi } from '../shared/api'

declare global {
  interface Window { gitmanager: GitManagerApi }
}

/** The preload bridge. The renderer has no other access to the computer. */
export const api: GitManagerApi = window.gitmanager
