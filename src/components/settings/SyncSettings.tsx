import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate, isTranslationKey, type TranslationKey } from '../../i18n/index.js'
import {
  applySyncAccount,
  clearSyncCredentials,
  normalizeServerUrl,
  setSyncEnabled,
  useSyncConfig,
} from '../../services/sync/config.js'
import { syncLogin, syncLogout, syncState } from '../../services/sync/client.js'
import { resetSyncMeta } from '../../services/sync/meta.js'
import { syncNow } from '../../services/sync/engine.js'
import { syncProgressPercent, useSyncStatus } from '../../services/sync/status.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

const validUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value.trim())

/** 云同步设置：登录即开启同步，已登录时账号信息只读，状态与操作分开呈现。 */
export const SyncSettings = () => {
  const t = useTranslate()
  const config = useSyncConfig()
  const status = useSyncStatus()
  const [serverUrl, setServerUrl] = useState(config.serverUrl)
  const [username, setUsername] = useState(config.username)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverSessions, setServerSessions] = useState<number | null>(null)
  // 退出登录需要二次确认，确认弹窗叠在设置之上
  const [confirmLogout, setConfirmLogout] = useState(false)

  const signedIn = config.token !== null
  // 已登录后账号信息以配置为准，输入框只读；更换账号必须先退出登录。
  const displayServerUrl = signedIn ? config.serverUrl : serverUrl
  const displayUsername = signedIn ? config.username : username
  const needsAuth = !signedIn

  // 登录时读取云端会话数，之后每次同步成功（lastSyncedAt 变化）刷新一次。
  // 旧版服务端不返回 sessions、或请求失败时保持隐藏/沿用上次结果，不打扰用户。
  useEffect(() => {
    if (!signedIn) {
      setServerSessions(null)
      return
    }
    if (!config.enabled) {
      return
    }
    const controller = new AbortController()
    void syncState(controller.signal)
      .then((state) => {
        if (controller.signal.aborted) {
          return
        }
        // 旧版服务端没有这个字段，此时隐藏而不是沿用其它账号的数字
        setServerSessions(typeof state.sessions === 'number' ? state.sessions : null)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [
    signedIn,
    config.enabled,
    config.serverUrl,
    config.username,
    config.token,
    status.lastSyncedAt,
  ])

  const authenticate = async (mode: 'login' | 'register') => {
    const url = normalizeServerUrl(serverUrl)
    if (!validUrl(url)) {
      setError(t('syncServerInvalid'))
      return
    }
    const user = username.trim()
    if (!user || !password) {
      setError(t('syncCredentialsRequired'))
      return
    }
    await finishAuth(url, user, password, mode)
  }

  const finishAuth = async (
    url: string,
    user: string,
    pass: string,
    mode: 'login' | 'register'
  ) => {
    setBusy(true)
    setError(null)
    try {
      const token = await syncLogin(url, user, pass, mode === 'register')
      if (url !== config.serverUrl || user !== config.username) {
        // 账号标识变了，清掉旧的同步进度，让本地会话重新对账到新账号
        await resetSyncMeta()
      }
      applySyncAccount({ serverUrl: url, username: user, token })
      setPassword('')
      showToast({ key: mode === 'register' ? 'syncRegisterSuccess' : 'syncLoginSuccess' })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(t(mode === 'register' ? 'syncRegisterFailed' : 'syncLoginFailed', { message }))
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    setBusy(true)
    setConfirmLogout(false)
    try {
      await syncLogout()
    } catch {
      // 服务器不可达或 token 已失效时，本地仍要清除登录态
    }
    // 不要在这里 resetSyncMeta：退出登录不代表放弃本地同步进度。
    // 清空 sessionRev / pending 会让登出期间删除的会话在重新登录后被云端版本复活，
    // 也会让导入备份的 origin 标记丢失（遇到墓碑时无法 revive）。
    // 换账号时 finishAuth 会按 serverUrl + username 检测到差异并重置同步元数据。
    clearSyncCredentials()
    setSyncEnabled(false)
    setServerUrl(config.serverUrl)
    setUsername(config.username)
    setPassword('')
    setBusy(false)
  }

  const statusText = (): string => {
    if (signedIn && !config.enabled) {
      return t('syncStatusPaused')
    }
    switch (status.phase) {
      case 'disabled':
        return t('syncStatusDisabled')
      case 'syncing': {
        // 首次同步上千条时会停留很久：用上传百分比代替队列总数，进度会随每批完成前进。
        // 只有拉取、没有待上传条目时百分比无意义，直接显示「正在同步」。
        const percent = syncProgressPercent(status)
        return percent === null
          ? t('syncStatusSyncing')
          : t('syncStatusSyncingPercent', { percent })
      }
      case 'error':
        return t('syncStatusError')
      case 'authRequired':
        return t('syncStatusAuthRequired')
      default:
        break
    }
    const parts = [t('syncStatusIdle')]
    if (status.lastSyncedAt > 0) {
      parts.push(t('syncStatusLastAt', { time: new Date(status.lastSyncedAt).toLocaleString() }))
    } else {
      parts.push(t('syncStatusNever'))
    }
    if (status.pending > 0) {
      parts.push(t('syncStatusPending', { count: status.pending }))
    }
    if (status.watch === 'connecting') {
      parts.push(t('syncWatchConnecting'))
    } else if (status.watch === 'unsupported') {
      parts.push(t('syncWatchUnsupported'))
    } else if (status.watch === 'retrying') {
      parts.push(t('syncWatchRetrying'))
    }
    return parts.join(' · ')
  }

  /** 状态点的颜色：绿=正常同步，品牌色=同步中，红=需要关注，灰=未开启/已暂停 */
  const stateTone = (): 'off' | 'ok' | 'busy' | 'error' => {
    if (!signedIn || !config.enabled) {
      return 'off'
    }
    switch (status.phase) {
      case 'syncing':
        return 'busy'
      case 'error':
      case 'authRequired':
        return 'error'
      default:
        return 'ok'
    }
  }

  const errorKey: TranslationKey | null =
    status.errorKey && isTranslationKey(status.errorKey) ? status.errorKey : null

  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.syncStateInfo}>
          <div className={styles.label}>{t('syncStatusLabel')}</div>
          <div className={styles.description}>{t('syncEnableDescription')}</div>
          <div className={styles.syncStateRow} role="status">
            <span className={styles.syncStateDot} data-tone={stateTone()} />
            <span>{statusText()}</span>
          </div>
          {serverSessions !== null && status.lastSyncedAt > 0 && status.phase !== 'syncing' ? (
            <div className={styles.syncServerCount}>
              {t('syncServerSessions', { count: serverSessions })}
            </div>
          ) : null}
        </div>
        {/* 暂停同步入口不展示：登录即视为开启同步。
            仅对历史版本遗留的「已暂停」账号保留恢复入口，避免卡在暂停状态无法继续。 */}
        {signedIn && !config.enabled ? (
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={busy}
            onClick={() => setSyncEnabled(true)}
          >
            {t('syncResume')}
          </Button>
        ) : null}
      </div>

      <div className={styles.cell}>
        <div className={styles.syncForm}>
          <label className={styles.syncField}>
            <span>{t('syncServerLabel')}</span>
            <input
              className={styles.syncInput}
              type="url"
              value={displayServerUrl}
              placeholder={t('syncServerPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy || signedIn}
              onChange={(event) => {
                setServerUrl(event.target.value)
                setError(null)
              }}
            />
          </label>
          <label className={styles.syncField}>
            <span>{t('syncUsernameLabel')}</span>
            <input
              className={styles.syncInput}
              type="text"
              value={displayUsername}
              placeholder={t('syncUsernamePlaceholder')}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy || signedIn}
              onChange={(event) => {
                setUsername(event.target.value)
                setError(null)
              }}
            />
          </label>
          {needsAuth ? (
            <label className={styles.syncField}>
              <span>{t('syncPasswordLabel')}</span>
              <input
                className={styles.syncInput}
                type="password"
                value={password}
                placeholder={t('syncPasswordPlaceholder')}
                autoComplete="current-password"
                disabled={busy}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    void authenticate('login')
                  }
                }}
              />
            </label>
          ) : null}
          {signedIn ? <div className={styles.syncHint}>{t('syncAccountLockedHint')}</div> : null}
          {error ? <div className={styles.error}>{error}</div> : null}
          {status.phase === 'error' && errorKey ? (
            <div className={styles.error}>{t(errorKey)}</div>
          ) : null}
          <div className={styles.syncActions}>
            {needsAuth ? (
              <>
                <Button
                  variant="primary"
                  size="m"
                  className={styles.cellButton}
                  disabled={busy}
                  onClick={() => void authenticate('login')}
                >
                  {busy ? t('syncLoggingIn') : t('syncLogin')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={busy}
                  onClick={() => void authenticate('register')}
                >
                  {t('syncRegister')}
                </Button>
              </>
            ) : (
              <Button
                variant="outlined"
                size="m"
                className={styles.cellButton}
                disabled={busy || status.phase === 'syncing' || !config.enabled}
                onClick={() => void syncNow()}
              >
                {status.phase === 'syncing' ? t('syncSyncing') : t('syncNow')}
              </Button>
            )}
            {signedIn ? (
              <Button
                variant="dangerOutlined"
                size="m"
                className={styles.cellButton}
                disabled={busy}
                onClick={() => setConfirmLogout(true)}
              >
                {t('syncLogout')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {confirmLogout ? (
        <Modal
          title={t('syncLogoutConfirmTitle')}
          className={styles.deleteConfirm}
          onClose={() => {
            if (!busy) {
              setConfirmLogout(false)
            }
          }}
          footer={
            <div className={styles.deleteActions} aria-busy={busy}>
              <Button
                variant="outlined"
                autoFocus
                disabled={busy}
                onClick={() => setConfirmLogout(false)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void logout()}>
                {t('syncLogout')}
              </Button>
            </div>
          }
        >
          {t('syncLogoutConfirmDescription')}
        </Modal>
      ) : null}
    </>
  )
}
