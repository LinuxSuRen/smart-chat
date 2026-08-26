# smart-chat 桥接插件 Host API 侦察笔记（P0）

> 状态：**P0 产出，待人工评审后才放行 P1**。
> 方法：只读源码侦察（不修改任何运行代码），并用本机运行中的 dsh Host 的
> Inspect `Service.listService` 目录做了活体交叉验证（所有引用的服务名均确认在活 Host 中注册）。
> 版本锚点：全局安装 `@deepseek-ai/dsh@0.1.1-rc.2`
> （内部包同为 `0.1.1-rc.2`，源码根：`$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，
> 下文记作 `$PKG/`）。行号以该版本打包产物为准，升级后需复核。
>
> 每条结论标注出处：`包名 文件 符号`。没把握的点在 §9 统一标注「不确定 + 备选方案」。

---

## 0. 总体结论（一段话）

dsh 的 Web GUI 走 `dsh-host-apiproxy`（Host 侧）+ `dsh-client-connection`（浏览器侧）之间
的 Typert RPC / WS mux；**桥接插件不需要碰这条协议**。Host 侧把全部能力暴露为普通
Cordis 服务与事件（`ctx.agents` / `ctx.on('session/event')` / `approval/request` waterfall /
`ctx.settings` / `webServer.register`），`dsh-host-apiproxy` 的实现就是这些 API 的最大参考
消费者。smart-chat 的桥接插件照它的调用路径，把这些能力改挂到普通 HTTP REST + SSE 上即可。

---

## 1. 会话创建（programmatically create/reuse an agent session）

### API

```js
const handle = await ctx.agents.create({
  sessionId,                       // 必填：agent 与 session 共用的唯一 id（ branded string，运行时就是普通字符串）
  meta: { cwd },                   // 可选：绝对路径；持久化后端按它分目录
  agentOptions: { provider, model }, // 可选：模型路由
  // setup 可省略：不挂 agent preset，agent 继承全局工具注册表（含 mcp__* 工具）
})
// handle: { agent, dispose(): Promise<void> }
```

- 服务：`ctx.agents`（`AgentRegistry`）。`create()` 委托给已注册的 factory
  （由 `dsh-agent-loop` 的 `AgentLoop.setFactory()` 注册）。
  - 出处：`dsh-agent lib/index.js` `AgentRegistry.create()`；`dsh-agent lib/types/index.d.ts`
    `CreateAgentOptions` / `AgentHandle` / `AgentFactory`。
  - 活体验证：Inspect `Service.listService` → `agents.create(options: CreateAgentOptions): Promise<AgentHandle>`、
    `agentLoop.createAgent(ownerCtx, options)`。
- **生命周期归属**：`agents.create()` 的 ownerCtx 是**调用者上下文**（即我们插件的 fiber）。
  插件 stop / dispose 会连带 drain 该 agent（`AgentHandle.dispose()` 显式路径：停 loop → 注销
  agent → 移除 session → unwind scoped world）。这正好满足「插件 stop 全部清理」。
  - 出处：`dsh-agent lib/types/index.d.ts` `AgentHandle` 注释（"The owner disposes the resolved
    handle to stop/drain, unregister, remove the session, and unwind the scope"）。
- **复用**：`ctx.agents.get(sessionId)` 命中活 agent 直接复用；并发去重用一个
  `Map<sessionId, Promise>`（apiproxy 的 `sessionCreations` 模式）。
  - 出处：`dsh-host-apiproxy lib/index.js` `ensureSession()`（约 L2079–L2138）。
- **sessionId 格式**：apiproxy 自己 mint `session-${randomUUID()}`（fork 路径 L2697）。
  我们同样 mint `session-<uuid>`；`SessionId` brand 是编译期的，运行时传普通字符串即可
  （`dsh-session lib/types/types.d.ts` `SessionId()` 注明 "no runtime cost"）。
- **cwd**：必须绝对路径（`dsh-session` `SessionStore.create` 校验非绝对路径抛错）；apiproxy
  在 create 前 `mkdir(cwd, { recursive: true })` 兜底。我们用 `bridge.cwd` 配置（默认
  `os.tmpdir()/smart-chat`），同样 mkdir 兜底。
- **agentOptions**：apiproxy 每次都传 `ctx.agentDefaultModel.currentSelection()`
  （服务 `agentDefaultModel`，活体已确认，方法 `currentSelection(): ModelSelection`）。
  我们同样：`ctx.get('agentDefaultModel')` 可选读取，取到就传，取不到就不传
  （`AgentOptions` 全字段可选，loop 走自己的默认路由解析）。
  - 出处：`dsh-host-apiproxy lib/index.js` `agentOptions()`（L1650）、defaults 注入
    `defaultModelSelection: () => ctx.agentDefaultModel.currentSelection()`（L5532）；
    `dsh-agent-default-model lib/types/index.d.ts`。
- **resume（本期不做，记档）**：`ctx.agents.resume({ resumeSessionId, ... })` 需要
  `sessionPersistence` 服务先就绪（consumer 需 `inject`）。聊天页刷新 = 新建会话即可，
  持久化列为 P6 之后的可选项。
  - 出处：`dsh-agent lib/types/index.d.ts` `ResumeAgentOptions` 注释。

### 设计决定（供 P3 实现）

- `POST {prefix}/sessions`：mint `session-<uuid>` → `agents.create({ sessionId, meta: { cwd },
  agentOptions })` → 存入插件内存 `Map<sessionId, { agent, handle }>` → 返回 `{ sessionId }`。
- 内存映射 + 插件 stop 自动清理（fiber teardown 已保证；显式 `ctx.effect` 也可选挂 dispose）。
- 不传 `setup`（不挂 preset）：agent 继承全局工具面。旧仓库 `dsh-plugin-mcp-chat` 证明
  mcp-client 全局注册的 `mcp__*` 工具对默认对话 agent 可见（它的全部价值就在于此）。
  见 §9-U1 的验证步骤。

---

## 2. 用户消息投递（GUI 输入框最终调用的方法）

### API

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const message = createUserMessage({
  content: [{ type: 'text', text }],   // ContentBlock[]
  source: { kind: 'user' },            // MessageSourceMap['user']；apiproxy 还附带 rpcId/clientTimeZone，均可选
})
agent.followup(message)   // 排一个普通后续 turn 并唤醒 driver（fire-and-forget）
```

