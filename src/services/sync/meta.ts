import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/**
 * 云同步元数据单独一个库，不改动 chat-demo 主库的 DB_VERSION。
 * 主库存会话与附件原件，本库只记录同步进度和待上传队列。
 */
export type PendingKind = 'upsert' | 'delete'

export type PendingItem = {
  id: string
  kind: PendingKind
  /** 本地变更时间，仅用于展示与排序 */
  updatedAt: number
  /** 'import' 来自导入备份的全量替换：允许覆盖云端墓碑恢复会话 */
  origin?: 'import'
}

interface SyncMetaDB extends DBSchema {
  /** 单条键值：lastSyncedRev、accountKey 等 */
  meta: { key: string; value: string | number }
  /** 每个会话在服务端的最新 rev，作为下次上传的 baseRev */
  sessionRev: { key: string; value: number }
  /** 待上传的本地变更；成功后移除 */
  pending: { key: string; value: PendingItem }
  /** 附件原件 id -> 上传成功时的服务端 rev；用于跳过重复上传和自己的回环变更 */
  uploadedFiles: { key: string; value: number }
}

const DB_NAME = 'chat-demo-sync'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<SyncMetaDB>> | null = null

const getDB = () =>
  (dbPromise ??= openDB<SyncMetaDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      for (const name of ['meta', 'sessionRev', 'pending', 'uploadedFiles'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name)
        }
      }
    },
  }).catch((error: unknown) => {
    dbPromise = null
    throw error
  }))

const getMeta = async <T extends string | number>(key: string, fallback: T): Promise<T> => {
  const value = await (await getDB()).get('meta', key)
  return (value === undefined ? fallback : value) as T
}

export const getLastSyncedRev = (): Promise<number> => getMeta('lastSyncedRev', 0)

export const getAccountKey = (): Promise<string> => getMeta('accountKey', '')

export const setAccountKey = async (value: string): Promise<void> => {
  await (await getDB()).put('meta', value, 'accountKey')
}

export const getSessionRev = async (id: string): Promise<number> =>
  (await (await getDB()).get('sessionRev', id)) ?? 0

export const setSessionRev = async (id: string, rev: number): Promise<void> => {
  await (await getDB()).put('sessionRev', rev, id)
}

export const deleteSessionRev = async (id: string): Promise<void> => {
  await (await getDB()).delete('sessionRev', id)
}

export const listPending = async (): Promise<PendingItem[]> =>
  (await (await getDB()).getAll('pending')).sort((a, b) => a.updatedAt - b.updatedAt)

export const markPending = async (item: PendingItem): Promise<void> => {
  await (await getDB()).put('pending', item, item.id)
}

/** 批量写入待上传变更；单事务保证整批要么全部入队，要么全部不生效。 */
export const markPendingMany = async (items: readonly PendingItem[]): Promise<void> => {
  if (items.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('pending', 'readwrite')
  const store = tx.objectStore('pending')
  await Promise.all([...items.map((item) => store.put(item, item.id)), tx.done])
}

export const clearPending = async (id: string): Promise<void> => {
  await (await getDB()).delete('pending', id)
}

/** 全量替换后丢弃过期的待上传变更，由调用方按替换后的本地列表重新排队 */
export const clearAllPending = async (): Promise<void> => {
  await (await getDB()).clear('pending')
}

/** 返回该附件上次上传成功时的 rev；-1 表示从未上传 */
export const uploadedFileRev = async (id: string): Promise<number> =>
  (await (await getDB()).get('uploadedFiles', id)) ?? -1

export const markFileUploaded = async (id: string, rev: number): Promise<void> => {
  await (await getDB()).put('uploadedFiles', rev, id)
}

/** 已同步过的会话 id 列表，用于全量替换后的对账 */
export const listSessionRevs = async (): Promise<Map<string, number>> => {
  const db = await getDB()
  const [keys, values] = await Promise.all([db.getAllKeys('sessionRev'), db.getAll('sessionRev')])
  return new Map(keys.map((key, index) => [key, values[index]]))
}

/** 批量写入同步进度，单事务保证游标与会话版本一致 */
export const commitSyncProgress = async (
  rev: number,
  sessionRevs: ReadonlyMap<string, number>,
  removedSessionIds: readonly string[]
): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction(['meta', 'sessionRev'], 'readwrite')
  const current = (await tx.objectStore('meta').get('lastSyncedRev')) as number | undefined
  if (current === undefined || rev > current) {
    await tx.objectStore('meta').put(rev, 'lastSyncedRev')
  }
  for (const [id, sessionRev] of sessionRevs) {
    await tx.objectStore('sessionRev').put(sessionRev, id)
  }
  for (const id of removedSessionIds) {
    await tx.objectStore('sessionRev').delete(id)
  }
  await tx.done
}

/** 切换账号时清空同步进度；本地会话保留，由调用方决定是上传还是覆盖 */
export const resetSyncMeta = async (): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction(['meta', 'sessionRev', 'pending', 'uploadedFiles'], 'readwrite')
  await Promise.all([
    tx.objectStore('meta').clear(),
    tx.objectStore('sessionRev').clear(),
    tx.objectStore('pending').clear(),
    tx.objectStore('uploadedFiles').clear(),
    tx.done,
  ])
}
