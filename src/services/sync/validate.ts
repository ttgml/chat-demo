import type { Session } from '../chat/types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512

/**
 * 校验服务端返回的会话 JSON。
 * 服务端原样存储客户端 payload，不解析内部字段，因此落库前必须在这里做结构检查，
 * 避免损坏或恶意数据写进 IndexedDB 后污染本地状态。
 * expectedId 用于确认 payload 与请求的会话 id 一致：主库按 payload.id 落键，
 * 若两者不一致会写出一个 id 对不上的幽灵会话，并让真正的 id 永远无法同步。
 */
export const isSessionPayload = (value: unknown, expectedId?: string): value is Session => {
  if (!isRecord(value)) {
    return false
  }
  if (
    !isNonEmptyString(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) ||
    typeof value.title !== 'string' ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !Array.isArray(value.messages)
  ) {
    return false
  }
  if (
    value.rootMessageId !== undefined &&
    value.rootMessageId !== null &&
    typeof value.rootMessageId !== 'string'
  ) {
    return false
  }
  for (const message of value.messages) {
    if (!isRecord(message) || !isNonEmptyString(message.id) || !isFiniteNumber(message.createdAt)) {
      return false
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string' || !Array.isArray(message.files)) {
        return false
      }
      for (const file of message.files) {
        if (!isRecord(file) || !isNonEmptyString(file.id) || typeof file.name !== 'string') {
          return false
        }
      }
    } else if (message.role === 'assistant') {
      if (!Array.isArray(message.blocks) || typeof message.status !== 'string') {
        return false
      }
    } else {
      return false
    }
  }
  return true
}

/** 从会话中提取所有引用的附件 id，用于上传原件 */
export const sessionFileIds = (session: Session): string[] => {
  const ids = new Set<string>()
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      ids.add(file.id)
    }
  }
  return [...ids]
}
