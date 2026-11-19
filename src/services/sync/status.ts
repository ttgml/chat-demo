import { create } from 'zustand'

/** 实时推送连接状态；失败时自动降级到定时同步，不影响聊天与数据。 */
export type WatchPhase = 'off' | 'connecting' | 'connected' | 'retrying' | 'unsupported'

/** 同步状态，供设置页展示；同步失败只影响这里，不阻塞聊天。 */
export type SyncState = {
  phase: 'disabled' | 'idle' | 'syncing' | 'error' | 'authRequired'
  lastSyncedAt: number
  pending: number
  errorKey: string | null
  conflictCount: number
  watch: WatchPhase
}

const initial: SyncState = {
  phase: 'disabled',
  lastSyncedAt: 0,
  pending: 0,
  errorKey: null,
  conflictCount: 0,
  watch: 'off',
}

export const useSyncStatus = create<SyncState>(() => initial)

export const setSyncStatus = (patch: Partial<SyncState>) => useSyncStatus.setState(patch)

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
