import { randomUUID } from 'node:crypto'
/** Short random ids for roots and plans (the same shape as the store's ids, without importing the store). */
export const newIdLike = () => randomUUID().replace(/-/g, '').slice(0, 16)
