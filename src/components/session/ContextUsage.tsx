import clsx from 'clsx'
import { useDeferredValue, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { getContextUsage } from '../../services/chat/contextUsage.js'
import type { Session } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import styles from './ContextUsage.module.css'

/** 圆形进度条按钮：点击展开当前会话的上下文用量。 */
export const ContextUsage = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [open, setOpen] = useState(false)
  const titleId = useId()
  // 长会话在生成中每个动画帧都会更新消息，延后估算避免阻塞流式渲染
  const deferredSession = useDeferredValue(session)
  const usage = useMemo(() => getContextUsage(deferredSession), [deferredSession])
  const percentValue = usage.ratio * 100
  // 1M 窗口下百分比经常小于 1%，保留两位小数并避免显示成误导性的 0%
  const percentText =
    percentValue === 0
      ? '0'
      : percentValue < 0.01
        ? '<0.01'
        : percentValue < 10
          ? percentValue.toFixed(2)
          : String(Math.round(percentValue))
  // 进度环至少给 1% 的可见弧长
  const progress = usage.usedTokens > 0 ? Math.max(1, Math.min(100, percentValue)) : 0
  const level = percentValue >= 90 ? 'danger' : percentValue >= 70 ? 'warning' : 'normal'
  const ringTone =
    level === 'danger'
      ? styles.progressDanger
      : level === 'warning'
        ? styles.progressWarning
        : undefined
  const barTone =
    level === 'danger' ? styles.fillDanger : level === 'warning' ? styles.fillWarning : undefined
  const percentTone =
    level === 'danger'
      ? styles.percentDanger
      : level === 'warning'
        ? styles.percentWarning
        : undefined
  const format = useMemo(() => new Intl.NumberFormat(locale).format, [locale])
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { side: 'bottom', align: 'start', offset: 6 }
  )
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false))

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        <button
          type="button"
          className={styles.button}
          aria-label={t('contextUsage')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <svg className={styles.ring} viewBox="0 0 24 24" aria-hidden="true">
            <circle className={styles.track} cx="12" cy="12" r="8" pathLength="100" />
            <circle
              className={clsx(styles.progress, ringTone)}
              cx="12"
              cy="12"
              r="8"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - progress}
            />
          </svg>
        </button>
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="dialog"
              aria-labelledby={titleId}
            >
              <div className={styles.header}>
                <span id={titleId} className={styles.title}>
                  {t('contextUsage')}
                </span>
                <span className={styles.badge}>{t('contextUsageEstimate')}</span>
              </div>
              <div className={styles.readout}>
                <span className={clsx(styles.percent, percentTone)}>
                  {t('contextUsageUsedPercent', { percent: percentText })}
                </span>
                <span className={styles.tokens}>
                  {t('contextUsageTokensOfLimit', {
                    used: format(usage.usedTokens),
                    limit: format(usage.limitTokens),
                  })}
                </span>
              </div>
              <div
                className={styles.bar}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <div className={clsx(styles.fill, barTone)} style={{ width: `${progress}%` }} />
              </div>
              {level === 'danger' ? (
                <div className={styles.warning}>
                  {percentValue > 100 ? t('contextUsageExceeded') : t('contextUsageLow')}
                </div>
              ) : null}
              <div className={styles.note}>{t('contextUsageNote')}</div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
