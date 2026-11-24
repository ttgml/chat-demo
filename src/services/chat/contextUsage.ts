import type { ChatModel } from '../api/types.js'
import { getVisibleMessages } from './branches.js'
import {
  getContextRoundsWithReminders,
  isUsableReply,
  SYSTEM_PROMPT,
  type ContextRound,
} from './reply.js'
import type { AssistantMessage, Message, Session, UserMessage } from './types.js'
import { getPromptTokens } from './usage.js'

/**
 * 上下文用量。
 * 已结算的回复带着服务端返回的 usage，它本身就是那一次请求真实的上下文大小，因此以最新一条可用回复的用量为锚点，
 * 只估算其后的新增内容；没有用量的会话（导入的历史归档、只有失败轮次的会话）才回到按请求内容估算。
 * 估算只计算真正会进入下一次请求的轮次，失败、拒绝、模板提示以及历史思考都不计入。
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
  /** 已用比例，0–1 */
  ratio: number
}

/** BMP 内的宽字符；emoji 在代理对分支里单独判断 */
const isWideCodePoint = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6)

/**
 * 粗略 token 估算：中文按约 0.6 token/字，英文与符号按约 0.3 token/字符。
 * 与真实分词器有偏差，但用于展示剩余上下文足够。
 * 按下标扫描而不是 `for (const char of text)`：后者要经字符串迭代器，实测慢一倍以上。
 */
export const estimateTextTokens = (text: string): number => {
  let wide = 0
  let narrow = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x1100) {
      narrow += 1
      continue
    }
    // 先判代理区再取低位：中文文本里每个字都 >= 0x1100，提前取 code unit 会多一倍开销
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        const point = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        index += 1
        if (point >= 0x1f300 && point <= 0x1faff) {
          wide += 1
        } else {
          narrow += 2
        }
        continue
      }
      narrow += 1
      continue
    }
    if (isWideCodePoint(code)) {
      wide += 1
    } else {
      narrow += 1
    }
  }
  return Math.ceil(wide * 0.6 + narrow * 0.3)
}

const fileTokens = (isImage: boolean) => (isImage ? IMAGE_TOKENS : DOCUMENT_TOKENS)

/**
 * 估算结果按消息对象缓存：消息都是不可变更新的，对象没变内容就不会变。
 * 流式生成时只有正在增长的那一条会落到重算，长会话不必每帧重扫全部历史。
 */
const userTokens = new WeakMap<UserMessage, number>()
const replyTokens = new WeakMap<AssistantMessage, number>()

/** 提问只计算真正会带上的附件：没有 serverId 或已被移出上下文的附件不会进入请求 */
const estimateUser = (message: UserMessage): number => {
  const cached = userTokens.get(message)
  if (cached !== undefined) {
    return cached
  }
  let tokens = estimateTextTokens(message.content)
  for (const file of message.files) {
    if (file.serverId && !file.omitted) {
      tokens += fileTokens(file.isImage)
    }
  }
  userTokens.set(message, tokens)
  return tokens
}

/** 历史回复只回传正文与 read_link 结果；思考、搜索等块不计入 */
const estimateAssistant = (message: AssistantMessage): number => {
  const cached = replyTokens.get(message)
  if (cached !== undefined) {
    return cached
  }
  let tokens = 0
  for (const block of message.blocks) {
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
  replyTokens.set(message, tokens)
  return tokens
}

/** 一轮在请求里的开销：快照（如有）、提问、回复各自带消息开销 */
const roundTokens = ({ user, reply, reminder }: ContextRound): number =>
  (reminder ? MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(reminder) : 0) +
  MESSAGE_OVERHEAD_TOKENS +
  estimateUser(user) +
  MESSAGE_OVERHEAD_TOKENS +
  estimateAssistant(reply)

/**
 * 锚点回复本身贡献的上下文：历史思考不回传，所以带思考的回复不能直接取 output_tokens；
 * 被停止的回复收不到累计用量，output_tokens 仍是 0，只能按正文估算。
 */
const replyContextTokens = (reply: AssistantMessage): number => {
  const generated = reply.usage?.output_tokens ?? 0
  if (generated > 0 && !reply.blocks.some((block) => block.type === 'thinking')) {
    return generated
  }
  return estimateAssistant(reply)
}

/**
 * 最新一条带服务端用量的轮次：它的输入就是那一次请求真实的上下文大小，之后只需估算新增内容。
 * 前缀被改过（旧附件移出/恢复上下文、删除历史轮次）时仍然沿用这个锚点，宁可略有偏差也不让数字跳变。
 */
const findAnchor = (rounds: ContextRound[]): { prompt: number; index: number } | null => {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const prompt = getPromptTokens(rounds[index].reply)
    if (prompt !== null) {
      return { prompt, index }
    }
  }
  return null
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
  const rounds = getContextRoundsWithReminders(messages)
  const anchor = findAnchor(rounds)
  let usedTokens: number
  if (anchor) {
    usedTokens = anchor.prompt + replyContextTokens(rounds[anchor.index].reply)
    for (let index = anchor.index + 1; index < rounds.length; index += 1) {
      usedTokens += roundTokens(rounds[index])
    }
  } else {
    usedTokens = REQUEST_OVERHEAD_TOKENS + estimateTextTokens(SYSTEM_PROMPT)
    for (const round of rounds) {
      usedTokens += roundTokens(round)
    }
  }
  usedTokens += estimatePendingTail(messages)

  const model = lastModel(messages) ?? DEFAULT_MODEL
  const limitTokens = CONTEXT_WINDOWS[model] ?? CONTEXT_WINDOWS[DEFAULT_MODEL]
  return {
    usedTokens,
    limitTokens,
    ratio: limitTokens > 0 ? usedTokens / limitTokens : 0,
  }
}
