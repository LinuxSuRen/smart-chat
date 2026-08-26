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
      })
    }
    return { servers }
  }

  const reconcile = () => {
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
    for (const [serverName, record] of [...mounted]) {
      const target = next.find((e) => e.serverName === serverName)
      const same = target !== undefined && JSON.stringify(target) === JSON.stringify(record.entry)
      if (same) continue
      mounted.delete(serverName)
      try {
        record.fiber.dispose()
        log.info('unmounted MCP server "%s"', serverName)
      } catch (error) {
        log.warn('dispose of server "%s" failed: %s', serverName, error)
      }
    }
    for (const entry of next) {
      if (mounted.has(entry.serverName)) continue
      try {
        // Settings hands out deeply frozen snapshots and the mcp-client
        // schema (schemastery) writes defaults into the config object in
        // place — validating a frozen object throws. structuredClone
        // produces an unfrozen plain copy in every environment.
        const fiber = ctx.plugin(McpClient, structuredClone(entry))
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

  const remount = (serverName, why) => {
    const record = mounted.get(serverName)
    if (record === undefined) return
    log.warn('server "%s": %s; remounting the MCP client', serverName, why)
    noteServerLog(serverName, `${why}; remounting`)
    mounted.delete(serverName)
    try {
      record.fiber.dispose()
    } catch (error) {
      log.warn('dispose of server "%s" during remount failed: %s', serverName, error)
    }
    try {
      // Same clone rule as reconcile(): settings snapshots are deep-frozen
      // and schemastery writes defaults in place.
      const fiber = ctx.plugin(McpClient, structuredClone(record.entry))
      mounted.set(serverName, { fiber, entry: record.entry })
    } catch (error) {
      invalid.set(serverName, String(error))
      log.error('remounting MCP server "%s" failed: %s', serverName, error)
    }
    recountTools()
  }

  const scheduleRemount = (serverName, why) => {
    const last = remountedAt.get(serverName) ?? 0
    if (Date.now() - last < REMOUNT_COOLDOWN_MS) return
    remountedAt.set(serverName, Date.now())
    remount(serverName, why)
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
    if (!SESSION_LOST_PATTERN.test(failure)) return
    scheduleRemount(prefix[1], `MCP session lost (${text.slice(0, 120) || 'session error'})`)
  })

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

  return {
    statusPayload,
    statusJson: () => JSON.stringify(statusPayload()),
    replaceServers,
    validateList: validateServerList,
    reconcile,
  }
}
