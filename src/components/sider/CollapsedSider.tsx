import { useState } from 'react'
import { IconPanelLeftOutline16, IconSearchOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { SessionSearch } from './SessionSearch.js'
import styles from './Sider.module.css'

/** 收起后左上角的按钮组：打开边栏 / 搜索对话 / 开启新对话 */
export const CollapsedSider = () => {
  const t = useTranslate()
  const [searchOpen, setSearchOpen] = useState(false)
  return (
    <div className={styles.collapsed}>
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={() => setSiderCollapsed(false)}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconSearchOutline16 />}
          tooltip={t('searchSessions')}
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
      </div>
      <SessionSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
