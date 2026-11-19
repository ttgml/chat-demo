import * as db from '../chat/db.js'
import {
  applyRemoteSummaries,
  onChatChange,
  useChatStore,
  type ChatChangeEvent,
} from '../chat/store.js'
import type { Session } from '../chat/types.js'
import { showToast } from '../../components/base/toastState.js'
import { clearSyncCredentials, syncAccountKey, syncReady, useSyncConfig } from './config.js'
import {
  syncChanges,
  syncDeleteSession,
  syncGetFile,
  syncGetSession,
  syncPutFile,
  syncPutSession,
} from './client.js'
import {
  clearAllPending,
  clearPending,
  commitSyncProgress,
  deleteSessionRev,
  getAccountKey,
  getLastSyncedRev,
  getSessionRev,
  listPending,
  listSessionRevs,
  markFileUploaded,
  markPending,
  resetSyncMeta,
  setAccountKey,
  setSessionRev,
  uploadedFileRev,
  type PendingItem,
} from './meta.js'
import { setSyncStatus, syncErrorKey } from './status.js'
import { SyncError } from './types.js'
import { isSessionPayload, sessionFileIds } from './validate.js'
import { createWatch, type WatchController } from './watch.js'

/** 本地变更后的合并窗口：连续编辑只触发一次同步 */
const DEBOUNCE_MS = 1200
/** 后台定时对账间隔：WebSocket 不可用时的兜底 */
const POLL_INTERVAL_MS = 60_000
/** 推送通知的合并窗口：一批连续写入只跑一次完整同步 */
const WATCH_DEBOUNCE_MS = 200
/** 单次拉取的分页大小 */
const PAGE_SIZE = 200
/** 失败后的重试退避上限 */
const MAX_BACKOFF_MS = 60_000

let syncQueue: Promise<void> = Promise.resolve()
let debounceTimer = 0
let pollTimer = 0
let retryTimer = 0
let retryDelay = 2_000
let started = false
let stopped = false
let watch: WatchController | null = null
let watchTimer = 0

const enqueue = (run: () => Promise<void>): Promise<void> => {
  const task = syncQueue.then(run)
  syncQueue = task.catch(() => {})
  return task
}

const isUnauthorized = (error: unknown): boolean =>
  error instanceof SyncError && error.status === 401

const isConflict = (error: unknown): error is SyncError =>
  error instanceof SyncError && error.status === 409

const isNetwork = (error: unknown): boolean =>
  error instanceof SyncError && error.code === 'network'

/** 从 IndexedDB 读取会话内容；优先内存缓存，缺页时回源 */
const loadLocalSession = async (id: string): Promise<Session | undefined> =>
  useChatStore.getState().sessionCache[id] ?? (await db.loadSession(id))

/** 写入单条远端会话（或墓碑）到主库，并刷新内存列表 */
const applyOneRemote = async (
  id: string,
  rev: number,
  deleted: boolean,
  payload: unknown
): Promise<boolean> => {
  if (!deleted && !isSessionPayload(payload)) {
    // 损坏的 payload 绝不能当作删除，否则会抹掉本地数据
    return false
  }
  const session = deleted ? null : (payload as Session)
  const summaries = await db.applyRemoteChanges({
    sessions: session ? [session] : [],
    files: [],
    deletedIds: deleted ? [id] : [],
  })
  applyRemoteSummaries(summaries, session ? [id] : [], deleted ? [id] : [])
  if (deleted) {
    await deleteSessionRev(id)
  } else {
    await setSessionRev(id, rev)
  }
  return true
}

type FetchedSession = Awaited<ReturnType<typeof syncGetSession>>

/**
 * 会话新鲜度：updatedAt 在每次消息落盘时都会刷新，等价于「最后一条消息的时间」；
 * 外部归档导入的会话可能只带消息时间，因此再取最后一条消息的 createdAt 兜底。
 */
const freshness = (session: Session): number => {
  let time = session.updatedAt
  for (const message of session.messages) {
    if (message.createdAt > time) {
      time = message.createdAt
    }
  }
  return time
}

/** 采用服务端版本覆盖本地，并丢弃该会话的待上传队列 */
const adoptRemote = async (id: string, remote: FetchedSession): Promise<boolean> => {
  if (!(await applyOneRemote(id, remote.rev, remote.deleted, remote.session))) {
    return false
  }
  // 不推进全局游标：remote.rev 只是该会话的版本，若中途有其他设备的变更
  // 带着更小的 rev，直接跳到它会漏拉。游标只能由 pull 阶段按页推进。
  await clearPending(id)
  return true
}

