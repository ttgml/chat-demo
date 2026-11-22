import type { Message, Session } from './types.js'

/** 将线性消息列表规范化为单分支，保留消息 ID、内容及时间。 */
export const normalizeSession = (session: Session): Session =>
  session.rootMessageId !== undefined
    ? session
    : {
        ...session,
        rootMessageId: session.messages[0]?.id ?? null,
        messages: session.messages.map((message, index, messages) => ({
          ...message,
          parentId: messages[index - 1]?.id ?? null,
          selectedChildId: messages[index + 1]?.id,
        })),
      }

/** 展示内容与请求上下文共用当前选中的分支路径。 */
export const getVisibleMessages = (session: Session): Message[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: Message[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

export type MessageVersions = { ids: string[]; index: number }

/** 一次遍历收集兄弟版本；版本列表未变化时复用旧对象与索引，避免流式正文更新重绘历史消息。 */
export const buildMessageVersions = (
  session: Session,
  previous: ReadonlyMap<string, MessageVersions>
): ReadonlyMap<string, MessageVersions> => {
  const groups = new Map<string | null | undefined, string[]>()
  for (const message of session.messages) {
    const key = session.rootMessageId === undefined ? message.id : message.parentId
    const ids = groups.get(key)
    if (ids) {
      ids.push(message.id)
    } else {
      groups.set(key, [message.id])
    }
  }

  const versions = new Map<string, MessageVersions>()
  let unchanged = previous.size === session.messages.length
  for (const ids of groups.values()) {
    const cachedIds = previous.get(ids[0])?.ids
    const stableIds =
      cachedIds?.length === ids.length && ids.every((id, index) => id === cachedIds[index])
        ? cachedIds
        : ids
    ids.forEach((id, index) => {
      const cached = previous.get(id)
      const version =
        cached?.ids === stableIds && cached.index === index ? cached : { ids: stableIds, index }
      versions.set(id, version)
      if (version !== cached) {
        unchanged = false
      }
    })
  }
  return unchanged ? previous : versions
}

/** 新消息挂在指定父节点下，并选择新分支；原节点与其后续对话保持不变。 */
export const appendBranch = (
  original: Session,
  parentId: string | null,
  messages: Message[]
): Session => {
  const session = normalizeSession(original)
  const first = messages[0]
  if (!first) {
    return session
  }
  return {
    ...session,
    rootMessageId: parentId === null ? first.id : session.rootMessageId,
    messages: [
      ...session.messages.map((message) =>
        message.id === parentId ? { ...message, selectedChildId: first.id } : message
      ),
      ...messages.map((message, index) => ({
        ...message,
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })),
    ],
  }
}

/** 仅允许切换当前路径上某一节点的兄弟版本，恢复该版本已选中的后续分支。 */
export const selectVersion = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || !getVisibleMessages(session).some((item) => item.parentId === message.parentId)) {
    return original
  }
  return {
    ...session,
    rootMessageId: message.parentId === null ? message.id : session.rootMessageId,
    messages: session.messages.map((item) =>
      item.id === message.parentId ? { ...item, selectedChildId: message.id } : item
    ),
  }
}

/**
 * 删除一轮所需的逆操作信息：把被删消息按原下标插回去，并把下面这几处链接改回原值。
 * 用补丁而不是整会话快照，撤销才不会盖掉删除之后新发的内容。
 */
export type RoundDeletePatch = {
  removed: { message: Message; index: number }[]
  /** 被上提到被删轮次父节点下的后续消息 */
  promotedIds: string[]
  /** 这些后续消息原来的父节点（被删掉的回答）；没有回答时为 null */
  promotedParentId: string | null
  /** 被改写的选择；parentId 为 null 时改写的是 rootMessageId，由 rootMessageId 恢复 */
  selection: { parentId: string | null; selectedChildId: string | undefined }
  rootMessageId: string | null
}

