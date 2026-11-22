import { useTranslate } from '../../i18n/index.js'
import { undoDelete, useChatStore } from '../../services/chat/store.js'
import styles from './UndoBar.module.css'

/**
 * 删除一轮后的撤销入口：只在撤销窗口内、且停留在同一个会话时出现。
 * 不做成 toast：toast 不接收点击，也会被其它提示顶掉。
 */
export const UndoBar = ({ sessionId }: { sessionId: string }) => {
  const t = useTranslate()
  const undoable = useChatStore((state) => state.undo?.sessionId === sessionId)
  if (!undoable) {
    return null
  }
  return (
    <div className={styles.bar} role="status">
      <span className={styles.text}>{t('messageRoundDeleted')}</span>
      <button type="button" className={styles.action} onClick={() => undoDelete()}>
        {t('undo')}
      </button>
    </div>
  )
}
