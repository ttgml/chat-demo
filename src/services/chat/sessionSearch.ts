import { loadAllSessions } from './db.js'
import { isPinned, type Session } from './types.js'

/**
 * 对话历史搜索：一次性读出全部会话建成内存索引，面板打开期间在本地过滤。
 * 只索引用户可见的文本（提问、回答正文、附件名），跳过思考过程、模板提示与工具结果，
 * 避免把服务端注入的中间数据也搜出来。
 */

/** 索引项：标题与摊平后的正文（空白已折叠，便于取片段） */
export type SessionSearchDoc = {
  id: string
  title: string
  updatedAt: number
  pinnedAt?: number
  text: string
}

export type SessionSearchHit = SessionSearchDoc & {
  /** 命中的正文片段；只有标题命中时为 null */
  snippet: string | null
}

/** 片段命中的上下文宽度（命中词左右各取这么多字符） */
const SNIPPET_RADIUS = 36
/** 最多返回的命中条数；列表本身可滚动，再多也不会有人翻到底 */
const RESULT_LIMIT = 50

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

const sessionText = (session: Session): string => {
  const parts: string[] = []
  for (const message of session.messages) {
    if (message.role === 'user') {
      if (message.content) {
        parts.push(message.content)
      }
      for (const file of message.files) {
        parts.push(file.name)
      }
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'text' && !block.isTemplate && block.text) {
        parts.push(block.text)
      }
    }
  }
  return flatten(parts.join('\n'))
}

const toDoc = (session: Session): SessionSearchDoc => ({
  id: session.id,
  title: session.title,
  updatedAt: session.updatedAt,
  ...(isPinned(session) ? { pinnedAt: session.pinnedAt } : {}),
  text: sessionText(session),
})

/**
 * 读取全部会话建索引。列表里已有的会话（含刚改过标题、尚未同步到列表的）优先用内存版本，
 * 避免搜索结果落后于界面。
 */
export const loadSessionSearchDocs = async (
  cached: Record<string, Session>
): Promise<SessionSearchDoc[]> => {
  const sessions = await loadAllSessions()
  return sessions.map((session) =>
    toDoc(Object.hasOwn(cached, session.id) ? cached[session.id] : session)
  )
}

/** 查询拆成空白分隔的关键词，全部命中才算匹配（不区分大小写） */
export const splitQuery = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).filter(Boolean)

const snippetOf = (doc: SessionSearchDoc, tokens: string[]): string | null => {
  const text = doc.text.toLowerCase()
  let at = -1
  let length = 0
  // 取最靠前的命中词，关键词分散时片段也只围绕最早命中处
  for (const token of tokens) {
    const found = text.indexOf(token)
    if (found === -1) {
      continue
    }
    if (at === -1 || found < at) {
      at = found
      length = token.length
    }
  }
  if (at === -1) {
    return null
  }
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(doc.text.length, at + length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${doc.text.slice(start, end)}${end < doc.text.length ? '…' : ''}`
}

const byRecent = (a: SessionSearchDoc, b: SessionSearchDoc) => {
  if (isPinned(a) !== isPinned(b)) {
    return isPinned(a) ? -1 : 1
  }
  if (isPinned(a) && isPinned(b)) {
    return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
  }
  return b.updatedAt - a.updatedAt
}

/** 空查询返回最近的会话；否则标题命中排在正文命中之前，同类按时间倒序 */
export const searchSessions = (
  docs: SessionSearchDoc[],
  query: string,
  limit = RESULT_LIMIT
): SessionSearchHit[] => {
  const tokens = splitQuery(query)
  if (tokens.length === 0) {
    return [...docs]
      .sort(byRecent)
      .slice(0, limit)
      .map((doc) => ({ ...doc, snippet: null }))
  }
  const hits: { hit: SessionSearchHit; rank: number }[] = []
  for (const doc of docs) {
    const title = doc.title.toLowerCase()
    const body = doc.text.toLowerCase()
    if (!tokens.every((token) => title.includes(token) || body.includes(token))) {
      continue
    }
    // 标题全部命中时正文里可能一处都没有，此时不展示片段
    const inTitle = tokens.every((token) => title.includes(token))
    hits.push({
      hit: { ...doc, snippet: inTitle ? null : snippetOf(doc, tokens) },
      rank: inTitle ? 0 : 1,
    })
  }
  return hits
    .sort((a, b) => a.rank - b.rank || byRecent(a.hit, b.hit))
    .slice(0, limit)
    .map((item) => item.hit)
}