/**
 * 以服务端当前版本为 baseRev 重新上传本地会话。
 * revive 为 true 时允许覆盖墓碑，仅用于导入备份这类显式全量替换。
 * 调用方需保证会话引用的附件原件已上传。
 */
const reupload = async (
  id: string,
  baseRev: number,
  session: Session,
  revive = false
): Promise<void> => {
  const { rev } = await syncPutSession(id, {
    baseRev,
    updatedAt: session.updatedAt,
    session,
    ...(revive ? { revive: true } : {}),
  })
  await setSessionRev(id, rev)
  await clearPending(id)
}

/**
 * 409 冲突：按会话内容时间决定采用哪一版，而不是无条件「服务端 rev 大者胜」。
 * - 远端是有效会话：本地更新则以 serverRev 为 baseRev 重新上传；时间相同或服务端更新则采用远端。
 * - 远端是墓碑：默认沿用删除；但导入备份是用户显式恢复数据的意图，允许 revive 覆盖墓碑。
 *   否则「删除全部 → 重新导入同一份备份」会因同 id 全是墓碑而把两端一起清零。
 * 返回值表示是否发生了「服务端版本覆盖本地」，用于汇总冲突提示。
 */
const resolveConflict = async (
  id: string,
  item: PendingItem,
  local: Session | undefined
): Promise<boolean> => {
  const remote = await syncGetSession(id)
  if (remote.deleted) {
    if (item.origin === 'import' && local) {
      await reupload(id, remote.rev, local, true)
      return false
    }
    return adoptRemote(id, remote)
  }
  if (!isSessionPayload(remote.session)) {
    // 损坏数据既不能落库也不能当成删除，保留队列等下次重试
    return false
  }
  if (local && freshness(local) > freshness(remote.session)) {
    await reupload(id, remote.rev, local)
    return false
  }
  return adoptRemote(id, remote)
}

/** 上传会话引用的附件原件；本地没有原件的导入附件跳过 */
const uploadSessionFiles = async (session: Session): Promise<void> => {
  for (const fileId of sessionFileIds(session)) {
    if ((await uploadedFileRev(fileId)) >= 0) {
      continue
    }
    const blob = await db.loadFile(fileId)
    if (!blob) {
      // 只有元数据、没有原件的附件不上传；会话 JSON 仍会带上引用。
      continue
    }
    const { rev } = await syncPutFile(fileId, blob)
    await markFileUploaded(fileId, rev)
  }
}

/** 处理一条待上传变更；返回是否发生远端冲突 */
const pushOne = async (item: PendingItem): Promise<boolean> => {
  if (item.kind === 'delete') {
    const baseRev = await getSessionRev(item.id)
    if (baseRev === 0) {
      // 从未上传成功的会话，无需写墓碑
      await clearPending(item.id)
      return false
    }
    try {
      await syncDeleteSession(item.id, baseRev)
      await deleteSessionRev(item.id)
      // 不推进全局游标，理由见 adoptRemote
      await clearPending(item.id)
    } catch (error) {
      if (!isConflict(error)) {
        throw error
      }
      return resolveConflict(item.id, item, undefined)
    }
    return false
  }

  const session = await loadLocalSession(item.id)
  if (!session) {
    // 详情暂时读不到（全量替换事务未提交、缓存缺页）不等于会话被删除。
    // 只有内存列表里也确实没有该会话时，才允许转成墓碑。
    if (useChatStore.getState().sessions.some((summary) => summary.id === item.id)) {
      return false
    }
    await markPending({ id: item.id, kind: 'delete', updatedAt: item.updatedAt })
    return false
  }
  // 生成中的中间态不上传，保留队列等回复结束后的下一次通知
  if (Object.hasOwn(useChatStore.getState().streaming, item.id)) {
    return false
  }
  await uploadSessionFiles(session)
  const baseRev = await getSessionRev(item.id)
  try {
    const { rev } = await syncPutSession(item.id, {
      baseRev,
      updatedAt: session.updatedAt,
      session,
    })
    // 只记录该会话的服务端版本；全局游标仍由 pull 按页推进，
    // pull 会通过 localRev >= change.rev 跳过自己刚上传的回环变更。
    await setSessionRev(item.id, rev)
    await clearPending(item.id)
  } catch (error) {
    if (!isConflict(error)) {
      throw error
    }
    // 重新导入时云端往往是「删除全部」留下的墓碑：409 响应已带当前 rev 和 deleted，
    // 直接显式复活即可，大批量导入时省掉上千次额外的 GET。
    if (item.origin === 'import' && error.deleted && error.serverRev !== undefined) {
      await reupload(item.id, error.serverRev, session, true)
      return false
    }
    return resolveConflict(item.id, item, session)
  }
  return false
}

