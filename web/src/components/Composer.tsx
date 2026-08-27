import { memo, useCallback, useEffect, useRef, useState } from 'react'
import styles from '../styles/composer.module.css'

interface Props {
  disabled: boolean
  busy: boolean
  hint?: string
  onSend: (text: string) => void
  onStop: () => void
  onAddMenu: () => void
}

const MAX_HEIGHT = 216

/** The chat composer card, styled after the harness InputBar. */
export const Composer = memo(function Composer({ disabled, busy, hint, onSend, onStop, onAddMenu }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  useEffect(resize, [value, resize])

  const submit = useCallback(() => {
    const text = value.trim()
    if (text === '' || disabled || busy) return
    onSend(text)
    setValue('')
    window.setTimeout(() => { ref.current?.focus() }, 0)
  }, [value, disabled, busy, onSend])

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
      ev.preventDefault()
      submit()
    }
  }

  const canSend = value.trim() !== '' && !disabled && !busy

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.scroll}>
          <textarea
            ref={ref}
            className={styles.textarea}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={disabled ? 'unavailable' : 'Message (Enter to send, Shift+Enter for newline)'}
            onChange={(ev) => setValue(ev.target.value)}
            onKeyDown={onKeyDown}
            aria-label="chat message"
          />
        </div>
        <div className={styles.row}>
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.add}
              title="Manage MCP servers"
              disabled={disabled}
              onClick={onAddMenu}
              aria-label="manage MCP servers"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className={styles.trailing}>
            {busy && <span className={styles.pending} aria-label="turn running" />}
            {busy ? (
              <button type="button" className={styles.primary} title="Stop" onClick={onStop} aria-label="stop">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className={styles.primary}
                title="Send"
                disabled={!canSend}
                onClick={submit}
                aria-label="send"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3.5 8L13 3.5L10.8 8L13 12.5L3.5 8Z"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  )
})