- **`agent.followup(message)`**：排队一个独立 turn 并唤醒。同步、不返回结果——回复只走事件流。
  - 出处：`dsh-agent lib/types/runtime-types.d.ts` `Agent.followup()` / `Agent.send()` /
    `Agent.steer()` / `Agent.inject()`（四种投递边界，我们只需要 followup）。
- **`createUserMessage()`**：`dsh-llm lib/types/message.d.ts` L171（input 为完整 content + source，
  自动补 id/role 并深冻结）。
- **参考实现（GUI 的最终调用点）**：`dsh-host-apiproxy lib/index.js` `api.sessions.prompt`
  （约 L2733–L2782）：
  - `mode === 'steer' ? agent.steer(message) : agent.followup(message)`；
  - 立即返回 `{ accepted: true }`，**不等待回合结束**（结果全走事件订阅）；
  - `source` 附 `rpcId`（我们无 rpc 概念，省略即可，字段可选）。
- **ContentBlock 形状**：`dsh-llm lib/types/types.d.ts` `ContentBlockMap`——文本就是
  `{ type: 'text', text }`。
- **停止**：`agent.cancel({ kind: 'user' }, { keepInbox: true })`
  （`AgentCancelCause` 见 `dsh-session lib/types/types.d.ts`；GUI 的 stop 按钮 →
  `api.sessions.cancel` → 此调用，apiproxy L2861–L2872）。
  - `keepInbox: true` 保留排队消息（GUI 行为）；我们的停止按钮同样用 `{ kind: 'user' }`。

### 设计决定（供 P3 实现）

- `POST {prefix}/messages` `{ sessionId, text }`：查内存映射拿 agent → `followup` → `202`。
- 追加 `POST {prefix}/sessions/{id}/cancel` → `agent.cancel({kind:'user'}, {keepInbox:true})`
  → `202`（契约草案见 §8；P5 页面的「停止」按钮需要）。

---

## 3. 输出事件流（host 侧事件源 = GUI WS 帧的源头）

### 3.1 订阅入口

```js
ctx.on('session/event', (session, event) => { ... })
```

