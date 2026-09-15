import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api, loadToken, openEvents, submitServerCredential, saveToken,
  loadMcpCredential, saveMcpCredential, UnauthorizedError,
} from './lib/api'
import type { ServerCredential } from './lib/api'
import {
  makeDispatcher, pushSys, pushUser, setConn, setServers, setSessionId,
} from './lib/store'
import type { ServerRow } from './lib/store'
import { useChatState } from './hooks/useChatState'
import { Feed } from './components/Feed'
import { Composer } from './components/Composer'
import { ApprovalPanel } from './components/ApprovalPanel'
import { ServersPanel } from './components/ServersPanel'
import { TokenModal } from './components/TokenModal'
import layout from './styles/layout.module.css'

const SESSION_KEY = 'smart-chat.sessionId'
const THEME_KEY = 'smart-chat.theme'

type Theme = 'system' | 'light' | 'dark'

function applyTheme(theme: Theme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.dataset.dsDarkTheme = dark ? 'true' : ''
}

export function App() {
  const state = useChatState()
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme) ?? 'system')
  const [needToken, setNeedToken] = useState(false)
  const [serverAuth, setServerAuth] = useState<{ serverName: string; reason: string } | null>(null)
  const [booted, setBooted] = useState(false)
  const [serversOpen, setServersOpen] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const sessionRef = useRef('')
  const tokenTriedRef = useRef(new Set<string>())
  // Invisible-auth continuation: the text of the message that was held (or
  // interrupted) by a missing login, re-sent automatically once credentials
  // land. `lastSent` tracks the in-flight turn so a mid-turn 401 also
  // qualifies.
  const pendingAuthMessageRef = useRef<string | null>(null)
  const lastSentRef = useRef<{ text: string; answered: boolean }>({ text: '', answered: true })

  // Raw send: submits the text without touching the UI (the caller decides
  // whether the user bubble already exists — a re-send after login must not
  // duplicate it).
  const doSubmit = useCallback(async (text: string) => {
    const res = await api<{ error?: string; code?: string; servers?: string[] }>('/messages', {
      method: 'POST',
      body: { sessionId: sessionRef.current, text },
    })
    return res
  }, [])

  // Submit per-server MCP credentials; a remembered record goes silently,
  // a manual one comes from the dialog. On success the held message (if
  // any) is re-sent so the interrupted conversation continues by itself.
  const sendServerCredential = useCallback(async (serverName: string, cred: ServerCredential, manual: boolean) => {
    tokenTriedRef.current.add(serverName)
    try {
      const res = await submitServerCredential(serverName, cred)
      if (res.status === 200) {
        setServerAuth(null)
        void pollServersRef.current?.()
        const held = pendingAuthMessageRef.current
        if (held !== null) {
          pendingAuthMessageRef.current = null
          lastSentRef.current = { text: held, answered: false }
          const retry = await doSubmit(held)
          if (retry.status !== 202) pushSys(`continue failed: ${retry.data?.error ?? retry.status}`)
        }
        return
      }
      pushSys(`login rejected for ${serverName}: ${res.error ?? res.status}`)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setNeedToken(true)
        return
      }
      pushSys(`credential submit failed for ${serverName}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (manual) setServerAuth({ serverName, reason: '' })
  }, [doSubmit])
  const pollServersRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const openStream = useCallback((sessionId: string) => {
    esRef.current?.close()
    setConn('connecting')
    const dispatch = makeDispatcher(() => {
      // session-not-found: mint a fresh session
      esRef.current?.close()
      void newSession()
    })
    esRef.current = openEvents(sessionId, {
      ready: () => dispatch('ready', {}),
      assistant_delta: (d) => dispatch('assistant_delta', d as unknown as Record<string, unknown>),
      tool_call: (d) => dispatch('tool_call', d as unknown as Record<string, unknown>),
      tool_result: (d) => dispatch('tool_result', d as unknown as Record<string, unknown>),
      tool_images: (d) => dispatch('tool_images', d as unknown as Record<string, unknown>),
      approval_required: (d) => dispatch('approval_required', d as unknown as Record<string, unknown>),
      approval_resolved: (d) => dispatch('approval_resolved', d as unknown as Record<string, unknown>),
      turn_done: (d) => {
        // A completed (non-error) turn answers the in-flight message; an
        // errored one (e.g. mid-turn 401) leaves it eligible for the
        // auto-continue after login.
        if (String((d as { reason?: string }).reason ?? '') !== 'error') {
          lastSentRef.current.answered = true
        }
        dispatch('turn_done', d as unknown as Record<string, unknown>)
      },
      error: (d) => dispatch('error', d as unknown as Record<string, unknown>),
      credential_required: (d) => {
        // Auth was missing when it mattered: if a message is still
        // unanswered, hold it for the automatic continue after login. The
        // dialog shows only its title — raw server errors stay in the
        // servers.json diagnostics.
        if (!lastSentRef.current.answered && lastSentRef.current.text !== '') {
          pendingAuthMessageRef.current = lastSentRef.current.text
        }
        const stored = loadMcpCredential(d.serverName)
        if (stored !== null && !tokenTriedRef.current.has(d.serverName)) {
          void sendServerCredential(d.serverName, stored, false)
        } else {
          setServerAuth({ serverName: d.serverName, reason: '' })
        }
      },
    })
    esRef.current.addEventListener('error', () => setConn('closed'))
  }, [sendServerCredential])

  const newSession = useCallback(async () => {
    try {
      const res = await api<{ sessionId: string }>('/sessions', { method: 'POST', body: {} })
      if (res.status !== 201) {
        pushSys(`failed to create session: HTTP ${res.status}`)
        return
      }
      localStorage.setItem(SESSION_KEY, res.data.sessionId)
      sessionRef.current = res.data.sessionId
      setSessionId(res.data.sessionId)
      openStream(res.data.sessionId)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setNeedToken(true)
        return
      }
      pushSys(`failed to create session: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [openStream])

  // boot: token, session reuse probe, servers poll
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      loadToken()
      const saved = localStorage.getItem(SESSION_KEY) ?? ''
      if (saved !== '') {
        sessionRef.current = saved
        setSessionId(saved)
        openStream(saved)
      } else {
        await newSession()
      }
      if (!cancelled) setBooted(true)
    }
    void boot()
    return () => {
      cancelled = true
      esRef.current?.close()
    }
  }, [newSession, openStream])

  const pollServers = useCallback(async () => {
    try {
      const res = await api<{ servers: ServerRow[] }>('/servers.json')
      if (res.status === 200) {
        setServers(res.data.servers ?? [])
        // Auto-resubmit remembered credentials for servers flagged as
        // unauthorized (covers connection-level 401s; tool-call 401s with a
        // stored password are re-logged-in host-side without the page).
        for (const row of res.data.servers ?? []) {
          if (row.auth?.required !== true) continue
          const stored = loadMcpCredential(row.serverName)
          if (stored !== null && !tokenTriedRef.current.has(row.serverName)) {
            void sendServerCredential(row.serverName, stored, false)
          }
        }
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setNeedToken(true)
        return
      }
      setServers([], err instanceof Error ? err.message : String(err))
    }
  }, [sendServerCredential])

  // Assigned after definition: sendServerCredential (declared earlier) fires
  // it when credentials are accepted so the server bar refreshes immediately.
  pollServersRef.current = () => { void pollServers() }

  useEffect(() => {
    if (!booted) return
    void pollServers()
    const timer = window.setInterval(() => void pollServers(), 3000)
    return () => window.clearInterval(timer)
  }, [booted, pollServers, needToken])

  const send = useCallback(async (text: string, opts: { bubble?: boolean } = {}) => {
    const showBubble = opts.bubble !== false
    if (showBubble) pushUser(text)
    lastSentRef.current = { text, answered: false }
    try {
      const res = await doSubmit(text)
      if (res.status === 409 && res.data?.code === 'credentials-required') {
        // Input-time gate: the bridge held the message because a mounted
        // server has no credentials yet. Show the (clean) login dialog; the
        // message continues automatically once the login succeeds.
        pendingAuthMessageRef.current = text
        const servers = res.data.servers ?? []
        setServerAuth({ serverName: servers[0] ?? 'MCP server', reason: '' })
        return
      }
      if (res.status !== 202) pushSys(`message rejected: ${res.data?.error ?? res.status}`)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setNeedToken(true)
        return
      }
      pushSys(`send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [doSubmit])

  const stop = useCallback(async () => {
    try {
      await api(`/sessions/${encodeURIComponent(sessionRef.current)}/cancel`, { method: 'POST', body: {} })
    } catch { /* best effort */ }
  }, [])

  const busy = state.feed.some(
    (i) => (i.kind === 'turn' && i.state === 'running') || (i.kind === 'tool' && i.state === 'running'),
  )
  const pendingApproval = state.feed.find((i) => i.kind === 'approval' && i.outcome === undefined)
  const up = state.servers.filter((s) => s.state === 'connected').length
  const toolCount = state.servers.reduce((n, s) => n + (s.toolCount ?? 0), 0)

  const themeCycle = () =>
    setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))

  return (
    <div className={layout.root}>
      <header className={layout.header}>
        <div className={layout.titleRow}>
          <span className={layout.brand}>smart-chat</span>
          <span className={layout.conn} data-ok={state.conn === 'open'} title={state.conn === 'open' ? '已连接' : '连接中断'} />
          <span className={layout.serverbar}>
            {state.serversError
              ? '服务状态暂时无法获取'
              : `服务 ${up}/${state.servers.length} 正常 · ${toolCount} 个功能`}
          </span>
          <div className={layout.headerActions}>
            <ServersPanel
              servers={state.servers}
              error={state.serversError}
              open={serversOpen}
              onOpenChange={setServersOpen}
              onRefreshed={pollServers}
              onToken={(name) => setServerAuth({ serverName: name, reason: '' })}
            />
            <button type="button" className={layout.ghost} onClick={() => openStream(sessionRef.current)}>
              重新连接
            </button>
            <button type="button" className={layout.ghost} onClick={() => void newSession()}>
              新对话
            </button>
            <button type="button" className={layout.ghost} onClick={themeCycle} title="外观：跟随系统 / 浅色 / 深色">
              {theme === 'system' ? '外观：自动' : theme === 'light' ? '外观：浅色' : '外观：深色'}
            </button>
          </div>
        </div>
      </header>
      <div className={layout.scrollBody}>
        <div className={layout.chatColumn}>
          <Feed />
        </div>
      </div>
      <div className={layout.composerSeat}>
        {pendingApproval && pendingApproval.kind === 'approval' ? (
          <ApprovalPanel item={pendingApproval} />
        ) : (
          <Composer
            disabled={!booted || state.sessionId === ''}
            busy={busy}
            onSend={(text) => void send(text)}
            onStop={() => void stop()}
            onAddMenu={() => setServersOpen(true)}
          />
        )}
      </div>
      {needToken && (
        <TokenModal
          onSaved={(cred) => {
            if (cred.kind === 'token') saveToken(cred.token ?? '', true)
            setNeedToken(false)
            void newSession()
            void pollServers()
          }}
        />
      )}
      {serverAuth && !needToken && (
        <TokenModal
          title={`Login: ${serverAuth.serverName}`}
          hint={serverAuth.reason === '' ? '' : serverAuth.reason}
          allowPassword
          onSaved={(cred, remember) => {
            saveMcpCredential(serverAuth.serverName, cred, remember)
            void sendServerCredential(serverAuth.serverName, cred, true)
          }}
          onCancel={() => {
            pendingAuthMessageRef.current = null
            setServerAuth(null)
          }}
        />
      )}
    </div>
  )
}
