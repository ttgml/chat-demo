import * as db from '../chat/db.js'
import {
  applyRemoteSummaries,
  onChatChange,
  useChatStore,
  type ChatChangeEvent,
} from '../chat/store.js'
import { sessionFreshness, type Session } from '../chat/types.js'
import { showToast } from '../../components/base/toastState.js'
import { clearSyncCredentials, syncAccountKey, syncReady, useSyncConfig } from './config.js'
import {
  syncChanges,
  syncDeleteSession,
  syncGetFile,
  syncGetSession,
  syncPutFile,
  syncPutSession,
  syncState,
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
  markPendingMany,
  prepareLocalDeletion,
  resetSyncMeta,
  resetSyncProgress,
  setAccountKey,
  setSessionRev,
  uploadedFileRev,
  type PendingItem,
} from './meta.js'
import { setSyncStatus, syncErrorKey, useSyncStatus } from './status.js'
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
/** 每次页面会话只做一次遗留漏同步修复，避免每轮同步都扫描全部会话。 */
let backfilled = false

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
  if (!deleted && !isSessionPayload(payload, id)) {
    // 损坏的 payload 绝不能当作删除，否则会抹掉本地数据
    return false
  }
  const session = deleted ? null : (payload as Session)
  const result = await db.applyRemoteChanges({
    sessions: session ? [session] : [],
    files: [],
    deletedIds: deleted ? [id] : [],
  })
  // 解决冲突期间本地又落盘了更新的版本（例如用户刚好在此刻编辑）：保留本地与队列。
  if (session && result.skippedSessionIds.includes(id)) {
    return false
  }
  applyRemoteSummaries(
    result.summaries,
    session ? result.appliedSessionIds : [],
    deleted ? [id] : []
  )
  if (deleted) {
    await deleteSessionRev(id)
  } else {
    await setSessionRev(id, rev)
  }
  return true
}

