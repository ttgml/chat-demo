/**
 * 当前页面实例的同步客户端标识：每个标签页（页面会话）一个随机值。
 * - REST 请求放在 X-Sync-Client-Id 头里，WebSocket 放在首帧认证里；
 * - 服务端据此跳过向写入方本人回推自己的变更通知。否则首次上传上千条会话时，
 *   每上传一批都会收到自己的回环通知，客户端要排队多跑几十轮完整同步，
 *   界面会长时间停在「同步中」；
 * - 不持久化：刷新页面后新连接会收到 ready 并补一次同步，不需要复用旧标识。
 */
const createClientId = (): string => {
  try {
    return crypto.randomUUID()
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

export const syncClientId = createClientId()