- **`session/event`**：post-commit、fire-and-forget 的 append feed。listener 快照在 log push
  前解析、回调在 push 后执行；observer 失败被 contain。在**插件根 ctx** 上注册 = 收到所有
  session 的事件（scope 过滤只会收窄 agent-scoped listener；根级 listener 全收，需自己按
  `session.id` 过滤）。
  - 出处：`dsh-session lib/types/index.d.ts` Events 声明（`'session/event'(session, event)`，
    @mode emit，"Post-commit, fire-and-forget append feed"）。
- **参考实现**：`dsh-host-apiproxy lib/index.js` `api.events.mux`（约 L3524–L3599）——每个连接
  一个 FrameQueue；订阅时先重放当前态（pending approvals、queue items），再挂
  `ctx.on('session/event')` 转发；断开时 dispose 所有 listener。**我们的 SSE 端点照抄这个
  骨架**（重放 + live 转发 + 断开清理）。
- 辅助：`agent/status`（`idle|running`）与 `agent/error` 是 **Cordis 事件**（不在 session log），
  出处 `dsh-agent lib/types/runtime-types.d.ts` Events 声明。用于 SSE 的 `error`/状态帧。

### 3.2 SessionEvent 全词汇（SSE 映射的依据）

出处：`dsh-session lib/types/types.d.ts` `SessionEventMap`（L223–L359）；事件信封
`{ type, seq, time, data }`（`SessionEvent`，seq 连续）。

