# smart-chat

A minimal MCP-driven AI chat web tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

dsh is the engine **and** the MCP client host: you tell smart-chat which MCP servers to talk to
(from the chat page), it mounts each one as a `@deepseek-ai/dsh-mcp-client` fiber, and every tool
the agent can call is `mcp__<serverName>__<tool>`. smart-chat itself is only a thin shell —
no local file/command tools, no second MCP implementation.

```
React chat page (web/, Vite + React 18 + TS — same stack as the dsh web GUI;
  dsw design tokens, composer/approval/reasoning styling copied from the harness)
      │  普通 HTTP REST + SSE（不碰 dsh 的 WS mux 协议）
      ▼
  smart-chat 桥接插件（本仓库，Cordis host 插件）
      │  ctx.agents（会话/投递） · session/event（流式/工具） ·
      │  approval/request waterfall（审批） · ctx.settings（server 列表写穿）
      ▼
  dsh 引擎（agent loop ── 模型路由 ── 工具注册表）
      ▼
  多个 dsh-mcp-client fiber ──> 用户指定的 MCP servers（stdio / streamable-http）
```

## Install

```sh
# from a local checkout
dsh plugin add /path/to/smart-chat
# then start dsh with a web profile and open the page:
open http://127.0.0.1:3080/smart-chat/
```

The `cordis.patch.yml` shipped here inserts the `mcp-chat-web` row automatically; `servers:`
starts empty and you manage servers on the page itself (or declare a YAML baseline — see the
comments in `cordis.patch.yml`).

## Frontend

`web/` holds the chat page source: **Vite + React 18 + TypeScript**, the same stack as the
dsh web GUI (`@deepseek-ai/dsh-web-frontend`). The look follows the harness conversation
surface — the dsw design tokens (`--dsw-alias-*` / `--dsw-static-*`, light + dark), the
InputBar composer card geometry (22px radius card, 34px round send button, 28px add button,
216px capped textarea), the amber ApprovalPanel that takes over the composer while a tool
call waits, the ReasoningRow (collapsible thinking with the running sweep), and the
turn-status shimmer while a reply streams. Markdown renders through marked + DOMPurify with
fenced-code banners (language label + copy button).

Build outputs to `lib/public/` (committed, so installs need no web toolchain); the bridge
serves it with the live `bridge.prefix` injected into `index.html`. Without a build present
the bridge falls back to the legacy single-file page in `lib/page.js`, so a source checkout
never breaks.

```sh
cd web
npm install
npm run build     # or: npm run watch
```

## HTTP surface (under `bridge.prefix`, default `/smart-chat`)

| Method & path | Body | Result |
|---|---|---|
| `GET /` | – | the chat page (token-exempt; built React shell, or the legacy single-file page when no build exists) |
| `GET /assets/*` | – | hashed frontend assets (`immutable` cache; traversal is rejected) |
| `GET /health` | – | `{ ok, version }` (token-exempt) |
| `POST /sessions` | `{}` | `201 { sessionId }` |
| `POST /messages` | `{ sessionId, text }` | `202` (reply arrives over SSE) |
| `POST /sessions/{id}/cancel` | – | `202` — abort the running turn |
| `GET /events?sessionId=` | – | SSE: `ready`/`assistant_delta`/`tool_call`/`tool_result`/`approval_required`/`approval_resolved`/`turn_done`/`error`, 15s heartbeat |
| `POST /approvals/{id}` | `{ decision: allow\|deny }` | `200`; unknown `404`; repeat `409` |
| `GET /servers.json` | – | per-server `state/toolCount/error/logs/tools` |
| `POST /servers` | `{ servers: [full list] }` | `200`; validation `400`; read-only settings `503` |

## Configuration

`servers` — composition/base layer of the effective MCP server list (the page edits the dsh
settings **user** layer on top; both merge through dsh's normal settings chain):

```yaml
servers:
  - serverName: demo-http          # [A-Za-z0-9_-]{1,32}, unique
    transport: streamable-http
    url: https://mcp.example.com/mcp
    headers: { Authorization: Bearer demo-placeholder-token }
  - serverName: demo-stdio
    transport: stdio
    command: /usr/local/bin/demo-mcp-server
    args: ["--verbose"]
    env: { DEMO_API_PASSWORD: secret }
    toolCallTimeoutMs: 60000
    failOnStartupError: false
```

`bridge`:

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | register the HTTP routes; `false` = servers still mount, no page |
| `prefix` | `/smart-chat` | path prefix the bridge owns (not `/plugins`) |
| `token` | `""` | when non-empty, everything except `GET /` and `/health` requires `Authorization: Bearer <token>` (SSE also accepts `?token=`) |
| `autoApproveTools` | `false` | auto-allow `mcp__*` tool calls instead of asking the page |
| `approvalTimeoutMs` | `120000` | pending approvals are **denied** (fail-closed) after this |
| `cancelOnDisconnect` | `false` | abort the running turn when the last SSE subscriber leaves |
| `cwd` | `<tmp>/smart-chat` | working directory for chat sessions |

## Security notes

- Routes only register on profiles that have a web server; headless profiles get the MCP engine
  without any HTTP surface.
- `bridge.token` protects the page/REST/SSE with a shared secret. Recommended for local use;
  the token also travels as a query parameter on SSE (EventSource cannot send headers), so treat
  it as local-only. On first visit the page prompts for the token (`?token=` works too).
- `autoApproveTools: true` lets the model call every MCP tool without asking. Only enable this
  for local, fully trusted MCP servers — a tool with side effects will run unattended.

## Known limitations

- Two tabs sharing one `sessionId` both receive all events and interleave turns; use "New chat".
- Session transcripts are not persisted across dsh restarts (a fresh page = a fresh session).
- Do not install the legacy `dsh-plugin-mcp-chat` alongside this package: both mount
  `dsh-mcp-client` fibers per serverName and would duplicate the same servers.

## Development

```sh
pnpm install
npm test        # unit + servers + bridge + integration
```

The integration tests run a real stdio MCP echo server and the real `dsh-mcp-client`,
`dsh-tools`, `dsh-settings`, `dsh-session`, and `dsh-user-approval` packages; only the LLM and
the agent factory are faked with a scripted turn that emits the same session-event vocabulary.
Host-API reconnaissance notes with sources live in `docs/bridge-api-notes.md`.

## Manual acceptance checklist

1. Open `{prefix}/` → server bar shows your MCP servers and tool counts (3s polling).
2. Send a message → reply streams token by token; the reasoning row (thinking) collapses
   and expands above the markdown body; code blocks render with a copy banner.
3. A tool call appears as a collapsible row (name, duration, result summary).
4. An approval takes over the composer (amber panel) → Allow/Deny settles it and the
   turn continues.
5. Kill the network / close the tab → the page reconnects automatically (or press Reconnect).
6. "New chat" starts a fresh session; the theme button cycles system/light/dark.
7. Add/remove a server in the Servers panel (or the composer `+`) → tools appear/disappear
   immediately (verified live against a local `http://localhost:8090/mcp` server: 55 tools
   registered).
