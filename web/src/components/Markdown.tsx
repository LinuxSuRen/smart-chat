import { memo, useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import styles from '../styles/markdown.module.css'

interface Props {
  text: string
}

/** Click handler for the copy buttons rendered inside sanitized HTML. */
function onCopyClick(ev: React.MouseEvent<HTMLDivElement>): void {
  const target = ev.target as HTMLElement
  if (!target.matches('[data-md-copy]')) return
  const block = target.closest('[data-md-code]')
  const code = block?.querySelector('code')
  if (!code) return
  void navigator.clipboard?.writeText(code.textContent ?? '').then(() => {
    target.textContent = 'copied'
    window.setTimeout(() => { target.textContent = 'copy' }, 1200)
  })
}

export const Markdown = memo(function Markdown({ text }: Props) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div className={styles.mdRoot}>
      <div
        className={styles.mdBody}
        // eslint-disable-next-line react/no-danger -- sanitized via DOMPurify
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={onCopyClick}
      />
    </div>
  )
})
