import { useSyncConfig } from './config.js'
import { SyncError, type SyncChanges, type SyncErrorBody, type SyncSessionsBatch } from './types.js'

const REQUEST_TIMEOUT = 20_000
/** 大附件在移动网络下可能远超普通 API 超时；32MB 按 2Mbps 上传就要两分钟。 */
const FILE_TIMEOUT = 120_000

const baseUrl = (): string => useSyncConfig.getState().serverUrl

const tokenOf = (): string => useSyncConfig.getState().token ?? ''

/** 合并外部取消信号与超时，不依赖较新的 AbortSignal.any */
const withTimeout = (
  timeout: number,
  signal?: AbortSignal
): { signal: AbortSignal; cancel: () => void } => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    cancel: () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

const readErrorBody = async (response: Response): Promise<SyncErrorBody> => {
  try {
    const value: unknown = await response.json()
    if (value && typeof value === 'object') {
      const body = value as SyncErrorBody
      return {
        error: typeof body.error === 'string' ? body.error : undefined,
        message: typeof body.message === 'string' ? body.message : undefined,
        serverRev: typeof body.serverRev === 'number' ? body.serverRev : undefined,
        deleted: typeof body.deleted === 'boolean' ? body.deleted : undefined,
      }
    }
  } catch {
    // 非 JSON 错误体
  }
  return {}
}

const request = async (
  path: string,
  init: RequestInit & { auth?: boolean } = {},
  signal?: AbortSignal,
  timeout = REQUEST_TIMEOUT
): Promise<Response> => {
  const { auth = true, headers, ...rest } = init
  const combined = withTimeout(timeout, signal)
  const requestHeaders = new Headers(headers)
  if (auth) {
    requestHeaders.set('Authorization', `Bearer ${tokenOf()}`)
  }
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...rest,
      headers: requestHeaders,
      signal: combined.signal,
    })
    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new SyncError(
        body.error ?? 'http',
        response.status,
        body.message ?? response.statusText,
        body.serverRev,
        body.deleted
      )
    }
    return response
  } catch (error) {
    if (error instanceof SyncError) {
      throw error
    }
    if (signal?.aborted) {
      throw error
    }
    throw new SyncError('network', 0, error instanceof Error ? error.message : String(error))
  } finally {
    combined.cancel()
  }
}

const jsonRequest = async <T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
  signal?: AbortSignal,
  timeout = REQUEST_TIMEOUT
): Promise<T> => {
  const response = await request(path, init, signal, timeout)
  return (await response.json()) as T
}

export type LoginResult = { token: string }

/** 注册 / 登录用传入的地址，避免账号切换时读到旧配置 */
export const syncLogin = async (
  serverUrl: string,
  username: string,
  password: string,
  register: boolean
): Promise<string> => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(`${serverUrl}/api/${register ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new SyncError(
        body.error ?? 'http',
        response.status,
        body.message ?? response.statusText
      )
    }
    const result = (await response.json()) as LoginResult
    if (!result.token) {
      throw new SyncError('protocol', response.status, 'missing token')
    }
    return result.token
  } catch (error) {
    if (error instanceof SyncError) {
      throw error
    }
    throw new SyncError('network', 0, error instanceof Error ? error.message : String(error))
  } finally {
    window.clearTimeout(timer)
  }
}

export const syncLogout = (signal?: AbortSignal): Promise<void> =>
  request('/api/logout', { method: 'POST' }, signal).then(() => undefined)

export type SyncServerState = {
  rev: number
  /** 云端未删除的会话数；旧版服务端不返回此字段 */
  sessions?: number
}

export const syncState = (signal?: AbortSignal): Promise<SyncServerState> =>
  jsonRequest<SyncServerState>('/api/state', {}, signal)

export const syncChanges = (since: number, limit = 200, signal?: AbortSignal) =>
  jsonRequest<SyncChanges>(
    `/api/changes?since=${encodeURIComponent(String(since))}&limit=${limit}`,
    {},
    signal
  )

export const syncGetSession = (id: string, signal?: AbortSignal) =>
  jsonRequest<{
    rev: number
    updatedAt: number
    deleted: boolean
    session: unknown
  }>(`/api/session/${encodeURIComponent(id)}`, {}, signal)

/**
 * 批量取会话详情。分页同步一页最多 200 条变更，逐条 GET 会变成 200 次请求，
 * 每次还要鉴权查一次数据库，所以服务端提供了批量接口。
 * 响应可能因 payload 总量超预算被截断（truncated），缺失的 id 由调用方回退单条接口。
 */
export const syncGetSessions = (
  ids: string[],
  signal?: AbortSignal
): Promise<SyncSessionsBatch> =>
  jsonRequest<SyncSessionsBatch>(
    '/api/sessions/batch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    },
    signal
  )

export const syncPutSession = (
  id: string,
  body: { baseRev: number; updatedAt: number; session: unknown; revive?: boolean },
  signal?: AbortSignal
) =>
  jsonRequest<{ rev: number }>(
    `/api/session/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    signal
  )

export const syncDeleteSession = (id: string, baseRev: number, signal?: AbortSignal) =>
  jsonRequest<{ rev: number }>(
    `/api/session/${encodeURIComponent(id)}?baseRev=${encodeURIComponent(String(baseRev))}`,
    { method: 'DELETE' },
    signal
  )

export const syncPutFile = (id: string, blob: Blob, signal?: AbortSignal) =>
  jsonRequest<{ rev: number }>(
    `/api/file/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    },
    signal,
    FILE_TIMEOUT
  )

export const syncGetFile = (id: string, signal?: AbortSignal): Promise<Blob> =>
  request(`/api/file/${encodeURIComponent(id)}`, {}, signal, FILE_TIMEOUT).then((response) =>
    response.blob()
  )
