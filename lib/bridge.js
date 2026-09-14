// smart-chat — HTTP bridge: plain REST + SSE over the dsh engine.
//
// Routes (under config.bridge.prefix, all JSON unless noted):
//   GET  /                     single-file chat page (token-exempt)
//   GET  /health               { ok, version }            (token-exempt)
//   POST /sessions             -> 201 { sessionId }       ctx.agents.create()
//   POST /messages             { sessionId, text } -> 202 agent.followup()
//   POST /sessions/{id}/cancel -> 202                     agent.cancel({kind:'user'})
//   GET  /events?sessionId=    SSE stream (see page.js consumer)
//   POST /approvals/{id}       { decision: allow|deny }   approval answerer settle
//   GET  /servers.json         MCP server status (from servers.js)
//   POST /servers              { servers: [...] }         settings user-layer write
//
// Event sources (see docs/bridge-api-notes.md for the source map):
//   - ctx.on('session/event')  -> assistant_delta / tool_call / tool_result / turn_done / error
//   - ctx.on('approval/request', { prepend: true }) — claims only requests whose
//     agent belongs to this bridge; everything else flows to the next answerer
//     (the dsh web GUI's apiproxy), so both UIs coexist.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pageHtml } from './page.js'

const MAX_BODY_BYTES = 1_000_000
const HEARTBEAT_MS = 15_000
const MAX_PREVIEW = 200
const MCP_TOOL_PREFIX = 'mcp__'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
// The token appears only as the string-literal value inside index.html; it
// must NOT collide with the property name window.__SMART_CHAT_PREFIX__ (a
// naive split/join over that name would corrupt the script).
const PREFIX_PLACEHOLDER = '@@SMART_CHAT_PREFIX@@'
const ASSET_MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Load the built React shell (web/ → lib/public). Returns null when the
 * bundle is absent (source checkout without a build); the caller falls back
 * to the legacy single-file page. The HTML carries a placeholder that is
 * replaced with the live bridge prefix so one build serves any prefix.
 */
const loadWebShell = async (prefix) => {
  let html
  try {
    html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  } catch {
    return null
  }
  if (!html.includes(PREFIX_PLACEHOLDER)) return null
  return html.split(PREFIX_PLACEHOLDER).join(prefix)
}

