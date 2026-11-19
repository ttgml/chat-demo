import { translate } from '../../i18n/index.js'
import { monthKey } from '../../utils/format.js'
import { isPinned, type SessionSummary } from './types.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** 置顶分组的 key；时间分组的 key 是翻译 key 或月份，不会与它重复 */
const PINNED_KEY = 'pinned'

/** 分组：置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 按月 */
export const groupSessions = (sessions: SessionSummary[], now: number, t = translate) => {
  const groups: { key: string; label: string; sessions: SessionSummary[] }[] = []
  for (const session of sessions) {
    // 置顶会话单独成组；列表已按「置顶在前」排序，这组自然落在最前。
    if (isPinned(session)) {
      const pinned = groups.at(-1)
      if (pinned?.key === PINNED_KEY) {
        pinned.sessions.push(session)
      } else {
        groups.push({
          key: PINNED_KEY,
          label: t('sessionHistoryTimelineLabelPinned'),
          sessions: [session],
        })
      }
      continue
    }
    const diff = Math.floor((now - startOfDay(session.updatedAt)) / DAY)
    const key =
      diff <= 0
        ? 'sessionHistoryTimelineLabelToday'
        : diff <= 1
          ? 'sessionHistoryTimelineLabelYesterday'
          : diff < 7
            ? 'sessionHistoryTimelineLabel7days'
            : diff < 30
              ? 'sessionHistoryTimelineLabel30days'
              : null
    const groupKey = key ?? monthKey(session.updatedAt) ?? ''
    const last = groups.at(-1)
    if (last?.key === groupKey) {
      last.sessions.push(session)
    } else {
      groups.push({ key: groupKey, label: key ? t(key) : groupKey, sessions: [session] })
    }
  }
  return groups
}
