// Bridge tests: REST status codes, SSE frame vocabulary, approvals (allow /
// deny / 404 / 409 / timeout fail-closed / auto-approve), auth, cancel, and
// that foreign-agent approval requests pass through to other answerers.
// Uses real SessionStore + real ApprovalService; the agent is faked with a
// scripted turn that emits the same session-event vocabulary the real loop
// produces. Run: node test/bridge.mjs
import os from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalSvc from '@deepseek-ai/dsh-user-approval'
import {
  MemorySettings, FakeWebServer, FakeAgents, FakeSystemPrompt, makeTurnScript,
  echoEntry, authHttpMcpServer, call, openSse, waitFor, waitForRoute, scopeOf, check, finish,
} from './helpers.mjs'

/** Current effective server entries (for full-list replacement in tests). */
async function lastEntries(handler) {
  const r = await call(handler, 'GET', '/smart-chat/servers.json')
  return (r.json?.servers ?? []).map((s) => s.entry)
}

async function buildApp(bridgeOpts) {
  const app = new Context()
  await app.plugin(SessionStore).await()
  await app.plugin(ApprovalSvc).await()
  await app.plugin(MemorySettings).await()
  const web = (await app.plugin(FakeWebServer).await(), app.get('webServer'))
  await app.plugin(FakeAgents).await()
  const record = {}
  app.get('agents').emitTurn = makeTurnScript(app, { record })
  const plugin = await import('../lib/index.js')
  await app.plugin(plugin, { servers: [], bridge: { enabled: true, prefix: '/smart-chat', ...bridgeOpts } }).await()
  const handler = await waitForRoute(web, '/smart-chat')
  return { app, handler, record }
}

