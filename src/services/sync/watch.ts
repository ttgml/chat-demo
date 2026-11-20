import { syncReady, type SyncConfig } from './config.js'
import { syncClientId } from './identity.js'
import { setSyncStatus, type WatchPhase } from './status.js'

/** 握手超时：代理不支持 Upgrade 时浏览器可能迟迟不触发 onclose */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** 首帧认证超时：连上但服务端不响应时不要一直挂着 */
const AUTH_TIMEOUT_MS = 8_000
/** 应用层心跳检查间隔；服务端每 25s 发一次 ping */
const WATCHDOG_INTERVAL_MS = 10_000
const WATCHDOG_TIMEOUT_MS = 70_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 60_000

type WatchCallbacks = {
  /** 收到 ready（补连上之前的变更）或 changed（有远端写入）时触发增量同步 */
  onNotify: () => void
  /** 服务端判定 token 失效，交回同步引擎清除登录态 */
  onAuthFailure: () => void
}

export type WatchController = {
  /** 同步配置变化时重新评估连接；配置未变则不做任何事 */
  update: (config: SyncConfig) => void
  /** 页面切回前台时立刻重试，不必等退避计时器 */
  retryNow: () => void
  close: () => void
}

/** 由 http(s) 服务地址推导 ws(s) 地址，保留反向代理可能使用的路径前缀 */
const watchUrl = (serverUrl: string): string | null => {
  try {
    const url = new URL(serverUrl)
    if (url.protocol === 'https:') {
      url.protocol = 'wss:'
    } else if (url.protocol === 'http:') {
      url.protocol = 'ws:'
    } else {
      return null
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/watch`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** 用普通 GET 探测 watch 端点是否存在，保持 http(s) 协议 */
const probeUrl = (serverUrl: string): string | null => {
  try {
    const url = new URL(serverUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/watch`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** 只有服务地址与 token 决定连接归属；用户名变化不需要重连 */
const connectionKey = (config: SyncConfig): string =>
  syncReady(config) ? `${config.serverUrl}\n${config.token ?? ''}` : ''

/**
 * 订阅服务端的轻量变更通知。服务端只推 rev，不推内容，收到后由同步引擎
 * 走既有的 /api/changes 增量拉取，因此断线、乱序、漏通知都有定时同步兜底。
 * 连接不支持的场景（旧服务端、代理未放行 Upgrade）会自动退避重连，
 * 不影响聊天与本地数据。
 */
export const createWatch = (callbacks: WatchCallbacks): WatchController => {
  let config: SyncConfig | null = null
  let socket: WebSocket | null = null
  let key = ''
  let generation = 0
  let closed = false
  let authBlocked = false
  let unsupported = false
  let probeDone = false
  let phase: WatchPhase = 'off'
  let retryDelay = RETRY_MIN_MS
  let lastMessageAt = 0
  let retryTimer = 0
  let handshakeTimer = 0
  let authTimer = 0

  const setPhase = (next: WatchPhase): void => {
    if (phase === next) {
      return
    }
    phase = next
    setSyncStatus({ watch: next })
  }

  const clearTimers = (): void => {
    window.clearTimeout(retryTimer)
    window.clearTimeout(handshakeTimer)
    window.clearTimeout(authTimer)
    retryTimer = 0
    handshakeTimer = 0
    authTimer = 0
  }

  /** 断开并让旧连接的所有回调失效，避免重连期间收到过期消息 */
  const detach = (): void => {
    generation += 1
    clearTimers()
    const ws = socket
    socket = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        // 连接已关闭
      }
    }
  }

  /**
   * 握手总是失败时，用普通 GET 探测端点：新版服务端因缺少 Upgrade 头返回 400，
   * 未包含该路由的旧版服务端返回 404。据此区分「服务端版本过旧」与
   * 网络/代理故障，避免用户只看到无限重连却不知道原因。
   * CORS 未放行时读不到状态码，保持原有重连行为即可。
   */
  function probeSupport(serverUrl: string): void {
    if (probeDone) {
      return
    }
    probeDone = true
    const url = probeUrl(serverUrl)
    if (!url) {
      return
    }
    const gen = generation
    void fetch(url, { method: 'GET', cache: 'no-store' })
      .then((response) => {
        if (
          closed ||
          gen !== generation ||
          config?.serverUrl !== serverUrl ||
          phase === 'connected'
        ) {
          return
        }
        if (response.status === 404) {
          unsupported = true
          setPhase('unsupported')
        }
      })
      .catch(() => {
        // 无法读取状态码时不做判定，继续按退避重连
      })
  }

  function scheduleReconnect(): void {
    if (closed || authBlocked || !config || !syncReady(config)) {
      return
    }
    // 已确认服务端不支持时降为低频探测，服务端升级后仍能自动恢复。
    if (unsupported) {
      setPhase('unsupported')
      retryTimer = window.setTimeout(() => {
        retryTimer = 0
        connect()
      }, RETRY_MAX_MS)
      return
    }
    // 抖动避免所有客户端在服务端重启后同时重连
    const delay = Math.round(retryDelay * (0.8 + Math.random() * 0.4))
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    setPhase('retrying')
    retryTimer = window.setTimeout(() => {
      retryTimer = 0
      connect()
    }, delay)
  }

  function connect(): void {
    if (closed || authBlocked || !config || !syncReady(config)) {
      return
    }
    const current = config
    const url = watchUrl(current.serverUrl)
    if (!url) {
      setPhase('off')
      return
    }
    const myGen = ++generation
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    socket = ws
    setPhase('connecting')
    lastMessageAt = Date.now()

    handshakeTimer = window.setTimeout(() => {
      if (myGen === generation) {
        ws.close()
      }
    }, HANDSHAKE_TIMEOUT_MS)

    ws.onopen = () => {
      if (myGen !== generation) {
        ws.close()
        return
      }
      window.clearTimeout(handshakeTimer)
      handshakeTimer = 0
      lastMessageAt = Date.now()
      try {
        // clientId 让服务端在广播时跳过本页面自己写入的变更。
        ws.send(JSON.stringify({ type: 'auth', token: current.token, clientId: syncClientId }))
      } catch {
        ws.close()
        return
      }
      authTimer = window.setTimeout(() => {
        if (myGen === generation) {
          ws.close()
        }
      }, AUTH_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      if (myGen !== generation) {
        return
      }
      lastMessageAt = Date.now()
      let value: unknown
      try {
        value = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!value || typeof value !== 'object') {
        return
      }
      const type = (value as { type?: unknown }).type
      if (type === 'ready') {
        window.clearTimeout(authTimer)
        authTimer = 0
        retryDelay = RETRY_MIN_MS
        unsupported = false
        probeDone = false
        setPhase('connected')
        // 连接建立期间可能有其它设备写入，补拉一次。
        callbacks.onNotify()
      } else if (type === 'changed') {
        callbacks.onNotify()
      } else if (type === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong' }))
        } catch {
          // 连接已断开，onclose 会重连
        }
      } else if (type === 'auth_required') {
        // token 已失效：停止重连，等用户重新登录（配置变化）后再启用。
        authBlocked = true
        callbacks.onAuthFailure()
        detach()
        setPhase('off')
      } else if (type === 'error') {
        // 服务端临时故障，不清除登录态，断开后按退避重连。
        ws.close()
      }
    }

    ws.onclose = () => {
      if (myGen !== generation) {
        return
      }
      socket = null
      clearTimers()
      if (closed || authBlocked) {
        setPhase('off')
        return
      }
      // 首次握手失败时探测一次端点，识别仍在运行旧版服务端的情况。
      if (!probeDone) {
        probeSupport(current.serverUrl)
      }
      scheduleReconnect()
    }
  }

  // 半开连接（网线断开、移动端休眠）时 onclose 可能很久才来，主动探活。
  const watchdogTimer = window.setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }
    if (Date.now() - lastMessageAt > WATCHDOG_TIMEOUT_MS) {
      socket.close()
    }
  }, WATCHDOG_INTERVAL_MS)

  const update = (next: SyncConfig): void => {
    if (closed) {
      return
    }
    const nextKey = connectionKey(next)
    if (config !== null && nextKey === key) {
      return
    }
    const changed = nextKey !== key
    key = nextKey
    config = next
    // 换账号/重新登录/换服务地址后，重新评估认证与端点能力。
    if (changed) {
      authBlocked = false
      unsupported = false
      probeDone = false
    }
    retryDelay = RETRY_MIN_MS
    detach()
    if (syncReady(next)) {
      connect()
    } else {
      setPhase('off')
    }
  }

  const retryNow = (): void => {
    if (closed || !config || !syncReady(config)) {
      return
    }
    authBlocked = false
    retryDelay = RETRY_MIN_MS
    if (socket && socket.readyState === WebSocket.OPEN) {
      return
    }
    detach()
    connect()
  }

  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    window.clearInterval(watchdogTimer)
    detach()
    config = null
    key = ''
    setPhase('off')
  }

  return { update, retryNow, close }
}
