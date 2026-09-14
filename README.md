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
| `POST /messages` | `{ sessionId, text }` | `202` (reply arrives over SSE); held with `409 { code: "credentials-required" }` while a mounted server lacks credentials — the page logs in and re-sends automatically |
| `POST /sessions/{id}/cancel` | – | `202` — abort the running turn |
| `GET /events?sessionId=` | – | SSE: `ready`/`assistant_delta`/`tool_call`/`tool_result`/`tool_images`/`approval_required`/`approval_resolved`/`credential_required`/`turn_done`/`error`, 15s heartbeat |
| `POST /approvals/{id}` | `{ decision: allow\|deny }` | `200`; unknown `404`; repeat `409` |
| `GET /servers.json` | – | per-server `state/toolCount/error/logs/tools` and `auth.required` for streamable-http entries |
| `POST /servers` | `{ servers: [full list] }` | `200`; validation `400`; read-only settings `503` |
| `POST /servers/{name}/credentials` (alias `/token`) | `{ token }` or `{ username, password, loginUrl? }` | `200` — store credentials and remount; unknown `404`; stdio `400`; failed login `400` |

## MCP server credentials (invisible auth; login only when input needs it)

Authentication is designed to be **invisible**: remembered credentials are re-submitted
silently, and when a stored username+password session expires the bridge re-logs-in on its
own — no dialog, no interruption. The login dialog appears only when the user actually sends
a message and a mounted server still has no credentials **for the hop smart-chat owns**:

1. `POST /messages` is **held** with `409 { code: "credentials-required", servers: [...] }` —
   the turn never runs into certain 401s. The page opens the login dialog; cancelling simply
   drops the held message.
2. Once the login succeeds the page **re-sends the held message automatically**, so the
   conversation continues exactly where it stopped ("logged in — continuing: …").

**Scope of the credential flow — the page/bridge → MCP endpoint hop only:**

- The MCP **endpoint** rejects the connection with 401 (e.g. robot-platform-mcp deployed with
  `-mcp-token`/`MCP_SERVER_TOKEN` admission) → flag + dialog; paste that admission token.
- A bridge-stored **username+password** turned out to be wrong (the server's own login rejects
  it and the tool call says so) → prompt again.
- A 401/403 coming from the system **behind** an already-connected MCP server (its own
  platform credentials — robot-platform-mcp's `-username`/`-password` — or per-API
  permissions) is **the server's credential domain**: it surfaces as a normal tool error,
  never prompts, never gates messages. Fix those on the MCP server's own arguments/env.

Credential modes (**pure passthrough** — smart-chat never logs in itself; stored **in host
memory only**, the settings layer never sees a credential):

- **token** — sent as `X-Platform-Token` + `Authorization: Bearer`;
- **username + password** — sent as `X-Platform-Username` / `X-Platform-Password`; the MCP
  server receives them at initialize and runs its OWN authentication/JWT lifecycle.
  There is **no login URL**: correctness is confirmed the only reliable way — by executing
  a tool (`auth.probeTool`, or the model's own calls).

Everything is lost on dsh restart (by design); the page caches credentials in `localStorage`
purely to re-submit them silently for you. A stale streamable-http session
(`session not found`) is healed separately: the watchdog remounts the fiber automatically, no
credentials involved.

When the MCP server restarts **mid-conversation**, the in-flight tool call still fails once
(nothing can revive a request that hit a dead session). Right after the remount completes and
the tools are live again, the bridge injects a steering notice into the conversation — "the
server restarted, the session was rebuilt, the failed call was never executed; retry it" — so
the model retries with the fresh session and the chat continues on its own. The page also
receives a `session-rebuilt` informational frame.

**Silent probe at the first message** (`auth.probeTool` on the entry): the MCP connection
itself never touches the platform (initialize and tools/list are server-local), so a server
that expects per-request platform credentials (robot-platform style: `X-Platform-Token`,
`X-Platform-Username/X-Platform-Password`, session-pinned at initialize) mounts as
"connected" while its tool calls would fail with "本次调用未提供平台凭证". With a cheap
read-only probe tool configured, the bridge silently executes it ONCE per credential
generation right when the user's first message arrives: static server credentials or working
stored credentials → the message flows with zero prompts; missing credentials → the message
is held (409), the login dialog opens, and after login the held message re-probes and
continues automatically. Mid-conversation, a tool result that explicitly asks the
caller for per-request credentials ("请经请求头传入…") re-opens the same flow.

## Configuration

`servers` — composition/base layer of the effective MCP server list (the page edits the dsh
settings **user** layer on top; both merge through dsh's normal settings chain):

```yaml
servers:
  - serverName: demo-http          # [A-Za-z0-9_-]{1,32}, unique
    transport: streamable-http
    url: https://mcp.example.com/mcp
    headers: { X-Extra: demo }      # static headers (credentials belong in the dialog, not here)
    auth:
      probeTool: system_dashboard_stats   # optional read-only tool for the silent credential probe
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
- Per-MCP-server tokens live in host memory only (see above) — never in the settings layer, the
  YAML config, or the repo. The page's `localStorage` cache is opt-out ("remember" checkbox).
- `autoApproveTools: true` lets the model call every MCP tool without asking. Only enable this
  for local, fully trusted MCP servers — a tool with side effects will run unattended.

## Known limitations

- Two tabs sharing one `sessionId` both receive all events and interleave turns; use "New chat".
- Session transcripts are not persisted across dsh restarts (a fresh page = a fresh session).
- Do not install the legacy `dsh-plugin-mcp-chat` alongside this package: both mount
  `dsh-mcp-client` fibers per serverName and would duplicate the same servers.

## Image rendering (base64)

Two channels reach the page:

- **Tool-result images** (`mcp__robot__ptz_capture` style captures): dsh-mcp-client stores MCP
  image results in the dsh attachment service (facing the model). The bridge reads the bytes
  back and streams them as base64 **data URLs** in a follow-up `tool_images { callId, images }`
  SSE frame; the tool entry expands and renders them inline (≤8 images, ≤8 MB each). Reconnects
  replay them (Last-Event-ID); a failed read drops the frame silently. Note the upstream gate:
  images only exist when the deployment mounts an attachment store AND the model route declares
  image input — otherwise dsh-mcp-client degrades them to `[image unavailable …]` text.
- **Markdown images**: assistant output may embed `![alt](https://…)` (always worked) and
  `![alt](data:image/png;base64,…)` — the sanitizer allows `data:image/(png|jpeg|webp|gif)`
  URIs specifically, nothing else about the default scheme whitelist changes.

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
