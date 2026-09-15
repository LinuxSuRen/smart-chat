import { memo, useState } from 'react'
import { api } from '../lib/api'
import type { ApprovalItem } from '../lib/store'
import { displayToolName } from './Feed'
import styles from '../styles/approval.module.css'

interface Props {
  item: ApprovalItem
}

/** One-shot decision card that replaces the composer while pending. */
export const ApprovalPanel = memo(function ApprovalPanel({ item }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { tool } = displayToolName(item.toolName)

  const decide = async (decision: 'allow' | 'deny') => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api<{ error?: string }>(`/approvals/${encodeURIComponent(item.approvalId)}`, {
        method: 'POST',
        body: { decision },
      })
      if (res.status !== 200) setError('提交失败，请重试')
    } catch {
      setError('网络异常，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.strip}>
          <span className={styles.dot} />
          需要你的确认
        </div>
        <div className={styles.body}>
          <div className={styles.headline}>{tool}</div>
          <div className={styles.command}>{item.summary}</div>
          {error && <div className={styles.command}>{error}</div>}
        </div>
        <div className={styles.actionRow}>
          <button type="button" className={`${styles.button} ${styles.reject}`} disabled={busy} onClick={() => void decide('deny')}>
            拒绝
          </button>
          <button type="button" className={`${styles.button} ${styles.allow}`} disabled={busy} onClick={() => void decide('allow')}>
            允许
          </button>
        </div>
      </div>
    </div>
  )
})
