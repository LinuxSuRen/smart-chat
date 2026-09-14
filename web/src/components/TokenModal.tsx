import { memo, useState } from 'react'
import styles from '../styles/layout.module.css'

interface Props {
  title?: string
  hint?: string
  /** Receives the trimmed value and the remember choice; the caller decides what it authorizes. */
  onSaved: (value: string, remember: boolean) => void
  onCancel?: () => void
}

/** Token prompt: the bridge's own token (401) or a target MCP server's token (401/403). */
export const TokenModal = memo(function TokenModal({ title, hint, onSaved, onCancel }: Props) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(true)

  const save = () => onSaved(value.trim(), remember)

  return (
    <div className={styles.modalMask} role="dialog" aria-modal="true" aria-label={title ?? 'access token'}>
      <div className={styles.modalCard}>
        <h2>{title ?? 'Access token required'}</h2>
        <p className={styles.modalHint}>
          {hint ?? 'This bridge is protected. Paste the token from the bridge config.'}
        </p>
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
          <button type="button" className={styles.ghost} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
})
