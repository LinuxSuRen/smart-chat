import { memo, useState } from 'react'
import styles from '../styles/reasoning.module.css'

interface Props {
  text: string
  running: boolean
}

function summarize(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return firstLine.trim().slice(0, 80)
}

/** Collapsible thinking row with the harness sweep animation. */
export const ReasoningRow = memo(function ReasoningRow({ text, running }: Props) {
  const [open, setOpen] = useState(false)
  if (text === '') return null
  return (
    <div className={styles.root} data-state={running ? 'running' : 'idle'} data-open={open}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.chevron}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          aria-label={open ? 'collapse reasoning' : 'expand reasoning'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className={styles.title}>{running ? 'Thinking…' : 'Thought process'}</span>
        <span className={styles.separator} />
        <span className={styles.summary}>{summarize(text)}</span>
      </div>
      {open && <div className={styles.thinkBody}>{text}</div>}
    </div>
  )
})
