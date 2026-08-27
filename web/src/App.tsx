import { useCallback, useEffect, useRef, useState } from 'react'
import { api, loadToken, openEvents, UnauthorizedError } from './lib/api'
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
  const [booted, setBooted] = useState(false)
  const [serversOpen, setServersOpen] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const sessionRef = useRef('')

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
      approval_required: (d) => dispatch('approval_required', d as unknown as Record<string, unknown>),
      approval_resolved: (d) => dispatch('approval_resolved', d as unknown as Record<string, unknown>),
      turn_done: (d) => dispatch('turn_done', d as unknown as Record<string, unknown>),
      error: (d) => dispatch('error', d as unknown as Record<string, unknown>),
    })
    esRef.current.addEventListener('error', () => setConn('closed'))
  }, [])

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
      if (res.status === 200) setServers(res.data.servers ?? [])
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setNeedToken(true)
        return
      }
      setServers([], err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!booted) return
    void pollServers()
    const timer = window.setInterval(() => void pollServers(), 3000)
    return () => window.clearInterval(timer)
  }, [booted, pollServers, needToken])

  const send = useCallback(async (text: string) => {
    pushUser(text)
    try {
      const res = await api<{ error?: string }>('/messages', {
        method: 'POST',
        body: { sessionId: sessionRef.current, text },
      })
      if (res.status !== 202) pushSys(`message rejected: ${res.data?.error ?? res.status}`)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setNeedToken(true)
        return
      }
      pushSys(`send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

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
          <span className={layout.conn} data-ok={state.conn === 'open'} title={`SSE ${state.conn}`} />
          <span className={layout.serverbar}>
            {state.serversError
              ? `servers: error — ${state.serversError}`
              : `servers: ${up}/${state.servers.length} up, ${toolCount} tools`}
          </span>
          <div className={layout.headerActions}>
            <ServersPanel
              servers={state.servers}
              error={state.serversError}
              open={serversOpen}
              onOpenChange={setServersOpen}
              onRefreshed={pollServers}
            />
            <button type="button" className={layout.ghost} onClick={() => openStream(sessionRef.current)}>
              Reconnect
            </button>
            <button type="button" className={layout.ghost} onClick={() => void newSession()}>
              New chat
            </button>
            <button type="button" className={layout.ghost} onClick={themeCycle} title="theme: follow system / light / dark">
              {theme === 'system' ? 'Theme: auto' : theme === 'light' ? 'Theme: light' : 'Theme: dark'}
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
          onSaved={() => {
            setNeedToken(false)
            void newSession()
            void pollServers()
          }}
        />
      )}
    </div>
  )
}
