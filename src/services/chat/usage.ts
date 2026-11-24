import type { ChatModel } from '../api/types.js'
import type { AssistantMessage } from './types.js'

/**
 * DeepSeek 官方价格，单位：人民币元 / 百万 tokens。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 空闲时段价格为高峰时段的一半；高峰为北京时间周一至周五（不含法定节假日）
 * 9:00-12:00、14:00-18:00，其余时段为空闲。
 */
type Price = {
  /** 输入，缓存命中 */
  cacheHit: number
  /** 输入，缓存未命中（含缓存写入） */
  cacheMiss: number
  /** 输出 */
  output: number
}

const PRICING: Record<ChatModel, { peak: Price; offPeak: Price }> = {
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
}

export type MessageUsageSummary = {
  model: ChatModel
  /** 输入总量，含缓存命中与未命中 */
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  /** 按高峰价估算的费用（元） */
  peakCost: number
  /** 按空闲价估算的费用（元） */
  offPeakCost: number
  /** 这条消息的创建时间是否落在高峰时段 */
  isPeak: boolean
}

const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const PEAK_PERIODS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
] as const

/** 按北京时间判断；法定节假日需要日历数据，这里只区分工作日与周末。 */
export const isPeakTime = (timestamp: number): boolean => {
  const parts = SHANGHAI_CLOCK.formatToParts(timestamp)
  const read = (type: 'weekday' | 'hour' | 'minute') =>
    parts.find((part) => part.type === type)?.value ?? ''
  const weekday = read('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false
  }
  const hour = Number(read('hour'))
  const minute = Number(read('minute'))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false
  }
  const time = hour * 60 + minute
  return PEAK_PERIODS.some(([start, end]) => time >= start && time < end)
}

/** 最近一次请求的输入（含缓存命中与写入）token；没有用量时返回 null。 */
export const getPromptTokens = (message: AssistantMessage): number | null => {
  const { usage } = message
  return usage
    ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
    : null
}

/** 最近一次请求的输入与输出之和，即这一条结束时的上下文 token；没有用量时返回 null。 */
export const getContextTokens = (message: AssistantMessage): number | null => {
  const prompt = getPromptTokens(message)
  return prompt === null ? null : prompt + (message.usage?.output_tokens ?? 0)
}

const costOf = (
  price: Price,
  cacheHitTokens: number,
  cacheMissTokens: number,
  outputTokens: number
) =>
  (cacheHitTokens * price.cacheHit +
    cacheMissTokens * price.cacheMiss +
    outputTokens * price.output) /
  1_000_000

/** 把一条回复的 usage 换算成可展示的 token 与高峰/空闲费用；没有 usage 时返回 null。 */
export const getMessageUsageSummary = (message: AssistantMessage): MessageUsageSummary | null => {
  const { usage } = message
  if (!usage) {
    return null
  }
  const model = message.model ?? 'deepseek-flash'
  const price = PRICING[model] ?? PRICING['deepseek-flash']
  const cacheHitTokens = usage.cache_read_input_tokens
  const cacheMissTokens = usage.input_tokens + usage.cache_creation_input_tokens
  const inputTokens = cacheHitTokens + cacheMissTokens
  const outputTokens = usage.output_tokens
  return {
    model,
    inputTokens,
    cacheHitTokens,
    cacheMissTokens,
    outputTokens,
    peakCost: costOf(price.peak, cacheHitTokens, cacheMissTokens, outputTokens),
    offPeakCost: costOf(price.offPeak, cacheHitTokens, cacheMissTokens, outputTokens),
    isPeak: isPeakTime(message.createdAt),
  }
}
