// Unit tests for the pure server-entry validators. Run: node test/unit.mjs
import { validateServerEntry, validateServerList } from '../lib/servers.js'
import { check, finish } from './helpers.mjs'

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
