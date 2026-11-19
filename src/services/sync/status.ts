import { create } from 'zustand'

/** 同步状态，供设置页展示；同步失败只影响这里，不阻塞聊天。 */
export type SyncState = {
  phase: 'disabled' | 'idle' | 'syncing' | 'error' | 'authRequired'
  lastSyncedAt: number
  pending: number
  errorKey: string | null
  conflictCount: number
}

const initial: SyncState = {
  phase: 'disabled',
  lastSyncedAt: 0,
  pending: 0,
  errorKey: null,
  conflictCount: 0,
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
