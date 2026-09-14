// smart-chat — single-file chat page served at GET {prefix}/.
// Self-contained vanilla HTML/CSS/JS: no build step, no framework, no external
// requests. Kept intentionally minimal.

export function pageHtml(prefix) {
  const P = JSON.stringify(prefix)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>smart-chat</title>
<style>
  :root { color-scheme: light dark; --line: #d8d8de; --bg: #fff; --fg: #1c1c22; --muted: #77777f; --accent: #3563d9; }
  @media (prefers-color-scheme: dark) { :root { --line: #33333c; --bg: #14141a; --fg: #e8e8ee; --muted: #94949e; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0 8px 0 0; }
  #conn { width: 9px; height: 9px; border-radius: 50%; background: #c33; flex: none; }
  #conn.ok { background: #2a2; }
  #serverbar { color: var(--muted); font-size: 12px; flex: 1; min-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  #feed { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { max-width: 78ch; margin: 0 auto 12px; }
  .msg .who { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
  .msg .body { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; white-space: pre-wrap; word-break: break-word; }
  .msg.user .body { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
  .msg .body code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; background: color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 4px; padding: 1px 4px; }
  .msg .body pre { background: color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 8px; padding: 8px 10px; overflow-x: auto; white-space: pre; }
  .msg .body pre code { background: none; padding: 0; }
  .reasoning { color: var(--muted); font-size: 12.5px; border-left: 3px solid var(--line); margin: 0 0 6px; padding: 2px 8px; white-space: pre-wrap; }
  .tool { max-width: 78ch; margin: 0 auto 8px; border: 1px dashed var(--line); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; }
  .tool summary { cursor: pointer; color: var(--muted); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .tool .tname { color: var(--fg); font-family: ui-monospace, Menlo, Consolas, monospace; }
  .tool .dur { margin-left: auto; }
  .tool.error .tname { color: #c33; }
  .approval { max-width: 78ch; margin: 0 auto 8px; border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; }
  .approval .q { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .approval .s { color: var(--muted); font-size: 12px; margin-bottom: 8px; word-break: break-all; }
  .approval .outcome { color: var(--muted); font-size: 12.5px; }
  .sysline { max-width: 78ch; margin: 0 auto 8px; color: #c33; font-size: 12.5px; text-align: center; }
  footer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
  #input { flex: 1; resize: none; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); max-height: 40vh; }
  #panel { display: none; border-bottom: 1px solid var(--line); padding: 10px 12px; font-size: 12.5px; }
  #panel.open { display: block; }
  #srvrows .row { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; flex-wrap: wrap; }
  #srvrows .state { font-weight: 600; }
  .state.connected { color: #2a2; } .state.connecting { color: #b80; } .state.failed, .state.invalid { color: #c33; } .state.removed, .state.disposed { color: var(--muted); }
  #addform { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); }
  #addform input, #addform select { font: inherit; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
  #modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; align-items: center; justify-content: center; }
  #modal.open { display: flex; }
  #modal .card { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 18px; width: min(92vw, 380px); }
  #modal input { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); margin: 8px 0; }
</style>
</head>
<body>
<header>
  <h1>smart-chat</h1>
  <span id="conn" title="SSE connection"></span>
  <span id="serverbar">servers: loading…</span>
  <button id="btn-servers" title="Manage MCP servers">Servers</button>
  <button id="btn-reconnect" title="Reopen the event stream">Reconnect</button>
  <button id="btn-new">New chat</button>
</header>
<div id="panel">
  <div id="srvrows"></div>
  <form id="addform">
    <input name="serverName" placeholder="name (a-z 0-9 _ -)" size="16" required>
    <select name="transport"><option value="streamable-http">http</option><option value="stdio">stdio</option></select>
    <input name="url" placeholder="http://localhost:8090/mcp" size="28">
    <input name="command" placeholder="command" size="18" style="display:none">
    <input name="args" placeholder="args, comma separated" size="20" style="display:none">
    <input name="kv" placeholder="headers / env as KEY=value lines" size="30">
    <button class="primary" type="submit">Add server</button>
  </form>
</div>
<div id="feed"><div class="sysline" id="hint">connecting…</div></div>
<footer>
  <textarea id="input" rows="2" placeholder="Message (Enter to send, Shift+Enter for newline)"></textarea>
  <button id="btn-send" class="primary">Send</button>
  <button id="btn-stop" title="Cancel the running turn">Stop</button>
</footer>
<div id="modal"><div class="card">
  <b id="modal-title">Access token required</b>
  <p id="modal-desc" style="color:var(--muted);font-size:12.5px">This bridge is protected. Paste the token from the bridge config.</p>
  <div id="cred-mode-row" style="display:none;gap:14px;font-size:12.5px;margin:6px 0 2px">
    <label><input type="radio" name="cred-mode" value="token" checked> token</label>
    <label><input type="radio" name="cred-mode" value="password"> username + password</label>
  </div>
  <input id="token-input" type="password" placeholder="token" autocomplete="off">
  <div id="cred-fields" style="display:none;flex-direction:column;gap:8px">
    <input id="cred-username" type="text" placeholder="username" autocomplete="off">
    <input id="cred-password" type="password" placeholder="password" autocomplete="off">
    <input id="cred-loginurl" type="text" placeholder="login URL (optional; default: auth.loginUrl or origin + /api/v1/auth/login)" autocomplete="off">
  </div>
  <label style="font-size:12px;color:var(--muted)"><input type="checkbox" id="token-remember"> remember on this device</label>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
    <button id="token-save" class="primary">Save</button>
  </div>
</div></div>
<script>
'use strict';
const PREFIX = ${P};
const $ = (id) => document.getElementById(id);
const feed = $('feed'), input = $('input'), connDot = $('conn');

// ---- credential dialogs -----------------------------------------------------
// One modal serves two askers: the BRIDGE token (401 on our own API) and a
// per-SERVER MCP credential (401/403 from the target MCP server) — either a
// pasted token OR a username+password pair (the bridge logs in itself,
// robot-platform style, and refreshes the session automatically). Server
// credentials are never written into the server config; the bridge keeps
// them in host memory, this page only caches them in localStorage.
let token = '';
let mcpTokens = {};
try { mcpTokens = JSON.parse(localStorage.getItem('smart-chat.mcpTokens') ?? '{}') || {}; } catch { mcpTokens = {}; }
for (const k of Object.keys(mcpTokens)) {
  if (typeof mcpTokens[k] === 'string') mcpTokens[k] = { kind: 'token', token: mcpTokens[k] };
}
function saveMcpTokens() { try { localStorage.setItem('smart-chat.mcpTokens', JSON.stringify(mcpTokens)); } catch {} }

let tokenWaiter = null;   // resolves with { kind, cred }
let modalKind = 'bridge';
let modalMode = 'token';
function askToken(kind, serverName, reason) {
  modalKind = kind;
  modalMode = 'token';
  $('modal-title').textContent = kind === 'server'
    ? 'Credentials required: ' + serverName
    : 'Access token required';
  $('modal-desc').textContent = kind === 'server'
    ? (reason || 'This MCP server rejected the request as unauthorized (401/403). Credentials stay in the bridge memory, not in the server config.')
    : 'This bridge is protected. Paste the token from the bridge config.';
  const tokenRadio = document.querySelector('input[name="cred-mode"][value="token"]');
  if (tokenRadio) tokenRadio.checked = true;
  $('cred-mode-row').style.display = kind === 'server' ? 'flex' : 'none';
  $('cred-fields').style.display = 'none';
  $('token-input').style.display = '';
  $('token-input').value = '';
  $('cred-username').value = '';
  $('cred-password').value = '';
  $('cred-loginurl').value = '';
  $('modal').classList.add('open');
  $('token-input').focus();
  return new Promise((resolve) => { tokenWaiter = resolve; });
}
function syncCredMode() {
  const isPassword = document.querySelector('input[name="cred-mode"]:checked')?.value === 'password';
  modalMode = isPassword ? 'password' : 'token';
  $('cred-fields').style.display = isPassword ? '' : 'none';
  $('token-input').style.display = isPassword ? 'none' : '';
}
for (const radio of document.querySelectorAll('input[name="cred-mode"]')) {
  radio.addEventListener('change', syncCredMode);
}
$('token-save').onclick = () => {
  let cred;
  if (modalKind === 'server' && modalMode === 'password') {
    const username = $('cred-username').value.trim();
    const password = $('cred-password').value;
    if (username === '' || password === '') { $('cred-password').focus(); return; }
    cred = { kind: 'password', username, password };
    const loginUrl = $('cred-loginurl').value.trim();
    if (loginUrl !== '') cred.loginUrl = loginUrl;
  } else {
    cred = { kind: 'token', token: $('token-input').value.trim() };
  }
  if ($('token-remember').checked) {
    if (modalKind === 'server' && tokenWaiterServer) mcpTokens[tokenWaiterServer] = cred, saveMcpTokens();
    else if (modalKind === 'bridge' && cred.kind === 'token') { try { localStorage.setItem('smart-chat.token', cred.token); } catch {} }
  }
  $('modal').classList.remove('open');
  if (tokenWaiter) { const w = tokenWaiter; tokenWaiter = null; w({ kind: modalKind, cred }); }
};
let tokenWaiterServer = null;

{
  const qp = new URLSearchParams(location.search).get('token');
  if (qp) { token = qp; try { localStorage.setItem('smart-chat.token', qp); history.replaceState(null, '', location.pathname); } catch {} }
  else { try { token = localStorage.getItem('smart-chat.token') ?? ''; } catch {} }
}
function askBridgeToken() { return askToken('bridge', undefined, undefined).then((r) => { if (r.cred.kind === 'token') token = r.cred.token; }); }

// ---- per-server credential flow ------------------------------------------
const tokenTried = new Set();
// Invisible-auth continuation: the message held/interrupted by a missing
// login, re-sent automatically once credentials land.
let pendingAuthMessage = null;
let lastSent = { text: '', answered: true };

async function submitServerCredential(serverName, cred, auto) {
  tokenTried.add(serverName);
  try {
    const r = await apiJson('/servers/' + encodeURIComponent(serverName) + '/credentials', { method: 'POST', body: JSON.stringify(cred) });
    if (r.status === 200) {
      void pollServers();
      if (pendingAuthMessage !== null) {
        const held = pendingAuthMessage;
        pendingAuthMessage = null;
        sysLine('logged in — continuing: ' + (held.length > 60 ? held.slice(0, 60) + '…' : held));
        lastSent = { text: held, answered: false };
        const retry = await apiJson('/messages', { method: 'POST', body: JSON.stringify({ sessionId, text: held }) });
        if (retry.status !== 202) sysLine('continue failed: ' + (retry.data?.error ?? retry.status));
      } else if (!auto) {
        sysLine('logged in to ' + serverName + ' — you can retry the request');
      }
      return true;
    }
    sysLine('login rejected for ' + serverName + ': ' + (r.data?.error ?? r.status));
  } catch (err) {
    sysLine('credential submit failed for ' + serverName + ': ' + (err && err.message ? err.message : String(err)));
  }
  if (!auto) await promptServerCredential(serverName, 'retry');
  return false;
}
async function promptServerCredential(serverName, reason) {
  if (reason === 'retry') tokenTried.delete(serverName);
  tokenWaiterServer = serverName;
  const r = await askToken('server', serverName, reason);
  tokenWaiterServer = null;
  if (r.cred.kind === 'password' || r.cred.token !== '') await submitServerCredential(serverName, r.cred, false);
  else pendingAuthMessage = null;
}
async function maybeAutoSubmit(serverName) {
  if (tokenTried.has(serverName)) return;
  const stored = mcpTokens[serverName];
  if (stored) await submitServerCredential(serverName, stored, true);
}

// ---- api ----------------------------------------------------------------
// Wrapped so failures surface: a network error or a non-JSON body (e.g. the
// SPA fallback serving index.html because the bridge route is inactive)
// throws a visible error instead of dying silently.
async function api(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = Object.assign({}, opts.headers);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(PREFIX + path, { method: opts.method ?? 'GET', headers, body: opts.body });
    } catch (err) {
      const e = new Error('network error: ' + (err && err.message ? err.message : String(err)));
      throw e;
    }
    if (res.status === 401 && attempt === 0) { await askBridgeToken(); continue; }
    return res;
  }
}
async function apiJson(path, opts) {
  const res = await api(path, opts);
  const ctype = String(res.headers.get('content-type') ?? '');
  if (!ctype.includes('application/json')) {
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 120); } catch {}
    throw new Error('expected JSON from ' + path + ' (HTTP ' + res.status + ') but got ' + (ctype || 'no content-type') + (snippet ? ': ' + snippet : ''));
  }
  let data = null;
  try { data = await res.json(); } catch (err) { throw new Error('bad JSON from ' + path + ': ' + (err && err.message ? err.message : String(err))); }
  return { status: res.status, data };
}

// ---- rendering ----------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mdLite(text) {
  const parts = String(text).split(/\`\`\`/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[a-zA-Z0-9_-]*\\n/, '');
      html += '<pre><code>' + esc(body) + '</code></pre>';
    } else {
      html += esc(parts[i])
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
    }
  }
  return html;
}
const scrollDown = () => { feed.scrollTop = feed.scrollHeight; };
function sysLine(text) {
  const div = document.createElement('div');
  div.className = 'sysline'; div.textContent = text;
  feed.appendChild(div); scrollDown();
  return div;
}

// streaming assistant node
let live = null;
function startAssistant() {
  if (live) return live;
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = '<div class="who">assistant</div><div class="reasoning" style="display:none"></div><div class="body"></div>';
  feed.appendChild(wrap); scrollDown();
  live = { wrap, reasoning: wrap.querySelector('.reasoning'), body: wrap.querySelector('.body'), text: '', reason: '' };
  return live;
}
function endAssistant() {
  if (!live) return;
  live.body.innerHTML = mdLite(live.text);
  live.reasoning.innerHTML = mdLite(live.reason);
  live = null;
}

// tool entries
const tools = new Map();
function toolEntry(callId, name, preview) {
  const det = document.createElement('details');
  det.className = 'tool';
  det.innerHTML = '<summary><span class="tname"></span><span class="tstate">running…</span><span class="dur"></span></summary><div class="detail" style="color:var(--muted);white-space:pre-wrap;word-break:break-all"></div>';
  det.querySelector('.tname').textContent = name;
  det.querySelector('.detail').textContent = 'args: ' + (preview || '');
  feed.appendChild(det); scrollDown();
  tools.set(callId, { det, name });
  return tools.get(callId);
}
function toolResult(callId, isError, summary, durationMs) {
  const t = tools.get(callId);
  if (!t) return;
  t.det.classList.toggle('error', !!isError);
  t.det.querySelector('.tstate').textContent = isError ? 'error' : 'done';
  t.det.querySelector('.dur').textContent = durationMs !== undefined ? Math.round(durationMs) + ' ms' : '';
  if (summary) t.det.querySelector('.detail').textContent += '\\nresult: ' + summary;
}

// approval cards
const approvals = new Map();
function approvalCard(id, toolName, summary) {
  const div = document.createElement('div');
  div.className = 'approval';
  div.innerHTML = '<div class="q"></div><div class="s"></div><div class="actions"><button class="primary">Allow</button> <button>Deny</button></div><div class="outcome" style="display:none"></div>';
  div.querySelector('.q').textContent = 'Approval requested: ' + toolName;
  div.querySelector('.s').textContent = summary || '';
  const [allow, deny] = div.querySelectorAll('button');
  const decide = async (decision) => {
    const r = await apiJson('/approvals/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ decision }) });
    if (r.status !== 200) settle(decision === 'allow' ? 'error' : 'error', 'failed: ' + (r.data?.error ?? r.status));
  };
  allow.onclick = () => decide('allow');
  deny.onclick = () => decide('deny');
  const settle = (outcome, note) => {
    div.querySelector('.actions').style.display = 'none';
    const out = div.querySelector('.outcome');
    out.style.display = 'block';
    out.textContent = note ? note : 'settled: ' + outcome;
    if (outcome === 'allowed-once' || outcome === 'allowed') out.textContent = 'allowed';
    if (outcome === 'rejected' || outcome === 'denied') out.textContent = 'denied';
    if (outcome === 'cancelled') out.textContent = 'cancelled';
    approvals.delete(id);
  };
  feed.appendChild(div); scrollDown();
  approvals.set(id, { div, settle });
  return approvals.get(id);
}

// ---- session + SSE -------------------------------------------------------
let sessionId = '';
try { sessionId = localStorage.getItem('smart-chat.sessionId') ?? ''; } catch {}
let es = null;

async function newSession() {
  const r = await apiJson('/sessions', { method: 'POST', body: '{}' });
  if (r.status !== 201) { sysLine('failed to create session: ' + (r.data?.error ?? r.status)); return false; }
  sessionId = r.data.sessionId;
  try { localStorage.setItem('smart-chat.sessionId', sessionId); } catch {}
  feed.innerHTML = '';
  openEvents();
  return true;
}

function openEvents() {
  if (es) { es.close(); es = null; }
  const url = PREFIX + '/events?sessionId=' + encodeURIComponent(sessionId) + (token ? '&token=' + encodeURIComponent(token) : '');
  es = new EventSource(url);
  connDot.classList.remove('ok');
  es.addEventListener('ready', () => { connDot.classList.add('ok'); const h = $('hint'); if (h) h.remove(); });
  es.addEventListener('assistant_delta', (ev) => {
    const d = JSON.parse(ev.data);
    const node = startAssistant();
    if (d.delta !== undefined) node.text += d.delta;
    if (d.reasoning !== undefined) { node.reasoning.style.display = 'block'; node.reason += d.reasoning; }
    node.body.textContent = node.text;
    node.reasoning.textContent = node.reason;
    scrollDown();
  });
  es.addEventListener('tool_call', (ev) => {
    const d = JSON.parse(ev.data);
    toolEntry(d.callId, d.name, d.argsPreview);
  });
  es.addEventListener('tool_result', (ev) => {
    const d = JSON.parse(ev.data);
    toolResult(d.callId, d.isError, d.summary, d.durationMs);
  });
  es.addEventListener('approval_required', (ev) => {
    const d = JSON.parse(ev.data);
    approvalCard(d.approvalId, d.toolName, d.summary);
  });
  es.addEventListener('approval_resolved', (ev) => {
    const d = JSON.parse(ev.data);
    const a = approvals.get(d.approvalId);
    if (a) a.settle(d.outcome);
  });
  es.addEventListener('turn_done', (ev) => {
    // A completed (non-error) turn answers the in-flight message; an errored
    // one (e.g. mid-turn 401) leaves it eligible for the post-login continue.
    let reason = '';
    try { reason = String((JSON.parse(ev.data) ?? {}).reason ?? ''); } catch {}
    if (reason !== 'error') lastSent.answered = true;
    endAssistant(); connDot.classList.add('ok');
  });
  es.addEventListener('credential_required', (ev) => {
    const d = JSON.parse(ev.data);
    if (!lastSent.answered && lastSent.text !== '') pendingAuthMessage = lastSent.text;
    const stored = mcpTokens[d.serverName];
    if (stored && !tokenTried.has(d.serverName)) void submitServerCredential(d.serverName, stored, true);
    else void promptServerCredential(d.serverName, d.reason);
  });
  es.addEventListener('error', (ev) => {
    if (ev.data) {
      const d = JSON.parse(ev.data);
      sysLine(d.message || 'error');
      if (d.code === 'session-not-found') { void newSession(); }
    }
    connDot.classList.remove('ok');
  });
}

// ---- composer ------------------------------------------------------------
async function send() {
  const text = input.value.trim();
  if (!text || !sessionId) return;
  input.value = '';
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="who">you</div><div class="body"></div>';
  div.querySelector('.body').textContent = text;
  feed.appendChild(div); scrollDown();
  lastSent = { text, answered: false };
  try {
    const r = await apiJson('/messages', { method: 'POST', body: JSON.stringify({ sessionId, text }) });
    if (r.status === 409 && r.data?.code === 'credentials-required') {
      // Input-time gate: hold the message, open the login dialog; it
      // continues automatically after a successful login.
      pendingAuthMessage = text;
      const servers = r.data.servers ?? [];
      void promptServerCredential(servers[0] ?? 'MCP server', (r.data.error ?? 'login required') + ' — your message continues automatically after login.');
      return;
    }
    if (r.status !== 202) sysLine('message rejected: ' + (r.data?.error ?? r.status));
  } catch (err) {
    sysLine('send failed: ' + (err && err.message ? err.message : String(err)));
  }
}
$('btn-send').onclick = () => { void send(); };
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); }
});
$('btn-stop').onclick = async () => {
  await api('/sessions/' + encodeURIComponent(sessionId) + '/cancel', { method: 'POST', body: '{}' });
};
$('btn-new').onclick = () => { void newSession(); };
$('btn-reconnect').onclick = () => { if (sessionId) openEvents(); };

// ---- servers bar ----------------------------------------------------------
let lastServers = [];
let serverBarError = '';
async function pollServers() {
  try {
    const r = await apiJson('/servers.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status + (r.data?.error ? ': ' + r.data.error : ''));
    serverBarError = '';
    lastServers = r.data.servers ?? [];
  } catch (err) {
    serverBarError = err && err.message ? err.message : String(err);
  }
  if (serverBarError) { $('serverbar').textContent = 'servers: error — ' + serverBarError; return; }
  const up = lastServers.filter((s) => s.state === 'connected').length;
  const tools = lastServers.reduce((n, s) => n + (s.toolCount ?? 0), 0);
  $('serverbar').textContent = 'servers: ' + up + '/' + lastServers.length + ' up, ' + tools + ' tools';
  renderServers();
}
function renderServers() {
  const rows = $('srvrows');
  rows.innerHTML = '';
  for (const s of lastServers) {
    const row = document.createElement('div');
    row.className = 'row';
    const needsToken = s.auth && s.auth.required;
    row.innerHTML = '<span class="tname"></span><span class="state"></span><span></span>'
      + (needsToken ? '<button class="tok">token…</button>' : '')
      + '<button class="rm">remove</button>';
    row.querySelector('.tname').textContent = s.serverName;
    const st = row.querySelector('.state');
    st.textContent = needsToken ? 'needs login' : s.state;
    st.className = 'state ' + (needsToken ? 'failed' : s.state);
    row.children[2].textContent = (s.toolCount ?? 0) + ' tools' + (s.error ? ' — ' + s.error : '');
    if (needsToken) row.querySelector('.tok').onclick = () => { void promptServerCredential(s.serverName, s.auth.reason); };
    row.querySelector('.rm').onclick = () => { void replaceServers(lastServers.filter((x) => x.serverName !== s.serverName).map((x) => x.entry)); };
    rows.appendChild(row);
    if (needsToken) void maybeAutoSubmit(s.serverName);
  }
}
async function replaceServers(list) {
  try {
    const r = await apiJson('/servers', { method: 'POST', body: JSON.stringify({ servers: list }) });
    if (r.status !== 200) sysLine('server list update failed: ' + (r.data?.error ?? r.status));
    else await pollServers();
  } catch (err) {
    sysLine('server list update failed: ' + (err && err.message ? err.message : String(err)));
  }
}
$('btn-servers').onclick = () => { $('panel').classList.toggle('open'); void pollServers(); };
$('addform').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const name = f.serverName.value.trim();
  const entry = { serverName: name, transport: f.transport.value };
  const kv = {};
  for (const line of (f.kv.value || '').split(/\\n|,/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (Object.keys(kv).length) {
    if (entry.transport === 'stdio') entry.env = kv; else entry.headers = kv;
  }
  if (entry.transport === 'streamable-http') { entry.url = f.url.value.trim(); }
  else { entry.command = f.command.value.trim(); entry.args = (f.args.value || '').split(',').map((s) => s.trim()).filter(Boolean); }
  const list = lastServers.filter((x) => x.serverName !== name).map((x) => x.entry);
  list.push(entry);
  await replaceServers(list);
  f.reset(); f.transport.value = 'streamable-http'; syncTransport();
});
function syncTransport() {
  const t = $('addform').transport.value;
  $('addform').url.style.display = t === 'streamable-http' ? '' : 'none';
  $('addform').command.style.display = t === 'stdio' ? '' : 'none';
  $('addform').args.style.display = t === 'stdio' ? '' : 'none';
}
$('addform').transport.addEventListener('change', syncTransport);
syncTransport();
setInterval(() => { void pollServers(); }, 3000);

// ---- boot -----------------------------------------------------------------
(async () => {
  try {
    if (!sessionId || !(await reuseSession())) await newSession();
  } catch (err) {
    sysLine('startup failed: ' + (err && err.message ? err.message : String(err)));
  }
  void pollServers().catch(() => {});
})();
async function reuseSession() {
  // Probe the stream; if the bridge no longer knows the session it tells us.
  return new Promise((resolve) => {
    const probe = new EventSource(PREFIX + '/events?sessionId=' + encodeURIComponent(sessionId) + (token ? '&token=' + encodeURIComponent(token) : ''));
    let ok = false;
    probe.addEventListener('ready', () => { ok = true; probe.close(); openEvents(); resolve(true); });
    probe.addEventListener('error', (ev) => {
      if (ok) return;
      probe.close();
      resolve(ev.data && ev.data.includes && ev.data.includes('session-not-found') ? false : true);
    });
    setTimeout(() => { if (!ok) { probe.close(); resolve(true); } }, 2500);
  });
}
</script>
</body>
</html>
`
}
