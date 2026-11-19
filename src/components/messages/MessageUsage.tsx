import clsx from 'clsx'
import { useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { getMessageUsageSummary } from '../../services/chat/usage.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconChartOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './MessageUsage.module.css'

/** 回复下方的用量按钮：展示 token 用量，并按官方价格估算高峰/空闲费用。 */
export const MessageUsage = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const summary = useMemo(() => getMessageUsageSummary(message), [message])
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const currencyFormat = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'CNY',
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }),
    [locale]
  )
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { side: 'bottom', align: 'start', offset: 6 }
  )
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false))

  if (!summary) {
    return null
  }

  const rows = [
    { key: 'input', label: t('messageUsageInput'), value: summary.inputTokens },
    {
      key: 'cache-hit',
      label: t('messageUsageCacheHit'),
      value: summary.cacheHitTokens,
      sub: true,
    },
    {
      key: 'cache-miss',
      label: t('messageUsageCacheMiss'),
      value: summary.cacheMissTokens,
      sub: true,
    },
    { key: 'output', label: t('messageUsageOutput'), value: summary.outputTokens },
  ]
  const costs = [
    {
      key: 'peak',
      label: t('messageUsagePeak'),
      value: summary.peakCost,
      active: summary.isPeak,
    },
    {
      key: 'off-peak',
      label: t('messageUsageOffPeak'),
      value: summary.offPeakCost,
      active: !summary.isPeak,
    },
  ]

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        <Tooltip content={open ? null : t('messageUsage')} placement="top">
          <IconButton
            icon={<IconChartOutline16 />}
            aria-label={t('messageUsage')}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          />
        </Tooltip>
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
                  {t('messageUsage')}
                </span>
                <span className={styles.model}>{summary.model}</span>
              </div>
              <div className={styles.rows}>
                {rows.map((row) => (
                  <div key={row.key} className={clsx(styles.row, row.sub && styles.subRow)}>
                    <span className={styles.label}>{row.label}</span>
                    <span className={styles.value}>
                      {numberFormat.format(row.value)}
                      <span className={styles.unit}> tokens</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className={styles.divider} />
              <div className={styles.costHeader}>
                <span>{t('messageUsageCost')}</span>
                <span className={styles.currency}>{t('messageUsageCurrency')}</span>
              </div>
              <div className={styles.costs}>
                {costs.map((cost) => (
                  <div
                    key={cost.key}
                    className={clsx(styles.costRow, cost.active && styles.costRowActive)}
                  >
                    <span className={styles.costLabel}>
                      {cost.label}
                      {cost.active ? (
                        <span className={styles.activeBadge}>{t('messageUsageThisMessage')}</span>
                      ) : null}
                    </span>
                    <span className={styles.costValue}>{currencyFormat.format(cost.value)}</span>
                  </div>
                ))}
              </div>
              <div className={styles.note}>{t('messageUsageNote')}</div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
