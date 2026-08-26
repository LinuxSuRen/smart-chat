// Unit tests for the pure server-entry validators and the embedded page.
// Run: node test/unit.mjs
import { pageHtml } from '../lib/page.js'
import { validateServerEntry, validateServerList } from '../lib/servers.js'
import { check, finish } from './helpers.mjs'

console.log('# page: embedded script compiles')
{
  // The page is emitted through a template literal, so regex escapes (\\n,
  // \\*) must survive into the output; a raw newline would split a regex
  // across lines and kill the whole script with a browser SyntaxError.
  // Compiling the extracted <script> body catches that class of bug here.
  const html = pageHtml('/smart-chat')
  const match = /<script>([\s\S]*)<\/script>/.exec(html)
  check('script tag found', match !== null)
  if (match !== null) {
    let err = null
    try { new Function(match[1]) } catch (e) { err = e }
    check('script parses', err === null, String(err))
  }
  check('page under 50KB', Buffer.byteLength(html) < 50 * 1024, Buffer.byteLength(html))
  check('prefix interpolated', html.includes('const PREFIX = "/smart-chat"'))
}

console.log('# validateServerEntry')

const stdio = { serverName: 'demo', transport: 'stdio', command: '/usr/local/bin/demo-mcp-server', args: ['-v'] }
const http = { serverName: 'demo-http', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer demo-placeholder-token' } }

check('valid stdio', validateServerEntry(stdio).ok === true, validateServerEntry(stdio))
check('valid http', validateServerEntry(http).ok === true, validateServerEntry(http))
check('non-object rejected', validateServerEntry('nope').ok === false)
check('array rejected', validateServerEntry([stdio]).ok === false)
check('bad serverName rejected', validateServerEntry({ ...stdio, serverName: 'has space' }).ok === false)
check('too long serverName rejected', validateServerEntry({ ...stdio, serverName: 'a'.repeat(33) }).ok === false)
check('bad transport rejected', validateServerEntry({ ...stdio, transport: 'grpc' }).ok === false)
check('stdio without command rejected', validateServerEntry({ ...stdio, command: '' }).ok === false)
check('stdio with non-string args rejected', validateServerEntry({ ...stdio, args: ['-v', 3] }).ok === false)
check('stdio with non-string env values rejected', validateServerEntry({ ...stdio, env: { N: 3 } }).ok === false)
check('http without url rejected', validateServerEntry({ ...http, url: 'ftp://x' }).ok === false)
check('http with non-string header values rejected', validateServerEntry({ ...http, headers: { X: 1 } }).ok === false)
check('bad toolCallTimeoutMs rejected', validateServerEntry({ ...http, toolCallTimeoutMs: -1 }).ok === false)
check('good toolCallTimeoutMs accepted', validateServerEntry({ ...http, toolCallTimeoutMs: 5000 }).ok === true)
check('local test url accepted', validateServerEntry({ serverName: 'local', transport: 'streamable-http', url: 'http://localhost:8090/mcp' }).ok === true)

console.log('# validateServerList')

check('non-array rejected', validateServerList('x').ok === false)
check('empty list ok', validateServerList([]).ok === true)
check('valid list ok', validateServerList([stdio, http]).ok === true)
check('propagates entry error', validateServerList([stdio, { serverName: 'x', transport: 'stdio' }]).ok === false)
check('duplicate serverName rejected', validateServerList([stdio, { ...stdio, command: '/other' }]).error.includes('duplicate'), validateServerList([stdio, { ...stdio, command: '/other' }]))

finish('unit')
