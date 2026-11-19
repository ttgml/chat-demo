import { create } from 'zustand'

/**
 * 云同步的本机配置，存 localStorage。
 * 注意：密码不落盘，登录成功后只保存 token；token 与聊天数据同属敏感信息，
 * 服务端用 token 隔离用户，泄露等价于账号被盗。
 */
export type SyncConfig = {
  enabled: boolean
  /** 同步服务根地址，例如 https://sync.example.com（不带 /api） */
  serverUrl: string
  username: string
  token: string | null
}

const KEYS = {
  enabled: 'chat-demo:sync-enabled',
  serverUrl: 'chat-demo:sync-server-url',
  username: 'chat-demo:sync-username',
  token: 'chat-demo:sync-token',
} as const

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 去掉末尾斜杠与常见的 /api 后缀，避免拼接出双斜杠 */
export const normalizeServerUrl = (raw: string): string => {
  let url = raw.trim().replace(/\/+$/, '')
  if (/\/api$/.test(url)) {
    url = url.slice(0, -4).replace(/\/+$/, '')
  }
  return url
}

const initial: SyncConfig = {
  enabled: read(KEYS.enabled) === 'true',
  serverUrl: read(KEYS.serverUrl) ?? '',
  username: read(KEYS.username) ?? '',
  token: read(KEYS.token),
}

export const useSyncConfig = create<SyncConfig>(() => initial)

export const setSyncEnabled = (enabled: boolean) => {
  write(KEYS.enabled, String(enabled))
  useSyncConfig.setState({ enabled })
}

export const setSyncServerUrl = (serverUrl: string) => {
  const value = normalizeServerUrl(serverUrl)
  write(KEYS.serverUrl, value)
  useSyncConfig.setState({ serverUrl: value })
}

export const setSyncUsername = (username: string) => {
  write(KEYS.username, username)
  useSyncConfig.setState({ username })
}

export const setSyncToken = (token: string | null) => {
  write(KEYS.token, token)
  useSyncConfig.setState({ token })
}

/** 切换服务器或账号时清空凭据，避免旧 token 被发到新地址 */
export const clearSyncCredentials = () => {
  write(KEYS.token, null)
  useSyncConfig.setState({ token: null })
}

/** 登录成功后一次性写入，避免多次触发同步状态刷新 */
export const applySyncAccount = (values: {
  serverUrl: string
  username: string
  token: string
}) => {
  const serverUrl = normalizeServerUrl(values.serverUrl)
  write(KEYS.serverUrl, serverUrl)
  write(KEYS.username, values.username)
  write(KEYS.token, values.token)
  write(KEYS.enabled, 'true')
  useSyncConfig.setState({
    serverUrl,
    username: values.username,
    token: values.token,
    enabled: true,
  })
}

/** 配置是否完整到可以发起同步 */
export const syncReady = (config: SyncConfig): boolean =>
  config.enabled && config.serverUrl.length > 0 && config.token !== null

/** 账号标识：用于检测切换账号后本地数据归属 */
export const syncAccountKey = (config: SyncConfig): string =>
  `${config.serverUrl}\n${config.username}`