const serveAsset = async (res, sub, method = 'GET') => {
  const rel = sub.replace(/^\/+/, '')
  const file = path.normalize(path.join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' })
  try {
    const body = await readFile(file)
    const ext = path.extname(file).toLowerCase()
    const mime = ASSET_MIME[ext] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': sub.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    return res.end(method === 'HEAD' ? undefined : body)
  } catch {
    return sendJson(res, 404, { error: 'not found' })
  }
}

export const BridgeConfig = Schema.object({
  enabled: Schema.boolean().default(true).description(
    'Register the HTTP bridge routes (chat page, REST, SSE). Requires a webServer service; headless profiles without one skip registration entirely.',
  ),
  prefix: Schema.string().default('/smart-chat').description(
    'HTTP path prefix the bridge owns (page, REST and SSE all live under it). Must not be "/plugins" (owned by dsh client modules).',
  ),
  token: Schema.string().default('').description(
    'Shared secret. When non-empty every route except GET / and GET /health requires Authorization: Bearer <token> (SSE also accepts ?token=).',
  ),
  autoApproveTools: Schema.boolean().default(false).description(
    'Automatically allow tool calls whose name starts with mcp__ instead of asking. Only enable for local, fully trusted MCP servers.',
  ),
  approvalTimeoutMs: Schema.number().default(120000).description(
    'Pending approvals are denied (fail-closed) after this many milliseconds and an error frame is streamed.',
  ),
  cancelOnDisconnect: Schema.boolean().default(false).description(
    'Abort the running turn when the last SSE subscriber for a session disconnects. Refreshing the page would also cancel, hence off by default.',
  ),
  cwd: Schema.string().default(path.join(os.tmpdir(), 'smart-chat')).description(
    'Working directory for chat sessions (created if missing; must be absolute or resolved against the process cwd).',
  ),
})

const readBody = (req, limit = MAX_BODY_BYTES) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) {
      reject(new Error('request body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const parseJsonBody = async (req) => {
  const raw = await readBody(req)
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw new Error(`invalid JSON body: ${error.message}`)
  }
}

const sendJson = (res, code, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

const formatFrame = (name, data, id) => {
  let frame = ''
  if (id !== undefined) frame += `id: ${id}\n`
  frame += `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return frame
}

/**
 * Install the bridge. Lives inside ctx.inject(['webServer']) so headless
 * profiles (no webServer) never register anything.
 */
export function installBridge(ctx, config, manager, version) {
  const log = ctx.logger('smart-chat/bridge')
  const bridge = config.bridge
  if (!bridge?.enabled) return

  ctx.inject(['webServer'], (sctx) => {
    // sessionId -> { agent, handle }
    const ourSessions = new Map()
    // sessionId -> Set<ServerResponse> (SSE subscribers)
    const subscribers = new Map()
    // sessionId -> Map<callId, { name, args, time }> — open tool calls of the
    // current turn; feeds approval summaries and tool durations.
    const openCalls = new Map()
    // approvalId -> pending entry
    const pendingApprovals = new Map()
    // approvalId -> settled outcome (for 409 on repeat decisions)
    const decidedApprovals = new Map()

    const broadcast = (sessionId, name, data, id) => {
      const set = subscribers.get(sessionId)
      if (set === undefined) return
      const frame = formatFrame(name, data, id)
      for (const res of set) {
        try { res.write(frame) } catch { /* subscriber went away */ }
      }
    }

    const trackOpenCall = (sessionId, data) => {
      let table = openCalls.get(sessionId)
      if (table === undefined) openCalls.set(sessionId, table = new Map())
      table.set(data.callId, { name: data.name, args: data.arguments, time: Date.now() })
    }

    /** Map one durable session event to SSE frames (minimal leaf data only). */
    const eventToFrames = (sessionId, event) => {
      switch (event.type) {
        case 'assistant/chunk': {
          const chunk = event.data.chunk
          if (chunk?.type === 'text-delta') {
            return [{ name: 'assistant_delta', id: event.seq, data: { seq: event.seq, delta: chunk.text } }]
          }
          if (chunk?.type === 'reasoning-delta') {
            return [{ name: 'assistant_delta', id: event.seq, data: { seq: event.seq, reasoning: chunk.text } }]
          }
          return []
        }
        case 'tool/call': {
          trackOpenCall(sessionId, event.data)
          return [{
            name: 'tool_call',
            id: event.seq,
            data: {
              seq: event.seq,
              callId: event.data.callId,
              name: event.data.name,
              argsPreview: String(event.data.arguments ?? '').slice(0, MAX_PREVIEW),
            },
          }]
        }
        case 'tool/result': {
          const data = event.data
          const blocks = Array.isArray(data.message?.content) ? data.message.content : []
          const block = blocks.find((b) => b?.type === 'tool-result')
          const callId = block?.toolCallId
          const text = (block?.content ?? [])
            .map((b) => (b?.type === 'text' ? b.text : ''))
            .join('')
            .trim()
          const open = openCalls.get(sessionId)?.get(callId)
          return [{
            name: 'tool_result',
            id: event.seq,
            data: {
              seq: event.seq,
              callId,
              isError: block?.isError === true || data.error !== undefined,
              summary: text.slice(0, MAX_PREVIEW),
              ...(open !== undefined ? { durationMs: Date.now() - open.time } : {}),
            },
          }]
        }
        case 'turn/end': {
          openCalls.delete(sessionId)
          const frames = []
          const reason = event.data.reason
          if (reason?.kind === 'error') {
            frames.push({
              name: 'error',
              id: event.seq,
              data: { message: reason.error?.message ?? 'turn failed', code: reason.error?.code },
            })
          }
          frames.push({
            name: 'turn_done',
            id: event.seq,
            data: { seq: event.seq, turn: event.data.turn, reason: reason?.kind ?? 'unknown' },
          })
          return frames
        }
        default:
          return []
      }
    }

    sctx.on('session/event', (session, event) => {
      if (!ourSessions.has(session.id)) return
      for (const frame of eventToFrames(session.id, event)) {
        broadcast(session.id, frame.name, frame.data, frame.id)
      }
      // Tool-result images arrive as attachment refs; reading the bytes is
      // async, so they follow the sync tool_result frame as tool_images.
      if (event.type === 'tool/result') void deliverToolImages(session.id, event)
    })

    // --- Tool-result image delivery (base64 data URLs) ---------------------
    // dsh-mcp-client stores MCP image results in the dsh attachment service
    // (facing the model). To show them on the page we read the bytes back
    // and stream them as data URLs in a follow-up frame keyed by callId.
    const MAX_TOOL_IMAGES = 8
    const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024
    const deliverToolImages = async (sessionId, event) => {
      const blocks = Array.isArray(event.data.message?.content) ? event.data.message.content : []
      const block = blocks.find((b) => b?.type === 'tool-result')
      if (block === undefined) return
      const imageBlocks = (block.content ?? [])
        .filter((b) => b?.type === 'image' && b?.attachment && typeof b.attachment.attachmentId === 'string')
        .slice(0, MAX_TOOL_IMAGES)
      if (imageBlocks.length === 0) return
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return
      const images = []
      for (const imageBlock of imageBlocks) {
        const ref = imageBlock.attachment
        if (!Number.isFinite(ref.bytes) || ref.bytes > MAX_TOOL_IMAGE_BYTES) continue
        try {
          const stored = await attachments.readImage(ref)
          images.push(`data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
        } catch (error) {
          log.warn('reading a tool result image failed: %s', error)
        }
      }
      if (images.length === 0) return
      broadcast(sessionId, 'tool_images', { seq: event.seq, callId: block.toolCallId, images }, event.seq)
    }

    // --- Approval answerer -------------------------------------------------
    // prepend: claim OUR sessions before any other answerer (e.g. the dsh web
    // GUI's apiproxy) sees the request; foreign requests flow to next().
    sctx.on('approval/request', (req, next) => {
      const sessionId = req.agent?.id
      if (!ourSessions.has(sessionId)) return next()
      if (req.signal?.aborted === true) return Promise.resolve('cancelled')
      if (bridge.autoApproveTools && typeof req.toolName === 'string' && req.toolName.startsWith(MCP_TOOL_PREFIX)) {
        return Promise.resolve('allowed-once')
      }
      const open = req.callId !== undefined ? openCalls.get(sessionId)?.get(req.callId) : undefined
      const summary = [
        req.toolName,
        open?.args !== undefined ? String(open.args).slice(0, MAX_PREVIEW) : undefined,
      ].filter((part) => part !== undefined && part !== '').join(' ')

      const id = `approval-${randomUUID()}`
      return new Promise((resolve) => {
        let settled = false
        const entry = {
          sessionId,
          toolName: req.toolName,
          summary,
          settle(outcome, cause) {
            if (settled) return
            settled = true
            clearTimeout(this.timer)
            pendingApprovals.delete(id)
            decidedApprovals.set(id, outcome)
            broadcast(sessionId, 'approval_resolved', { approvalId: id, outcome })
            if (cause === 'timeout') {
              broadcast(sessionId, 'error', {
                message: `approval for ${req.toolName} timed out after ${bridge.approvalTimeoutMs}ms and was denied (fail-closed)`,
                code: 'approval-timeout',
              })
            }
            resolve(outcome)
          },
        }
        entry.timer = setTimeout(() => entry.settle('rejected', 'timeout'), bridge.approvalTimeoutMs)
        pendingApprovals.set(id, entry)
        if (req.signal !== undefined) {
          req.signal.addEventListener('abort', () => entry.settle('cancelled'), { once: true })
        }
        broadcast(sessionId, 'approval_required', { approvalId: id, toolName: req.toolName, summary })
      })
    }, true)

    // --- Session helpers ---------------------------------------------------
    // The page's whole purpose is interacting with the user's MCP servers, so
    // every chat agent is composed MCP-focused: a persona that steers the
    // model toward the mcp__ tools, a tool-visibility restriction limited to
    // the currently mounted mcp__ tools (re-applied when servers change), and
    // an execution guard as the backstop so a stale allow-list can never let
    // a non-MCP tool run in this chat.
    const PERSONA_SECTION = 'smart-chat:persona'
    const personaText = [
      'You are the assistant behind the smart-chat web page — a minimal chat whose entire purpose is interacting with the user\'s MCP servers.',
      'Answer by calling the available mcp__<server>__<tool> tools whenever they can serve the request; report their results clearly and concisely.',
      'This is not a coding environment: local file, shell, or other non-MCP tools are not part of this chat.',
      'When a tool call needs approval, the user decides on the page; if it is denied or times out, explain that and suggest an alternative instead of retrying blindly.',
    ].join(' ')

    const mcpToolNames = () => {
      const tools = ctx.get('tools')
      if (tools === undefined) return []
      return tools.schemas(undefined).map((s) => s.name).filter((n) => n.startsWith(MCP_TOOL_PREFIX))
    }

    const applyRestriction = (entry) => {
      if (entry.agentCtx === null || entry.restrictionBusy) return
      // Re-entrancy guard: tools.restrict()/dispose() emit 'tools/change'
      // SYNCHRONOUSLY (ScopedLayers.effect notifies inside the call), which
      // re-enters this function through the listener below — before
      // entry.restriction has been assigned. Without the guard that recurses
      // until the stack overflows, leaking restriction entries per cycle and
      // freezing the host for seconds on every session create / server change.
      entry.restrictionBusy = true
      try {
        const names = mcpToolNames()
        const key = names.join('\u0000')
        if (entry.restriction !== undefined) {
          if (entry.restriction.key === key) return
          try { entry.restriction.dispose() } catch { /* already lifted */ }
          entry.restriction = undefined
        }
        if (names.length === 0) return
        try {
          // ctx.get() returns an instance traced through the calling context,
          // so the restriction lands in the agent's scope (a bare property
          // access would need an inject declaration the agent ctx lacks).
          const tools = entry.agentCtx.get('tools')
          if (tools === undefined) return
          const dispose = tools.restrict({ allow: names })
          entry.restriction = { key, dispose }
        } catch (error) {
          log.warn('tool restriction failed: %s', error)
        }
      } finally {
        entry.restrictionBusy = false
      }
    }

    const composeAgentSetup = () => {
      return (agentCtx) => {
        const prompt = agentCtx.get('systemPrompt')
        if (prompt !== undefined) {
          try {
            prompt.section({ name: PERSONA_SECTION, order: 1, text: personaText })
          } catch (error) {
            log.warn('persona section failed: %s', error)
          }
        }
        const tools = agentCtx.get('tools')
        if (tools !== undefined) {
          try {
            tools.guard((execution) => (execution?.name?.startsWith(MCP_TOOL_PREFIX) ? undefined : 'smart-chat only exposes MCP tools in this chat'))
          } catch (error) {
            log.warn('tool guard failed: %s', error)
          }
        }
      }
    }

    sctx.on('tools/change', () => {
      for (const entry of ourSessions.values()) applyRestriction(entry)
    })

    // An MCP server answered 401/403: tell every connected page so it can
    // prompt for the server token (POST /servers/{name}/token completes it).
    if (manager !== null && manager !== undefined) {
      manager.onCredentialNeeded = (serverName, reason) => {
        for (const sessionId of ourSessions.keys()) {
          broadcast(sessionId, 'credential_required', { serverName, reason })
        }
      }
      // A session-loss remount completed and the tools are live again: steer
      // the model into retrying the call that hit the dead session, so a
      // mid-conversation MCP server restart heals itself instead of ending
      // the turn with a bare "session not found" error.
      manager.onSessionRebuilt = (sessionId, serverName) => {
        const entry = ourSessions.get(sessionId)
        if (entry === undefined) return
        broadcast(sessionId, 'error', {
          message: `MCP server "${serverName}" restarted; its session was rebuilt automatically — the model will retry the failed call.`,
          code: 'session-rebuilt',
        })
        if (typeof entry.agent.inject !== 'function') return
        try {
          entry.agent.inject(createUserMessage({
            content: [{
              type: 'text',
              text: `Notice: the MCP server "${serverName}" restarted just now and its session has been rebuilt automatically. The tool call that failed with "session not found" was rejected before execution — the server never ran it. Retry that call if its result is still needed, using the freshly registered tools.`,
            }],
            source: { kind: 'plugin', plugin: 'smart-chat' },
          }))
        } catch (error) {
          log.warn('session-rebuilt steering failed: %s', error)
        }
      }
    }

    let cwdReady = null
    const ensureCwd = () => (cwdReady ??= (async () => {
      let dir = bridge.cwd && bridge.cwd !== '' ? bridge.cwd : path.join(os.tmpdir(), 'smart-chat')
      if (!path.isAbsolute(dir)) dir = path.resolve(dir)
      await mkdir(dir, { recursive: true })
      return dir
    })())

    const agentOptions = () => {
      try {
        const selection = ctx.get('agentDefaultModel')?.currentSelection()
        if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
      } catch { /* keep defaults */ }
      return {}
    }

    // --- SSE endpoint ------------------------------------------------------
    const handleEvents = (req, res, url) => {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const entry = ourSessions.get(sessionId)

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')

      if (entry === undefined) {
        // Friendly to EventSource: stream an error frame instead of a 404 so
        // the page can react (create a fresh session) and reconnect.
        res.write(formatFrame('error', { message: 'session not found on the bridge; create a new session', code: 'session-not-found' }))
        res.end()
        return
      }

      let set = subscribers.get(sessionId)
      if (set === undefined) subscribers.set(sessionId, set = new Set())
      set.add(res)
      res.write(formatFrame('ready', { sessionId }))

      // Replay pending approvals so a page refresh restores open cards.
      for (const [id, pending] of pendingApprovals) {
        if (pending.sessionId === sessionId) {
          res.write(formatFrame('approval_required', {
            approvalId: id,
            toolName: pending.toolName,
            summary: pending.summary,
          }))
        }
      }

      // Replay missed events when EventSource reconnects with Last-Event-ID.
      const lastId = Number(req.headers['last-event-id'])
      if (Number.isFinite(lastId)) {
        for (const event of entry.agent.session.events) {
          if (event.seq <= lastId) continue
          for (const frame of eventToFrames(sessionId, event)) {
            res.write(formatFrame(frame.name, frame.data, frame.id))
          }
          // Tool-result images are produced asynchronously; replay triggers
          // them too so a reconnect does not lose them.
          if (event.type === 'tool/result') void deliverToolImages(sessionId, event)
        }
      }

      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* gone */ }
      }, HEARTBEAT_MS)

      req.on('close', () => {
        clearInterval(heartbeat)
        set.delete(res)
        if (set.size === 0) {
          subscribers.delete(sessionId)
          if (bridge.cancelOnDisconnect && entry.agent.status === 'running') {
            try { entry.agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch (error) { log.warn(error) }
          }
        }
      })
    }

    // --- Route dispatch ----------------------------------------------------
    const prefix = bridge.prefix
    // undefined = not yet probed; null = no built shell (legacy page fallback)
    let webShell = undefined
    const handle = async (req, res) => {
      let url
      try {
        url = new URL(req.url, 'http://localhost')
      } catch {
        return sendJson(res, 400, { error: 'bad request path' })
      }
      if (prefix !== '' && !url.pathname.startsWith(prefix)) {
        return sendJson(res, 404, { error: 'not found' })
      }
      let sub = url.pathname.slice(prefix.length)
      if (sub === '') sub = '/'

      const method = req.method ?? 'GET'
      const pageRoute = sub === '/'
      const healthRoute = sub === '/health'

      // Token gate: the page shell and health stay reachable so the page can
      // prompt for the token in the first place.
      if (!(pageRoute || healthRoute) && method !== 'OPTIONS') {
        if (bridge.token && bridge.token !== '') {
          const header = req.headers.authorization ?? ''
          const queryToken = url.searchParams.get('token')
          const authorized = header === `Bearer ${bridge.token}` || queryToken === bridge.token
          if (!authorized) return sendJson(res, 401, { error: 'unauthorized' })
        }
      }

      try {
        if (healthRoute) {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(method === 'HEAD' ? undefined : JSON.stringify({ ok: true, version }))
        }
        if (pageRoute) {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          const shell = webShell === undefined ? null : webShell
          if (shell !== null) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            return res.end(method === 'HEAD' ? undefined : shell)
          }
          const html = pageHtml(prefix)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(method === 'HEAD' ? undefined : html)
        }
        if (sub.startsWith('/assets/') || sub.startsWith('/favicon')) {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          if (webShell === undefined) return sendJson(res, 404, { error: 'not found' })
          return serveAsset(res, sub, method)
        }
        if (sub === '/events') {
          if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
          return handleEvents(req, res, url)
        }
        if (sub === '/sessions') {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          const cwd = await ensureCwd()
          const options = agentOptions()
          const created = await ctx.agents.create({
            sessionId: `session-${randomUUID()}`,
            ...(Object.keys(options).length > 0 ? { agentOptions: options } : {}),
            meta: { cwd },
            setup: composeAgentSetup(),
          })
          const entry = {
            agent: created.agent,
            handle: created,
            agentCtx: created.agent?.ctx ?? null,
            restriction: undefined,
            restrictionBusy: false,
          }
          ourSessions.set(created.agent.id, entry)
          applyRestriction(entry)
          return sendJson(res, 201, { sessionId: created.agent.id })
        }
        if (sub === '/messages') {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          let body
          try {
            body = await parseJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: error.message })
          }
          const sessionId = body.sessionId
          const text = body.text
          if (typeof sessionId !== 'string' || sessionId === '') return sendJson(res, 400, { error: 'sessionId is required' })
          if (typeof text !== 'string' || text.trim() === '') return sendJson(res, 400, { error: 'text is required' })
          if (text.length > 100_000) return sendJson(res, 400, { error: 'text too long' })
          const entry = ourSessions.get(sessionId)
          if (entry === undefined) return sendJson(res, 404, { error: 'unknown session' })
          // Input-time credential gate: authentication stays INVISIBLE
          // while credentials are known; only when the user sends a message
          // and a mounted server still lacks credentials does the bridge
          // hold the message (the page opens the login dialog and re-sends
          // this exact text once credentials land). Mid-turn first-ever
          // 401/403s are still handled by the watchdog's SSE event.
          const blocked = typeof manager.authBlocked === 'function' ? manager.authBlocked() : []
          if (blocked.length > 0) {
            return sendJson(res, 409, {
              error: `login required for: ${blocked.join(', ')}`,
              code: 'credentials-required',
              servers: blocked,
            })
          }
          const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
          entry.agent.followup(message)
          return sendJson(res, 202, { accepted: true })
        }
        if (sub === '/servers.json') {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          const body = manager.statusJson()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(method === 'HEAD' ? undefined : body)
        }
        if (sub === '/servers') {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          let body
          try {
            body = await parseJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: error.message })
          }
          const verdict = manager.validateList ? manager.validateList(body.servers) : { ok: false, error: 'unsupported' }
          if (!verdict.ok) return sendJson(res, 400, { error: verdict.error })
          const settings = ctx.get('settings')
          if (settings === undefined || !settings.writable) {
            return sendJson(res, 503, { error: 'server list editing is unavailable: no writable settings provider' })
          }
          await manager.replaceServers(body.servers)
          return sendJson(res, 200, { ok: true, count: body.servers.length })
        }
        const credMatch = /^\/servers\/([^/]+)\/(token|credentials)$/.exec(sub)
        if (credMatch !== null) {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          let body
          try {
            body = await parseJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: error.message })
          }
          if (manager.setCredentials === undefined) return sendJson(res, 501, { error: 'credential flow unavailable' })
          // Accepts { token } (bearer passthrough) OR { username, password,
          // loginUrl? } (bridge-side login, robot-platform style). An empty
          // body clears the stored credentials.
          const verdict = await manager.setCredentials(decodeURIComponent(credMatch[1]), body)
          if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.error })
          return sendJson(res, 200, { ok: true })
        }
        const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(sub)
        if (cancelMatch !== null) {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          const entry = ourSessions.get(decodeURIComponent(cancelMatch[1]))
          if (entry === undefined) return sendJson(res, 404, { error: 'unknown session' })
          entry.agent.cancel({ kind: 'user' }, { keepInbox: true })
          return sendJson(res, 202, { accepted: true })
        }
        const approvalMatch = /^\/approvals\/([^/]+)$/.exec(sub)
        if (approvalMatch !== null) {
          if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          let body
          try {
            body = await parseJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: error.message })
          }
          const decision = body.decision
          if (decision !== 'allow' && decision !== 'deny') {
            return sendJson(res, 400, { error: 'decision must be "allow" or "deny"' })
          }
          const id = decodeURIComponent(approvalMatch[1])
          const pending = pendingApprovals.get(id)
          if (pending === undefined) {
            if (decidedApprovals.has(id)) {
              return sendJson(res, 409, { error: 'approval already decided', outcome: decidedApprovals.get(id) })
            }
            return sendJson(res, 404, { error: 'unknown approval' })
          }
          pending.settle(decision === 'allow' ? 'allowed-once' : 'rejected', 'user')
          return sendJson(res, 200, { ok: true, outcome: decision })
        }
        return sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('route %s %s failed: %s', method, sub, message)
        if (!res.headersSent) return sendJson(res, 500, { error: message })
        try { res.end() } catch { /* already gone */ }
      }
    }

    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req, res) => handle(req, res),
    }), 'smart-chat: bridge routes')

    // Probe the built React shell once (async); until it resolves the page
    // route falls through to the legacy single-file page, so tests that do
    // not await it still see a working page.
    loadWebShell(prefix).then(
      (shell) => {
        webShell = shell
        if (process.env.SMART_CHAT_DEBUG) console.error('[dbg] web shell:', shell === null ? 'absent (legacy page)' : `${shell.length} bytes`)
      },
      (error) => {
        webShell = null
        if (process.env.SMART_CHAT_DEBUG) console.error('[dbg] web shell probe failed:', error)
      },
    )

    sctx.effect(() => () => {
      for (const pending of [...pendingApprovals.values()]) pending.settle('cancelled', 'teardown')
      for (const set of subscribers.values()) {
        for (const res of set) { try { res.end() } catch { /* gone */ } }
      }
      subscribers.clear()
      for (const entry of ourSessions.values()) {
        Promise.resolve(entry.handle.dispose()).catch(() => {})
      }
      ourSessions.clear()
    }, 'smart-chat: bridge teardown')
  })
}
