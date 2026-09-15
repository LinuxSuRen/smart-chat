import { memo, useEffect, useRef } from 'react'
import { useChatState } from '../hooks/useChatState'
import { Markdown } from './Markdown'
import { ReasoningRow } from './ReasoningRow'
import type { ApprovalItem, FeedItem, ToolItem, TurnItem } from '../lib/store'
import styles from '../styles/feed.module.css'

/**
 * smart-chat is operated by NON-technical users: raw tool names
 * (mcp__robot__alarm_list), transport vocabulary, and stack traces never
 * reach the feed. Display names strip the mcp__<server>__ prefix; the
 * server rides along as a small badge.
 */
export function displayToolName(raw: string): { server?: string; tool: string } {
  const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(raw)
  if (match === null) return { tool: raw }
  return { server: match[1], tool: match[2] }
}

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
        <div className={styles.turnStatus}>思考中…</div>
      )}
      {item.state === 'error' && <div className={styles.stopped}>回复中断，请重试</div>}
    </div>
  )
})

const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const { server, tool } = displayToolName(item.name)
  return (
    <details className={styles.toolRoot} data-state={item.state} open={item.state === 'error' || (item.images?.length ?? 0) > 0}>
      <summary className={styles.toolSummary}>
        <span className={styles.toolDot} data-state={item.state} />
        {server !== undefined && <span className={styles.toolServer}>{server}</span>}
        <span className={styles.toolName}>{tool}</span>
        <span className={styles.toolState}>
          {item.state === 'running' ? 'running…' : item.state === 'error' ? 'failed' : 'done'}
        </span>
        <span className={styles.toolDur}>
          {item.durationMs !== undefined ? `${(Math.max(1, item.durationMs) / 1000).toFixed(1)} s` : ''}
        </span>
      </summary>
      <div className={styles.toolDetail}>
        {item.summary !== undefined ? item.summary : ''}
      </div>
      {(item.images?.length ?? 0) > 0 && (
        <div className={styles.toolImages}>
          {item.images?.map((src, index) => (
            <img key={`${item.callId}-${index}`} src={src} alt={`result ${index + 1}`} loading="lazy" />
          ))}
        </div>
      )}
    </details>
  )
})

function ApprovalLine({ item }: { item: ApprovalItem }) {
  // Pending approvals render as the composer takeover (see App); here we only
  // keep the settled audit line.
  if (item.outcome === undefined) return null
  const { tool } = displayToolName(item.toolName)
  const label =
    item.outcome === 'allowed-once' ? 'allowed'
    : item.outcome === 'rejected' ? 'denied'
    : item.outcome
  return (
    <div className={styles.approvalDone} data-outcome={item.outcome}>
      <b>{tool}</b> — {label}
    </div>
  )
}