type FetchedSession = Awaited<ReturnType<typeof syncGetSession>>

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
  if (!isSessionPayload(remote.session, id)) {
    // 损坏数据既不能落库也不能当成删除，保留队列等下次重试
    return false
  }
  if (local && sessionFreshness(local) > sessionFreshness(remote.session)) {
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

  // 同一页里同一个会话可能先删除再恢复：变更按 rev 升序返回，后出现的状态才是最终状态。
  const dropQueuedSession = (id: string) => {
    const index = sessions.findIndex((session) => session.id === id)
    if (index !== -1) {
      sessions.splice(index, 1)
    }
    sessionRevs.delete(id)
  }
  const dropQueuedDeletion = (id: string) => {
    for (const list of [deletedIds, removedIds]) {
      const index = list.indexOf(id)
      if (index !== -1) {
        list.splice(index, 1)
      }
    }
  }

  for (const change of page.sessions) {
    const localRev = await getSessionRev(change.id)
    // 本地已持有不早于该变更的版本：可能是自己刚上传的回环，也可能是更晚的恢复。
    // 墓碑也必须跳过，否则旧的删除事件会删掉本地已恢复或已更新的会话。
    if (localRev >= change.rev) {
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
      // 更晚的墓碑覆盖同一页里更早的恢复版本。
      dropQueuedSession(change.id)
      deletedIds.push(change.id)
      removedIds.push(change.id)
    } else {
      // 服务端最新状态是有效会话：同一页里更早的墓碑作废，不能让它删掉随后恢复的会话。
      dropQueuedDeletion(change.id)
      if (!isSessionPayload(remote.session, change.id)) {
        // 损坏数据不能落库，也不能当成删除。游标仍会推进到本页 nextSince，
        // 因此该会话不会自动重试；只能等服务端修正后由用户重新登录触发全量对账。
        setSyncStatus({ errorKey: 'syncErrorInvalidData' })
        continue
      }
      // 本地版本比拉下来的更新：不要落库远端旧版本，保留并补上待上传队列，
      // 下一轮 push 会以 serverRev 为 baseRev 把本地版本写回服务端。
      // 列表元数据没有消息，按 updatedAt 与置顶时间计算新鲜度就够用（last message 时间不会晚于 updatedAt）。
      const localSummary = localSummaries.get(change.id)
      if (localSummary && sessionFreshness(localSummary) > sessionFreshness(remote.session)) {
        if (!pending.has(change.id)) {
          const item: PendingItem = { id: change.id, kind: 'upsert', updatedAt: Date.now() }
          await markPending(item)
          pending.set(change.id, item)
        }
        localWins += 1
        continue
      }
      // 同一页里更早的同一会话版本由最新版本替换（GET 返回的是当前版本）。
      dropQueuedSession(change.id)
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
  const fileRevs = new Map<string, number>()
  for (const change of page.files) {
    if ((await uploadedFileRev(change.id)) >= change.rev) {
      continue
    }
    try {
      const blob = await syncGetFile(change.id)
      files.push({ id: change.id, blob })
      fileRevs.set(change.id, change.rev)
    } catch (error) {
      if (isUnauthorized(error)) {
        throw error
      }
      // 单个附件失败不影响会话同步，下次对账再补
      setSyncStatus({ errorKey: syncErrorKey(error) })
    }
  }

  if (sessions.length > 0 || files.length > 0 || deletedIds.length > 0) {
    const result = await db.applyRemoteChanges({ sessions, files, deletedIds })
    // 本地在 pull 期间又落盘的会话不会被远端旧版本覆盖；重新排队，下一轮 push 上传本地版本。
    for (const id of result.skippedSessionIds) {
      await markPending({ id, kind: 'upsert', updatedAt: Date.now() })
    }
    localWins += result.skippedSessionIds.length
    applyRemoteSummaries(result.summaries, result.appliedSessionIds, deletedIds)
  }
  // 落库成功后才记录附件版本：applyRemoteChanges 失败（例如存储配额不足）时
  // 不能把附件标记为已同步，否则下次不会重试，本地会永久缺少原件。
  for (const [id, rev] of fileRevs) {
    await markFileUploaded(id, rev)
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
  const items: PendingItem[] = state.sessions.map((summary) => ({
    id: summary.id,
    kind: 'upsert',
    updatedAt: now,
    ...(origin ? { origin } : {}),
  }))
  if (tombstones) {
    const localIds = new Set(state.sessions.map((summary) => summary.id))
    const known = await listSessionRevs()
    for (const id of known.keys()) {
      if (!localIds.has(id)) {
        items.push({ id, kind: 'delete', updatedAt: now })
      }
    }
  }
  // 单事务写入：首次登录上千条时旧实现要开上千个事务，既慢又容易被刷新页面打断。
  await markPendingMany(items)
}

/**
 * 补回“从未成功上传、也不在待上传队列”的本地会话。
 * 用于修复旧版本在 reconcile 中途被刷新/关闭后留下的永久漏同步状态；
 * 正常已同步的会话都有 sessionRev，不会重复入队。
 */
const backfillMissingSessions = async (): Promise<void> => {
  const state = useChatStore.getState()
  if (state.sessions.length === 0) {
    return
  }
  const known = await listSessionRevs()
  const pending = new Set((await listPending()).map((item) => item.id))
  const now = Date.now()
  const items: PendingItem[] = state.sessions
    .filter((summary) => !known.has(summary.id) && !pending.has(summary.id))
    .map((summary) => ({ id: summary.id, kind: 'upsert', updatedAt: now }))
  if (items.length > 0) {
    await markPendingMany(items)
  }
}

/** 同步不可用（未登录、已暂停、凭据失效）时的状态。
 * 401 会先清空 token，配置订阅随后触发一次 refreshSyncState；如果这里无条件写 disabled，
 * 会把刚设置的 authRequired 覆盖掉，用户只能看到「未启用」而不知道需要重新登录。 */
const showSyncUnavailable = (resetPending: boolean) => {
  if (useSyncStatus.getState().phase === 'authRequired') {
    setSyncStatus({ phase: 'authRequired', errorKey: 'syncErrorAuth' })
    return
  }
  setSyncStatus({
    phase: 'disabled',
    errorKey: null,
    ...(resetPending ? { pending: 0 } : {}),
  })
}

/**
 * 首次登录、切换账号，或发现服务端数据被重置：清空旧进度并按本地现存会话重建上传队列。
 * accountKey 必须最后写入：reconcile 可能要给上千个会话排队，若中途刷新页面/关闭标签页，
 * 账号标识已存在但队列只写了一半，后续同步不会再补，本地会话会永久漏传。
 */
const resetAccountProgress = async (key: string): Promise<void> => {
  await resetSyncMeta()
  await reconcile()
  await setAccountKey(key)
}

/** 一次完整同步：先推送本地变更，再拉取远端变更 */
const syncOnce = async (): Promise<void> => {
  if (stopped || !syncReady(useSyncConfig.getState())) {
    showSyncUnavailable(false)
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
    const localRev = await getLastSyncedRev()
    if ((await getAccountKey()) !== key) {
      await resetAccountProgress(key)
    } else if (localRev > 0) {
      // user_rev 按账号单调递增，不可能回退。比本地游标小只可能是服务端换了数据库、
      // 重建了账号，或清空了同步数据；此时旧游标与 sessionRev 全部失效，必须重新对账，
      // 否则本地会话永远不会上传（syncOnce 只看 pending，pull 也会从过大的 since 开始）。
      const remote = await syncState()
      if (remote.rev < localRev) {
        await resetAccountProgress(key)
      }
    }
    if (!backfilled) {
      // 修复旧版本在全量对账中途被刷新后留下的「本地有会话但不在队列」状态。
      await backfillMissingSessions()
      backfilled = true
    }
    // 先把队列规模反映到设置页，避免首次上传上千条时一直显示「已同步 / 0 组对话」。
    await updatePendingCount()
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

const updatePendingCount = () =>
  listPending()
    .then((items) => setSyncStatus({ pending: items.length }))
    .catch(() => {})

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
  if (event.type === 'replace') {
    // 未登录时的「删除所有对话」是本地重置，不能当成云端删除意图：
    // 保留账号标识，清空游标/队列，重新登录后从服务端把数据拉回来。
    // 已登录时仍然写墓碑，保证删除全部能同步到其它设备。
    if (event.reason === 'clear' && config.token === null) {
      void enqueue(async () => {
        await resetSyncProgress()
        updatePendingCount()
      })
      return
    }
    // 从未配置过同步账号时不记录，避免纯本地使用积累无意义队列
    if (!config.serverUrl || !config.username) {
      return
    }
    const fromImport = event.reason === 'import'
    void enqueue(async () => {
      await reconcile(fromImport ? { resetPending: true, tombstones: false, origin: 'import' } : {})
      if (syncReady(useSyncConfig.getState())) {
        await syncOnce()
      }
    })
    return
  }
  // 从未配置过同步账号时不记录，避免纯本地使用积累无意义队列
  if (!config.serverUrl || !config.username) {
    return
  }
  if (!event.id) {
    return
  }
  // 未登录时删除单个会话只影响本地：不写云端墓碑，下次登录时从服务端合并回来。
  if (event.type === 'delete' && config.token === null) {
    void prepareLocalDeletion(event.id, event.fileIds)
      .then(updatePendingCount)
      .catch(() => {})
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
      showSyncUnavailable(true)
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
