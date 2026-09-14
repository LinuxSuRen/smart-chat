// smart-chat — MCP server engine.
//
// Owns the effective MCP server list: the plugin's composition config
// (cordis.patch.yml `servers:`) is the settings BASE layer, edits made from
// the chat page (POST {prefix}/servers) land in the settings USER layer, and
// dsh merges both — one storage, one chain. Every change reconciles live
// @deepseek-ai/dsh-mcp-client fibers per serverName: additions mount
// immediately, removals/changes dispose and remount. GET status reports
// transport, fiber state, tool count, and recent diagnostics per server.

import Schema from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export const SERVERS_SETTINGS_NS = settingsNamespace('mcp-chat-web')
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const MCP_TOOL_PREFIX = /^mcp__([A-Za-z0-9_-]{1,32})__/
const MAX_LOG_LINES = 8
const MAX_LOG_LINE = 300
// Fiber lifecycle states (cordis): 0 pending, 2 active/loading, 3 failed
// (`_error` set), 4 disposed.
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4

export const ServersField = Schema.array(Schema.any()).default([]).description(
  'Base MCP server list (composition layer). Each item takes the full dsh-mcp-client config: serverName plus transport stdio (command/args/env/cwd) or streamable-http (url/headers). Edits made in the chat page override this layer through the dsh settings user layer.',
)
export const ServersSettingsSchema = Schema.object({ servers: ServersField })

function isStringMap(value) {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

/** Validate one MCP server entry; returns { ok: true } or { ok: false, error }. */
export function validateServerEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: 'server entry must be an object' }
  }
  const serverName = entry.serverName
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    return { ok: false, error: `serverName must match ${SERVER_NAME_PATTERN}` }
  }
  if (entry.transport !== 'stdio' && entry.transport !== 'streamable-http') {
    return { ok: false, error: 'transport must be "stdio" or "streamable-http"' }
  }
  if (entry.transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command === '') {
      return { ok: false, error: 'stdio server requires a command' }
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      return { ok: false, error: 'args must be an array' }
    }
    if (entry.args !== undefined && !entry.args.every((a) => typeof a === 'string')) {
      return { ok: false, error: 'args must be an array of strings' }
    }
    if (!isStringMap(entry.env)) return { ok: false, error: 'env must be a map of strings' }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
      return { ok: false, error: 'cwd must be a string' }
    }
  } else {
    if (typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) {
      return { ok: false, error: 'streamable-http server requires an http(s) url' }
    }
    if (!isStringMap(entry.headers)) return { ok: false, error: 'headers must be a map of strings' }
    // Optional login endpoint for the username/password credential mode
    // (robot-platform style JWT login). It is configuration, not a secret.
    if (entry.auth !== undefined) {
      if (!entry.auth || typeof entry.auth !== 'object' || Array.isArray(entry.auth)) {
        return { ok: false, error: 'auth must be an object' }
      }
      if (entry.auth.loginUrl !== undefined && (typeof entry.auth.loginUrl !== 'string' || !/^https?:\/\//i.test(entry.auth.loginUrl))) {
        return { ok: false, error: 'auth.loginUrl must be an http(s) url' }
      }
      // Optional read-only probe tool (raw name or full mcp__ public name):
      // before a session's FIRST message the bridge silently executes it to
      // check whether platform credentials work, so the login prompt appears
      // at input time instead of after a failed model tool call.
      if (entry.auth.probeTool !== undefined && (typeof entry.auth.probeTool !== 'string' || !/^[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)*$/.test(entry.auth.probeTool))) {
        return { ok: false, error: 'auth.probeTool must be a tool name (raw or mcp__<server>__<tool>)' }
      }
    }
  }
  if (entry.toolCallTimeoutMs !== undefined && (typeof entry.toolCallTimeoutMs !== 'number' || !Number.isFinite(entry.toolCallTimeoutMs) || entry.toolCallTimeoutMs <= 0)) {
    return { ok: false, error: 'toolCallTimeoutMs must be a positive number' }
  }
  if (entry.failOnStartupError !== undefined && typeof entry.failOnStartupError !== 'boolean') {
    return { ok: false, error: 'failOnStartupError must be a boolean' }
  }
  return { ok: true }
}

