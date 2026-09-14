// Chat store: one observable source of truth for the feed, connection state,
// and server list, consumed through useSyncExternalStore (the same React
// binding pattern the harness renderer uses).

export type ConnState = 'connecting' | 'open' | 'closed'

export interface UserItem {
  kind: 'user'
  key: string
  text: string
  at: number
}

export interface TurnItem {
  kind: 'turn'
  key: string
  turn: number
  text: string
  reasoning: string
  state: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  reason?: string
}

export interface ToolItem {
  kind: 'tool'
  key: string
  callId: string
  name: string
  argsPreview: string
  state: 'running' | 'done' | 'error'
  summary?: string
  durationMs?: number
}

export interface ApprovalItem {
  kind: 'approval'
  key: string
  approvalId: string
  toolName: string
  summary: string
  outcome?: string
}

export interface ErrorItem {
  kind: 'error'
  key: string
  message: string
}

export interface SysItem {
  kind: 'sys'
  key: string
  message: string
}

export type FeedItem = UserItem | TurnItem | ToolItem | ApprovalItem | ErrorItem | SysItem

export interface ServerRow {
  serverName: string
  transport?: string
  state: string
  toolCount: number
  error: string | null
  logs: string[]
  tools: { name: string; description: string }[]
  entry: Record<string, unknown>
  auth?: { required: boolean; reason?: string }
}

export interface ChatState {
  sessionId: string
  conn: ConnState
  feed: FeedItem[]
  servers: ServerRow[]
  serversError: string
}

let state: ChatState = {
  sessionId: '',
  conn: 'connecting',
  feed: [],
  servers: [],
  serversError: '',
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getState(): ChatState {
  return state
}

function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch }
  emit()
}

let keySeq = 0
const nextKey = (p: string) => `${p}-${++keySeq}`

// ---- feed mutations ------------------------------------------------------

function ensureTurn(): TurnItem {
  let item = [...state.feed].reverse().find((i): i is TurnItem => i.kind === 'turn' && i.state === 'running')
  if (item) return item
  item = {
    kind: 'turn',
    key: nextKey('turn'),
    turn: state.feed.filter((i) => i.kind === 'turn').length + 1,
    text: '',
    reasoning: '',
    state: 'running',
    startedAt: Date.now(),
  }
  set({ feed: [...state.feed, item] })
  return item
}

function patchItem(key: string, patch: (item: FeedItem) => FeedItem): void {
  set({ feed: state.feed.map((i) => (i.key === key ? patch(i) : i)) })
}

export function pushUser(text: string): void {
  const item: UserItem = { kind: 'user', key: nextKey('user'), text, at: Date.now() }
  set({ feed: [...state.feed, item] })
}

export function pushSys(message: string): void {
  const item: SysItem = { kind: 'sys', key: nextKey('sys'), message }
  set({ feed: [...state.feed, item] })
}

export function pushError(message: string): void {
  const item: ErrorItem = { kind: 'error', key: nextKey('err'), message }
  set({ feed: [...state.feed, item] })
}

// ---- SSE dispatch ---------------------------------------------------------

export type SseDispatch = (event: string, data: Record<string, unknown>) => void

export function makeDispatcher(onSessionNotFound: () => void): SseDispatch {
  return (event, data) => {
    switch (event) {
      case 'ready':
        set({ conn: 'open' })
        break
      case 'assistant_delta': {
        const turn = ensureTurn()
        const patch: Partial<TurnItem> = {}
        if (typeof data.delta === 'string') patch.text = turn.text + data.delta
        if (typeof data.reasoning === 'string') patch.reasoning = turn.reasoning + data.reasoning
        patchItem(turn.key, (i) => ({ ...(i as TurnItem), ...patch }))
        break
      }
      case 'tool_call': {
        const item: ToolItem = {
          kind: 'tool',
          key: nextKey(`tool-${String(data.callId)}`),
          callId: String(data.callId),
          name: String(data.name),
          argsPreview: String(data.argsPreview ?? ''),
          state: 'running',
        }
        set({ feed: [...state.feed, item] })
        break
      }
      case 'tool_result': {
        const callId = String(data.callId)
        const item = [...state.feed].reverse().find((i): i is ToolItem => i.kind === 'tool' && i.callId === callId)
        if (!item) break
        patchItem(item.key, (i) => ({
          ...(i as ToolItem),
          state: data.isError === true ? 'error' : 'done',
          summary: typeof data.summary === 'string' ? data.summary : undefined,
          durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
        }))
        break
      }
      case 'approval_required': {
        const item: ApprovalItem = {
          kind: 'approval',
          key: nextKey(`appr-${String(data.approvalId)}`),
          approvalId: String(data.approvalId),
          toolName: String(data.toolName),
          summary: String(data.summary ?? ''),
        }
        set({ feed: [...state.feed, item] })
        break
      }
      case 'approval_resolved': {
        const id = String(data.approvalId)
        const item = state.feed.find((i): i is ApprovalItem => i.kind === 'approval' && i.approvalId === id)
        if (item) patchItem(item.key, (i) => ({ ...(i as ApprovalItem), outcome: String(data.outcome) }))
        break
      }
      case 'turn_done': {
        const item = [...state.feed].reverse().find((i): i is TurnItem => i.kind === 'turn' && i.state === 'running')
        if (item) {
          patchItem(item.key, (i) => ({
            ...(i as TurnItem),
            state: 'done',
            endedAt: Date.now(),
            reason: String(data.reason ?? ''),
          }))
        }
        break
      }
      case 'error': {
        const code = typeof data.code === 'string' ? data.code : ''
        if (code === 'session-not-found') {
          onSessionNotFound()
          break
        }
        pushError(String(data.message ?? 'error'))
        const item = [...state.feed].reverse().find((i): i is TurnItem => i.kind === 'turn' && i.state === 'running')
        if (item) patchItem(item.key, (i) => ({ ...(i as TurnItem), state: 'error' }))
        break
      }
      default:
        break
    }
  }
}

export function setConn(conn: ConnState): void {
  set({ conn })
}

export function setSessionId(sessionId: string): void {
  set({ sessionId, feed: [] })
}

export function setServers(servers: ServerRow[], serversError = ''): void {
  set({ servers, serversError })
}
