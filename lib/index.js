// smart-chat: a minimal MCP-driven AI chat web tool for DeepSeek Harness.
//
// The dsh engine IS the MCP client host: user-specified MCP servers (managed
// from the chat page, stored in the dsh settings layer) mount as
// @deepseek-ai/dsh-mcp-client fibers, so every tool the agent can call is
// mcp__<serverName>__<tool>. This package adds only a thin shell:
//
//   single-file chat page (plain HTML, no build)
//        |  REST + SSE
//   bridge routes (this package, host plugin)
//        |  ctx.agents / session events / approval waterfall / settings
//   dsh engine -> mcp-client fibers -> user MCP servers

import { createRequire } from 'node:module'
import Schema from '@deepseek-ai/schemastery'
import { ServersField, createServerManager } from './servers.js'
import { BridgeConfig, installBridge } from './bridge.js'

const require = createRequire(import.meta.url)
const version = require('../package.json').version

export const name = 'smart-chat'

// Hard dependency: the bridge creates chat sessions through the agents
// service (provided by dsh-agent-loop in real deployments).
export const inject = ['agents']

export const Config = Schema.object({
  servers: ServersField,
  bridge: BridgeConfig,
})

export function apply(ctx, config) {
  const log = ctx.logger('smart-chat')
  const manager = createServerManager(ctx, config, log)
  installBridge(ctx, config, manager, version)
}