| session event | data 形状（摘要） | → SSE 映射 |
|---|---|---|
| `turn/start` | `{ turn }` | （内部态） |
| `turn/end` | `{ turn, reason }`，`reason.kind` ∈ `completed\|aborted\|blocked\|error\|max-tokens\|interrupted`（error 变体带 `error: LlmFailure{message,code,status?}`；aborted 带 `reason: {kind:'user'\|...}`） | `turn_done`（kind≠completed 时另发 `error` 帧） |
| `step/start` / `step/end` | `{ turn, step }` | （内部态，可做耗时统计） |
| `user/message` | `UserMessage`（content 块 + source） | （回显已由本地输入产生，不转发） |
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` | **`assistant_delta`**（见 3.3） |
| `assistant/message` | `{ turn, step, message: AssistantMessage, usage?, interrupted? }` | 消息定稿（可用于补齐/校正增量；不单独出 SSE 事件） |
| `tool/call` | `{ turn, step, callId, name, arguments }`（arguments 是**未解析的原始 JSON 字符串**） | **`tool_call`**（name + 截断预览） |
| `tool/result` | `{ turn, step, message: ToolResultMessage, error?{name,code}, meta? }`；`message.content = [ { type:'tool-result', toolCallId, content, isError? } ]` | **`tool_result`**（按 callId 关联，摘要） |
| `todo/write` | `{ todos }` | （忽略或 `todo` 帧，P5 可选） |
| `request/header` / `request/context` / `session/end-seed` | log-only | 忽略 |
| `agent/inbox/spliced` | 见 `dsh-agent lib/types/inbox.d.ts`（apiproxy 用它渲染排队消息） | 忽略（极简页不做排队 UI） |
| `approval/asked` / `approval/decided` | `{ id, toolName, callId?, reason? }` / `{ id, outcome }`（log-only 审计对） | 不直接映射（审批走 §4 的 waterfall answerer） |

### 3.3 StreamChunk（`assistant/chunk` 的 chunk 字段）

出处：`dsh-llm lib/types/types.d.ts` `StreamChunk`（L287–L317）。

| chunk.type | 字段 | 用途 |
|---|---|---|
| `text-delta` | `{ index, text }` | → SSE `assistant_delta { delta: text }` |
| `reasoning-delta` | `{ index, text }` | → 可并入 `assistant_delta { reasoning: text }`（P5 折叠显示） |
| `tool-call-delta` | `{ index, id, name?, argumentsDelta }` | 忽略（工具参数在 `tool/call` 一次性给全） |
| `block-start` / `block-end` | `{ index, blockType / block }` | 忽略（定稿用 `assistant/message`） |
| `usage` / `finish` | `{ usage }` / `{ reason, replayState? }` | 忽略（usage 在 `assistant/message` 也有） |

- 判定「可见输出」可参考 `isTokenDelta(chunk)`（`dsh-llm lib/types/message.d.ts` L204）。
- **注意**：`assistant/chunk` 只在本进程 live append 时发布（构造 seed 不发布，
  `Session.firstLiveSeq` 注释）——对全新会话无影响；resume 场景要重放 log 而非指望 chunk。

### 3.4 SSE 事件 → GUI 帧的对应关系（验收要求「每类帧必有 host 事件源」）

GUI 经 WS 收到的 `session/event` 帧就是 `SessionEvent` 原样（apiproxy L3568–L3574：
`frame({ type: 'session/event', sessionId, event, view? })`）；`view` 是 presentation 增强，
我们不需要。因此映射天然成立：**GUI 看到的每一帧 = host 的一个 `session/event`**，
外加 mux 层自产的 `session/queue`、`approval/requested`、`approval/resolved`、
`question/*`、`session/jobs`、`host/remote-event`（后两者我们不用）。

---

## 4. 审批流（dsh-user-approval）

### 4.1 机制

- 服务 `ctx.approval`（`ApprovalService`）：`request(req: ApprovalRequest): Promise<ApprovalOutcome>`。
  内部：policy 检查 → 以 `scopeTarget(this, req.agent)` 为 scope dispatch **waterfall 事件
  `approval/request`** → 无 answerer 认领/抛错/返回非法值 → 一律 `'unavailable'`（fail-closed）。
  - 出处：`dsh-user-approval lib/index.js` L189（`ctx.waterfall(scopeTarget(this, req.agent),
    'approval/request', req, () => Promise.resolve('unavailable'))`）；
    `dsh-user-approval lib/types/index.d.ts`（`ApprovalRequest{agent, toolName, callId?, reason?,
    signal?}`、`'approval/request'` @mode waterfall 声明）。
- **ApprovalOutcome**：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
  （`dsh-user-approval lib/types/types.d.ts`）。`'allowed-once'` 是唯一授权。
- **req.signal abort** → 请求即刻落 `'cancelled'`（turn 被取消时审批随之中止）。
- **无内置超时**：服务本身没有「默认超时」；signal 由工具调用方（turn 取消链）arm。
  「超时按 deny」必须由**我们的 answerer** 自己实现（定时器 race，见 4.3）。
  这一点与 P4 的「host 审批默认超时按 deny（fail-closed）处理」一致——实现在桥接层。
- policy：`ctx.approval.setPolicy(agent, 'ask'|'never')` 可切；默认 `'ask'`。
  我们**不动 policy**（'never' 是全拒绝，不是自动放行）。

### 4.2 程序化 allow/reject（answerer 模式）

参考实现：`dsh-host-apiproxy lib/index.js` L1899–L1955（apiproxy 自己就是一台 answerer）：

```js
ctx.on('approval/request', (req, next) => {
  if (req.signal?.aborted) return Promise.resolve('cancelled')
  // 1) 判断是否属于我们的 agent（见下方「必须过滤」）
  // 2) 关联 durable id：在 req.agent.session.events 里倒序找未决 'approval/asked'
  //    （按 callId 匹配）——ApprovalRequest 本身不带 id，durable id 在 session log 里
  // 3) 不属于我们 → return next()（放行给链上下一个 answerer）
  // 4) 属于我们 → 返回 new Promise(resolve => { 记入 pendingApprovals；SSE 推卡片 })
})
```

- **必须按 agent 过滤**：`approval/request` 的 scope extractor 取 `req.agent`
  （`dsh-scope lib/invariant.js` L22）。在插件根 ctx 注册的 listener 会收到**所有** agent
  （包括 GUI 主会话）的审批请求——**必须**维护「我们的 sessionId 集合」，不是我们的就
  `return next()`，否则会抢走 GUI 自己的审批。apiproxy 用「backscan 已认领 id + callId 匹配」
  双重过滤；我们用 sessionId 集合过滤更直接。
- **决断入口**：apiproxy 的 `api.respond(message)` 按 rpcId 查 `pendingApprovals` →
  `approval.resolve(outcome)`（L3727–L3741）。我们同构：`POST {prefix}/approvals/{id}` 查
  自己的 pending map → resolve。map 删除即「先到先得」，天然支持 404（未知 id）/409（已决）。
- **approvalId 来源**：两个选择——
  a) 照 apiproxy backscan `approval/asked` 拿 durable id（好处：与 session log 可对账）；
  b) 自己 mint（`approval-<uuid>`，作为 pending map 的 key 直接暴露给页面）。
  **选 b**（简单、无需 backscan）；durable id 不出插件。标注于 §9-U3。

### 4.3 桥接层审批策略（供 P4 实现）

1. `approval_required` SSE 帧：`{ approvalId, toolName, summary }`——summary = 工具名 +
   截断参数预览（从 `tool/call` 的 arguments 原始串截 200 字符；**不整包 dump**）。
2. 超时：answerer 内 `setTimeout(bridge.approvalTimeoutMs, 默认 120_000)` 到点 resolve
   `'rejected'`（fail-closed deny）并补发 SSE `error` 帧说明超时。
3. `bridge.autoApproveTools`（默认 false）为 true 且 `toolName.startsWith('mcp__')`：
   answerer 直接 resolve `'allowed-once'`，不发卡片。README 必须写明风险。
4. 插件 stop：清理所有 pending（resolve `'cancelled'`，apiproxy teardown 同款，L1900–L1902）。

---

## 5. settings 读写（聊天页 server 管理写穿到 YAML base 合并链路）

### 5.1 API

- 服务 `ctx.settings`（`SettingsProvider`，抽象类；文件实现是 `dsh-settings-file`）。
  - `register<T>(ns, schema, options?): SettingsScope<T>`——注册命名空间，返回 owner scope：
    - `get(): T`（解析顺序：schema 默认 < 组合层 `base` < user 层）
    - `watch(cb): () => void`（提交后异步串行回调，拿 next/prev）
    - `update(patch): Promise<void>`（合并进 user 层并持久化）
    - `replace(section): Promise<void>`（整段替换；`replace({})` 全重置回 base）
  - `settings.writable: boolean`——provider 是否可写（只读 provider 下 POST servers 要报错）。
  - 出处：`dsh-settings lib/types/index.d.ts`（`SettingsScope` L85–L111、`SettingsProvider`
    L167+）。活体验证：Inspect 目录确认 `settings.register/update/replace/mutate` 均在。
- **规范接线（我们要用的）**：`installSettingsSection(ctx, ns, schema, entry, hooks)`
  ——settings 服务存在时注册 ns（以组合 entry 为 base 层），不存在时回退到 entry 本身
  （headless 也能跑）。hooks：`setSource(current)` 拿读值 thunk、`onChange()` 触发 reconcile。
  - 出处：`dsh-settings lib/types/index.d.ts` L341。
- namespace 常量：`settingsNamespace('mcp-chat-web')`。

### 5.2 分层语义（写穿链路）

```
cordis.patch.yml 的插件 entry config（servers: [...]）  ← 组合 base 层
        +  settings user 层（POST {prefix}/servers 写入，dsh-settings-file 落盘）
        =  生效列表（scope.get()）
```

- `POST {prefix}/servers` 的写法：`scope.replace({ servers: 全量新列表 })`
  （页面端「列表编辑」语义，replace 比 update 补丁直白；replace 空 section = 重置回 base）。
  写后 `watch` 触发 reconcile（§6）。
- 并发写同 namespace 会被服务内 serialized write queue 排队（`update/replace` 文档）。
  可选 `expectedRevision` 乐观锁（`SettingsConflictError`），极简页第一版不用。

---

## 6. MCP server 管理（移植旧仓库思路，代码自己写）

参考（只读）：`/Users/rick/Workspace/github/linuxsuren/dsh-plugin-mcp-chat/lib/index.js`。

- **挂载**：`import * as McpClient from '@deepseek-ai/dsh-mcp-client'`；
  `ctx.plugin(McpClient, structuredClone(entry))` → fiber。
  - Config 形状：`StdioConfig{transport:'stdio', serverName, command, args, env, cwd,
    toolCallTimeoutMs, failOnStartupError}` | `StreamableHttpConfig{transport:'streamable-http',
    serverName, url, headers, toolCallTimeoutMs, failOnStartupError}`（serverName 约束
    `[A-Za-z0-9_-]{1,32}`，工具名 `mcp__<serverName>__<raw>`）。
    出处：`dsh-mcp-client lib/types/index.d.ts`。
  - **必须 structuredClone**：settings 解析值是深冻结快照，而 schemastery 校验会**原地写
    默认值**——直接传冻结对象会抛（旧仓库 lib/index.js L198–L203 注释，实测教训）。
- **reconcile**：按 serverName diff——新增挂载；删除/变更先 `fiber.dispose()` 再重挂。
  `watch`/`onChange` 驱动，删除时同步清掉该 server 的诊断 ring。
- **工具计数**：`ctx.tools.schemas(scope?)` 过滤 `^mcp__([^_]+)__` 前缀统计；监听
  `tools/change` 事件重算。出处：`dsh-tools lib/types/index.d.ts`（`schemas(scope?):
  ToolSchema[]`、`'tools/change'()`）。活体验证：Inspect 目录确认 `tools.schemas`。
- **状态端点**：每 server 输出 `serverName/transport/state/toolCount/error/logs/tools`：
  - fiber.state：`3` = failed（读 `fiber._error`），`4` = disposed，其余按 toolCount>0 判
    `connected` 否则 `connecting`；
  - 诊断日志：`ctx.logger.exporter({ levels: { default: 3 }, export })` 抓
    `mcp-client(<serverName>)` 前缀的 warn/error 进环形缓冲（旧仓库 L59–L86，注意必须显式
    放宽 exporter 级别，否则 warn 级重连诊断被默认阈值丢弃）。
- **测试 server**：本机 `http://localhost:8090/mcp`（streamable-http），用于 P2/P5 联调；
  测试数据一律占位值（`https://api.example.com`、`DEMO_API_PASSWORD: secret`）。

---

## 7. HTTP 挂载（普通 REST + SSE 的落点）

- 服务 `ctx.webServer`（`dsh-host-webserver`）：`register({ kind: 'exact'|'prefix', path,
  handler })` → 返回 **disposer**；handler 拥有完整响应生命周期（**可长持连接，SSE 合法**）。
  - 出处：`dsh-host-webserver lib/types/index.d.ts`（`WebRoute`、`register()`、
    "may hold the response open, e.g. SSE"）。
- 注册模式（webServer 可能晚于插件 apply 激活；headless 无此服务）：

  ```js
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix', path: '/smart-chat', handler,
    }), 'mcp-chat-web: bridge routes')
  })
  ```

  headless profile 下 inject 永不触发 → 自动跳过（这正是硬性约束要求的形态）。
- **路由冲突**：重复 (kind, path) 注册抛错——组合级契约。**不要用 `/plugins` 前缀**
  （`dsh-client-modules` 的 bundle 路由拥有它，会遮蔽我们的 handler；旧仓库注释）。
- **prefix 匹配**：`path` 及 `path/<anything>` 都归我们（longest-prefix-wins），所以
  `/smart-chat` 一个 prefix 覆盖全部子路径。

---

## 8. REST/SSE 契约草案（定稿，后续阶段按此实现）

前缀 `{prefix} = /smart-chat`（可配，`bridge.prefix`）。所有响应 JSON、`cache-control:
no-store`。除 `GET {prefix}/health` 与静态页外，全部要求鉴权（见 8.3）。

### 8.1 端点

| 方法 & 路径 | 请求 | 响应 | 实现依据 |
|---|---|---|---|
| `POST {prefix}/sessions` | `{}`（或空体） | `201 { sessionId }` | §1：mint uuid + `agents.create` |
| `POST {prefix}/messages` | `{ sessionId, text }` | `202`（无体） | §2：`createUserMessage` + `agent.followup` |
| `POST {prefix}/sessions/{id}/cancel` | – | `202` | §2：`agent.cancel({kind:'user'},{keepInbox:true})`（P5 停止按钮） |
| `GET {prefix}/events?sessionId=` | SSE | 见 8.2 | §3：`session/event` 订阅 + 15s 心跳注释行 |
| `POST {prefix}/approvals/{id}` | `{ decision: 'allow' \| 'deny' }` | `200 { outcome }`；未知 id `404`；重复决断 `409` | §4：pending map resolve |
| `GET {prefix}/servers.json` | – | `{ servers: [{ serverName, transport, state, toolCount, error, logs, tools }] }` | §6 |
| `POST {prefix}/servers` | `{ servers: [完整列表] }`（全量替换语义） | `200`；校验失败 `400 { error }`；settings 只读 `503` | §5：`scope.replace` |
| `GET {prefix}/` | – | `text/html` 单文件聊天页 | P5 |
| `GET {prefix}/health` | – | `200 { ok: true, version }`（**免鉴权**，探活） | P1 |

错误统一：`{ error: string }` + 恰当状态码（400/401/404/409/503）。

### 8.2 SSE 事件词汇（`GET {prefix}/events?sessionId=`）

- 信封：`event: <name>\ndata: <json>\n\n`；连接即发 `event: ready`（`{ sessionId }`），
  之后按 8.2 表推送；每 15s 发注释行 `: ping`。
- 断线重连：客户端带 `Last-Event-ID` 时从其 seq 续传（第一版可仅支持整段重放：
  重连后把 `session.events` 里 seq > cursor 的部分重映射重发；**cursor = 客户端已收到的
  最大 seq**）。实现按「重放 + live」两段式（apiproxy mux 骨架）。
- 客户端断开：dispose 订阅；若该 session 无其他订阅者且回合进行中，**尽力**调用
  `agent.cancel({kind:'user'})` 中止本轮（「尽力」= best-effort，不保证精确时序）。
- 只发最小 JSON 叶子数据（绝不 JSON.stringify Cordis 活对象）。

| SSE event | data | 源事件 |
|---|---|---|
| `ready` | `{ sessionId }` | 连接建立 |
| `assistant_delta` | `{ seq, delta, reasoning? }` | `assistant/chunk`（text-delta / reasoning-delta） |
| `tool_call` | `{ seq, callId, name, argsPreview }` | `tool/call`（argsPreview ≤200 字符） |
| `tool_result` | `{ seq, callId, isError, summary, durationMs? }` | `tool/result`（summary：首个 text 块截断） |
| `approval_required` | `{ approvalId, toolName, summary }` | §4 answerer（工具名+截断预览） |
| `approval_resolved` | `{ approvalId, outcome }` | 决断/超时/取消后补发（页面落定卡片） |
| `turn_done` | `{ seq, turn, reason }`（reason.kind） | `turn/end` |
| `error` | `{ message, code? }` | `turn/end`(kind=error) / `agent/error` / 审批超时说明 |

（`approval_resolved` 是在任务给定契约上的**补充**：P5 要求「决断后落定」，页面需要一个
终态信号；来源是我们自己的 pending map，非 dsh 事件。）

### 8.3 鉴权（`bridge.token`）

- 非空时：所有 `{prefix}` 请求要求 `Authorization: Bearer <token>`，否则 `401`；
  `GET {prefix}/health` 与 `GET {prefix}/`（页面壳本身）免鉴权——页面需要先能加载才能
  弹 token 输入框。
- **EventSource 不能带自定义 header**（浏览器 API 限制）：SSE 端点额外接受
  `?token=<token>` 查询参数，校验逻辑与 Bearer 完全一致。权衡：token 可能进服务器/代理
  日志——本地工具可接受，README 写明；token 为空（默认）则全开放。
- **首次进入弹 token 输入框**（用户要求）：页面检测 401 后弹框让用户手输，存
  `localStorage`（可选「记住」）；同时保留 `?token=` 便捷入口（优先级：URL 参数 > 输入框）。

### 8.4 闭环验收映射（P0 验收标准逐条落实）

| 验收场景 | 链路 |
|---|---|
| 发一条消息 | `POST /messages` → `followup` → `session/event`（§2/§3） |
| 流式回复 | `assistant/chunk` text-delta → SSE `assistant_delta`（§3.3） |
| 工具调用可见 | `tool/call` / `tool/result` → SSE（§3.2） |
| 审批在页面完成 | `approval/request` waterfall answerer → SSE `approval_required` → `POST /approvals/{id}`（§4） |
| 页面增删 MCP server 即时生效 | `POST /servers` → settings user 层 → `watch` → reconcile diff 挂/卸 mcp-client fiber → `tools/change` → `servers.json` 刷新（§5/§6） |

---

## 9. 不确定点与备选方案（显式标注，不许编造）

- **U1｜无 preset 的 agent 是否能看到全局 mcp__ 工具**（§1 设计决定的前提）。
  证据：旧仓库 `dsh-plugin-mcp-chat` 的形态（GUI 默认会话即可用 MCP 工具）表明全局注册的
  工具对默认 agent 可见；但其 GUI agent 可能经默认 preset 组合。备选：P3 联调时若
  `request/header` 里 `tools` 不含 mcp__*，则在 `agents.create` 的 `setup` 里显式挂工具
  （apiproxy 的 `composeAgent(presetId)` 路径，`ctx.agentPresets.resolve()`）。
  **验证方法**：发首条消息后读该 session 的 `request/header` 事件看 tools 列表。
- **U2｜`agents.create` 不传 agentOptions 时 loop 的默认路由解析**。apiproxy 总是显式传
  `agentDefaultModel.currentSelection()`。备选：我们照抄（`ctx.get('agentDefaultModel')`
  可选读取），不依赖省略行为。
- **U3｜approvalId 用自 mint 而非 durable id**（§4.2）。备选：若需要与 session log 对账，
  照 apiproxy backscan `approval/asked`（按 callId 匹配倒序找未决项）。
- **U4｜SSE 续传语义**。`Last-Event-ID` 对 EventSource 自动重连友好，但跨重放重映射
  seq→eventId 需要小心（重放段与 live 段的 seq 连续，天然可用）。备选：第一版只做
  「重连即重放全部」，页面幂等渲染（按 seq 去重）。
- **U5｜同机共存**。与旧 `dsh-plugin-mcp-chat` 同时安装会重复挂载同一 serverName 的
  mcp-client fiber（其 namespace 唯一性约束在**各自进程内**生效，跨插件无协调）。
  处理：README 已知限制声明（P6），不做代码防御。
- **U6｜多标签共用 sessionId**。两个标签页同 sessionId：消息都进同一 inbox（串行 turn），
  SSE 各自独立订阅都会收到全量事件——功能可用但输入会交错。处理：README 已知限制（P6）。
- **U7｜`agent.cancel` 的「尽力」边界**。断开 SSE 即取消回合是启发式：若用户只是刷新页面，
  回合会被误中止。备选（更温和）：仅当 `bridge.cancelOnDisconnect`（默认 false）时才取消；
  默认只断订阅不取消，由用户手动点停止。**P3 实现取备选方案**（保守），契约 8.2 相应弱化为
  「默认仅取消订阅；可配置取消回合」。

---

## 10. 附：本次侦察的文件清单（复核入口）

| 包 | 文件 | 关键符号 |
|---|---|---|
| dsh-agent | lib/index.js; lib/types/{index,runtime-types,inbox}.d.ts | `AgentRegistry.create/get`、`AgentHandle`、`Agent.followup/steer/cancel`、`agent/*` 事件 |
| dsh-agent-loop | lib/types/index.d.ts | `AgentLoop`（factory 注册方）、`createAgent/resume` |
| dsh-session | lib/types/{index,types,known-event-types}.d.ts | `SessionEventMap`、`SessionEvent`、`session/event|created|disposed|flush`、`SessionStore` |
| dsh-llm | lib/types/{types,message}.d.ts | `StreamChunk`、`ContentBlockMap`、`UserMessage`、`createUserMessage`、`isTokenDelta` |
| dsh-user-approval | lib/types/{index,types}.d.ts; lib/index.js | `ApprovalService.request`、`approval/request` waterfall、`ApprovalOutcome`、`approval/asked/decided` |
| dsh-settings | lib/types/index.d.ts | `SettingsProvider.register/update/replace`、`SettingsScope`、`installSettingsSection` |
| dsh-mcp-client | lib/types/index.d.ts | `Config`（stdio/streamable-http）、`apply` |
| dsh-host-webserver | lib/types/index.d.ts | `WebRoute`、`register/registerUpgrade` |
| dsh-host-apiproxy | lib/index.js（参考实现） | `ensureSession`、`prompt`、`cancel`、`events.mux`、approval answerer、`respond` |
| dsh-agent-default-model | lib/types/index.d.ts | `agentDefaultModel.currentSelection()` |
| dsh-scope | lib/invariant.js | `approval/request` scope extractor（按 agent 过滤的依据） |
| 旧仓库（只读参考） | /Users/rick/Workspace/github/linuxsuren/dsh-plugin-mcp-chat/lib/index.js | settings→reconcile→mcp-client 挂载、状态端点、logger.exporter 诊断 |

（完）