/** 推送阶段：按时间顺序处理本地待上传变更 */
const push = async (): Promise<number> => {
  let conflicts = 0
  // upsert 可能转成 delete，最多再跑几轮收敛
  for (let round = 0; round < 5; round += 1) {
    const items = await listPending()
    if (items.length === 0) {
      break
    }
    let advanced = false
    for (const item of items) {
      try {
        if (await pushOne(item)) {
          conflicts += 1
        }
        advanced = true
      } catch (error) {
        if (isUnauthorized(error) || isNetwork(error)) {
          throw error
        }
        // 单条失败不阻塞其他会话；保留队列，由外层重试
        setSyncStatus({ errorKey: syncErrorKey(error) })
      }
    }
    if (!advanced) {
      break
    }
    const remaining = await listPending()
    if (remaining.length === 0) {
      break
    }
    // 没有任何一条被成功处理或转换，避免空转
    if (
      remaining.length === items.length &&
      remaining.every((r, index) => r.id === items[index].id && r.kind === items[index].kind)
    ) {
      break
    }
  }
  return conflicts
}

/** 拉取一页变更并应用；返回分页信息、被服务端覆盖的本地改动数、以及本地更新的会话数 */
const pullPage = async (
  since: number
): Promise<{ nextSince: number; hasMore: boolean; overwritten: number; localWins: number }> => {
  const page = await syncChanges(since, PAGE_SIZE)
  const sessions: Session[] = []
  const files: db.StoredFile[] = []
  const deletedIds: string[] = []
  const sessionRevs = new Map<string, number>()
  const removedIds: string[] = []
  const pending = new Map((await listPending()).map((item) => [item.id, item]))
  const localSummaries = new Map(useChatStore.getState().sessions.map((item) => [item.id, item]))
  let overwritten = 0
  let localWins = 0

  for (const change of page.sessions) {
    const localRev = await getSessionRev(change.id)
    if (!change.deleted && localRev >= change.rev) {
      // 自己刚上传的回环变更，跳过重复应用
      continue
    }
    const remote = await syncGetSession(change.id)
    if (remote.deleted) {
      // 导入期间 push 若有单条失败，云端仍可能暂时是墓碑。此时不能用旧墓碑删掉
      // 刚导入的会话：保留 origin='import' 的队列项，下一轮 push 会 revive 覆盖它。
      const queued = pending.get(change.id)
      if (
        queued?.origin === 'import' &&
        queued.kind === 'upsert' &&
        localSummaries.has(change.id)
      ) {
        continue
      }
      deletedIds.push(change.id)
      removedIds.push(change.id)
    } else if (!isSessionPayload(remote.session)) {
      // 损坏数据不能落库，也不能当成删除。游标仍会推进到本页 nextSince，
      // 因此该会话不会自动重试；只能等服务端修正后由用户重新登录触发全量对账。
      setSyncStatus({ errorKey: 'syncErrorInvalidData' })
      continue
    } else {
      // 本地版本比拉下来的更新：不要落库远端旧版本，保留并补上待上传队列，
      // 下一轮 push 会以 serverRev 为 baseRev 把本地版本写回服务端。
      // 列表元数据只有 updatedAt（正常数据里它就是最后一条消息的时间），足够做这个判断。
      const localSummary = localSummaries.get(change.id)
      if (localSummary && localSummary.updatedAt > freshness(remote.session)) {
        if (!pending.has(change.id)) {
          const item: PendingItem = { id: change.id, kind: 'upsert', updatedAt: Date.now() }
          await markPending(item)
          pending.set(change.id, item)
        }
        localWins += 1
        continue
      }
      sessions.push(remote.session)
      sessionRevs.set(change.id, remote.rev)
    }
    // 远端变更覆盖了本地未上传的改动，丢弃该队列项
    if (pending.has(change.id)) {
      await clearPending(change.id)
      pending.delete(change.id)
      overwritten += 1
    }
  }
  for (const change of page.files) {
    if ((await uploadedFileRev(change.id)) >= change.rev) {
      continue
    }
    try {
      const blob = await syncGetFile(change.id)
      files.push({ id: change.id, blob })
      await markFileUploaded(change.id, change.rev)
    } catch (error) {
      if (isUnauthorized(error)) {
        throw error
      }
      // 单个附件失败不影响会话同步，下次对账再补
      setSyncStatus({ errorKey: syncErrorKey(error) })
    }
  }

  if (sessions.length > 0 || files.length > 0 || deletedIds.length > 0) {
    const summaries = await db.applyRemoteChanges({ sessions, files, deletedIds })
    applyRemoteSummaries(
      summaries,
      sessions.map((session) => session.id),
      deletedIds
    )
  }
  await commitSyncProgress(page.nextSince, sessionRevs, removedIds)
  return { nextSince: page.nextSince, hasMore: page.hasMore, overwritten, localWins }
}