export type RoundDeletion = { session: Session; patch: RoundDeletePatch }

/** 某个父节点下的子消息（同父即同一位置的多个版本）。 */
const groupChildren = (messages: readonly Message[]) => {
  const children = new Map<string | null, string[]>()
  for (const message of messages) {
    const key = message.parentId ?? null
    const ids = children.get(key)
    if (ids) {
      ids.push(message.id)
    } else {
      children.set(key, [message.id])
    }
  }
  return children
}

/**
 * 删除 `messageId` 所在的一整轮：提问与它的回答、该提问的其它版本及其后续分支都被移除，
 * 被删回答之后的对话上提到被删轮次的父节点下，因此显示与请求上下文都不再包含这一轮。
 * 只有当前路径上的消息可以删：删隐藏版本会悄悄改掉当前可见的对话。
 */
export const deleteRound = (original: Session, messageId: string): RoundDeletion | null => {
  const session = normalizeSession(original)
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const target = byId.get(messageId)
  if (!target || !getVisibleMessages(session).some((message) => message.id === messageId)) {
    return null
  }

  // 点回答时删的是它对应的提问，因此两种情况都以提问为准；回答缺失（提问还没答完）也按一轮处理。
  const question =
    target.role === 'user' ? target : target.parentId ? byId.get(target.parentId) : undefined
  const answer =
    target.role === 'assistant'
      ? target
      : target.selectedChildId
        ? byId.get(target.selectedChildId)
        : undefined
  const parentId = question ? (question.parentId ?? null) : null
  const children = groupChildren(session.messages)
  // 回答之后的对话要保留：它们改挂到被删轮次的父节点下，而不是跟着被删的回答一起消失。
  const promotedIds = answer ? (children.get(answer.id) ?? []) : []
  const promoted = new Set(promotedIds)

  const deleteIds = new Set<string>()
  const stack = [...(question ? (children.get(parentId) ?? []) : [target.id])]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || promoted.has(id) || deleteIds.has(id)) {
      continue
    }
    deleteIds.add(id)
    for (const childId of children.get(id) ?? []) {
      stack.push(childId)
    }
  }

  const selectedChildId = answer?.selectedChildId
  const selection = {
    parentId,
    selectedChildId: parentId === null ? undefined : byId.get(parentId)?.selectedChildId,
  }
  const removed = session.messages.flatMap((message, index) =>
    deleteIds.has(message.id) ? [{ message, index }] : []
  )
  const messages = session.messages
    .filter((message) => !deleteIds.has(message.id))
    .map((message) => {
      if (promoted.has(message.id)) {
        return { ...message, parentId }
      }
      return message.id === parentId ? { ...message, selectedChildId } : message
    })

  return {
    session: {
      ...session,
      // 删的是根时，被上提的后续消息成为新的根；全删光时 rootMessageId 为 null。
      rootMessageId:
        parentId === null ? (selectedChildId ?? null) : (session.rootMessageId ?? null),
      messages,
    },
    patch: {
      removed,
      promotedIds,
      promotedParentId: answer?.id ?? null,
      selection,
      rootMessageId: session.rootMessageId ?? null,
    },
  }
}

/** 撤销一次 {@link deleteRound}：把消息插回原位置，并恢复被改写的链接。 */
export const restoreRoundDelete = (session: Session, patch: RoundDeletePatch): Session => {
  const messages = [...session.messages]
  for (const { message, index } of patch.removed) {
    messages.splice(Math.min(index, messages.length), 0, message)
  }
  const promoted = new Set(patch.promotedIds)
  return {
    ...session,
    rootMessageId: patch.rootMessageId,
    messages: messages.map((message) => {
      if (promoted.has(message.id)) {
        return { ...message, parentId: patch.promotedParentId }
      }
      return message.id === patch.selection.parentId
        ? { ...message, selectedChildId: patch.selection.selectedChildId }
        : message
    }),
  }
}