async function main() {
  console.log('# auth: token gate')
  const A = await buildApp({ token: 'test-token' })
  {
    const auth = { authorization: 'Bearer test-token' }
    const page = await call(A.handler, 'GET', '/smart-chat/')
    check('page served without token', page.status === 200 && page.text.includes('<!doctype html>'), page.status)
    const health = await call(A.handler, 'GET', '/smart-chat/health')
    check('health without token', health.status === 200 && health.json?.ok === true && typeof health.json?.version === 'string', health.json)
    const noAuth = await call(A.handler, 'GET', '/smart-chat/servers.json')
    check('servers.json without token 401', noAuth.status === 401, noAuth.status)
    const wrongAuth = await call(A.handler, 'GET', '/smart-chat/servers.json', undefined, { authorization: 'Bearer wrong' })
    check('wrong bearer 401', wrongAuth.status === 401, wrongAuth.status)
    const goodAuth = await call(A.handler, 'GET', '/smart-chat/servers.json', undefined, auth)
    check('correct bearer 200', goodAuth.status === 200 && Array.isArray(goodAuth.json?.servers), goodAuth.status)
    const msgNoAuth = await call(A.handler, 'POST', '/smart-chat/messages', '{"sessionId":"x","text":"y"}')
    check('messages without token 401', msgNoAuth.status === 401, msgNoAuth.status)
    const sseBad = await call(A.handler, 'GET', '/smart-chat/events?sessionId=x&token=wrong')
    check('sse wrong query token 401', sseBad.status === 401, sseBad.status)

    console.log('# happy path: message -> stream -> tool -> approval -> turn done')
    const created = await call(A.handler, 'POST', '/smart-chat/sessions', '{}', auth)
    check('session created 201', created.status === 201 && typeof created.json?.sessionId === 'string', created.json)
    const sessionId = created.json.sessionId

    const sse = openSse(A.handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}&token=test-token`)
    await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready frame' })
    check('ready frame carries sessionId', sse.frames().find((f) => f.event === 'ready')?.data?.sessionId === sessionId)

    const sent = await call(A.handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId, text: 'world' }), auth)
    check('message accepted 202', sent.status === 202, sent.status)

    const approval = await waitFor(() => sse.frames().find((f) => f.event === 'approval_required'), { what: 'approval_required frame' })
    check('approval frame shape', typeof approval.data?.approvalId === 'string' && approval.data?.toolName === 'mcp__echo__echo' && typeof approval.data?.summary === 'string', approval.data)
    check('approval summary includes args preview', approval.data.summary.includes('"text":"hi"'), approval.data.summary)

    const toolCall = sse.frames().find((f) => f.event === 'tool_call')
    check('tool_call frame', toolCall?.data?.callId === 'call-1' && toolCall?.data?.name === 'mcp__echo__echo', toolCall)
    check('tool_call args preview', toolCall?.data?.argsPreview === '{"text":"hi"}', toolCall?.data)

    const deltas = sse.frames().filter((f) => f.event === 'assistant_delta')
    check('text delta streamed', deltas.some((f) => f.data?.delta === 'Hello world'), deltas.map((f) => f.data))
    check('reasoning delta streamed', deltas.some((f) => f.data?.reasoning === 'pondering...'), deltas.map((f) => f.data))

    const decision = await call(A.handler, 'POST', `/smart-chat/approvals/${encodeURIComponent(approval.data.approvalId)}`, '{"decision":"allow"}', auth)
    check('decision accepted 200', decision.status === 200, decision)

    await waitFor(() => sse.frames().some((f) => f.event === 'turn_done'), { what: 'turn_done frame' })
    const toolResult = sse.frames().find((f) => f.event === 'tool_result')
    check('tool_result summary', toolResult?.data?.summary === 'echo: hi', toolResult)
    check('tool_result not error', toolResult?.data?.isError === false, toolResult)
    check('tool_result duration measured', typeof toolResult?.data?.durationMs === 'number' && toolResult.data.durationMs >= 0, toolResult)
    const resolved = sse.frames().find((f) => f.event === 'approval_resolved')
    check('approval_resolved allowed-once', resolved?.data?.outcome === 'allowed-once', resolved)
    check('recorded outcome allowed-once', A.record.approvalOutcome === 'allowed-once', A.record)
    const turnDone = sse.frames().find((f) => f.event === 'turn_done')
    check('turn_done completed', turnDone?.data?.reason === 'completed', turnDone)
    check('frame order: tool_call before approval', sse.frames().findIndex((f) => f.event === 'tool_call') < sse.frames().findIndex((f) => f.event === 'approval_required'))

    console.log('# approvals: repeat decision 409, unknown 404, bad decision 400')
    const repeat = await call(A.handler, 'POST', `/smart-chat/approvals/${encodeURIComponent(approval.data.approvalId)}`, '{"decision":"deny"}', auth)
    check('repeat decision 409', repeat.status === 409 && repeat.json?.outcome === 'allowed-once', repeat)
    const unknown = await call(A.handler, 'POST', '/smart-chat/approvals/approval-nope', '{"decision":"allow"}', auth)
    check('unknown approval 404', unknown.status === 404, unknown.status)
    const badDecision = await call(A.handler, 'POST', `/smart-chat/approvals/${encodeURIComponent(approval.data.approvalId)}`, '{"decision":"maybe"}', auth)
    check('bad decision 400 (or 409 for decided)', badDecision.status === 400 || badDecision.status === 409, badDecision.status)

    console.log('# SSE: Last-Event-ID replay')
    const replay = openSse(A.handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}&token=test-token`, { 'last-event-id': '0' })
    await waitFor(() => replay.frames().some((f) => f.event === 'turn_done'), { what: 'replayed turn_done' })
    check('replay includes delta', replay.frames().some((f) => f.event === 'assistant_delta'))
    check('replay includes tool_result', replay.frames().some((f) => f.event === 'tool_result'))
    replay.req.emit('close')

    console.log('# approvals: foreign agents pass through')
    const foreign = await app2Foreign(A.app)
    check('foreign request fell through to unavailable', foreign === 'unavailable', foreign)
    sse.req.emit('close')
  }

  console.log('# errors and cancel (no token)')
  const B = await buildApp({ cancelOnDisconnect: true })
  {
    const created = await call(B.handler, 'POST', '/smart-chat/sessions', '{}')
    const sessionId = created.json.sessionId
    check('session without token 201', created.status === 201, created.status)

    const bogus = openSse(B.handler, '/smart-chat/events?sessionId=session-bogus')
    await waitFor(() => bogus.frames().some((f) => f.event === 'error'), { what: 'session-not-found error frame' })
    check('session-not-found error code', bogus.frames().find((f) => f.event === 'error')?.data?.code === 'session-not-found')
    check('stream closed after error', bogus.res.ended)

    const unknownSession = await call(B.handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId: 'session-x', text: 'hi' }))
    check('unknown session 404', unknownSession.status === 404, unknownSession.status)
    const noText = await call(B.handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId }))
    check('missing text 400', noText.status === 400, noText.status)
    const badJson = await call(B.handler, 'POST', '/smart-chat/messages', '{oops')
    check('bad json 400', badJson.status === 400, badJson.status)
    const method405 = await call(B.handler, 'DELETE', '/smart-chat/sessions')
    check('delete sessions 405', method405.status === 405, method405.status)
    const notFound = await call(B.handler, 'GET', '/smart-chat/nope')
    check('unknown route 404', notFound.status === 404, notFound.status)

    console.log('# cancel route and disconnect cancel')
    const agents = B.app.get('agents')
    const before = agents.cancelCount
    const cancel = await call(B.handler, 'POST', `/smart-chat/sessions/${encodeURIComponent(sessionId)}/cancel`, '{}')
    check('cancel 202', cancel.status === 202, cancel.status)
    check('cancel reached agent', agents.cancelCount === before + 1, agents.cancelCount)
    const cancelUnknown = await call(B.handler, 'POST', '/smart-chat/sessions/session-x/cancel', '{}')
    check('cancel unknown session 404', cancelUnknown.status === 404, cancelUnknown.status)

    const sse = openSse(B.handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}`)
    await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready' })
    agents.store.get(sessionId).status = 'running'
    const before2 = agents.cancelCount
    sse.req.emit('close')
    await waitFor(() => agents.cancelCount > before2, { what: 'disconnect cancel' })
    check('disconnect cancels running turn', agents.cancelCount === before2 + 1, agents.cancelCount)
  }

  console.log('# approval timeout: fail-closed deny')
  const C = await buildApp({ approvalTimeoutMs: 150 })
  {
    const created = await call(C.handler, 'POST', '/smart-chat/sessions', '{}')
    const sessionId = created.json.sessionId
    const sse = openSse(C.handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}`)
    await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready' })
    await call(C.handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId, text: 'hi' }))
    const approval = await waitFor(() => sse.frames().find((f) => f.event === 'approval_required'), { what: 'approval_required' })
    await waitFor(() => sse.frames().some((f) => f.event === 'error' && f.data?.code === 'approval-timeout'), { what: 'timeout error frame' })
    await waitFor(() => sse.frames().some((f) => f.event === 'turn_done'), { what: 'turn continues after timeout' })
    check('timeout outcome rejected', C.record.approvalOutcome === 'rejected', C.record)
    const late = await call(C.handler, 'POST', `/smart-chat/approvals/${encodeURIComponent(approval.data.approvalId)}`, '{"decision":"allow"}')
    check('late decision 409', late.status === 409 && late.json?.outcome === 'rejected', late)
    sse.req.emit('close')
  }

  console.log('# auto-approve: mcp tools allowed without asking')
  const D = await buildApp({ autoApproveTools: true })
  {
    const created = await call(D.handler, 'POST', '/smart-chat/sessions', '{}')
    const sessionId = created.json.sessionId
    const sse = openSse(D.handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}`)
    await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready' })
    await call(D.handler, 'POST', '/smart-chat/messages', JSON.stringify({ sessionId, text: 'hi' }))
    await waitFor(() => sse.frames().some((f) => f.event === 'turn_done'), { what: 'turn_done' })
    check('no approval_required frame', !sse.frames().some((f) => f.event === 'approval_required'))
    check('outcome allowed-once', D.record.approvalOutcome === 'allowed-once', D.record)
    sse.req.emit('close')
  }

  console.log('# focus: chat agents see only MCP tools and the MCP persona')
  {
    // Full stack for this section: real tools registry with a non-MCP global
    // tool registered next to the echo MCP server, plus the prompt stub so
    // the persona section lands somewhere assertable.
    const app = new Context()
    await app.plugin(FakeSystemPrompt).await()
    await app.plugin(Tools).await()
    await app.plugin(SessionStore).await()
    await app.plugin(MemorySettings).await()
    await app.plugin(FakeWebServer).await()
    await app.plugin(FakeAgents).await()
    app.get('tools').register({
      name: 'local_demo',
      description: 'a non-MCP global tool that must stay invisible to chat agents',
      parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}) }] },
      async execute() { return { content: [{ type: 'text', text: 'local ok' }] } },
    })
    const plugin = await import('../lib/index.js')
    await app.plugin(plugin, { servers: [echoEntry()], bridge: { enabled: true, prefix: '/smart-chat' } }).await()
    const handler = await waitForRoute(app.get('webServer'), '/smart-chat')
    await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__echo__echo'), { what: 'echo tool' })

    const created = await call(handler, 'POST', '/smart-chat/sessions', '{}')
    const sessionId = created.json.sessionId
    const agent = app.get('agents').store.get(sessionId)
    check('agent has scoped ctx', agent?.ctx !== undefined)
    const scope = scopeOf(agent.ctx)
    check('agent ctx is scoped', scope !== undefined)

    const visible = () => app.get('tools').schemas(scope).map((s) => s.name)
    check('mcp tool visible to the agent', visible().includes('mcp__echo__echo'), visible())
    check('non-mcp global tool hidden', !visible().includes('local_demo'), visible())
    check('global view still sees both', app.get('tools').schemas(undefined).some((s) => s.name === 'local_demo'))

    const persona = app.get('systemPrompt').sections.get('smart-chat:persona')
    check('persona section registered', persona !== undefined && persona.text.includes('MCP servers'), persona)
    check('persona ordered after deployment persona', persona?.order === 1, persona?.order)

    console.log('# focus: visibility follows server changes')
    const add = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry(), echoEntry('echo2')] }))
    check('add accepted', add.status === 200, add)
    await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__echo2__echo'), { what: 'echo2 mounted' })
    await waitFor(() => visible().includes('mcp__echo2__echo'), { what: 'restriction updated with echo2' })
    check('new server tool becomes visible', visible().includes('mcp__echo2__echo'), visible())
    check('non-mcp tool still hidden', !visible().includes('local_demo'), visible())

    const remove = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({ servers: [echoEntry('echo2')] }))
    check('remove accepted', remove.status === 200, remove)
    await waitFor(() => !app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__echo__echo'), { what: 'echo unmounted' })
    await waitFor(() => !visible().includes('mcp__echo__echo'), { what: 'restriction dropped echo' })
    check('removed server tool disappears', !visible().includes('mcp__echo__echo'), visible())

    console.log('# focus: credential_required broadcasts only when the bridge owns the credential')
    {
      // A 401 from behind an already-connected server is the MCP server's
      // own credential domain — no prompt. The broadcast fires only when a
      // stored bridge-side password can no longer refresh (rotated here).
      const plain = app.get('sessions').create('session-plain401')
      plain.append('turn/start', { turn: 1 })
      plain.append('tool/call', { turn: 1, step: 1, callId: 'c8', name: 'mcp__echo2__echo', arguments: '{}' })
      plain.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c8', isError: true, content: [{ type: 'text', text: 'Error POSTing to endpoint: 401 Unauthorized' }] }],
          source: { kind: 'tool', callId: 'c8' },
        },
      }, { surfaceOp: 'append' })

      const authServer = await authHttpMcpServer('demo-mcp-token')
      try {
        const add = await call(handler, 'POST', '/smart-chat/servers', JSON.stringify({
          servers: [...await lastEntries(handler), { serverName: 'authy', transport: 'streamable-http', url: authServer.url, auth: { loginUrl: authServer.loginUrl } }],
        }))
        check('authy added', add.status === 200, add)
        const login = await call(handler, 'POST', '/smart-chat/servers/authy/credentials', JSON.stringify({ username: 'demo-user', password: 'demo-password' }))
        check('authy logged in', login.status === 200, login)
        await waitFor(() => app.get('tools').schemas(undefined).some((s) => s.name === 'mcp__authy__echo'), { what: 'authy tools' })

        const created = await call(handler, 'POST', '/smart-chat/sessions', '{}')
        const sessionId = created.json.sessionId
        const sse = openSse(handler, `/smart-chat/events?sessionId=${encodeURIComponent(sessionId)}`)
        await waitFor(() => sse.frames().some((f) => f.event === 'ready'), { what: 'ready' })

        authServer.setPassword('demo-rotated-password')
        const session = app.get('sessions').create('session-cred')
        session.append('turn/start', { turn: 1 })
        session.append('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'mcp__authy__echo', arguments: '{}' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: {
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'Error POSTing to endpoint: 401 Unauthorized' }] }],
            source: { kind: 'tool', callId: 'c9' },
          },
        }, { surfaceOp: 'append' })

        await new Promise((resolve) => setTimeout(resolve, 500))
        check('no frame for the server-own-domain 401', !sse.frames().some((f) => f.event === 'credential_required' && f.data?.serverName === 'echo2'))
        const frame = await waitFor(() => sse.frames().find((f) => f.event === 'credential_required' && f.data?.serverName === 'authy'), { what: 'credential_required frame for authy' })
        check('frame carries the failed re-login reason', String(frame.data?.reason).includes('re-login failed'), frame.data)
        const tokenRoute = await call(handler, 'POST', `/smart-chat/servers/echo2/token`, '{"token":"x"}')
        check('stdio server token rejected 400', tokenRoute.status === 400, tokenRoute.status)
        sse.req.emit('close')
      } finally {
        await authServer.close()
      }
    }

    await app.fiber.dispose()
  }

  await A.app.fiber.dispose()
  await B.app.fiber.dispose()
  await C.app.fiber.dispose()
  await D.app.fiber.dispose()
  finish('bridge')
}

/** Create an agent NOT owned by the bridge and ask for approval. */
async function app2Foreign(app) {
  const agents = app.get('agents')
  const handle = await agents.create({ sessionId: 'session-foreign', meta: { cwd: os.tmpdir() } })
  const agent = handle.agent
  agent.session.append('turn/start', { turn: 1 })
  return app.get('approval').request({ agent, toolName: 'mcp__echo__echo', reason: 'foreign agent' })
}

main().catch((e) => { console.error('bridge harness error:', e); process.exit(1) })
