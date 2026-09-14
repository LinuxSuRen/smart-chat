// MCP server engine tests: real cordis + real dsh-tools + real settings +
// real dsh-mcp-client over a stdio echo server. Verifies mounting, the status
// view, and the settings write-through (POST /servers -> user layer ->
// reconcile remount). Run: node test/servers.mjs
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  MemorySettings, ReadOnlySettings, FakeWebServer, FakeSystemPrompt, FakeAgents,
  echoEntry, zombieEntry, authHttpMcpServer, call, waitFor, waitForRoute, check, finish,
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

  console.log('# engine: stale MCP session auto-remounts (session not found)')
  {
    // The zombie server reports its pid in the tool description and makes
    // its FIRST tools/call fail with the exact streamable-http stale-session
    // text. The watchdog must notice the failed result (via the session-event
    // feed, like the real agent loop records it) and remount the fiber — the
    // new process has a different pid.
    const { app, handler } = await buildApp(MemorySettings, [zombieEntry()])
    const pidOf = () => {
      const schema = app.get('tools').schemas(undefined).find((s) => s.name === 'mcp__zombie__echo')
      const m = /pid-(\d+)/.exec(schema?.description ?? '')
      return m === null ? undefined : m[1]
    }
    const firstPid = await waitFor(() => pidOf(), { what: 'zombie tool registration' })

    // Execute the tool for real so the failure text comes from the actual
    // MCP error path, not from the test's imagination. Failures come back as
    // { isError: true, content, error } — not as rejections.
    let failureText = ''
    try {
      const result = await app.get('tools').execute({ callId: 'c1', name: 'mcp__zombie__echo', arguments: { text: 'hi' }, signal: new AbortController().signal })
      if (result?.isError === true) {
        failureText = [
          result.error?.message,
          ...(result.content ?? []).map((b) => (b?.type === 'text' ? b.text : '')),
        ].filter(Boolean).join(' ')
      }
    } catch (error) {
      failureText = error instanceof Error ? error.message : String(error)
    }
    check('real failure mentions session not found', /session not found/i.test(failureText), failureText)
    if (failureText === '') failureText = 'Error POSTing to endpoint: session not found'

    // Record the failure the way the agent loop would (durable tool/result).
    const session = app.get('sessions').create('session-watchdog')
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'mcp__zombie__echo', arguments: JSON.stringify({ text: 'hi' }) })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: failureText }] }],
        source: { kind: 'tool', callId: 'c1' },
      },
    }, { surfaceOp: 'append' })

    const secondPid = await waitFor(() => (pidOf() !== undefined && pidOf() !== firstPid ? pidOf() : undefined), { timeout: 20_000, what: 'zombie remount (new pid)' })
    check('fiber was replaced', secondPid !== firstPid, { firstPid, secondPid })

    const status = await call(handler, 'GET', '/smart-chat/servers.json')
    const row = status.json?.servers?.find((s) => s.serverName === 'zombie')
    check('server healthy after remount', row?.state === 'connected' && row?.toolCount === 1, row)
    check('remount noted in diagnostics', (row?.logs ?? []).some((l) => l.includes('remounting')), row?.logs)

    await app.fiber.dispose()
  }

  console.log('# engine: 401 from MCP server surfaces a token prompt and setToken recovers')
  {
    const authServer = await authHttpMcpServer('demo-mcp-token')
    try {
      const { app, handler } = await buildApp(MemorySettings, [
        { serverName: 'authy', transport: 'streamable-http', url: authServer.url },
        echoEntry(),
      ])
      const rowOf = async (name) => {
        const r = await call(handler, 'GET', '/smart-chat/servers.json')
        return r.json?.servers?.find((s) => s.serverName === name)
      }

      // Without a token the connection is rejected with 401 (the supervisor
      // retries with backoff in the background — the status must flag it).
      const authRow = await waitFor(async () => {
        const row = await rowOf('authy')
        return row?.auth?.required === true ? row : undefined
      }, { what: 'authy flagged as needing a token' })
      check('status flags auth.required', authRow?.auth?.required === true, authRow)
      check('no tools from the rejected server', authRow?.toolCount === 0, authRow)

      // Route validation.
      const unknown = await call(handler, 'POST', '/smart-chat/servers/nope/token', '{"token":"x"}')
      check('unknown server token 404', unknown.status === 404, unknown.status)
      const stdio = await call(handler, 'POST', '/smart-chat/servers/echo/token', '{"token":"x"}')
      check('stdio token 400', stdio.status === 400, stdio.status)
      const empty = await call(handler, 'POST', '/smart-chat/servers/authy/token', '{}')
      check('missing token field treated as clear', empty.status === 200 || empty.status === 400, empty.status)

      // Submitting the token remounts with merged credentials.
      const set = await call(handler, 'POST', '/smart-chat/servers/authy/token', JSON.stringify({ token: 'demo-mcp-token' }))
      check('token accepted', set.status === 200, set)
      await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__authy__echo'), { what: 'authy tools after token' })
      const ok = await rowOf('authy')
      check('server connected after token', ok?.state === 'connected' && ok?.toolCount === 1, ok)
      check('auth.required cleared', ok?.auth?.required === false, ok?.auth)
      check('server saw rejected attempts', authServer.calls.rejected >= 1, authServer.calls)

      // The settings layer stays credential-free.
      const docJson = JSON.stringify(app.get('settings').doc)
      check('settings layer has no Authorization', docJson.includes('Authorization') === false, docJson)

      // Tool-call-time 403 (connection fine, call rejected) flips the flag
      // without remounting; the SSE broadcast side is covered in bridge.mjs.
      const session = app.get('sessions').create('session-auth-watchdog')
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'mcp__authy__echo', arguments: '{}' })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'Error POSTing to endpoint: 403 Forbidden' }] }],
          source: { kind: 'tool', callId: 'c2' },
        },
      }, { surfaceOp: 'append' })
      const reFlagged = await waitFor(async () => {
        const row = await rowOf('authy')
        return row?.auth?.required === true ? row : undefined
      }, { what: 'authy re-flagged after 403' })
      check('403 tool result re-flags auth.required', reFlagged?.auth?.required === true, reFlagged)

      await app.fiber.dispose()
    } finally {
      await authServer.close()
    }
  }

  finish('servers')
}

main().catch((e) => { console.error('servers harness error:', e); process.exit(1) })
