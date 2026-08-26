// MCP server engine tests: real cordis + real dsh-tools + real settings +
// real dsh-mcp-client over a stdio echo server. Verifies mounting, the status
// view, and the settings write-through (POST /servers -> user layer ->
// reconcile remount). Run: node test/servers.mjs
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  MemorySettings, ReadOnlySettings, FakeWebServer, FakeSystemPrompt, FakeAgents,
  echoEntry, call, waitFor, waitForRoute, check, finish,
} from './helpers.mjs'

async function buildApp(settings = MemorySettings, servers = []) {
  const app = new Context()
  await app.plugin(FakeSystemPrompt).await()
  await app.plugin(Tools, { mode: 'native' }).await()
  await app.plugin(SessionStore).await()
  await app.plugin(settings).await()
  await app.plugin(FakeWebServer).await()
  await app.plugin(FakeAgents).await()
  const web = app.get('webServer')
  const plugin = await import('../lib/index.js')
  await app.plugin(plugin, { servers, bridge: { enabled: true, prefix: '/smart-chat' } }).await()
  const handler = await waitForRoute(web, '/smart-chat')
  return { app, handler, web }
}

async function main() {
  console.log('# engine: mount + status')
  {
    const { app, handler } = await buildApp(MemorySettings, [echoEntry()])
    await waitFor(() => app.get('tools')?.schemas(undefined).some((s) => s.name === 'mcp__echo__echo'), { what: 'echo tool registration' })
    const r = await call(handler, 'GET', '/smart-chat/servers.json')
    check('http 200', r.status === 200, r.status)
    check('content-type json', String(r.headers['content-type']).includes('application/json'))
    check('no-store', r.headers['cache-control'] === 'no-store')
    const srv = r.json?.servers?.[0]
    check('one server row', r.json?.servers?.length === 1, r.json)
    check('serverName', srv?.serverName === 'echo', srv)
    check('transport stdio', srv?.transport === 'stdio', srv)
    check('state connected', srv?.state === 'connected', srv)
    check('toolCount 1', srv?.toolCount === 1, srv)
    check('tool listed', srv?.tools?.[0]?.name === 'mcp__echo__echo', srv?.tools)
    check('entry echoed back', srv?.entry?.serverName === 'echo', srv?.entry)
    check('logs array', Array.isArray(srv?.logs), srv)

    console.log('# engine: 405 for non-GET status')
    const r405 = await call(handler, 'POST', '/smart-chat/servers.json', '{}')
    check('method not allowed', r405.status === 405, r405.status)

    console.log('# engine: write-through replace remounts')
    const r2 = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry('echo2')] }))
    check('replace accepted', r2.status === 200, r2)
    await waitFor(() => app.get('tools')?.schemas(undefined).some((s) => s.name === 'mcp__echo2__echo'), { what: 'echo2 tool registration' })
    check('old tool unregistered', !app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__echo__echo'))
    const r3 = await call(handler, 'GET', '/smart-chat/servers.json')
    check('status shows echo2', r3.json?.servers?.[0]?.serverName === 'echo2', r3.json)
    check('echo2 connected', r3.json?.servers?.[0]?.state === 'connected', r3.json)

    console.log('# engine: validation rejections')
    const bad1 = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [{ serverName: 'bad name', transport: 'stdio', command: 'x' }] }))
    check('invalid name 400', bad1.status === 400 && bad1.json?.error !== undefined, bad1)
    const bad2 = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry(), echoEntry()] }))
    check('duplicate 400', bad2.status === 400 && String(bad2.json?.error).includes('duplicate'), bad2)
    const bad3 = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: 'nope' }))
    check('non-array 400', bad3.status === 400, bad3)

    await app.fiber.dispose()
  }

  console.log('# engine: read-only settings refuses writes')
  {
    const { app, handler } = await buildApp(ReadOnlySettings, [])
    const r = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry()] }))
    check('read-only 503', r.status === 503 && r.json?.error !== undefined, r)
    await app.fiber.dispose()
  }

  finish('servers')
}

main().catch((e) => { console.error('servers harness error:', e); process.exit(1) })
