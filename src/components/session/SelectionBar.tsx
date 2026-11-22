import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { deleteMessageRounds, extractSession } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './SelectionBar.module.css'

/**
 * 多选模式的底部动作条：替换输入框，提供批量删除与另存为新对话。
 * 批量删除用确认弹窗（一次删多轮不可逆，不叠撤销）；另存失败时留在多选模式，方便重试。
 */
export const SelectionBar = ({
  sessionId,
  roundIds,
  onDone,
}: {
  sessionId: string
  roundIds: readonly string[]
  onDone: () => void
}) => {
  const t = useTranslate()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const empty = roundIds.length === 0

  const extract = () => {
    setSaving(true)
    void extractSession(sessionId, roundIds)
      .then((ok) => {
        showToast(ok ? { key: 'sessionExtracted' } : { key: 'extractSessionFailed', type: 'error' })
        if (ok) {
          onDone()
        }
      })
      .finally(() => setSaving(false))
  }

  const remove = () => {
    setConfirmOpen(false)
    if (deleteMessageRounds(sessionId, roundIds)) {
      onDone()
    } else {
      showToast({ key: 'deleteMessagesFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.bar}>
      <span className={styles.count}>{t('selectionCount', { count: roundIds.length })}</span>
      <div className={styles.actions}>
        <Button size="s" variant="outlined" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button size="s" variant="outlined" disabled={empty || saving} onClick={extract}>
          {t('selectionExtract')}
        </Button>
        <Button
          size="s"
          variant="danger"
          disabled={empty || saving}
          onClick={() => setConfirmOpen(true)}
        >
          {t('delete')}
        </Button>
      </div>
      {confirmOpen ? (
        <Modal
          title={t('deleteMessagesModalTitle')}
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Button variant="outlined" autoFocus onClick={() => setConfirmOpen(false)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" onClick={remove}>
                {t('delete')}
              </Button>
            </>
          }
        >
          <div className={styles.description}>
            {t('deleteMessagesModalDescription', { count: roundIds.length })}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