/** Validate a whole replacement list (shape + unique serverNames). */
export function validateServerList(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'servers must be an array' }
  const seen = new Set()
  for (const entry of list) {
    const verdict = validateServerEntry(entry)
    if (!verdict.ok) return verdict
    if (seen.has(entry.serverName)) {
      return { ok: false, error: `duplicate serverName "${entry.serverName}"` }
    }
    seen.add(entry.serverName)
  }
  return { ok: true }
}

/**
 * Build the server engine on `ctx`. Mounts fibers per server, keeps the
 * status view fresh on `tools/change`, and exposes the write path used by
 * POST {prefix}/servers.
 */
export function createServerManager(ctx, config, log) {
  // serverName -> { fiber, entry } for currently mounted MCP client fibers.
  const mounted = new Map()
  // serverName -> last validation error (never mounted).
  const invalid = new Map()
  // serverName -> tool count, recomputed from the tools registry.
  const toolCounts = new Map()
  // serverName -> ring of recent warn/error diagnostics from the mcp-client
  // supervisor ("mcp-client(<serverName>): ..."), surfaced in the status view
  // so the page can show WHY a server is down.
  const serverLogs = new Map()
  const LOG_MATCH = /^mcp-client\(([^)]+)\):?\s*(.*)$/

  const noteServerLog = (serverName, text) => {
    if (!serverLogs.has(serverName)) serverLogs.set(serverName, [])
    const lines = serverLogs.get(serverName)
    lines.push(`${new Date().toLocaleTimeString()} ${text}`.slice(0, MAX_LOG_LINE))
    if (lines.length > MAX_LOG_LINES) serverLogs.set(serverName, lines.slice(-MAX_LOG_LINES))
  }

  ctx.effect(() => ctx.logger.exporter({
    colors: 0,
    // Capture down to debug level; without an explicit `levels` the exporter's
    // default threshold silently drops the supervisor's warn-level reconnect
    // diagnostics ("connection attempt failed", "reconnecting in ...").
    levels: { default: 3 },
    export: (message) => {
      if (message.type !== 'error' && message.type !== 'warn') return
      const first = message.args.find((a) => typeof a === 'string')
      if (typeof first !== 'string') return
      const match = LOG_MATCH.exec(first)
      if (match === null) return
      const text = message.args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter((s) => s !== '')
        .join(' ')
      noteServerLog(match[1], text)
    },
  }), 'smart-chat: server diagnostics')

  // --- per-server credentials (never persisted to settings) --------------
  // Streamable-http MCP servers that answer 401/403 without credentials get
  // theirs from the CHAT PAGE (input dialog), kept in host memory only and
  // merged into the transport headers at mount time. Two kinds:
  //   token    — pasted bearer token, sent as Authorization: Bearer
  //   password — username + password; the bridge performs the login itself
  //              (robot-platform style): POST {loginUrl} JSON {username,
  //              password}; on 200 prefer Set-Cookie auth_token=<JWT>, fall
  //              back to the body's {token}; the JWT is then carried in BOTH
  //              forms (Authorization: Bearer + Cookie: auth_token=). When a
  //              later 401/403 arrives, the bridge re-logs-in automatically
  //              instead of asking again.
  const AUTH_NEEDED_PATTERN = /\b(401|403)\b|unauthorized|forbidden/i
  // The server explicitly asks the CALLER to supply per-call platform
  // credentials (robot-platform style) — unlike a backend 401, this is OUR
  // credential domain by the server's own declaration.
  const PER_CALL_CRED_PATTERN = /未提供[^，。;；]{0,12}凭证|经请求头传入|X-Platform-Token|no (platform )?credentials|missing (platform )?credentials|credentials? (are )?required/i
  const AUTH_COOKIE_NAME = 'auth_token'
  const credentials = new Map() // serverName -> { kind:'token', token } | { kind:'password', username, password, loginUrl, jwt? }
  const authRequired = new Map() // serverName -> reason string (watchdog flag)
  const probeVerified = new Map() // serverName -> true once the silent probe passed

  /** Default login endpoint: same origin as the MCP endpoint. */
  const defaultLoginUrl = (entry) => {
    try {
      return new URL('/api/v1/auth/login', new URL(entry.url).origin).href
    } catch {
      return undefined
    }
  }

  /**
   * Perform the platform login dance. Returns { ok, token } — never throws.
   * Mirrors robot-platform-mcp: prefer Set-Cookie auth_token, fall back to
   * the response body's token field; non-200 is a failure.
   */
  const login = async (username, password, loginUrl) => {
    let response
    try {
      response = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      return { ok: false, error: `login request failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (response.status !== 200) {
      let detail = ''
      try { detail = (await response.text()).slice(0, 200) } catch { /* empty */ }
      return { ok: false, error: `login rejected (HTTP ${response.status})${detail ? `: ${detail}` : ''}` }
    }
    // Prefer the auth_token cookie (new deployments), then the body token.
    const setCookie = response.headers.getSetCookie?.() ?? []
    for (const line of setCookie) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0 && pair.slice(0, eq).trim() === AUTH_COOKIE_NAME) {
        const value = pair.slice(eq + 1).trim()
        if (value !== '') return { ok: true, token: value }
      }
    }
    let token = ''
    try {
      const body = await response.json()
      if (typeof body?.token === 'string') token = body.token
    } catch { /* not JSON */ }
    if (token !== '') return { ok: true, token }
    return { ok: false, error: 'login response carried no session credential (neither an auth_token cookie nor a token field)' }
  }

  /** Merge stored credentials into a streamable-http entry WITHOUT mutating it.
   *
   * Speaks both credential vocabularies (harmless to send both — unknown
   * X-Platform-* headers are ignored by servers that do not read them):
   *   - robot-platform per-call style: X-Platform-Token (token) or
   *     X-Platform-Username/X-Platform-Password (account); the server pins
   *     them to the MCP session at initialize.
   *   - bridge-login style: Authorization: Bearer (+ Cookie auth_token for
   *     logged-in JWTs) against deployments with admission off.
   */
  const mergedEntry = (entry) => {
    if (entry?.transport !== 'streamable-http') return entry
    const cred = credentials.get(entry.serverName)
    if (cred === undefined) return entry
    const headers = { ...(entry.headers ?? {}) }
    if (cred.kind === 'token' && cred.token !== '') {
      headers.Authorization = `Bearer ${cred.token}`
      headers['X-Platform-Token'] = cred.token
    } else if (cred.kind === 'password' && cred.jwt !== undefined && cred.jwt !== '') {
      headers.Authorization = `Bearer ${cred.jwt}`
      headers.Cookie = `${AUTH_COOKIE_NAME}=${cred.jwt}`
      headers['X-Platform-Username'] = cred.username
      headers['X-Platform-Password'] = cred.password
    } else {
      return entry
    }
    return { ...entry, headers }
  }

  /**
   * Store credentials from the page and remount. Accepts a token or a
   * username/password pair (plus optional loginUrl override).
   */
  const setCredentials = async (serverName, body) => {
    const entry = readSettings().find((e) => e?.serverName === serverName)
    if (entry === undefined) return { ok: false, status: 404, error: `unknown server "${serverName}"` }
    if (entry.transport !== 'streamable-http') {
      return { ok: false, status: 400, error: 'only streamable-http servers use credentials' }
    }
    const hasToken = typeof body.token === 'string' && body.token !== ''
    const hasPassword = typeof body.username === 'string' && body.username !== '' && typeof body.password === 'string'
    if (!hasToken && !hasPassword) {
      // Neither supplied: treat as a clear.
      credentials.delete(serverName)
      authRequired.delete(serverName)
      probeVerified.delete(serverName)
      serverLogs.delete(serverName)
      void remount(serverName, 'credentials cleared')
      return { ok: true }
    }
    if (hasToken) {
      if (body.token.length > 4096) return { ok: false, status: 400, error: 'invalid token' }
      credentials.set(serverName, { kind: 'token', token: body.token })
    } else {
      const loginUrl = typeof body.loginUrl === 'string' && body.loginUrl !== ''
        ? body.loginUrl
        : entry.auth?.loginUrl ?? defaultLoginUrl(entry)
      if (loginUrl === undefined) return { ok: false, status: 400, error: 'no login URL (set auth.loginUrl on the server entry)' }
      const verdict = await login(body.username, body.password, loginUrl)
      if (!verdict.ok) return { ok: false, status: 400, error: verdict.error }
      credentials.set(serverName, { kind: 'password', username: body.username, password: body.password, loginUrl, jwt: verdict.token })
    }
    // New credentials: the silent probe must re-verify them (the auto
    // re-sent message re-enters the gate).
    probeVerified.delete(serverName)
    authRequired.delete(serverName)
    serverLogs.delete(serverName)
    void remount(serverName, hasToken ? 'token updated' : 'logged in; session token updated')
    return { ok: true }
  }

  /**
   * 401/403 arrived and password credentials are stored: re-login quietly
   * and remount. Returns true when the session was refreshed.
   */
  const tryRelogin = async (serverName) => {
    const cred = credentials.get(serverName)
    if (cred?.kind !== 'password') return false
    const verdict = await login(cred.username, cred.password, cred.loginUrl)
    if (!verdict.ok) {
      noteServerLog(serverName, `auto re-login failed: ${verdict.error}`)
      log.warn('server "%s": auto re-login failed: %s', serverName, verdict.error)
      return false
    }
    cred.jwt = verdict.token
    authRequired.delete(serverName)
    log.info('server "%s": re-logged in after 401/403; remounting', serverName)
    void remount(serverName, 'session expired; re-logged in')
    return true
  }

  let readSettings = () => config.servers ?? []

  const recountTools = () => {
    const tools = ctx.get('tools')
    if (tools === undefined) return
    toolCounts.clear()
    for (const schema of tools.schemas(undefined)) {
      const match = MCP_TOOL_PREFIX.exec(schema.name)
      if (match === null) continue
      toolCounts.set(match[1], (toolCounts.get(match[1]) ?? 0) + 1)
    }
  }

  // Snapshot every registered MCP tool as { name, description } leaf data,
  // grouped per server. Descriptions are truncated to keep the payload small.
  const toolsSnapshot = () => {
    const tools = ctx.get('tools')
    const grouped = new Map()
    if (tools === undefined) return grouped
    for (const schema of tools.schemas(undefined)) {
      const match = MCP_TOOL_PREFIX.exec(schema.name)
      if (match === null) continue
      const server = match[1]
      if (!grouped.has(server)) grouped.set(server, [])
      grouped.get(server).push({
        name: schema.name,
        description: typeof schema.description === 'string' ? schema.description.slice(0, 300) : '',
      })
    }
    return grouped
  }

  const statusPayload = () => {
    const grouped = toolsSnapshot()
    const servers = []
    for (const entry of readSettings()) {
      const name = entry && typeof entry === 'object' ? entry.serverName : undefined
      const key = typeof name === 'string' ? name : String(name)
      let state = 'removed'
      let error = invalid.get(key)
      const record = mounted.get(key)
      if (record !== undefined) {
        const fiberState = record.fiber.state
        if (fiberState === FIBER_FAILED) {
          state = 'failed'
          const reason = record.fiber._error
          error = reason instanceof Error ? reason.message : String(reason ?? 'fiber failed')
        } else if (fiberState === FIBER_DISPOSED) {
          state = 'disposed'
        } else {
          state = (toolCounts.get(key) ?? 0) > 0 ? 'connected' : 'connecting'
        }
      } else if (invalid.has(key)) {
        state = 'invalid'
      }
      servers.push({
        serverName: key,
        transport: entry && typeof entry === 'object' ? entry.transport : undefined,
        state,
        toolCount: toolCounts.get(key) ?? 0,
        error: error ?? null,
        logs: serverLogs.get(key) ?? [],
        tools: grouped.get(key) ?? [],
        entry,
        ...(entry && typeof entry === 'object' && entry.transport === 'streamable-http'
          ? { auth: authStateFor(key, record) }
          : {}),
      })
    }
    return { servers }
  }

  /**
   * Per-server auth state for streamable-http entries: whether the page
   * should prompt for a token. A live connection wins (clears the flag even
   * if old 401 diagnostics still sit in the ring); otherwise the watchdog
   * flag, the fiber error, or the captured diagnostics decide.
   */
  const authStateFor = (serverName, record) => {
    // The watchdog flag wins: a tool call can be rejected as unauthorized
    // even while the connection itself is healthy. Submitting credentials
    // (or a successful auto re-login) clears it.
    const flagged = authRequired.get(serverName)
    const has = credentials.get(serverName)?.kind
    if (flagged !== undefined) return { required: true, reason: flagged, ...(has !== undefined ? { has } : {}) }
    if (record !== undefined && (toolCounts.get(serverName) ?? 0) > 0) {
      return { required: false, ...(has !== undefined ? { has } : {}) }
    }
    const texts = []
    if (record?.fiber?.state === FIBER_FAILED) texts.push(String(record.fiber._error ?? ''))
    texts.push(...(serverLogs.get(serverName) ?? []))
    if (AUTH_NEEDED_PATTERN.test(texts.join(' '))) {
      return { required: true, reason: 'connection or tool call rejected as unauthorized', ...(has !== undefined ? { has } : {}) }
    }
    return { required: false, ...(has !== undefined ? { has } : {}) }
  }

  const reconcile = async () => {
    const next = []
    const seen = new Set()
    for (const entry of readSettings()) {
      const verdict = validateServerEntry(entry)
      const name = entry && typeof entry === 'object' ? entry.serverName : undefined
      if (!verdict.ok) {
        invalid.set(typeof name === 'string' ? name : String(name), verdict.error)
        log.warn('server entry rejected: %s (%s)', name, verdict.error)
        continue
      }
      invalid.delete(entry.serverName)
      if (seen.has(entry.serverName)) {
        log.warn('duplicate serverName "%s" skipped', entry.serverName)
        continue
      }
      seen.add(entry.serverName)
      next.push(entry)
    }
    // Drop diagnostics for names that no longer exist at all.
    const nextNames = new Set(
      readSettings()
        .map((e) => (e && typeof e === 'object' && typeof e.serverName === 'string' ? e.serverName : undefined))
        .filter((n) => n !== undefined),
    )
    for (const key of [...serverLogs.keys()]) {
      if (!nextNames.has(key)) serverLogs.delete(key)
    }

    // Dispose servers that disappeared or changed config; changed ones remount below.
    const disposals = new Map()
    for (const [serverName, record] of [...mounted]) {
      const target = next.find((e) => e.serverName === serverName)
      const same = target !== undefined && JSON.stringify(target) === JSON.stringify(record.entry)
      if (same) continue
      mounted.delete(serverName)
      try {
        disposals.set(serverName, Promise.resolve(record.fiber.dispose()).catch((error) => {
          log.warn('dispose of server "%s" failed: %s', serverName, error)
        }))
        log.info('unmounted MCP server "%s"', serverName)
      } catch (error) {
        log.warn('dispose of server "%s" failed: %s', serverName, error)
      }
    }
    for (const entry of next) {
      if (mounted.has(entry.serverName)) continue
      // Await the old fiber's teardown before reusing its serverName (the
      // mcp-client namespace reservation is released only on full disposal).
      if (disposals.has(entry.serverName)) {
        await disposals.get(entry.serverName)
        disposals.delete(entry.serverName)
      }
      try {
        // Settings hands out deeply frozen snapshots and the mcp-client
        // schema (schemastery) writes defaults into the config object in
        // place — validating a frozen object throws. structuredClone
        // produces an unfrozen plain copy in every environment.
        const fiber = ctx.plugin(McpClient, structuredClone(mergedEntry(entry)))
        mounted.set(entry.serverName, { fiber, entry })
        log.info('mounted MCP server "%s"', entry.serverName)
      } catch (error) {
        invalid.set(entry.serverName, String(error))
        log.error('mounting MCP server "%s" failed: %s', entry.serverName, error)
      }
    }
    recountTools()
  }

  installSettingsSection(ctx, SERVERS_SETTINGS_NS, ServersSettingsSchema, { servers: config.servers ?? [] }, {
    setSource: (source) => {
      readSettings = () => source().servers ?? []
    },
    onChange: () => reconcile(),
  })

  ctx.on('tools/change', () => recountTools())

  // --- session-loss watchdog --------------------------------------------
  // dsh-mcp-client's supervisor reconnects only when the transport CLOSES.
  // A stale streamable-http session (server restarted, session expired)
  // fails every call with "Error POSTing to endpoint: session not found"
  // while the connection stays nominally open — the supervisor never fires
  // and the tools keep failing forever. Watch the session-event feed for
  // that failure signature and remount the fiber so a fresh session is
  // established and the tools re-register.
  const SESSION_LOST_PATTERN = /session (not found|expired|invalid|terminated)|invalid session/i
  const REMOUNT_COOLDOWN_MS = 2_000
  const remountedAt = new Map()
  const callNames = new Map()

  const remounting = new Set()
  const remount = async (serverName, why) => {
    if (remounting.has(serverName)) return
    const record = mounted.get(serverName)
    if (record === undefined) return
    remounting.add(serverName)
    log.warn('server "%s": %s; remounting the MCP client', serverName, why)
    noteServerLog(serverName, `${why}; remounting`)
    mounted.delete(serverName)
    // Await full teardown: the mcp-client namespace reservation for
    // serverName is only released when the old fiber finishes disposing —
    // mounting before that fails with "serverName already in use".
    try {
      await record.fiber.dispose()
    } catch (error) {
      log.warn('dispose of server "%s" during remount failed: %s', serverName, error)
    }
    try {
      // Same clone rule as reconcile(): settings snapshots are deep-frozen
      // and schemastery writes defaults in place. mergedEntry() re-applies a
      // stored page-supplied token, if any.
      const fiber = ctx.plugin(McpClient, structuredClone(mergedEntry(record.entry)))
      mounted.set(serverName, { fiber, entry: record.entry })
    } catch (error) {
      invalid.set(serverName, String(error))
      log.error('remounting MCP server "%s" failed: %s', serverName, error)
    }
    remounting.delete(serverName)
    recountTools()
  }

  /**
   * Wait (bounded) until the server's tools are registered again, so the
   * rebuild notification does not invite a retry into a half-connected
   * client. Best effort: fires anyway after the timeout.
   */
  const waitUntilToolsReady = async (serverName, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      recountTools()
      if ((toolCounts.get(serverName) ?? 0) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Rebuild after a session loss and notify once the tools are live again.
   * The remount itself respects the per-server cooldown (a rebuild may
   * already be fresh or in flight), but the notification ALWAYS fires after
   * the tools are ready — otherwise a rapid second loss would swallow the
   * model steering.
   */
  const rebuildAfterSessionLoss = (serverName, why, sessionId) => {
    const last = remountedAt.get(serverName) ?? 0
    const due = Date.now() - last >= REMOUNT_COOLDOWN_MS
    if (due) remountedAt.set(serverName, Date.now())
    void (due ? remount(serverName, why) : Promise.resolve())
      .then(() => waitUntilToolsReady(serverName))
      .then(() => {
        try { api.onSessionRebuilt?.(sessionId, serverName) } catch (error) { log.warn(error) }
      })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      callNames.set(`${session.id}:${event.data.callId}`, event.data.name)
      if (callNames.size > 1_000) callNames.clear()
      return
    }
    if (event.type !== 'tool/result') return
    const blocks = Array.isArray(event.data.message?.content) ? event.data.message.content : []
    const block = blocks.find((b) => b?.type === 'tool-result')
    if (block === undefined) return
    const key = `${session.id}:${block.toolCallId}`
    const name = callNames.get(key)
    callNames.delete(key)
    if (name === undefined || !name.startsWith('mcp__')) return
    const prefix = MCP_TOOL_PREFIX.exec(name)
    if (prefix === null) return
    const text = (block.content ?? [])
      .map((b) => (b?.type === 'text' ? b.text : ''))
      .join(' ')
    const failure = `${text} ${event.data.error?.name ?? ''} ${event.data.error?.code ?? ''}`
    if (SESSION_LOST_PATTERN.test(failure)) {
      rebuildAfterSessionLoss(prefix[1], `MCP session lost (${text.slice(0, 120) || 'session error'})`, session.id)
      return
    }
    if (PER_CALL_CRED_PATTERN.test(failure)) {
      // The server explicitly asked the CALLER for per-request platform
      // credentials — our credential domain. Password credentials refresh
      // quietly first; otherwise prompt.
      const cred = credentials.get(prefix[1])
      if (cred?.kind === 'password') {
        void tryRelogin(prefix[1]).then((refreshed) => {
          if (refreshed) return
          flagAuthNeeded(prefix[1], `server asked the caller for platform credentials (${text.slice(0, 120)}) and the stored login no longer works`)
        })
        return
      }
      probeVerified.delete(prefix[1])
      flagAuthNeeded(prefix[1], `server asked the caller for platform credentials: ${text.slice(0, 160)}`)
      return
    }
    if (AUTH_NEEDED_PATTERN.test(failure)) {
      // If WE own a password credential, refresh it quietly and only prompt
      // when the re-login itself fails.
      const cred = credentials.get(prefix[1])
      if (cred?.kind === 'password') {
        void tryRelogin(prefix[1]).then((refreshed) => {
          if (refreshed) return
          flagAuthNeeded(prefix[1], `tool call rejected as unauthorized (${text.slice(0, 120) || '401/403'}); auto re-login failed`)
        })
        return
      }
      // The endpoint already accepted the connection (tools are registered),
      // so this 401/403 originates BEHIND the MCP server — e.g. the server's
      // own platform credentials (robot-platform-mcp's -username/-password)
      // or per-API permissions of the target system. That is the server's
      // credential domain, not ours: surface it as a normal tool error and
      // NEVER prompt. (The note must stay free of the trigger words —
      // authStateFor scans these logs for connection-level rejections.)
      const note = 'target system rejected the call as unauthenticated; the MCP server carries its own credentials'
      const existingLogs = serverLogs.get(prefix[1]) ?? []
      if (existingLogs[existingLogs.length - 1] !== note) noteServerLog(prefix[1], note)
      log.info('server "%s": auth rejection from the system behind the MCP server; leaving it to the server\'s own credentials', prefix[1])
    }
  })

  /** Mark a server as needing credentials and notify the page sink. */
  const flagAuthNeeded = (serverName, reason) => {
    if (authRequired.get(serverName) === reason) return
    authRequired.set(serverName, reason)
    noteServerLog(serverName, reason)
    log.warn('server "%s": %s; supply credentials from the chat page', serverName, reason)
    try { api.onCredentialNeeded?.(serverName, reason) } catch (error) { log.warn(error) }
  }

  // Initial mount (settings attach only rewires the source, it does not fire onChange).
  reconcile()

  /** Replace the whole effective list through the settings user layer. */
  const replaceServers = async (list) => {
    const settings = ctx.get('settings')
    if (settings === undefined) {
      throw new Error('settings service is not mounted; server list edits require a settings provider')
    }
    if (!settings.writable) {
      throw new Error('settings provider is read-only; server list edits are unavailable')
    }
    await settings.replace(SERVERS_SETTINGS_NS, { servers: list })
  }

  /**
   * Names of desired streamable-http servers currently flagged as needing
   * credentials. The bridge gates POST /messages on this so the "login
   * dialog at input time" happens BEFORE a turn runs into certain 401s;
   * once credentials land (or a silent re-login succeeds) the list empties
   * and the held message can be re-sent.
   */
  const authBlocked = () => {
    const names = []
    for (const entry of readSettings()) {
      if (entry?.transport !== 'streamable-http' || typeof entry?.serverName !== 'string') continue
      if (authStateFor(entry.serverName, mounted.get(entry.serverName)).required) names.push(entry.serverName)
    }
    return names
  }

  /**
   * Silent credential probe: execute the entry's configured read-only
   * probe tool ONCE per credential generation and read the outcome. The
   * MCP connection itself never touches the platform (initialize and
   * tools/list are server-local), so this is the only way to learn BEFORE
   * the first message whether platform credentials work. Returns
   * { blocked: true } when the server asked the caller for credentials.
   */
  const probeCredentials = async (entry, agent) => {
    const serverName = entry.serverName
    const probeTool = String(entry.auth?.probeTool ?? '')
    const publicName = probeTool.startsWith('mcp__') ? probeTool : `mcp__${serverName}__${probeTool}`
    await waitUntilToolsReady(serverName)
    const tools = ctx.get('tools')
    if (tools === undefined) return { blocked: false }
    let failureText = ''
    try {
      const result = await tools.execute({
        callId: `smart-chat-probe-${serverName}`,
        name: publicName,
        arguments: {},
        ...(agent !== undefined ? { agent } : {}),
        signal: AbortSignal.timeout(15_000),
      })
      if (result?.isError === true) {
        failureText = [
          result.error?.message,
          ...(result.content ?? []).map((b) => (b?.type === 'text' ? b.text : '')),
        ].filter(Boolean).join(' ')
      }
    } catch (error) {
      failureText = error instanceof Error ? error.message : String(error)
    }
    if (failureText !== '' && (PER_CALL_CRED_PATTERN.test(failureText) || AUTH_NEEDED_PATTERN.test(failureText))) {
      flagAuthNeeded(serverName, `silent probe rejected: ${failureText.slice(0, 160)}`)
      return { blocked: true }
    }
    if (failureText !== '') {
      // A non-auth probe failure (bad tool name, upstream 500, ...) must not
      // block the conversation; note it and consider the probe done.
      noteServerLog(serverName, `probe "${probeTool}" errored (non-auth): ${failureText.slice(0, 120)}`)
    }
    probeVerified.set(serverName, true)
    return { blocked: false }
  }

  /**
   * The input-time credential gate: already-flagged servers stay blocked;
   * otherwise every streamable-http entry with auth.probeTool that has not
   * been verified yet is probed silently (once per credential generation).
   * Returns the server names that still block the message.
   */
  const probeGate = async (agent) => {
    const flagged = authBlocked()
    if (flagged.length > 0) return flagged
    for (const entry of readSettings()) {
      if (entry?.transport !== 'streamable-http') continue
      if (typeof entry?.serverName !== 'string') continue
      if (typeof entry.auth?.probeTool !== 'string' || entry.auth.probeTool === '') continue
      if (probeVerified.has(entry.serverName)) continue
      const verdict = await probeCredentials(entry, agent)
      if (verdict.blocked) return [entry.serverName]
    }
    return []
  }

  const api = {
    statusPayload,
    statusJson: () => JSON.stringify(statusPayload()),
    replaceServers,
    validateList: validateServerList,
    reconcile,
    setCredentials,
    authBlocked,
    probeGate,
    /** Optional sink the bridge wires to broadcast credential_required. */
    onCredentialNeeded: null,
    /**
     * Optional sink the bridge wires: (sessionId, serverName) after a
     * session-loss remount completed and the tools are live again — lets the
     * bridge steer the model into retrying the call that hit the dead
     * session, so a mid-conversation MCP server restart self-heals.
     */
    onSessionRebuilt: null,
  }
  return api
}
