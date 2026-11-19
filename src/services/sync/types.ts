/** 云同步：与 chat-demo 同步服务端通信的类型。会话 payload 保持客户端原生格式，服务端不解析。 */

export type SyncChange = {
  id: string
  rev: number
  updatedAt?: number
  deleted?: boolean
  mimeType?: string
}

export type SyncChanges = {
  /** 服务端全局游标，仅在 hasMore 为 false 时可作为上次同步版本 */
  rev: number
  /** 下一页请求应携带的 since（本页最大 rev） */
  nextSince: number
  sessions: SyncChange[]
  files: SyncChange[]
  hasMore: boolean
}

export type RemoteSession = {
  rev: number
  updatedAt: number
  deleted: boolean
  /** 原生 Session JSON，客户端需自行校验后再落库 */
  session: unknown
}

export type SessionChange = {
  id: string
  rev: number
  updatedAt: number
  deleted: boolean
  /** 非删除时为已校验的原生 Session JSON */
  session: unknown
}

export type FileChange = {
  id: string
  rev: number
  blob: Blob
}

/** 服务端返回的错误体 */
export type SyncErrorBody = {
  error?: string
  message?: string
  serverRev?: number
  deleted?: boolean
}

export class SyncError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly serverRev?: number,
    /** 409 时服务端该会话是否为删除墓碑 */
    readonly deleted?: boolean
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

/** 同步运行状态，供设置页展示 */
export type SyncPhase = 'disabled' | 'idle' | 'syncing' | 'error' | 'authRequired'

export type SyncStatus = {
  phase: SyncPhase
  /** 最近一次成功同步的时间戳；0 表示从未成功 */
  lastSyncedAt: number
  /** 待上传的变更数 */
  pending: number
  /** 最近一次错误的可展示文案 key */
  errorKey: string | null
  conflictCount: number
}
