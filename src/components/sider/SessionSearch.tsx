import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useDismiss } from '../base/anchored.js'
import { IconSearchOutline16 } from '../base/icons.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import {
  loadSessionSearchDocs,
  searchSessions,
  splitQuery,
  type SessionSearchDoc,
  type SessionSearchHit,
} from '../../services/chat/sessionSearch.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 把命中的关键词标出来；关键词已在过滤时统一小写，这里按不区分大小写切分 */
const Highlight = ({ text, tokens }: { text: string; tokens: string[] }) => {
  if (tokens.length === 0) {
    return <>{text}</>
  }
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi')
  const lowered = new Set(tokens)
  return (
    <>
      {text.split(pattern).map((part, index) =>
        lowered.has(part.toLowerCase()) ? (
          <mark key={index} className={styles.mark}>
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  )
}

/**
 * 对话历史搜索：浮在页面中间偏上的搜索框，输入关键词后即时过滤标题与正文，
 * 点击或回车打开对应会话。没有输入时不展开结果区，保持界面只有一个输入框的轻量感。
 */
export const SessionSearch = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const sessionCount = useChatStore((state) => state.sessions.length)
  const [query, setQuery] = useState('')
  const [docs, setDocs] = useState<SessionSearchDoc[] | null>(null)
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  useDismiss(open, [panelRef], onClose)

  // 打开时重建索引：期间可能有对话被编辑、导入或删除，缓存会过期
  useEffect(() => {
    if (!open) {
      return
    }
    setQuery('')
    setActive(0)
    setDocs(null)
    let cancelled = false
    void loadSessionSearchDocs(useChatStore.getState().sessionCache)
      .then((loaded) => {
        if (!cancelled) {
          setDocs(loaded)
        }
      })
      .catch(() => {
        // 读取失败时按空索引处理，面板仍可关闭后重开
        if (!cancelled) {
          setDocs([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const tokens = useMemo(() => splitQuery(query), [query])
  // 没有关键词时不展示列表，也不做过滤
  const searching = tokens.length > 0
  const hits = useMemo(
    () => (searching && docs ? searchSessions(docs, query) : []),
    [docs, query, searching]
  )
  const loading = docs === null
  const current = Math.min(active, Math.max(0, hits.length - 1))

  if (!open) {
    return null
  }

  const openHit = (hit: SessionSearchHit) => {
    selectSession(hit.id)
    closeMobileSider()
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (hits.length === 0) {
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current + step + hits.length) % hits.length)
    } else if (event.key === 'Enter' && hits.length > 0) {
      event.preventDefault()
      openHit(hits[current])
    }
  }

  return createPortal(
    <div ref={panelRef} role="dialog" aria-label={t('searchSessions')} className={styles.panel}>
      <div className={styles.searchRow}>
        <span className={styles.searchIcon}>
          <IconSearchOutline16 />
        </span>
        <input
          className={styles.input}
          autoFocus
          type="text"
          value={query}
          placeholder={t('searchSessionsPlaceholder')}
          aria-label={t('searchSessionsPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {searching ? (
        <div className={styles.list} role="listbox" aria-label={t('searchSessions')}>
          {loading ? (
            <div className={styles.hint} role="status">
              {t('searchSessionsLoading')}
            </div>
          ) : hits.length === 0 ? (
            <div className={styles.hint} role="status">
              {sessionCount === 0 ? t('searchSessionsNoHistory') : t('searchSessionsEmpty')}
            </div>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={index === current}
                className={clsx(styles.item, index === current && styles.itemActive)}
                ref={(element) => {
                  // 键盘移动时把选中项滚进视野
                  if (index === current && element) {
                    element.scrollIntoView({ block: 'nearest' })
                  }
                }}
                onMouseEnter={() => setActive(index)}
                onClick={() => openHit(hit)}
              >
                <span className={styles.itemTitle}>
                  <Highlight text={hit.title || t('untitledChat')} tokens={tokens} />
                </span>
                {hit.snippet ? (
                  <span className={styles.itemSnippet}>
                    <Highlight text={hit.snippet} tokens={tokens} />
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>,
    document.body
  )
}
