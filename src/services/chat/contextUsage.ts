import type { ChatModel, MessageParam } from '../api/types.js'
import { getVisibleMessages } from './branches.js'
import { isUsableReply, SYSTEM_PROMPT, toContextMessages } from './reply.js'
import type { AssistantMessage, Message, Session, UserMessage } from './types.js'

/**
 * 上下文用量估算。
 * 导入的历史对话没有 token 用量，本地请求也不保证每条都带 usage，因此统一按请求内容估算：
 * 只计算真正会进入下一次请求的轮次，失败、拒绝、模板提示以及历史思考都不计入。
 */

/** 所有模型统一按 1M tokens 配置；实际窗口不同时改这里即可。 */
const CONTEXT_WINDOW_TOKENS = 1_000_000

const CONTEXT_WINDOWS: Record<ChatModel, number> = {
  'deepseek-flash': CONTEXT_WINDOW_TOKENS,
  'deepseek-v4-pro': CONTEXT_WINDOW_TOKENS,
}

const DEFAULT_MODEL: ChatModel = 'deepseek-flash'

/** 每条请求固定携带的 system、tools、safety_check 等开销 */
const REQUEST_OVERHEAD_TOKENS = 96
/** 消息角色、分隔符等协议开销 */
const MESSAGE_OVERHEAD_TOKENS = 4
/** 图片与文档内容在服务端解析，客户端只能按类型给一个粗略占位值 */
const IMAGE_TOKENS = 1_000
const DOCUMENT_TOKENS = 2_000
/** read_link 的网页正文加密在 signature 里，客户端看不到原文，只能粗略估算 */
const READ_LINK_TOKENS = 2_000

export type ContextUsage = {
  usedTokens: number
  limitTokens: number
  remainingTokens: number
  /** 已用比例，0–1 */
  ratio: number
}

const isWideCodePoint = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff)

/**
 * 粗略 token 估算：中文按约 0.6 token/字，英文与符号按约 0.3 token/字符。
 * 与真实分词器有偏差，但用于展示剩余上下文足够。
 */
export const estimateTextTokens = (text: string): number => {
  let wide = 0
  let narrow = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isWideCodePoint(code)) {
      wide += 1
    } else {
      narrow += 1
    }
  }
  return Math.ceil(wide * 0.6 + narrow * 0.3)
}

const fileTokens = (isImage: boolean) => (isImage ? IMAGE_TOKENS : DOCUMENT_TOKENS)

/** 提问只计算真正会带上的附件：没有 serverId 的附件不会进入请求 */
const estimateUser = ({ content, files }: UserMessage): number => {
  let tokens = estimateTextTokens(content)
  for (const file of files) {
    if (file.serverId) {
      tokens += fileTokens(file.isImage)
    }
  }
  return tokens
}

/** 历史回复只回传正文与 read_link 结果；思考、搜索等块不计入 */
const estimateAssistant = ({ blocks }: AssistantMessage): number => {
  let tokens = 0
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.isTemplate) {
        tokens += estimateTextTokens(block.text)
      }
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result'
    ) {
      tokens += READ_LINK_TOKENS
    } else if (block.type === 'server_tool_use') {
      tokens += 16
    }
  }
  return tokens
}

const estimateParam = (message: MessageParam): number => {
  let tokens = MESSAGE_OVERHEAD_TOKENS
  if (message.role === 'latest_reminder') {
    return tokens + estimateTextTokens(message.content)
  }
  if (typeof message.content === 'string') {
    return tokens + estimateTextTokens(message.content)
  }
  for (const block of message.content) {
    if (block.type === 'text') {
      tokens += estimateTextTokens(block.text)
    } else if (block.type === 'thinking') {
      tokens += estimateTextTokens(block.thinking)
    } else if (block.type === 'image') {
      tokens += IMAGE_TOKENS
    } else if (block.type === 'document') {
      tokens += DOCUMENT_TOKENS
    } else if (block.type === 'web_fetch_tool_result') {
      tokens += READ_LINK_TOKENS
    } else if (block.type === 'server_tool_use') {
      tokens += 16
    }
  }
  return tokens
}

const lastModel = (messages: Message[]): ChatModel | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.model) {
      return message.model
    }
  }
  return null
}

/**
 * 末尾还没成对的轮次：刚发出的提问，以及正在生成、完成后会进入上下文的回复。
 * 失败的提问不会进入下一次请求，因此不计入。
 */
const estimatePendingTail = (messages: Message[]): number => {
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }
  if (lastUserIndex < 0) {
    return 0
  }
  const user = messages[lastUserIndex]
  const reply = messages[lastUserIndex + 1]
  if (user.role !== 'user') {
    return 0
  }
  if (!reply) {
    return MESSAGE_OVERHEAD_TOKENS + estimateUser(user)
  }
  if (reply.role !== 'assistant') {
    return 0
  }
  // 用 Message 类型的别名判断，避免类型谓词在 false 分支把 reply 收窄成 never
  const replyMessage: Message = reply
  if (isUsableReply(replyMessage)) {
    return 0
  }
  if (reply.status !== 'pending' && reply.status !== 'streaming') {
    return 0
  }
  return MESSAGE_OVERHEAD_TOKENS + estimateUser(user) + estimateAssistant(reply)
}

export const getContextUsage = (session: Session): ContextUsage => {
  const messages = getVisibleMessages(session)
  let usedTokens = REQUEST_OVERHEAD_TOKENS + estimateTextTokens(SYSTEM_PROMPT)
  for (const message of toContextMessages(messages)) {
    usedTokens += estimateParam(message)
  }
  usedTokens += estimatePendingTail(messages)

  const model = lastModel(messages) ?? DEFAULT_MODEL
  const limitTokens = CONTEXT_WINDOWS[model] ?? CONTEXT_WINDOWS[DEFAULT_MODEL]
  return {
    usedTokens,
    limitTokens,
    remainingTokens: Math.max(0, limitTokens - usedTokens),
    ratio: limitTokens > 0 ? usedTokens / limitTokens : 0,
  }
}
