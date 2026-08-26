// Integration test: the full stack — real dsh-tools, real settings, a real
// stdio MCP server via dsh-mcp-client, real session store and approval
// service — wired through the bridge routes. Covers the acceptance chain:
// health/page, MCP tool registration, session -> message -> streamed reply ->
// tool call -> approval decided from the "page", and server add/remove taking
// effect immediately. Run: node test/integration.mjs
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalSvc from '@deepseek-ai/dsh-user-approval'
import {
  MemorySettings, FakeWebServer, FakeAgents, FakeSystemPrompt, makeTurnScript,
  echoEntry, call, openSse, waitFor, waitForRoute, check, finish,
} from './helpers.mjs'

async function main() {
  const app = new Context()
  await app.plugin(FakeSystemPrompt).await()
  await app.plugin(Tools, { mode: 'native' }).await()
  await app.plugin(SessionStore).await()
  await app.plugin(ApprovalSvc).await()
  await app.plugin(MemorySettings).await()
  await app.plugin(FakeWebServer).await()
  await app.plugin(FakeAgents).await()
  const record = {}
  app.get('agents').emitTurn = makeTurnScript(app, { record })

  const plugin = await import('../lib/index.js')
  await app.plugin(plugin, {
    servers: [echoEntry()],
    bridge: { enabled: true, prefix: '/smart-chat' },
  }).await()
  const handler = await waitForRoute(app.get('webServer'), '/smart-chat')

  console.log('# health and page')
  const health = await call(handler, 'GET', '/smart-chat/health')
  check('health ok+version', health.status === 200 && health.json?.ok === true && typeof health.json?.version === 'string', health.json)
  const page = await call(handler, 'GET', '/smart-chat/')
  check('page html served', page.status === 200 && page.text.includes('smart-chat') && page.text.includes('<!doctype html>'), page.status)
  check('page self-contained size', Buffer.byteLength(page.text) < 50 * 1024, Buffer.byteLength(page.text))

  console.log('# MCP engine drives the tool surface')
  await waitFor(() => app.get('tools')?.schemas(undefined).some((s) => s.name === 'mcp__echo__echo'), { what: 'echo tool' })
  const status = await call(handler, 'GET', '/smart-chat/servers.json')
  check('one connected server', status.json?.servers?.length === 1 && status.json.servers[0].state === 'connected', status.json)
  check('tool count matches registry', status.json.servers[0].toolCount === 1, status.json.servers[0])

  console.log('# chat: session -> message -> stream -> tool -> approval -> done')
  const created = await call(handler, 'POST', '/smart-chat/sessions', '{}')
  const sessionId = created.json.sessionId
  const sse = openSse(handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}`)
  await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready' })
  await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId, text: 'integration' }))
  const approval = await waitFor(() => sse.frames().find((f) => f.event === 'approval_required'), { what: 'approval' })
  const decision = await call(handler, 'POST', `/smart-chat/approvals/${encodeURIComponent(approval.data.approvalId)}`, '{"decision":"allow"}')
  check('approval decided from the page', decision.status === 200, decision)
  await waitFor(() => sse.frames().some((f) => f.event === 'turn_done'), { what: 'turn_done' })
  check('reply streamed', sse.frames().some((f) => f.event === 'assistant_delta' && f.data?.delta === 'Hello integration'))
  check('tool visible', sse.frames().some((f) => f.event === 'tool_call' && f.data?.name === 'mcp__echo__echo'))
  check('outcome honored', record.approvalOutcome === 'allowed-once', record)

  console.log('# servers: add and remove take effect immediately')
  const add = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry(), echoEntry('echo2')] }))
  check('add accepted', add.status === 200, add)
  await waitFor(() => {
    const names = app.get('tools').schemas(undefined).map((s) => s.name)
    return names.includes('mcp__echo__echo') && names.includes('mcp__echo2__echo')
  }, { what: 'both servers mounted' })
  const two = await call(handler, 'GET', '/smart-chat/servers.json')
  check('status lists two servers', two.json?.servers?.length === 2, two.json?.servers?.map((s) => s.serverName))

  const remove = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry('echo2')] }))
  check('remove accepted', remove.status === 200, remove)
  await waitFor(() => !app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__echo__echo'), { what: 'echo unmounted' })
  const one = await call(handler, 'GET', '/smart-chat/servers.json')
  check('status lists one server', one.json?.servers?.length === 1 && one.json.servers[0].serverName === 'echo2', one.json?.servers?.map((s) => s.serverName))

  sse.req.emit('close')
  await app.fiber.dispose()
  finish('integration')
}

main().catch((e) => { console.error('integration harness error:', e); process.exit(1) })
