import { useState } from 'react'
import { useTranslate, isTranslationKey, type TranslationKey } from '../../i18n/index.js'
import {
  applySyncAccount,
  clearSyncCredentials,
  normalizeServerUrl,
  setSyncEnabled,
  useSyncConfig,
} from '../../services/sync/config.js'
import { syncLogin, syncLogout } from '../../services/sync/client.js'
import { resetSyncMeta } from '../../services/sync/meta.js'
import { syncNow } from '../../services/sync/engine.js'
import { useSyncStatus } from '../../services/sync/status.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

const validUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value.trim())

/** 云同步设置：服务地址 + 用户名密码登录/注册，开启后自动在设备间同步会话。 */
export const SyncSettings = () => {
  const t = useTranslate()
  const config = useSyncConfig()
  const status = useSyncStatus()
  const [serverUrl, setServerUrl] = useState(config.serverUrl)
  const [username, setUsername] = useState(config.username)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<'login' | 'register' | null>(null)

  const signedIn = config.token !== null
  const switching =
    signedIn &&
    (normalizeServerUrl(serverUrl) !== config.serverUrl || username.trim() !== config.username)
  // 已登录且未改动账号时不显示密码框；一旦改了地址/用户名，需要重新输密码才能切换。
  const needsAuth = !signedIn || switching

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
    if (switching) {
      setPendingSwitch(mode)
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
      setPendingSwitch(null)
    }
  }

  const logout = async () => {
    setBusy(true)
    try {
      await syncLogout()
    } catch {
      // 服务器不可达或 token 已失效时，本地仍要清除登录态
    }
    await resetSyncMeta()
    clearSyncCredentials()
    setSyncEnabled(false)
    setPassword('')
    setBusy(false)
  }

  const statusText = (): string => {
    switch (status.phase) {
      case 'disabled':
        return t('syncStatusDisabled')
      case 'syncing':
        return t('syncStatusSyncing')
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
    return parts.join(' · ')
  }

  const errorKey: TranslationKey | null =
    status.errorKey && isTranslationKey(status.errorKey) ? status.errorKey : null

  return (
    <>
      <div className={styles.cell}>
        <div className={styles.label}>{t('syncEnableLabel')}</div>
        <div className={styles.description}>{t('syncEnableDescription')}</div>
        <label className={styles.syncToggle}>
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={!signedIn || busy}
            onChange={(event) => setSyncEnabled(event.target.checked)}
          />
          <span>{config.enabled ? t('syncStatusIdle') : t('syncStatusDisabled')}</span>
        </label>
      </div>

      <div className={styles.cell}>
        <div className={styles.syncForm}>
          <label className={styles.syncField}>
            <span>{t('syncServerLabel')}</span>
            <input
              className={styles.syncInput}
              type="url"
              value={serverUrl}
              placeholder={t('syncServerPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => {
                setServerUrl(event.target.value)
                setError(null)
              }}
            />
          </label>
          {serverUrl.trim().toLowerCase().startsWith('http://') ? (
            <div className={styles.syncWarning}>{t('syncHttpWarning')}</div>
          ) : null}
          <label className={styles.syncField}>
            <span>{t('syncUsernameLabel')}</span>
            <input
              className={styles.syncInput}
              type="text"
              value={username}
              placeholder={t('syncUsernamePlaceholder')}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
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
          {error ? <div className={styles.error}>{error}</div> : null}
          {status.phase === 'error' && errorKey ? (
            <div className={styles.error}>{t(errorKey)}</div>
          ) : null}
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingDialogAsideSyncOptionLabel')}</div>
          <div className={styles.description}>{statusText()}</div>
        </div>
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
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={busy}
              onClick={() => void logout()}
            >
              {t('syncLogout')}
            </Button>
          ) : null}
        </div>
      </div>

      {pendingSwitch ? (
        <Modal
          title={t('syncAccountSwitchTitle')}
          className={styles.deleteConfirm}
          onClose={() => setPendingSwitch(null)}
          footer={
            <div className={styles.deleteActions}>
              <Button variant="outlined" autoFocus onClick={() => setPendingSwitch(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="dangerOutlined"
                onClick={() => {
                  const mode = pendingSwitch
                  void finishAuth(normalizeServerUrl(serverUrl), username.trim(), password, mode)
                }}
              >
                {t('syncAccountSwitchConfirm')}
              </Button>
            </div>
          }
        >
          {t('syncAccountSwitchDescription')}
        </Modal>
      ) : null}
    </>
  )
}
