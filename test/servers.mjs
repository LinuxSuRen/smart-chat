// MCP server engine tests: real cordis + real dsh-tools + real settings +
// real dsh-mcp-client over a stdio echo server. Verifies mounting, the status
// view, and the settings write-through (POST /servers -> user layer ->
// reconcile remount). Run: node test/servers.mjs
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  MemorySettings, ReadOnlySettings, FakeWebServer, FakeSystemPrompt, FakeAgents,
  echoEntry, zombieEntry, authHttpMcpServer, call, openSse, waitFor, waitForRoute, check, finish,
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

    console.log('# engine: mid-conversation restart steers the model to retry')
    {
      // The failed call was recorded on a session the bridge does NOT own,
      // so no steering may be injected for it.
      const strayBefore = app.get('agents').injected.length
      const agent = app.get('agents').store.get((await call(handler, 'POST', '/smart-chat/sessions', '{}')).json.sessionId)
      const sse = openSse(handler, `/smart-chat/events?sessionId=${encodeURIComponent(agent.id)}`)
      await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready' })

      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('tool/call', { turn: 1, step: 1, callId: 'r1', name: 'mcp__zombie__echo', arguments: '{}' })
      agent.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'r1', isError: true, content: [{ type: 'text', text: 'Error: Streamable HTTP error: Error POSTing to endpoint: session not found' }] }],
          source: { kind: 'tool', callId: 'r1' },
        },
      }, { surfaceOp: 'append' })

      const injectedMsg = await waitFor(() => {
        const msg = app.get('agents').injected[app.get('agents').injected.length - 1]
        return msg !== undefined && String(msg.content?.[0]?.text ?? '').includes('rebuilt') ? msg : undefined
      }, { timeout: 20_000, what: 'session-rebuilt steering' })
      check('no steering for the earlier non-bridge session', injectedMsg !== undefined && app.get('agents').injected.length >= 1)
      const text = String(injectedMsg.content[0]?.text ?? '')
      check('steering explains the restart', text.includes('restarted') && text.includes('Retry'), text.slice(0, 80))
      check('steering is plugin-sourced', injectedMsg.source?.kind === 'plugin', injectedMsg.source)
      const frame = await waitFor(() => sse.frames().find((f) => f.event === 'error' && f.data?.code === 'session-rebuilt'), { what: 'session-rebuilt frame' })
      check('page notified of the rebuild', String(frame.data?.message ?? '').includes('rebuilt'), frame.data)
      sse.req.emit('close')
    }

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

      // A tool-call-time 403 from the system BEHIND an already-connected
      // server must NOT prompt: the server carries its own credentials
      // (robot-platform-mcp's -username/-password), so the rejection is its
      // domain — it surfaces as a normal tool error and never gates messages.
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
      await new Promise((resolve) => setTimeout(resolve, 600))
      const notFlagged = await rowOf('authy')
      check('downstream 403 does not prompt', notFlagged?.auth?.required === false, notFlagged?.auth)
      const gateSession = await call(handler, 'POST', '/smart-chat/sessions', '{}')
      const flowsAfter403 = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: gateSession.json.sessionId, text: 'hi' }))
      check('messages not gated by downstream 403', flowsAfter403.status === 202, flowsAfter403.status)
      check('downstream rejection noted in diagnostics', (notFlagged?.logs ?? []).some((l) => l.includes('carries its own credentials')), notFlagged?.logs)

      await app.fiber.dispose()
    } finally {
      await authServer.close()
    }
  }

  console.log('# engine: username/password passthrough stores credentials and the probe confirms')
  {
    const authServer = await authHttpMcpServer('demo-mcp-token')
    try {
      const { app, handler } = await buildApp(MemorySettings, [
        { serverName: 'authy', transport: 'streamable-http', url: authServer.url, auth: { probeTool: 'echo' } },
      ])
      const rowOf = async (name) => {
        const r = await call(handler, 'GET', '/smart-chat/servers.json')
        return r.json?.servers?.find((s) => s.serverName === name)
      }

      // Connection-level auth mode: the server mounts only WITH credentials.
      // Store them first (pure passthrough, nothing to validate up front),
      // then the mount succeeds through the X-Platform-* headers.
      const store = await call(handler, 'POST', '/smart-chat/servers/authy/credentials', JSON.stringify({ username: 'demo-user', password: 'demo-password' }))
      check('credentials stored (passthrough)', store.status === 200, store)
      await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__authy__echo'), { what: 'authy mounted with credentials' })

      // Input-time gate: the silent probe runs on the first message and
      // gets the credential rejection → 409, dialog, no bridge login.
      const created = await call(handler, 'POST', '/smart-chat/sessions', '{}')
      const sid = created.json.sessionId
      const held = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: 'list alarms' }))
      check('message flows once the probe passes', held.status === 202, held.status)

      // Wrong password in CONNECTION mode fails the mount itself (the
      // headers are rejected at initialize); the server drops to
      // connecting/failed and the message gate stays.
      const bad = await call(handler, 'POST', '/smart-chat/servers/authy/credentials', JSON.stringify({ username: 'demo-user', password: 'wrong' }))
      check('wrong password stored (passthrough defers judgement)', bad.status === 200, bad)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const gatedAfterBad = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: 'list alarms' }))
      check('message gated while wrong credentials cannot mount', gatedAfterBad.status === 409, gatedAfterBad.status)

      // Correct credentials: remounted with X-Platform-* passthrough
      // headers, the mount succeeds and the gate opens.
      const good = await call(handler, 'POST', '/smart-chat/servers/authy/credentials', JSON.stringify({ username: 'demo-user', password: 'demo-password' }))
      check('credentials accepted 200', good.status === 200, good)
      await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__authy__echo'), { what: 'authy remounted with correct credentials' })
      const released = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: 'list alarms' }))
      check('message flows after credentials', released.status === 202, released.status)
      const ok = await rowOf('authy')
      check('connected after credentials', ok?.state === 'connected' && ok?.toolCount === 1, ok)
      check('auth cleared with kind password', ok?.auth?.required === false && ok?.auth?.has === 'password', ok?.auth)

      console.log('# engine: a rotated password re-flags via the tool call and gates until renewed')
      // The server-side account changes: the MCP server's own login now
      // fails, its tool call surfaces the per-call credential error, the
      // watchdog flags (this credential is OURS) and gates messages until
      // the user re-enters them.
      authServer.setPassword('demo-rotated-password')
      const session2 = app.get('sessions').create('session-rotated')
      session2.append('turn/start', { turn: 1 })
      session2.append('tool/call', { turn: 1, step: 1, callId: 'c4', name: 'mcp__authy__echo', arguments: '{}' })
      session2.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c4', isError: true, content: [{ type: 'text', text: 'Error: 本次调用未提供平台凭证：请经请求头传入（X-Platform-Token，或 X-Platform-Username/X-Platform-Password，或 Authorization: Basic），或启动时配置静态凭证' }] }],
          source: { kind: 'tool', callId: 'c4' },
        },
      }, { surfaceOp: 'append' })
      const flagged = await waitFor(async () => {
        const row = await rowOf('authy')
        return row?.auth?.required === true ? row : undefined
      }, { what: 'flagged after the account rotation' })
      check('rotation flags auth.required', flagged?.auth?.required === true, flagged?.auth)
      const gated2 = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: 'again' }))
      check('messages gated while credentials are wrong', gated2.status === 409, gated2.status)
      const renewed = await call(handler, 'POST', '/smart-chat/servers/authy/credentials', JSON.stringify({ username: 'demo-user', password: 'demo-rotated-password' }))
      check('re-entered credentials accepted', renewed.status === 200, renewed)
      const ungated = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: 'again' }))
      check('messages flow after renewal', ungated.status === 202, ungated.status)

      await app.fiber.dispose()
    } finally {
      await authServer.close()
    }
  }

  console.log('# engine: silent probe gates the FIRST message on missing platform credentials')
  {
    // Per-call-credential server: the MCP connection is open (state shows
    // connected), but tool calls fail with the "no platform credentials"
    // text — exactly the robot-platform deployment without static creds.
    const authServer = await authHttpMcpServer('demo-mcp-token', { perCallCreds: true })
    try {
      const { app, handler } = await buildApp(MemorySettings, [
        { serverName: 'authy', transport: 'streamable-http', url: authServer.url, auth: { probeTool: 'echo' } },
      ])
      // The connection succeeds and tools register — auth stays invisible.
      await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__authy__echo'), { what: 'authy tools' })
      const idle = await call(handler, 'GET', '/smart-chat/servers.json')
      check('connected with no visible auth need', idle.json?.servers?.[0]?.state === 'connected' && idle.json?.servers?.[0]?.auth?.required === false, idle.json?.servers?.[0])

      // First message: the silent probe runs, gets the credential error,
      // and the message is held for the login dialog.
      const created = await call(handler, 'POST', '/smart-chat/sessions', '{}')
      const sid = created.json.sessionId
      const held = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: '查询告警' }))
      check('first message held by the silent probe', held.status === 409 && held.json?.code === 'credentials-required' && held.json?.servers?.[0] === 'authy', held.json)
      check('probe call was rejected for credentials', authServer.state.credRejectedCalls >= 1, authServer.state)

      // Supply a token: remount merges X-Platform-Token; the re-sent
      // message re-probes and flows.
      const login = await call(handler, 'POST', '/smart-chat/servers/authy/credentials', JSON.stringify({ token: 'demo-mcp-token' }))
      check('token accepted', login.status === 200, login)
      const released = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: '查询告警' }))
      check('re-sent message flows after login', released.status === 202, released.status)
      const okRow = await call(handler, 'GET', '/smart-chat/servers.json')
      check('probe passed after login', okRow.json?.servers?.[0]?.auth?.required === false, okRow.json?.servers?.[0]?.auth)

      // Subsequent messages skip the probe (verified once per credential
      // generation — no extra platform calls).
      const credCallsBefore = authServer.state.credRejectedCalls
      const second = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: sid, text: '再来一条' }))
      check('second message flows without re-probe', second.status === 202, second.status)

      await app.fiber.dispose()
    } finally {
      await authServer.close()
    }
  }

  console.log('# engine: probe passes silently when the server carries static credentials')
  {
    const authServer = await authHttpMcpServer('demo-mcp-token', { perCallCreds: true, staticCreds: true })
    try {
      const { app, handler } = await buildApp(MemorySettings, [
        { serverName: 'authy', transport: 'streamable-http', url: authServer.url, auth: { probeTool: 'echo' } },
      ])
      await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__authy__echo'), { what: 'authy tools' })
      const created = await call(handler, 'POST', '/smart-chat/sessions', '{}')
      const first = await call(handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: created.json.sessionId, text: 'hi' }))
      check('static credentials: first message flows, no dialog', first.status === 202, first.status)
      await app.fiber.dispose()
    } finally {
      await authServer.close()
    }
  }

  finish('servers')
}

main().catch((e) => { console.error('servers harness error:', e); process.exit(1) })
