import { create } from 'zustand'

/** 实时推送连接状态；失败时自动降级到定时同步，不影响聊天与数据。 */
export type WatchPhase = 'off' | 'connecting' | 'connected' | 'retrying' | 'unsupported'

/** 同步状态，供设置页展示；同步失败只影响这里，不阻塞聊天。 */
export type SyncState = {
  phase: 'disabled' | 'idle' | 'syncing' | 'error' | 'authRequired'
  lastSyncedAt: number
  pending: number
  /** 本轮同步开始时待上传的条目数，作为进度分母；0 表示当前没有上传任务 */
  pendingTotal: number
  errorKey: string | null
  conflictCount: number
  watch: WatchPhase
}

const initial: SyncState = {
  phase: 'disabled',
  lastSyncedAt: 0,
  pending: 0,
  pendingTotal: 0,
  errorKey: null,
  conflictCount: 0,
  watch: 'off',
}

export const useSyncStatus = create<SyncState>(() => initial)

export const setSyncStatus = (patch: Partial<SyncState>) => useSyncStatus.setState(patch)

/**
 * 本轮同步的上传进度百分比（0-100）。
 * - 分母是本轮开始时的队列规模，分子是已经离队的条目数（pending 会被 push 逐批推小），
 *   因此首次导入上千条时能看到进度前进，而不是只显示一个不变的总数；
 * - 队列不满 2 项时没有「进度」可言，返回 null 让调用方只显示「正在同步」；
 * - 同步期间用户新排队的条目会让进度回退，这里限制在 0-100 之间。
 */
export const syncProgressPercent = (
  state: Pick<SyncState, 'pending' | 'pendingTotal'>
): number | null => {
  if (state.pendingTotal < 2) {
    return null
  }
  const remaining = Math.min(Math.max(state.pending, 0), state.pendingTotal)
  const done = state.pendingTotal - remaining
  return Math.min(100, Math.max(0, Math.floor((done / state.pendingTotal) * 100)))
}

export const syncErrorKey = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.name === 'SyncError') {
      const code = (error as Error & { code?: string }).code
      switch (code) {
        case 'unauthorized':
          return 'syncErrorAuth'
        case 'network':
          return 'syncErrorNetwork'
        case 'conflict':
          return 'syncErrorConflict'
        case 'too_large':
          return 'syncErrorTooLarge'
        case 'rate_limited':
          return 'syncErrorRateLimited'
        default:
          return 'syncErrorServer'
      }
    }
  }
  return 'syncErrorLocal'
}
