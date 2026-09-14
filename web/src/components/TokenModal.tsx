import { memo, useState } from 'react'
import type { ServerCredential } from '../lib/api'
import styles from '../styles/layout.module.css'

interface Props {
  title?: string
  /** Shown only when non-empty; the dialog stays clean by default. */
  hint?: string
  /** Offer the username+password mode in addition to the plain token. */
  allowPassword?: boolean
  defaultMode?: 'token' | 'password'
  /** Receives the credential and the remember choice; the caller decides what it authorizes. */
  onSaved: (cred: ServerCredential, remember: boolean) => void
  onCancel?: () => void
}

/**
 * Credential prompt: the bridge's own token (401) or a target MCP server's
 * credentials — token, or username+password in PURE PASSTHROUGH (the MCP
 * server authenticates itself; smart-chat confirms via a tool call).
 */
export const TokenModal = memo(function TokenModal({
  title, hint = '', allowPassword = false, defaultMode = 'token', onSaved, onCancel,
}: Props) {
  const [mode, setMode] = useState<'token' | 'password'>(allowPassword ? defaultMode : 'token')
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)

  const save = () => {
    if (mode === 'password') {
      if (username.trim() === '' || password === '') return
      onSaved({ kind: 'password', username: username.trim(), password }, remember)
    } else {
      onSaved({ kind: 'token', token: value.trim() }, remember)
    }
  }

  return (
    <div className={styles.modalMask} role="dialog" aria-modal="true" aria-label={title ?? 'access token'}>
      <div className={styles.modalCard}>
        <h2>{title ?? 'Access token required'}</h2>
        {hint !== '' && <p className={styles.modalHint}>{hint}</p>}
        {allowPassword && (
          <div className={styles.credMode}>
            <label>
              <input type="radio" name="cred-mode" checked={mode === 'token'} onChange={() => setMode('token')} />
              {' '}token
            </label>
            <label>
              <input type="radio" name="cred-mode" checked={mode === 'password'} onChange={() => setMode('password')} />
              {' '}username + password
            </label>
          </div>
        )}
        {mode === 'token' ? (
          <input
            type="password"
            placeholder="token"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(ev) => setValue(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') save()
            }}
          />
        ) : (
          <div className={styles.credFields}>
            <input
              type="text"
              placeholder="username"
              autoComplete="off"
              autoFocus
              value={username}
              onChange={(ev) => setUsername(ev.target.value)}
            />
            <input
              type="password"
              placeholder="password"
              autoComplete="off"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') save()
              }}
            />
          </div>
        )}
        <label className={styles.remember}>
          <input type="checkbox" checked={remember} onChange={(ev) => setRemember(ev.target.checked)} />
          remember on this device
        </label>
        <div className={styles.modalActions}>
          {onCancel && (
            <button type="button" className={styles.ghost} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="button" className={styles.modalPrimary} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
})
