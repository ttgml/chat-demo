import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { ContextUsage } from './ContextUsage.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题、上下文用量与开启新对话 */
export const MobileHeader = ({ title, session }: { title?: string; session?: Session }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined ? null : (
        <>
          <div className={styles.title}>{title}</div>
          {session ? <ContextUsage session={session} /> : null}
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
    </div>
  )
}
