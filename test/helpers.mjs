// Shared test harness: mock HTTP objects, SSE parsing, and service stubs.
import { EventEmitter } from 'node:events'
import { Service } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

export { scopeOf }

// A minimal stdio MCP server with one `echo` tool (placeholder data only).
export const ECHO_MCP = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'echo', description: 'echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (req.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'echo: ' + (req.params?.arguments?.text ?? '') }] } });
  }
});
`

export function echoEntry(serverName = 'echo') {
  return { serverName, transport: 'stdio', command: process.execPath, args: ['-e', ECHO_MCP] }
}

// A stdio MCP server whose tool description embeds its pid and whose FIRST
// tools/call fails with the exact stale streamable-http session text (later
// calls echo normally). Used to verify the session-loss watchdog remounts
// the fiber (observable via the pid changing).
export const ZOMBIE_MCP = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let calls = 0;
rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zombie', version: '1.0.0' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'echo', description: 'echo tool from pid-' + process.pid, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  } else if (req.method === 'tools/call') {
    calls += 1;
    if (calls === 1) {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'Error POSTing to endpoint: session not found' }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'echo: ' + (req.params?.arguments?.text ?? '') }] } });
    }
  }
});
`

export function zombieEntry(serverName = 'zombie') {
  return { serverName, transport: 'stdio', command: process.execPath, args: ['-e', ZOMBIE_MCP] }
}

export function mockReq({ method = 'GET', url = '/', headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

export function mockRes() {
  const res = new EventEmitter()
  res.statusCode = undefined
  res.headers = {}
  res.chunks = []
  res.ended = false
  res.writeHead = (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs ?? {}) }
  res.write = (chunk) => { res.chunks.push(Buffer.from(chunk)); return true }
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(Buffer.from(chunk))
    res.ended = true
    res.emit('finished')
  }
  Object.defineProperty(res, 'headersSent', { get() { return res.statusCode !== undefined } })
  return res
}

/** Invoke a captured route handler with a JSON body; returns status/body. */
export async function call(handler, method, url, body, headers = {}) {
  const req = mockReq({ method, url, headers })
  const res = mockRes()
  const result = handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(body))
  req.emit('end')
  await (result instanceof Promise ? result : null)
  const text = Buffer.concat(res.chunks).toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.statusCode, headers: res.headers, text, json, res, req }
}

/** Open a (mock) SSE connection; keeps res open, returns { req, res, frames }. */
export function openSse(handler, url, headers = {}) {
  const req = mockReq({ method: 'GET', url, headers })
  const res = mockRes()
  handler(req, res)
  const frames = () => {
    const text = Buffer.concat(res.chunks).toString('utf8')
    const out = []
    for (const block of text.split('\n\n')) {
      if (block === '' || block.startsWith(':')) continue
      const frame = { event: 'message', data: '' }
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data += line.slice(6)
        else if (line.startsWith('id: ')) frame.id = Number(line.slice(4))
      }
      if (frame.data !== '') { try { frame.data = JSON.parse(frame.data) } catch { /* raw */ } }
      out.push(frame)
    }
    return out
  }
  return { req, res, frames }
}

export async function waitFor(predicate, { timeout = 10_000, step = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw new Error(`timeout waiting for ${what}`)
}

export async function waitForRoute(web, path, prefix = '/smart-chat') {
  return waitFor(() => (typeof web.handlerFor(prefix) === 'function' ? web.handlerFor(prefix) : undefined), { what: `route ${path}` })
}

let failed = 0
export function check(name, cond, detail) {
  if (cond) console.log('  ok -', name)
  else { failed++; console.error('  FAIL -', name, detail !== undefined ? ':: ' + JSON.stringify(detail) : '') }
}
export function finish(suite) {
  if (failed > 0) { console.error(failed + ` ${suite} test(s) failed`); process.exit(1) }
  console.log(`all ${suite} tests passed`)
}

/** systemPrompt stub: dsh-tools injects it; sections are recorded so tests
 *  can assert agent-scoped persona registration. */
export class FakeSystemPrompt extends Service {
  static provide = 'systemPrompt'
  sections = new Map()
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools() { return () => {} }
  section(section) {
    this.sections.set(section.name, section)
    return () => { this.sections.delete(section.name) }
  }
  context() { return () => {} }
  variable() { return () => {} }
}

/** In-memory writable settings provider. */
export class MemorySettings extends SettingsProvider {
  constructor(ctx, doc = {}) { super(ctx, 'settings'); this.doc = doc }
  get writable() { return true }
  async load() { return structuredClone(this.doc) }
  async persist(ns, section) { this.doc[ns] = structuredClone(section) }
}

/** Read-only settings provider (writable=false path). */
export class ReadOnlySettings extends SettingsProvider {
  constructor(ctx, doc = {}) { super(ctx, 'settings'); this.doc = doc }
  get writable() { return false }
  async load() { return structuredClone(this.doc) }
  async persist() { throw new Error('read-only') }
}

/** Captures route registrations; the last prefix handler is exposed. */
export class FakeWebServer extends Service {
  static provide = 'webServer'
  routes = []
  constructor(ctx) { super(ctx, 'webServer') }
  register(route) {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((r) => r !== route)
    }
  }
  handlerFor(path) {
    return this.routes.find((r) => r.kind === 'prefix' && r.path === path)?.handler
      ?? this.routes.at(-1)?.handler
  }
}

/**
 * Fake agents service: creates REAL sessions (via ctx.sessions) driven by a
 * test-supplied `emitTurn(agent, message)` script. Mirrors the real factory's
 * composition boundary: the create options' `setup` receives a genuinely
 * scoped context (createScope + extend, like dsh-agent-loop does) BEFORE the
 * agent is published, so scoped sections/restrictions/guards land exactly
 * where the real ones would.
 */
export class FakeAgents extends Service {
  static provide = 'agents'
  static inject = ['sessions']
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.emitTurn = null
    this.cancelCount = 0
  }
  async create(options) {
    const session = this.ctx.sessions.create(options.sessionId, { meta: options.meta ?? {} })
    const service = this
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      followup(message) { void service.emitTurn?.(agent, message) },
      cancel() { service.cancelCount += 1 },
    }
    const scope = createScope(this.ctx, agent)
    agent.ctx = scope.ctx.extend({ agent })
    await options.setup?.(agent.ctx)
    this.store.set(agent.id, agent)
    return {
      agent,
      dispose: async () => {
        this.store.delete(agent.id)
        await scope.dispose()
      },
    }
  }
  get(id) { return this.store.get(id) }
}

/**
 * The scripted "agent turn": chunks, a tool call that needs approval, then a
 * tool result and turn end. Uses only real session-event appends, exactly the
 * vocabulary the real agent loop emits.
 */
export function makeTurnScript(app, { record = {} } = {}) {
  return async (agent, message) => {
    const session = agent.session
    const text = message.content?.[0]?.text ?? ''
    session.append('turn/start', { turn: 1 })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `Hello ${text}` } })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'pondering...' } })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'mcp__echo__echo', arguments: JSON.stringify({ text: 'hi' }) })
    record.approvalOutcome = await app.approval.request({
      agent,
      toolName: 'mcp__echo__echo',
      callId: 'call-1',
      reason: 'bridge test approval',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'echo: hi' }] }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
}
