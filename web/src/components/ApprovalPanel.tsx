import { memo, useState } from 'react'
import { api } from '../lib/api'
import type { ApprovalItem } from '../lib/store'
import styles from '../styles/approval.module.css'

interface Props {
  item: ApprovalItem
}

/** One-shot decision card that replaces the composer while pending. */
export const ApprovalPanel = memo(function ApprovalPanel({ item }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const decide = async (decision: 'allow' | 'deny') => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api<{ error?: string }>(`/approvals/${encodeURIComponent(item.approvalId)}`, {
        method: 'POST',
        body: { decision },
      })
      if (res.status !== 200) setError(res.data?.error ?? `HTTP ${res.status}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.strip}>
          <span className={styles.dot} />
          Approval required — the model is waiting for your decision
        </div>
        <div className={styles.body}>
          <div className={styles.headline}>{item.toolName}</div>
          <div className={styles.command}>{item.summary}</div>
          {error && <div className={styles.command}>{`decision failed: ${error}`}</div>}
        </div>
        <div className={styles.actionRow}>
          <button type="button" className={`${styles.button} ${styles.reject}`} disabled={busy} onClick={() => void decide('deny')}>
            Deny
          </button>
          <button type="button" className={`${styles.button} ${styles.allow}`} disabled={busy} onClick={() => void decide('allow')}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
})
