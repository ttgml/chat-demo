import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { sessionFreshness, toSessionSummary, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 11

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/**
 * 修改未打开会话的元数据：只读取该会话，原子更新详情和列表。
 * 修改后必须与详情读取的结果一致，否则下次打开会话会把修改覆盖掉。
 */
const mutateSession = async (id: string, mutate: (session: Session) => void): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          mutate(session)
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名 */
export const renameSession = (id: string, title: string): Promise<void> =>
  mutateSession(id, (session) => {
    session.title = title
  })

/** 未打开的会话也可置顶；undefined 表示取消置顶，同时清掉旧字段 */
export const setSessionPinned = (id: string, pinnedAt: number | undefined): Promise<void> =>
  mutateSession(id, (session) => {
    if (pinnedAt === undefined) {
      delete session.pinnedAt
    } else {
      session.pinnedAt = pinnedAt
    }
  })

/**
 * 删除会话，仅清理已无会话引用的本地原件；远端文件不删。
 * 返回实际删掉原件的附件 id：同步层在未登录删除时要用它清掉上传记录，
 * 否则重新登录后会话能恢复、图片却因为被标记为已下载而不再拉取。
 */
export const deleteSession = async (sessionId: string): Promise<string[]> => {
  const removedFiles: string[] = []
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
            removedFiles.push(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  return removedFiles
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/** 云同步拉取到的变更：会话、附件原件、删除墓碑 */
export type RemoteChanges = {
  sessions: Session[]
  files: StoredFile[]
  deletedIds: string[]
}

export type ApplyRemoteResult = {
  /** 提交后的完整会话列表 */
  summaries: SessionSummary[]
  /** 实际落库的会话 id（本地已有更新版本的会被跳过） */
  appliedSessionIds: string[]
  /** 本地版本更新而未被远端覆盖的会话 id，调用方需要把它们重新排入上传队列 */
  skippedSessionIds: string[]
}

/**
 * 增量应用远端变更：在单个事务中 upsert 会话与附件、应用删除墓碑，返回提交后的完整列表。
 * 与 commitStaging 不同，这里不清空任何现有数据，也不中断正在生成的回复。
 * 删除时不清理 files 原件：同一附件可能被本机其他会话引用，也可能被其他设备上传，
 * 本地引用计数不足以判断全局是否还需要，统一交由后续清理策略处理。
 *
 * 会话写入在事务内比对本地与远端的内容新鲜度（sessionFreshness）：pull 可能持续数十秒，
 * 期间用户对某个会话的新编辑会晚于远端快照落盘。若直接覆盖，用户这次的编辑会被静默丢弃。
 * 这里跳过本地更新的会话，把 id 返回给同步引擎重新排队上传。
 */
export const applyRemoteChanges = async (changes: RemoteChanges): Promise<ApplyRemoteResult> => {
  const appliedSessionIds: string[] = []
  const skippedSessionIds: string[] = []
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  const write = async () => {
    try {
      const sessions = tx.objectStore('sessions')
      const summaries = tx.objectStore('sessionSummaries')
      const files = tx.objectStore('files')
      for (const session of changes.sessions) {
        const existing = await sessions.get(session.id)
        if (existing && sessionFreshness(existing) > sessionFreshness(session)) {
          skippedSessionIds.push(session.id)
          continue
        }
        await sessions.put(session)
        await summaries.put(storedSummary(session))
        appliedSessionIds.push(session.id)
      }
      for (const id of changes.deletedIds) {
        await sessions.delete(id)
        await summaries.delete(id)
      }
      for (const file of changes.files) {
        await files.put(file)
      }
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([write(), tx.done])
  // 事务提交后统一读取列表，避免调用方在中途拿到不一致的快照。
  const all = await (await getDB()).getAll('sessionSummaries')
  return {
    summaries: all.map(toSessionSummary),
    appliedSessionIds,
    skippedSessionIds,
  }
}