/** 拉取阶段：分页直到追上服务端，返回被覆盖的本地改动数与本地更新的会话数 */
const pull = async (): Promise<{ overwritten: number; localWins: number }> => {
  let since = await getLastSyncedRev()
  let overwritten = 0
  let localWins = 0
  for (let page = 0; page < 100; page += 1) {
    const result = await pullPage(since)
    overwritten += result.overwritten
    localWins += result.localWins
    if (!result.hasMore) {
      return { overwritten, localWins }
    }
    if (result.nextSince <= since) {
      throw new SyncError('protocol', 0, 'sync cursor did not advance')
    }
    since = result.nextSince
  }
  throw new SyncError('protocol', 0, 'too many sync pages')
}

/**
 * 全量对账：首次启用、切换账号、导入或删除全部后调用。
 *
 * 导入 ZIP 是「用备份覆盖本地」，本地列表才是权威：旧队列里的删除意图已经过期，
 * 且全量替换期间列表可能尚未稳定。此时若按 sessionRev 差集给云端写墓碑，
 * 会把刚导入的会话在云端删掉，随后 pull 又把墓碑应用回本地，造成两端都丢数据。
 * 因此导入场景传入 { resetPending: true, tombstones: false, origin: 'import' }；
 * origin 让这些队列项在遇到云端墓碑时可以显式复活会话。
 */
const reconcile = async (
  options: { resetPending?: boolean; tombstones?: boolean; origin?: 'import' } = {}
): Promise<void> => {
  const { resetPending = false, tombstones = true, origin } = options
  if (resetPending) {
    await clearAllPending()
  }
  const state = useChatStore.getState()
  const now = Date.now()
  for (const summary of state.sessions) {
    await markPending({
      id: summary.id,
      kind: 'upsert',
      updatedAt: now,
      ...(origin ? { origin } : {}),
    })
  }
  if (!tombstones) {
    return
  }
  const localIds = new Set(state.sessions.map((summary) => summary.id))
  const known = await listSessionRevs()
  for (const id of known.keys()) {
    if (!localIds.has(id)) {
      await markPending({ id, kind: 'delete', updatedAt: now })
    }
  }
}

/** 一次完整同步：先推送本地变更，再拉取远端变更 */
const syncOnce = async (): Promise<void> => {
  if (stopped || !syncReady(useSyncConfig.getState())) {
    setSyncStatus({ phase: 'disabled', errorKey: null })
    return
  }
  if (!useChatStore.getState().ready || useChatStore.getState().importingHistory) {
    // 主库尚未初始化或正在全量替换，稍后重试
    scheduleRetry()
    return
  }
  setSyncStatus({ phase: 'syncing', errorKey: null })
  try {
    const key = syncAccountKey(useSyncConfig.getState())
    if ((await getAccountKey()) !== key) {
      await resetSyncMeta()
      await setAccountKey(key)
      await reconcile()
    }
    const pushConflicts = await push()
    const pullResult = await pull()
    let conflicts = pushConflicts + pullResult.overwritten
    // pull 判定本地版本更新并重新排了队，立刻再推一轮，不等下一次定时或推送通知
    if (pullResult.localWins > 0) {
      conflicts += await push()
    }
    const pending = await listPending()
    if (conflicts > 0) {
      showToast({ key: 'syncConflictToast', params: { count: conflicts } })
    }
    setSyncStatus({
      phase: 'idle',
      lastSyncedAt: Date.now(),
      pending: pending.length,
      errorKey: null,
      conflictCount: conflicts,
    })
    retryDelay = 2_000
  } catch (error) {
    if (isUnauthorized(error)) {
      clearSyncCredentials()
      setSyncStatus({ phase: 'authRequired', errorKey: 'syncErrorAuth' })
      return
    }
    setSyncStatus({ phase: 'error', errorKey: syncErrorKey(error) })
    scheduleRetry()
  }
}

