import { memo, useEffect, useRef } from 'react'
import { useChatState } from '../hooks/useChatState'
import { Markdown } from './Markdown'
import { ReasoningRow } from './ReasoningRow'
import type { ApprovalItem, FeedItem, ToolItem, TurnItem } from '../lib/store'
import styles from '../styles/feed.module.css'

export const Feed = memo(function Feed() {
  const { feed } = useChatState()
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)

  // Follow the tail only while a turn is running or new items land.
  useEffect(() => {
    if (feed.length === lastCount.current) return
    lastCount.current = feed.length
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [feed])

  return (
    <>
      {feed.map((item) => (
        <FeedItemView key={item.key} item={item} />
      ))}
      <div ref={bottomRef} />
    </>
  )
})

function FeedItemView({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={styles.userRow}>
          <div className={styles.userBubble}>{item.text}</div>
        </div>
      )
    case 'turn':
      return <TurnView item={item} />
    case 'tool':
      return <ToolRow item={item} />
    case 'approval':
      return <ApprovalLine item={item} />
    case 'error':
      return <div className={styles.errorLine}>{item.message}</div>
    case 'sys':
      return <div className={styles.stopped}>{item.message}</div>
    default:
      return null
  }
}

const TurnView = memo(function TurnView({ item }: { item: TurnItem }) {
  const running = item.state === 'running'
  return (
    <div className={styles.assistant}>
      {item.reasoning !== '' && <ReasoningRow text={item.reasoning} running={running} />}
      {item.text !== '' && <Markdown text={item.text} />}
      {running && item.text === '' && item.reasoning === '' && (
        <div className={styles.turnStatus}>Working…</div>
      )}
      {item.state === 'error' && <div className={styles.stopped}>turn failed</div>}
    </div>
  )
})

const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  return (
    <details className={styles.toolRoot} data-state={item.state} open={item.state === 'error'}>
      <summary className={styles.toolSummary}>
        <span className={styles.toolDot} data-state={item.state} />
        <span className={styles.toolName}>{item.name}</span>
        <span className={styles.toolState}>
          {item.state === 'running' ? 'running…' : item.state === 'error' ? 'error' : 'done'}
        </span>
        <span className={styles.toolDur}>
          {item.durationMs !== undefined ? `${Math.max(1, Math.round(item.durationMs))} ms` : ''}
        </span>
      </summary>
      <div className={styles.toolDetail}>
        {`args: ${item.argsPreview}`}
        {item.summary !== undefined ? `\nresult: ${item.summary}` : ''}
      </div>
    </details>
  )
})

function ApprovalLine({ item }: { item: ApprovalItem }) {
  // Pending approvals render as the composer takeover (see App); here we only
  // keep the settled audit line.
  if (item.outcome === undefined) return null
  const label =
    item.outcome === 'allowed-once' ? 'allowed'
    : item.outcome === 'rejected' ? 'denied'
    : item.outcome
  return (
    <div className={styles.approvalDone} data-outcome={item.outcome}>
      <b>{item.toolName}</b> — approval {label}
    </div>
  )
}
