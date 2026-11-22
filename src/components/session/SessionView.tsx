import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getRoundId } from '../../services/chat/branches.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { ContextUsage } from './ContextUsage.js'
import { MobileHeader } from './MobileHeader.js'
import { SelectionBar } from './SelectionBar.js'
import { UndoBar } from './UndoBar.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  // 多选按“轮”记录：提问与它的回答共用同一个轮 id。切换会话时退出多选。
  const [selecting, setSelecting] = useState(false)
  const [selectedRounds, setSelectedRounds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setSelecting(false)
    setSelectedRounds(new Set())
  }, [session.id])

  const enterSelection = useCallback(
    (messageId: string) => {
      const message = session.messages.find((item) => item.id === messageId)
      setSelectedRounds(new Set([message ? getRoundId(message) : messageId]))
      setSelecting(true)
    },
    [session.messages]
  )
  const toggleRound = useCallback((roundId: string) => {
    setSelectedRounds((previous) => {
      const next = new Set(previous)
      if (next.has(roundId)) {
        next.delete(roundId)
      } else {
        next.add(roundId)
      }
      return next
    })
  }, [])
  const exitSelection = useCallback(() => {
    setSelecting(false)
    setSelectedRounds(new Set())
  }, [])

  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} session={session} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.titleRow, siderCollapsed && styles.withCollapsedSider)}>
            <div className={styles.title}>{title}</div>
            <ContextUsage session={session} />
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        selecting={selecting}
        selectedRounds={selectedRounds}
        onToggleRound={toggleRound}
        onEnterSelection={enterSelection}
        footer={
          <div className={clsx(styles.inputContainer, selecting && styles.inputContainerSelecting)}>
            {selecting ? (
              <SelectionBar
                sessionId={session.id}
                roundIds={[...selectedRounds]}
                onDone={exitSelection}
              />
            ) : (
              <>
                <UndoBar sessionId={session.id} />
                <ChatInput sessionId={session.id} />
                <div className={styles.caveat}>{t('contentCaveat')}</div>
              </>
            )}
          </div>
        }
      />
    </div>
  )
}
