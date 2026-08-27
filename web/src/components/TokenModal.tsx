import { memo, useState } from 'react'
import { saveToken } from '../lib/api'
import styles from '../styles/layout.module.css'

interface Props {
  onSaved: () => void
}

/** Token prompt shown when the bridge answers 401. */
export const TokenModal = memo(function TokenModal({ onSaved }: Props) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(true)

  const save = () => {
    saveToken(value.trim(), remember)
    onSaved()
  }

  return (
    <div className={styles.modalMask} role="dialog" aria-modal="true" aria-label="access token">
      <div className={styles.modalCard}>
        <h2>Access token required</h2>
        <p className={styles.modalHint}>
          This bridge is protected. Paste the token from the bridge config.
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
          <button type="button" className={styles.ghost} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
})
