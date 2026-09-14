// Typed REST + SSE client for the smart-chat bridge.
//
// The bridge prefix is injected at serve time (window.__SMART_CHAT_PREFIX__);
// the token lives in localStorage and also accepts a ?token= URL param, same
// as the legacy page. A 401 rejects with UnauthorizedError so the app can
// pop the token modal and retry once the user supplies one.

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}

declare global {
  interface Window {
    __SMART_CHAT_PREFIX__?: string
  }
}

const RAW_PLACEHOLDER = '@@SMART_CHAT_PREFIX@@'

export const PREFIX =
  window.__SMART_CHAT_PREFIX__ && window.__SMART_CHAT_PREFIX__ !== RAW_PLACEHOLDER
    ? window.__SMART_CHAT_PREFIX__
    : '/smart-chat'

const TOKEN_KEY = 'smart-chat.token'

export let token = ''

export function loadToken(): string {
  const qp = new URLSearchParams(location.search).get('token')
  if (qp) {
    token = qp
    try {
      localStorage.setItem(TOKEN_KEY, qp)
      history.replaceState(null, '', location.pathname)
    } catch { /* private mode */ }
    return token
  }
  try {
    token = localStorage.getItem(TOKEN_KEY) ?? ''
  } catch { /* private mode */ }
  return token
}

export function saveToken(value: string, remember: boolean): void {
  token = value
  try {
    if (remember) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* private mode */ }
}

// ---- per-MCP-server tokens ---------------------------------------------
// Target MCP servers that answer 401/403 get their token from a page dialog
// (NOT from the server config): the bridge keeps them in host memory and
// merges them into the transport at mount time. The page only caches them
// here for convenience across reloads.
const MCP_TOKENS_KEY = 'smart-chat.mcpTokens'

function loadMcpTokenMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MCP_TOKENS_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function loadMcpToken(serverName: string): string {
  return loadMcpTokenMap()[serverName] ?? ''
}

export function saveMcpToken(serverName: string, value: string, remember: boolean): void {
  try {
    const map = loadMcpTokenMap()
    if (remember && value !== '') map[serverName] = value
    else delete map[serverName]
    localStorage.setItem(MCP_TOKENS_KEY, JSON.stringify(map))
  } catch { /* private mode */ }
}

export async function submitServerToken(serverName: string, value: string): Promise<{ status: number; error?: string }> {
  const res = await api<{ error?: string }>(`/servers/${encodeURIComponent(serverName)}/token`, {
    method: 'POST',
    body: { token: value },
  })
  return { status: res.status, error: res.data?.error }
}

export interface ApiResponse<T = unknown> {
  status: number
  data: T
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(PREFIX + path, { method: opts.method ?? 'GET', headers, body })
  if (res.status === 401) throw new UnauthorizedError()
  const ctype = String(res.headers.get('content-type') ?? '')
  if (!ctype.includes('application/json')) {
    let snippet = ''
    try { snippet = (await res.text()).slice(0, 120) } catch { /* empty */ }
    throw new Error(`expected JSON from ${path} (HTTP ${res.status}) but got ${ctype || 'no content-type'}${snippet ? ': ' + snippet : ''}`)
  }
  let data: T
  try {
    data = await res.json() as T
  } catch (err) {
    throw new Error(`bad JSON from ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { status: res.status, data }
}

// ---- SSE event vocabulary (bridge.js) ---------------------------------

export interface ReadyEvent { sessionId: string }
export interface AssistantDeltaEvent { seq: number; delta?: string; reasoning?: string }
export interface ToolCallEvent { seq: number; callId: string; name: string; argsPreview: string }
export interface ToolResultEvent { seq: number; callId: string; isError: boolean; summary: string; durationMs?: number }
export interface ApprovalRequiredEvent { approvalId: string; toolName: string; summary: string }
export interface ApprovalResolvedEvent { approvalId: string; outcome: string }
export interface TurnDoneEvent { seq: number; turn: number; reason: string }
export interface ErrorEvent { message: string; code?: string }
export interface CredentialRequiredEvent { serverName: string; reason: string }

export interface BridgeEvents {
  ready: ReadyEvent
  assistant_delta: AssistantDeltaEvent
  tool_call: ToolCallEvent
  tool_result: ToolResultEvent
  approval_required: ApprovalRequiredEvent
  approval_resolved: ApprovalResolvedEvent
  turn_done: TurnDoneEvent
  error: ErrorEvent
  credential_required: CredentialRequiredEvent
}

export function openEvents(sessionId: string, handlers: {
  [K in keyof BridgeEvents]: (data: BridgeEvents[K]) => void
}): EventSource {
  const url = `${PREFIX}/events?sessionId=${encodeURIComponent(sessionId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
  const es = new EventSource(url)
  const entries = Object.entries<(data: never) => void>(handlers as Record<string, (data: never) => void>)
  for (const [name, handler] of entries) {
    es.addEventListener(name, (ev) => {
      const data = (ev.data ? JSON.parse(ev.data) : {}) as never
      handler(data)
    })
  }
  return es
}