const updatePendingCount = () => {
  void listPending()
    .then((items) => setSyncStatus({ pending: items.length }))
    .catch(() => {})
}

const scheduleRetry = () => {
  if (stopped || retryTimer) {
    return
  }
  retryTimer = window.setTimeout(() => {
    retryTimer = 0
    void enqueue(syncOnce)
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, MAX_BACKOFF_MS)
}

/** 延迟合并本地变更，避免连续输入触发多次同步 */
const scheduleSync = () => {
  if (stopped || !syncReady(useSyncConfig.getState())) {
    return
  }
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = 0
    void enqueue(syncOnce)
  }, DEBOUNCE_MS)
}

/**
 * 合并 WebSocket 通知：一次回复可能产生多条变更，只跑一轮同步。
 * ready 也走这里，用来补齐连接建立/断线期间漏掉的远端写入。
 */
const scheduleWatchSync = () => {
  if (stopped || !syncReady(useSyncConfig.getState())) {
    return
  }
  window.clearTimeout(watchTimer)
  watchTimer = window.setTimeout(() => {
    watchTimer = 0
    void enqueue(syncOnce)
  }, WATCH_DEBOUNCE_MS)
}

/**
 * 本地变更始终记录，即使当前未登录或已关闭同步：
 * 重新开启后这些改动仍要上传，否则关闭期间的编辑会永久丢失。
 * 只有真正发起网络请求时才检查 syncReady。
 */
const handleChange = (event: ChatChangeEvent) => {
  const config = useSyncConfig.getState()
  // 从未配置过同步账号时不记录，避免纯本地使用积累无意义队列
  if (!config.serverUrl || !config.username) {
    return
  }
  if (event.type === 'replace') {
    const fromImport = event.reason === 'import'
    void enqueue(async () => {
      await reconcile(fromImport ? { resetPending: true, tombstones: false, origin: 'import' } : {})
      if (syncReady(useSyncConfig.getState())) {
        await syncOnce()
      }
    })
    return
  }
  if (!event.id) {
    return
  }
  const item: PendingItem = {
    id: event.id,
    kind: event.type === 'delete' ? 'delete' : 'upsert',
    updatedAt: Date.now(),
  }
  void markPending(item)
    .then(() => {
      updatePendingCount()
      scheduleSync()
    })
    .catch(() => {})
}

/** 手动触发同步（设置页按钮） */
export const syncNow = (): Promise<void> => enqueue(syncOnce)

/** 开启/关闭同步，或账号变更后调用 */
export const refreshSyncState = (): Promise<void> =>
  enqueue(async () => {
    if (!syncReady(useSyncConfig.getState())) {
      setSyncStatus({ phase: 'disabled', errorKey: null, pending: 0 })
      return
    }
    await syncOnce()
  })

/** 应用启动时绑定：变更监听、实时推送、定时对账、切回前台时补一次 */
export const startSync = (): (() => void) => {
  if (started) {
    return () => {}
  }
  started = true
  stopped = false
  const unsubscribe = onChatChange(handleChange)
  watch = createWatch({
    onNotify: scheduleWatchSync,
    onAuthFailure: () => {
      clearSyncCredentials()
      setSyncStatus({ phase: 'authRequired', errorKey: 'syncErrorAuth' })
    },
  })
  watch.update(useSyncConfig.getState())
  const unsubscribeConfig = useSyncConfig.subscribe((state, previous) => {
    if (
      state.enabled !== previous.enabled ||
      state.serverUrl !== previous.serverUrl ||
      state.token !== previous.token ||
      state.username !== previous.username
    ) {
      watch?.update(state)
      void refreshSyncState()
    }
  })
  pollTimer = window.setInterval(() => void enqueue(syncOnce), POLL_INTERVAL_MS)
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      // 后台期间推送连接可能被系统挂起，立刻恢复并补拉一次。
      watch?.retryNow()
      void enqueue(syncOnce)
    }
  }
  document.addEventListener('visibilitychange', onVisible)

  if (syncReady(useSyncConfig.getState())) {
    void refreshSyncState()
  } else {
    setSyncStatus({ phase: 'disabled' })
  }
  return () => {
    stopped = true
    started = false
    watch?.close()
    watch = null
    unsubscribe()
    unsubscribeConfig()
    window.clearInterval(pollTimer)
    window.clearTimeout(debounceTimer)
    window.clearTimeout(retryTimer)
    window.clearTimeout(watchTimer)
    debounceTimer = 0
    retryTimer = 0
    watchTimer = 0
  }
}
