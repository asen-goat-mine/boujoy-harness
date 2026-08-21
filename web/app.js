"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Match the upstream runtime's tail-window contract. Older pages are fetched
// on demand when the reader reaches the top, so a delivery repair never drops
// messages that were already visible.
const HISTORY_FETCH_LIMIT = 50;

const state = {
  page: "agent",
  theme: localStorage.getItem("boujoy-theme") || "dark",
  mode: "knowledge",
  host: null,
  sessions: [],
  workspaces: [],
  archivedSessionIds: [],
  sessionId: null,
  workspaceId: null,
  history: [],
  projection: null,
  models: [],
  modelDirectory: null,
  presets: [],
  pendingImages: [],
  attachmentUrls: new Map(),
  attachmentLoads: new Map(),
  attachmentGeneration: 0,
  knowledge: [],
  knowledgeLoading: false,
  knowledgeFilter: "all",
  knowledgeSearchQuery: "",
  knowledgeSearchPaths: [],
  records: { expert: [], style: [] },
  loadingHistory: false,
  historyHasMore: false,
  historyLoadingOlder: false,
  historyLoadToken: 0,
  sending: false,
  poll: null,
  lastHistorySignature: "",
  eventSources: [],
  visibilitySyncBound: false,
  sessionTailSeq: new Map(),
  sessionSubscribedLastSeq: new Map(),
  sessionEventBuffers: new Map(),
  sessionGapRepairs: new Set(),
  sessionProjectionSeq: new Map(),
  pendingInterrupts: [],
  lastInterruptShownAt: 0,
  resolvingInterrupt: false,
  userScrolledUp: false,
  lastManualScrollAt: 0,
  restoringConversationScroll: false,
  scrollRestoreGeneration: 0,
  pendingPermission: null,
  running: false,
  busyMode: localStorage.getItem("boujoy-busy-mode") || "steer",
  pendingSubmissions: [],
  liveResponse: null,
  livePumpTimer: null,
  liveScrollFrame: null,
  readerPath: null,
  readerStack: [],
  queue: [],
  subagents: [],
  sessionSearchResults: null,
  sessionSearchToken: 0,
};

const PAGE_META = {
  agent: ["LIVE / 01", "AGENT 执行现场"],
  knowledge: ["LOCAL / 02", "知识库 第二大脑"],
  experts: ["ROSTER / 03", "专家 调用阵容"],
  styles: ["VOICE / 04", "风格 输出声线"],
  monitor: ["GAUGE / 05", "运行监控"],
  news: ["FEED / 06", "AI 新闻与工具"],
};

const KIND_META = {
  project: { label: "项目", icon: "P" },
  knowledge: { label: "知识", icon: "K" },
  content: { label: "内容", icon: "C" },
  prompt: { label: "提示词", icon: ">" },
  business: { label: "商业", icon: "B" },
  skill: { label: "Skill", icon: "S" },
  system: { label: "系统", icon: "#" },
  other: { label: "文件", icon: "M" },
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

// Markdown content comes from local files and model output. Keep rendered
// links useful without allowing an untrusted card to turn a click into a
// javascript:, data:, or file: navigation.
function safeHttpHref(value = "") {
  const raw = String(value).trim();
  if (raw.startsWith("#")) return escapeHtml(raw);
  try {
    const parsed = new URL(raw, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? escapeHtml(parsed.href)
      : "#";
  } catch (_) {
    return "#";
  }
}

const MESSAGE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const MESSAGE_VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);
const MESSAGE_MEDIA_EXTENSION_PATTERN = "(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v)";
const BOUJOY_MEDIA_PREVIEW_INTENT = /(?:(?:视频|成片|影片|图片|图像|截图|mp4|mov|webm).{0,30}(?:看|播放|显示|预览|找|打开|发|给)|(?:看|播放|显示|预览|找|打开|发|给).{0,30}(?:视频|成片|影片|图片|图像|截图|mp4|mov|webm))/i;

function withBoujoyMediaGuidance(text = "") {
  const source = String(text);
  if (!source || !BOUJOY_MEDIA_PREVIEW_INTENT.test(source)) return source;
  const guidance = [
    "<!-- BOUJOY_MEDIA_START -->",
    "内部执行规则，不要在回复中引用。",
    "本轮直接使用文件或搜索工具查找用户指定的图片或视频；不要先写确认语、道歉或进度说明。",
    "找到后只给简短结果，并将每个真实文件的绝对路径单独成行。不要解释界面、路径规则或另起 HTTP 服务。",
    "找不到时只说明实际搜索过的位置，不编造路径。",
    "<!-- BOUJOY_MEDIA_END -->",
  ].join("\n");
  return `${guidance}\n${source}`;
}

function messageMediaKind(source = "") {
  const clean = String(source).split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  const extension = match?.[1]?.toLowerCase() || "";
  if (MESSAGE_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (MESSAGE_VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

function normalizeMessageMediaSource(rawSource, name = "", { allowRelative = false } = {}) {
  let source = String(rawSource || "").trim().replace(/^<|>$/g, "");
  if (!source) return null;
  try { source = decodeURIComponent(source); } catch (_) {}
  const kind = messageMediaKind(source);
  if (!kind) return null;
  if (/^https?:\/\//i.test(source)) return { kind, src: source, name: name || source.split("/").pop().split(/[?#]/, 1)[0] };
  if (/^file:\/\//i.test(source)) {
    try { source = decodeURIComponent(new URL(source).pathname); } catch (_) { return null; }
  }
  const isLocal = source.startsWith("/") || /^[a-z]:[\\/]/i.test(source) || allowRelative;
  return isLocal ? { kind, path: source, name: name || source.replaceAll("\\", "/").split("/").pop() } : null;
}

function mediaFromText(value = "", { kinds = ["image", "video"] } = {}) {
  const text = String(value);
  const media = [];
  const add = (source, name = "", options = {}) => {
    const item = normalizeMessageMediaSource(source, name, options);
    if (item && kinds.includes(item.kind)) media.push(item);
  };
  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) add(match[2], match[1], { allowRelative: true });
  for (const match of text.matchAll(new RegExp(`https?:\\/\\/[^\\s<>"']+?\\.${MESSAGE_MEDIA_EXTENSION_PATTERN}(?:\\?[^\\s<>"']*)?`, "gi"))) add(match[0]);
  const unixPath = new RegExp(`(?:^|[\\s(\\[{'"=\\x60：，。；、！？])((?:file:\\/\\/\\/|\\/(?:Users|home|Volumes|tmp|private|var|opt|mnt|media|srv|workspace|workspaces)\\/)[^<>"'\\r\\n]*?\\.${MESSAGE_MEDIA_EXTENSION_PATTERN})`, "gim");
  for (const match of text.matchAll(unixPath)) add(match[1]);
  for (const match of text.matchAll(new RegExp(`[a-z]:\\\\[^<>"'\\r\\n]*?\\.${MESSAGE_MEDIA_EXTENSION_PATTERN}`, "gi"))) add(match[0]);
  const seen = new Set();
  return media.filter(item => {
    const key = `${item.kind}:${item.src || item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mediaFromContent(content, { textKinds = ["image", "video"] } = {}) {
  const media = [];
  const visit = part => {
    if (typeof part === "string") { media.push(...mediaFromText(stripRecallInjection(part), { kinds: textKinds })); return; }
    if (!part || typeof part !== "object") return;
    if (["text", "input_text", "output_text"].includes(part.type)) media.push(...mediaFromText(stripRecallInjection(part.text), { kinds: textKinds }));
    if (String(part.type || "").includes("image")) {
      const attachment = part.attachment || part.ref;
      if (attachment?.attachmentId) {
        media.push({ kind: "image", attachmentId: String(attachment.attachmentId), mediaType: attachment.mediaType, name: attachment.name || part.name || "图片", width: attachment.width, height: attachment.height });
      } else if (part.data && /^image\/(png|jpeg|webp|gif)$/i.test(part.mediaType || "")) {
        media.push({ kind: "image", src: `data:${part.mediaType};base64,${part.data}`, name: part.name || "图片" });
      } else {
        const item = normalizeMessageMediaSource(part.url || part.path || "", part.name || "", { allowRelative: true });
        if (item) media.push(item);
      }
    }
    if (String(part.type || "").includes("video")) {
      const item = normalizeMessageMediaSource(part.url || part.path || "", part.name || "视频", { allowRelative: true });
      if (item) media.push(item);
    }
    if (Array.isArray(part.content)) part.content.forEach(visit);
  };
  (Array.isArray(content) ? content : [content]).forEach(visit);
  const seen = new Set();
  return media.filter(item => {
    const key = item.attachmentId ? `attachment:${item.attachmentId}` : `${item.kind}:${item.src || item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripRenderedMediaMarkdown(value = "") {
  return String(value).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, _label, source) => messageMediaKind(source.trim()) ? "" : whole).trim();
}

function stripMarkdown(value = "") {
  return String(value)
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~\-|]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function markdown(value = "") {
  const codeBlocks = [];
  const tableBlocks = [];
  let text = String(value).replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const clean = code.trim();
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    codeBlocks.push(`<div class="code-block"><div class="code-head">${langLabel}<button type="button" class="code-copy" data-code="${escapeHtml(clean)}" title="复制代码">⧉ 复制</button></div><pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(clean)}</code></pre></div>`);
    return `\n@@CODE${codeBlocks.length - 1}@@\n`;
  });
  text = escapeHtml(text)
    // GFM tables: extract whole blocks before line transforms so pipes and
    // separator rows are never mangled by the list/paragraph rules below.
    .replace(/((?:^\|.*\|\s*$\n?)+)/gm, block => {
      const lines = block.trim().split("\n").map(line => line.trim().replace(/^\|/, "").replace(/\|$/, ""));
      if (lines.length < 2) return block;
      const parseRow = line => line.split("|").map(cell => cell.trim());
      const header = parseRow(lines[0]);
      const sep = parseRow(lines[1]);
      if (!sep.every(cell => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, "")))) return block;
      const align = sep.map(cell => { const c = cell.replace(/\s+/g, ""); return c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""; });
      const cellHtml = cell => cell
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${safeHttpHref(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      const html = `<div class="markdown-table"><table><thead><tr>${header.map((h, i) => `<th${align[i] ? ` style="text-align:${align[i]}"` : ""}>${cellHtml(h)}</th>`).join("")}</tr></thead><tbody>${lines.slice(2).map(row => `<tr>${parseRow(row).map((cell, i) => `<td${align[i] ? ` style="text-align:${align[i]}"` : ""}>${cellHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      tableBlocks.push(html);
      return `\n@@TABLE${tableBlocks.length - 1}@@\n`;
    })
    .replace(/^###### (.+)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.+)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^[-*] \[x\] (.+)$/gim, "<p>☑ $1</p>")
    .replace(/^[-*] \[ \] (.+)$/gim, "<p>☐ $1</p>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${safeHttpHref(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
  text = `<p>${text}</p>`
    .replace(/<p>\s*(<h[1-6]>)/g, "$1")
    .replace(/(<\/h[1-6]>)\s*<\/p>/g, "$1")
    .replace(/<p>\s*(<pre>)/g, "$1")
    .replace(/(<\/pre>)\s*<\/p>/g, "$1")
    .replace(/(?:<li>.*?<\/li>(?:<br>)?)+/gs, match => `<ul>${match.replaceAll("<br>", "")}</ul>`);
  text = text.replace(/<br>@@TABLE(\d+)@@<br>/g, (_, index) => tableBlocks[Number(index)] ?? "");
  tableBlocks.forEach((block, index) => { text = text.replace(`@@TABLE${index}@@`, block); });
  codeBlocks.forEach((block, index) => { text = text.replace(`@@CODE${index}@@`, block); });
  return linkifyHtml(text);
}

function linkifyHtml(html = "") {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const urlPattern = /https?:\/\/[^\s<>"'，。；、！？）\]]+/gi;
  for (const node of nodes) {
    if (node.parentElement?.closest("a, code, pre")) continue;
    const value = node.nodeValue || "";
    const matches = [...value.matchAll(urlPattern)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      fragment.append(document.createTextNode(value.slice(cursor, match.index)));
      const link = document.createElement("a");
      link.href = match[0];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[0];
      fragment.append(link);
      cursor = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(value.slice(cursor)));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}

function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.textContent = message;
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), 3600);
}

// The product page is served from the Harness origin (3080) so the event
// WebSocket is same-origin and passes Harness's origin check. All knowledge /
// RPC APIs live on the local gateway (8766) and are addressed absolutely.
// Same-origin API base: on the desktop the page is served from
// http://127.0.0.1:8766, and on a phone from http://<Mac-LAN-IP>:8766 — in
// both cases the API lives right beside the page, so relative is correct and
// portable. (A hard-coded 127.0.0.1 would point the phone at itself.)
const API_ORIGIN = "";

async function jsonFetch(url, options = {}, timeoutMs = 15000) {
  const absolute = String(url).startsWith("http") ? url : `${API_ORIGIN}${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Phone/remote access: attach the remembered code so the gateway accepts
  // the call. Loopback (desktop) requests are always allowed regardless.
  const headers = new Headers(options.headers || {});
  const stored = localStorage.getItem("boujoy-access-code") || "";
  if (stored) headers.set("X-Boujoy-Access", stored);
  const request = { cache: "no-store", signal: controller.signal, ...options, headers };
  try {
    const response = await fetch(absolute, request);
    // Remote access without a code (or with a wrong one): prompt once, save,
    // and retry the same request. Local calls never hit this path.
    if (response.status === 401) {
      const code = window.prompt("Boujoy 手机访问需要访问码（在 Mac 桌面 Boujoy-访问码.txt 中查看）：");
      if (!code) throw new Error("未输入访问码");
      localStorage.setItem("boujoy-access-code", code.trim());
      request.headers = new Headers(options.headers || {});
      request.headers.set("X-Boujoy-Access", code.trim());
      const retry = await fetch(absolute, request);
      const retryData = await retry.json().catch(() => ({ ok: false, error: `HTTP ${retry.status}` }));
      if (!retry.ok || retryData.ok === false) {
        if (retry.status === 401) { localStorage.removeItem("boujoy-access-code"); throw new Error("访问码错误"); }
        throw new Error(retryData.error || `HTTP ${retry.status}`);
      }
      return retryData;
    }
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function rpcId() {
  return globalThis.crypto?.randomUUID?.() || `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function rpc(method, payload = {}, mode = state.mode, requestId = null) {
  const request = { type: "client-request", rpcId: requestId || rpcId(), method, payload };
  const response = await jsonFetch(`/api/harness/${mode}/${encodeURIComponent(method)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.result?.ok === false) throw new Error(response.result.error?.message || response.result.error || `${method} 失败`);
  return response.result?.value ?? response.value ?? response;
}

// Remote commands (such as /permission) use the commands/execute transport.
// Sending their text as a normal prompt only talks to the model and does not
// update Harness state, so this path deliberately bypasses session.prompt.
async function remoteCommand(line, mode = state.mode) {
  if (!state.sessionId) throw new Error("请先创建会话");
  const method = "commands/execute";
  const request = { type: "client-request", rpcId: rpcId(), method, payload: { args: { agentId: state.sessionId, line } } };
  const response = await jsonFetch(`/api/harness/${mode}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.result?.ok === false) throw new Error(response.result.error?.message || response.result.error || `${line} 失败`);
  return response.result?.value ?? response.value ?? response;
}

async function respondToServer(rpcIdValue, value, mode = state.mode) {
  // Keep the diagnostic useful without printing a user's answer or approval
  // payload into the Web Inspector.
  console.debug("[Boujoy] respondToServer", { rpcId: rpcIdValue, mode, valueKind: typeof value });
  const body = { type: "client-response", rpcId: rpcIdValue, result: { ok: true, value } };
  const headers = { "Content-Type": "application/json" };
  const code = localStorage.getItem("boujoy-access-code") || "";
  if (code) headers["X-Boujoy-Access"] = code;
  const response = await fetch(`/api/harness/${mode}/respond`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const receipt = await response.json().catch(() => ({ accepted: false }));
  if (!response.ok || receipt.accepted === false) throw new Error("交互响应未被 Agent 接收");
  return receipt;
}

function closeEventSources() {
  state.eventSources.forEach(entry => {
    try {
      entry.intentionalClose = true;
      (entry.socket || entry).close();
    } catch (_) {}
  });
  state.eventSources = [];
}

function connectEvents() {
  closeEventSources();
  // WebSocket events go through the local gateway (8766) which relays to the
  // Harness event streams. Each stream reconnects INDEPENDENTLY: if mux (the
  // approval/question channel) drops while host stays up, a single shared
  // "reconnect when all closed" check would never fire and interrupts would
  // silently stop arriving. Track per-endpoint and retry on its own close.
  for (const endpoint of ["events.mux", "events.host"]) {
    connectEventStream(endpoint);
  }
}

function connectEventStream(endpoint) {
  // Reconnect timers and visibility changes can race. Retire any older socket
  // for this endpoint first; otherwise one upstream event is rendered once per
  // surviving socket and live text appears doubled or tripled.
  state.eventSources.filter(item => item.endpoint === endpoint).forEach(item => {
    item.intentionalClose = true;
    try { item.socket.close(); } catch (_) {}
  });
  const socket = new WebSocket(`ws://${location.host}/api/harness/${state.mode}/${endpoint}?access=${encodeURIComponent(localStorage.getItem("boujoy-access-code") || "")}`);
  const entry = { endpoint, socket, intentionalClose: false };
  state.eventSources = state.eventSources.filter(item => item.endpoint !== endpoint);
  state.eventSources.push(entry);
  socket.onmessage = event => {
    try { handleServerFrame(JSON.parse(String(event.data))); } catch (_) { /* malformed push */ }
  };
  socket.onclose = () => {
    state.eventSources = state.eventSources.filter(item => item !== entry);
    if (entry.intentionalClose) return;
    // Disconnect banner with a grace delay: brief reconnects (network blips,
    // gateway restarts) must not flash the banner. Show it only if the mux
    // stays down past the grace window; a successful reconnect cancels it.
    if (endpoint === "events.mux") {
      if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
      state.disconnectTimer = setTimeout(() => { showDisconnectBanner(); }, 3000);
    }
    // ALWAYS reconnect, even when the page is hidden: if the mux (approval/
    // question channel) drops while the app sits in the background, skipping
    // the retry here would silently kill every future approval popup. The
    // visibilitychange handler below re-syncs on return to the foreground too.
    setTimeout(() => {
      const replacementExists = state.eventSources.some(item => item.endpoint === endpoint && item.socket.readyState < WebSocket.CLOSING);
      if (!replacementExists) connectEventStream(endpoint);
    }, 1400);
  };
  socket.onopen = () => {
    // After a reconnect, ask the gateway whether interactions are pending:
    // mux replays pending approval/question frames on open, so a fresh socket
    // will surface anything we missed while disconnected.
    if (endpoint === "events.mux") {
      if (state.disconnectTimer) { clearTimeout(state.disconnectTimer); state.disconnectTimer = null; }
      hideDisconnectBanner();
    }
  };
}

function eventStreamConnected(endpoint) {
  return state.eventSources.some(item =>
    item.endpoint === endpoint && item.socket?.readyState === WebSocket.OPEN
  );
}

function sessionEventSeq(entry) {
  return entry?.event?.seq ?? entry?.seq ?? null;
}

function bufferSessionEvent(sessionId, entry) {
  const buffer = state.sessionEventBuffers.get(sessionId) || [];
  const seq = sessionEventSeq(entry);
  if (seq == null || !buffer.some(item => sessionEventSeq(item) === seq)) buffer.push(entry);
  state.sessionEventBuffers.set(sessionId, buffer);
}

function projectionSeqKey(sessionId, key) {
  return `${sessionId}:${key}`;
}

function applySessionProjection(sessionId, key, value, seq) {
  const mapKey = projectionSeqKey(sessionId, key);
  const previousSeq = state.sessionProjectionSeq.get(mapKey);
  if (previousSeq != null && seq <= previousSeq) return;
  state.sessionProjectionSeq.set(mapKey, seq);
  const session = state.sessions.find(item => item.id === sessionId);
  if (session) session.projection = { ...(session.projection || {}), [key]: value };
  if (sessionId === state.sessionId) {
    state.projection = { ...(state.projection || {}), [key]: value };
  }
}

// Mirror upstream ProjectionValueStore.seed/truncate: a stale history page or
// reconnect baseline cannot overwrite a newer pushed projection.
function seedSessionProjections(sessionId, baseline) {
  if (!baseline || !Number.isFinite(Number(baseline.asOfSeq)) || !baseline.values) return false;
  const asOfSeq = Number(baseline.asOfSeq);
  const values = baseline.values;
  for (const [key, value] of Object.entries(values)) applySessionProjection(sessionId, key, value, asOfSeq);
  const session = state.sessions.find(item => item.id === sessionId);
  const targets = [session?.projection];
  if (sessionId === state.sessionId) targets.push(state.projection);
  for (const target of targets.filter(Boolean)) {
    for (const key of Object.keys(target)) {
      if (Object.hasOwn(values, key)) continue;
      const mapKey = projectionSeqKey(sessionId, key);
      if ((state.sessionProjectionSeq.get(mapKey) ?? 0) > asOfSeq) continue;
      delete target[key];
      state.sessionProjectionSeq.delete(mapKey);
    }
  }
  return true;
}

function truncateSessionProjections(sessionId, lastSeq) {
  const prefix = `${sessionId}:`;
  const session = state.sessions.find(item => item.id === sessionId);
  for (const [mapKey, seq] of state.sessionProjectionSeq) {
    if (!mapKey.startsWith(prefix) || seq <= lastSeq) continue;
    state.sessionProjectionSeq.delete(mapKey);
    const key = mapKey.slice(prefix.length);
    if (session?.projection) delete session.projection[key];
    if (sessionId === state.sessionId && state.projection) delete state.projection[key];
  }
}

// Match the upstream Session runtime: seq is the sole dedup key, and a gap is
// never appended. Buffer it and repull a contiguous history tail instead.
function acceptSessionEvent(sessionId, entry) {
  const seq = sessionEventSeq(entry);
  if (seq == null) return true;
  if (state.loadingHistory && sessionId === state.sessionId) {
    bufferSessionEvent(sessionId, entry);
    return false;
  }
  const tailSeq = state.sessionTailSeq.get(sessionId);
  if (tailSeq != null && seq <= tailSeq) return false;
  if (tailSeq != null && seq > tailSeq + 1) {
    bufferSessionEvent(sessionId, entry);
    requestSessionGapRepair(sessionId);
    return false;
  }
  state.sessionTailSeq.set(sessionId, seq);
  return true;
}

function showDisconnectBanner() {
  // Phone-only: on desktop the service pill already reflects connectivity and
  // a floating banner would be noise. Keep it to narrow (mobile) viewports.
  if (window.innerWidth > 820) return;
  let banner = $("#disconnectBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "disconnectBanner";
    banner.className = "disconnect-banner hidden";
    banner.textContent = "⚠ 连接断开 — 检查 Wi-Fi 或 Mac 是否在运行";
    document.body.appendChild(banner);
  }
  banner.classList.remove("hidden");
}

function hideDisconnectBanner() {
  const banner = $("#disconnectBanner");
  if (banner) banner.classList.add("hidden");
}

function handleServerFrame(message) {
  if (message.type !== "server-request") return;
  const frame = message.payload || {};
  if (frame.type === "session/event" && frame.sessionId === state.sessionId) {
    const entry = { event: frame.event, view: frame.view };
    if (!acceptSessionEvent(frame.sessionId, entry)) return;
    landSessionEvent(entry, frame.sessionId);
  } else if (frame.type === "session/subscribed") {
    const lastSeq = Number(frame.lastSeq);
    if (Number.isFinite(lastSeq)) {
      state.sessionSubscribedLastSeq.set(frame.sessionId, lastSeq);
      truncateSessionProjections(frame.sessionId, lastSeq);
      if (frame.sessionId === state.sessionId && state.queue.length) {
        state.queue = [];
        renderQueue();
      }
      const tailSeq = state.sessionTailSeq.get(frame.sessionId);
      if (frame.sessionId === state.sessionId && !state.loadingHistory && tailSeq != null && lastSeq > tailSeq) requestSessionGapRepair(frame.sessionId);
    }
  } else if (frame.type === "session/projection") {
    applySessionProjection(frame.sessionId, frame.key, frame.value, Number(frame.seq) || 0);
    renderSessions();
    if (frame.sessionId === state.sessionId) renderProjection();
  } else if (frame.type === "session/queue" && frame.sessionId === state.sessionId) {
    state.queue = (frame.items || []).filter(item => item.placement !== "context");
    reconcilePendingQueue(state.queue, frame.sessionId);
    // Don't rebuild the whole thread mid-stream: queue churn would reset the
    // reader's scroll position. renderQueue shows the queue state separately.
    if (!state.liveResponse) renderHistory(state.history);
    renderQueue();
  } else if (frame.type === "session/jobs" && frame.sessionId === state.sessionId) {
    $("#toolActivity").innerHTML = (frame.jobs || []).slice().reverse().map(job => `<div class="activity-tool"><strong>${escapeHtml(job.label || job.kind || "后台任务")}</strong><div>${escapeHtml(job.status || "")}${job.detail ? ` · ${escapeHtml(job.detail)}` : ""}</div></div>`).join("") || '<p class="muted">当前没有后台任务。</p>';
  } else if (frame.type === "approval/requested") {
    enqueueInterrupt({ kind: "approval", mode: state.mode, rpcId: message.rpcId, ...frame });
  } else if (frame.type === "question/requested") {
    enqueueInterrupt({ kind: "question", mode: state.mode, rpcId: message.rpcId, ...frame });
  } else if (frame.type === "approval/resolved" || frame.type === "question/resolved") {
    const matchesResolved = item => item.sessionId === frame.sessionId && (
      (frame.type === "approval/resolved" && item.kind === "approval" && item.approvalId === frame.approvalId)
      || (frame.type === "question/resolved" && item.kind === "question" && item.rpcId === frame.questionRpcId)
    );
    if (state.pendingInterrupts.some(matchesResolved)) {
      state.pendingInterrupts = state.pendingInterrupts.filter(item => !matchesResolved(item));
      $("#interruptDialog").close();
      showNextInterrupt();
    }
  } else if (frame.type === "host/session-status") {
    const session = state.sessions.find(item => item.id === frame.sessionId);
    if (session) session.running = frame.running;
    if (!frame.running && state.liveResponse?.sessionId === frame.sessionId && !state.liveResponse.finalEvent) {
      // Status and session events use separate streams, so "stopped" may race
      // a final assistant/message. Never erase the live row here (that causes
      // an end-of-answer blink). If the final event really was missed, repair
      // from persisted history after a short grace period.
      const stoppedLive = state.liveResponse;
      setTimeout(() => {
        const stillStopped = !state.sessions.find(item => item.id === frame.sessionId)?.running;
        if (state.liveResponse === stoppedLive && stillStopped) {
          loadSession(frame.sessionId, { quiet: true }).catch(() => {});
        }
      }, 700);
    }
    renderSessions(); renderProjection();
  } else if (frame.type === "host/session-added" || frame.type === "host/session-removed") {
    refreshSessions({ quiet: true });
  } else if (frame.type === "host/workspace-changed") {
    const normalized = normalizeWorkspaces({ items: [frame.workspace] })[0];
    const index = state.workspaces.findIndex(item => item.id === normalized.id);
    if (index >= 0) state.workspaces[index] = normalized; else state.workspaces.push(normalized);
    renderWorkspaces(); renderSessions();
  } else if (frame.type === "host/agent-error") {
    toast(frame.message || "Agent 运行错误", true);
  }
}

function landSessionEvent(entry, sessionId) {
  acknowledgeSteeringEvent(entry, sessionId);
  const isTransientChunk = updateLiveResponse(entry, sessionId);
  // Text deltas can arrive many times per second. Keep the in-progress text
  // in one live buffer instead of inflating history and rebuilding it for
  // every token. The final assistant/message remains the persisted source.
  if (!isTransientChunk) {
    state.history.push(entry);
    // While a live response is streaming, avoid full-list rebuilds for every
    // tool/thinking event. The final persisted message lands once.
    if (!state.liveResponse) renderHistory(state.history);
  }
}

function stitchBufferedSessionEvents(sessionId) {
  if (sessionId !== state.sessionId || state.loadingHistory) return;
  const buffered = (state.sessionEventBuffers.get(sessionId) || [])
    .slice()
    .sort((left, right) => (sessionEventSeq(left) ?? 0) - (sessionEventSeq(right) ?? 0));
  state.sessionEventBuffers.delete(sessionId);
  for (let index = 0; index < buffered.length; index += 1) {
    const entry = buffered[index];
    const seq = sessionEventSeq(entry);
    const tailSeq = state.sessionTailSeq.get(sessionId);
    if (seq != null && tailSeq != null && seq <= tailSeq) continue;
    if (seq != null && tailSeq != null && seq > tailSeq + 1) {
      buffered.slice(index).forEach(item => bufferSessionEvent(sessionId, item));
      requestSessionGapRepair(sessionId);
      return;
    }
    if (seq != null) state.sessionTailSeq.set(sessionId, seq);
    landSessionEvent(entry, sessionId);
  }
}

async function requestSessionGapRepair(sessionId) {
  if (sessionId !== state.sessionId || state.sessionGapRepairs.has(sessionId)) return;
  state.sessionGapRepairs.add(sessionId);
  try {
    await loadSession(sessionId, { quiet: true });
  } finally {
    state.sessionGapRepairs.delete(sessionId);
    if ((state.sessionEventBuffers.get(sessionId) || []).length) {
      queueMicrotask(() => requestSessionGapRepair(sessionId));
    }
  }
}

function enqueueInterrupt(interrupt) {
  // Same rpcId = duplicate broadcast; ignore. Otherwise append to the queue and
  // show the next one (approval and question can arrive back-to-back for one
  // escalated action; a single slot would silently drop one and stall the agent).
  if (state.pendingInterrupts.some(item => item.rpcId === interrupt.rpcId)) return;
  state.pendingInterrupts.push(interrupt);
  showNextInterrupt();
}

function showNextInterrupt() {
  const pending = state.pendingInterrupts[0];
  if (!pending) {
    $("#pendingInterruptBar").classList.add("hidden");
    renderProjection();  // restore runState to normal running/idle
    return;
  }
  // If the dialog is already open the user is mid-decision on an earlier
  // approval/question. Do NOT yank it away to surface the new one: that
  // steals the user's focus mid-read and risks approving the wrong item.
  // The newcomer stays in the queue and the waiting bar shows the count;
  // it pops up naturally after the current one is resolved.
  if ($("#interruptDialog").open) {
    showPendingInterruptBar(pending.kind);
    return;
  }
  if (pending.kind === "approval") {
    $("#interruptKicker").textContent = "PERMISSION REQUEST";
    $("#interruptTitle").textContent = "Agent 请求操作许可";
    $("#interruptBody").innerHTML = `<strong>${escapeHtml(pending.toolName || "工具操作")}</strong>${pending.reason ? `<p>${escapeHtml(pending.reason)}</p>` : ""}<small>会话：${escapeHtml(sessionTitle(state.sessions.find(item => item.id === pending.sessionId) || {}))}</small>`;
    $("#interruptReject").textContent = "拒绝";
    $("#interruptAllow").textContent = "允许一次";
  } else {
    $("#interruptKicker").textContent = "AGENT NEEDS YOUR CHOICE";
    $("#interruptTitle").textContent = "Agent 需要你决定";
    $("#interruptBody").innerHTML = (pending.questions || []).map(question => `
      <section class="interrupt-question" data-question-id="${escapeHtml(question.id)}" data-multi="${Boolean(question.multiSelect)}">
        ${question.header ? `<small>${escapeHtml(question.header)}</small>` : ""}<h3>${escapeHtml(question.question)}</h3>${question.detail ? `<p>${markdown(question.detail)}</p>` : ""}
        <div class="interrupt-options">${(question.options || []).map(option => `<label class="interrupt-option"><input type="${question.multiSelect ? "checkbox" : "radio"}" name="question-${escapeHtml(question.id)}" value="${escapeHtml(option.label)}"><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}<label class="interrupt-option"><input type="${question.multiSelect ? "checkbox" : "radio"}" name="question-${escapeHtml(question.id)}" value="__custom"><span><strong>其他</strong><input class="interrupt-custom" placeholder="输入你的回答"></span></label></div>
      </section>`).join("");
    $("#interruptReject").textContent = "稍后回答";
    $("#interruptAllow").textContent = "提交回答";
  }
  showPendingInterruptBar(pending.kind);
  // Throttle: never re-pop the dialog more than once per second. A burst of
  // duplicate/queued interrupts (or mux replay after a reconnect) used to
  // close+reopen the modal repeatedly, which looks like the dialog "bouncing".
  const now = Date.now();
  if (state.lastInterruptShownAt && now - state.lastInterruptShownAt < 1000) {
    return;
  }
  state.lastInterruptShownAt = now;
  // Force the dialog visible: if a previous interrupt left it open (or the
  // modal state is stale), showModal on an open dialog is a no-op and the new
  // question would never surface. Close first, then reopen.
  try { if ($("#interruptDialog").open) $("#interruptDialog").close(); } catch (_) {}
  $("#interruptDialog").showModal();
}

// Persistent, re-clickable notice so a pending approval/question can never
// silently stall the agent: the bar stays visible until resolved, shows how
// many interactions are waiting, and clicking it re-opens the dialog.
function showPendingInterruptBar(kind) {
  const bar = $("#pendingInterruptBar");
  const total = state.pendingInterrupts.length;
  const approvals = state.pendingInterrupts.filter(i => i.kind === "approval").length;
  const questions = state.pendingInterrupts.filter(i => i.kind === "question").length;
  const parts = [];
  if (approvals) parts.push(`${approvals} 个审批`);
  if (questions) parts.push(`${questions} 个提问`);
  bar.classList.remove("hidden");
  bar.textContent = `⚠ Agent 正在等你处理：${parts.join(" + ") || "交互"}（不处理任务会卡住，点击查看）`;
  bar.dataset.count = String(total);
  const runState = $("#runState");
  if (runState) {
    runState.className = "run-state waiting";
    const span = runState.querySelector("span");
    if (span) span.textContent = "等你处理";
  }
}

async function resolveInterrupt(allow) {
  const pending = state.pendingInterrupts[0];
  if (!pending || state.resolvingInterrupt) return;
  if (pending.kind === "question" && !allow) {
    // "稍后回答" defers this question: move it to the back of the queue so a
    // newer interrupt (approval/question) can surface instead of being blocked
    // forever behind a deferred item.
    state.pendingInterrupts.shift();
    state.pendingInterrupts.push(pending);
    $("#interruptDialog").close();
    showNextInterrupt();
    return;
  }
  state.resolvingInterrupt = true;
  try {
    if (pending.kind === "approval") {
      await respondToServer(pending.rpcId, { sessionId: pending.sessionId, approvalId: pending.approvalId, outcome: allow ? "allowed-once" : "rejected" }, pending.mode);
    } else {
      const answers = $$(".interrupt-question", $("#interruptBody")).map(section => {
        const selected = $$('input[type="radio"]:checked,input[type="checkbox"]:checked', section).map(input => input.value).filter(value => value !== "__custom");
        const customSelected = $('input[value="__custom"]', section)?.checked;
        const custom = customSelected ? $(".interrupt-custom", section)?.value.trim() : "";
        return { id: section.dataset.questionId, selected, ...(custom ? { custom } : {}) };
      });
      if (answers.some(answer => !answer.selected.length && !answer.custom)) { toast("每个问题都需要一个回答", true); return; }
      await respondToServer(pending.rpcId, { sessionId: pending.sessionId, answer: { answers } }, pending.mode);
    }
    state.pendingInterrupts.shift();
    $("#interruptDialog").close();
    showNextInterrupt();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const staleResponse = /not[-\s]?pending|not pending/i.test(message);
    if (staleResponse && state.pendingInterrupts[0]?.rpcId === pending.rpcId) {
      // The Harness already dropped this RPC during a reconnect/timeout. It
      // cannot be answered anymore, so discard only this stale entry and keep
      // the rest of the queue usable.
      state.pendingInterrupts.shift();
      try { if ($("#interruptDialog").open) $("#interruptDialog").close(); } catch (_) {}
      state.lastInterruptShownAt = 0;
      showNextInterrupt();
      toast("这条请求已失效，已继续处理下一项", true);
    } else {
      // A transport error may still be retryable. Close the modal so it never
      // traps the user, retain the request in the persistent bar for retry.
      try { if ($("#interruptDialog").open) $("#interruptDialog").close(); } catch (_) {}
      showPendingInterruptBar(pending.kind);
      toast(message, true);
    }
  } finally {
    state.resolvingInterrupt = false;
  }
}

function native(action, extra = {}) {
  try {
    const handler = window.webkit?.messageHandlers?.boujoy;
    if (!handler) return false;
    handler.postMessage({ action, ...extra });
    return true;
  } catch (_) { return false; }
}

async function restartBoujoy() {
  if (!confirm("重启 Boujoy Harness？当前运行中的任务会停止。")) return;
  toast("正在重启 Boujoy Harness…");
  if (native("restart")) return;
  try {
    const result = await jsonFetch("/api/app/restart", { method: "POST" });
    if (!result?.restarting) throw new Error("本地重启未被接收");
    // Browser-hosted Windows builds deliberately do not rely on a WebKit
    // bridge. Wait for the managed local host to bring the gateway back before
    // reloading, otherwise Edge can land on a transient connection error page.
    const previousServerPid = Number(result.serverPid) || 0;
    const deadline = Date.now() + 45_000;
    let sawUnavailable = false;
    const waitForProduct = async () => {
      try {
        const health = await fetch("/api/health", { cache: "no-store" });
        const status = await health.json().catch(() => ({}));
        // A healthy reply from the old gateway is not completion. Reload only
        // once the managed host has actually replaced that gateway process.
        if (health.ok && (sawUnavailable || !previousServerPid || Number(status.pid) !== previousServerPid)) {
          window.location.reload();
          return;
        }
        if (!health.ok) sawUnavailable = true;
      } catch (_) { sawUnavailable = true; }
      if (Date.now() >= deadline) {
        toast("本地服务正在重启；稍后刷新页面即可", true);
        return;
      }
      setTimeout(waitForProduct, 350);
    };
    setTimeout(waitForProduct, 900);
  } catch (error) {
    toast(error instanceof Error ? error.message : "本地重启失败", true);
  }
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("boujoy-theme", theme);
  $("#themeButton").textContent = theme === "dark" ? "☼" : "◐";
}

function showPage(page) {
  if (state.mode === "clean" && page !== "agent") {
    toast("纯净模式与知识库完全隔离；先切回知识模式。", true);
    return;
  }
  state.page = page;
  $$('[data-page-panel]').forEach(panel => panel.classList.toggle("active", panel.dataset.pagePanel === page));
  $$(".nav-cut").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  const [kicker, title] = PAGE_META[page];
  $("#pageKicker").textContent = kicker;
  $("#pageTitle").textContent = title;
  if (page === "knowledge" && !state.knowledge.length) loadKnowledge();
  if (page === "experts") loadRecords("expert");
  if (page === "styles") loadRecords("style");
  if (page === "monitor") renderMonitor();
  if (page === "news") loadNews();
}

async function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  closeEventSources();
  const clean = mode === "clean";
  $("#modeSwitch").setAttribute("aria-pressed", String(clean));
  $("#modeName").textContent = clean ? "纯净模式" : "知识模式";
  $("#modeHint").textContent = clean ? "NO VAULT / ISOLATED" : "VAULT 已连接";
  $("#agentEyebrow").textContent = clean ? "PURE HARNESS / NO MEMORY" : "KNOWLEDGE-LINKED AGENT";
  $("#agentHeadline").textContent = clean ? "新项目，不读取过去。" : "把想法变成行动。";
  configureStarterCards(clean);
  $$(".nav-cut").forEach(button => { if (button.dataset.page !== "agent") button.disabled = clean; });
  showPage("agent");
  state.sessions = [];
  state.sessionId = null;
  state.workspaceId = null;
  renderSessions();
  renderHistory([]);
  native("mode", { clean });
  setService("loading", clean ? "正在启动隔离引擎" : "正在连接知识引擎");
  await waitForHarness();
}

function configureStarterCards(clean) {
  const primary = $("#starterPrimary");
  const secondary = $("#starterSecondary");
  const tertiary = $("#starterTertiary");
  $("#starterDescription").textContent = clean
    ? "选择一个新项目。纯净模式不会读取知识库，也不会把上下文带进来。"
    : "选项目、发任务。知识模式会自动连接你的 Markdown 第二大脑。";
  primary.dataset.starter = clean ? "先检查当前项目结构，再给我一个不依赖历史知识的执行计划。" : "读取当前项目上下文，告诉我最重要的下一步。";
  primary.innerHTML = `${clean ? "规划这个新项目" : "接着做上次项目"} <span>↗</span>`;
  secondary.dataset.starter = clean ? "只基于当前目录，梳理项目结构、风险和下一步。" : "基于我的知识库，整理一个可执行的方案。";
  secondary.innerHTML = `${clean ? "梳理当前目录" : "调用第二大脑"} <span>↗</span>`;
  if (clean) {
    tertiary.removeAttribute("data-page");
    tertiary.dataset.starter = "先向我确认目标、边界和验收标准，再开始执行。";
    tertiary.innerHTML = '先确认目标 <span>↗</span>';
  } else {
    tertiary.removeAttribute("data-starter");
    tertiary.dataset.page = "experts";
    tertiary.innerHTML = '先选一位专家 <span>↗</span>';
  }
}

async function waitForHarness() {
  for (let count = 0; count < 50; count += 1) {
    try {
      await loadAgentFoundation();
      return;
    } catch (error) {
      if (count === 49) {
        setService("error", "本地引擎未就绪");
        toast(error.message, true);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

function setService(status, label) {
  const pill = $("#serviceStatus");
  pill.className = `service-pill ${status === "online" ? "online" : status === "error" ? "error" : ""}`;
  pill.lastChild.textContent = label;
}

function unpackList(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function normalizeWorkspaces(value) {
  // archivedSessionIds lives at the top level of workspace.list (global
  // registry-level archive), not inside each workspace item. Cache it on
  // state so session rendering can hide archived sessions.
  state.archivedSessionIds = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : (Array.isArray(value?.value?.archivedSessionIds) ? value.value.archivedSessionIds : []);
  return unpackList(value, ["workspaces", "items"]).map(item => ({
    ...item,
    id: item.id || item.workspaceId,
    name: item.name || item.title,
  }));
}

async function loadAgentFoundation() {
  const [host, sessionValue, workspaceValue] = await Promise.all([
    rpc("host.describe"), rpc("session.list"), rpc("workspace.list"),
  ]);
  state.host = host;
  state.sessions = unpackList(sessionValue, ["sessions", "items"]);
  state.workspaces = normalizeWorkspaces(workspaceValue);
  normalizeSessionProjections(sessionValue);
  chooseInitialWorkspaceAndSession();
  renderWorkspaces();
  renderSessions();
  await loadModels();
  await loadPresets();
  if (state.sessionId) await loadSession(state.sessionId);
  connectEvents();
  // When the app comes back to the foreground after sitting in the background,
  // re-sync every event stream: a socket that dropped while hidden has no
  // onclose retry that fires on return (the old code skipped the retry when
  // document.hidden), so approval/question frames would never surface again.
  if (!state.visibilitySyncBound) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      connectEvents();
    });
    state.visibilitySyncBound = true;
  }
  setService("online", "LOCAL ENGINE · 已连接");
}

function normalizeSessionProjections(value) {
  state.sessions = state.sessions.map(item => {
    const session = item.session || item;
    const projection = item.projection || session.projection || item.projections?.values || session.projections?.values || null;
    return {
      ...session,
      id: session.id || session.sessionId,
      title: session.title || projection?.title || null,
      projection,
    };
  });
}

function chooseInitialWorkspaceAndSession() {
  if (!state.workspaces.find(item => item.id === state.workspaceId)) {
    const withVault = state.workspaces.find(item => String(item.path || item.cwd || "").includes("AI-Second-Brain"));
    state.workspaceId = (state.mode === "knowledge" ? withVault : null)?.id || state.workspaces[0]?.id || null;
  }
  const ids = state.workspaces.find(item => item.id === state.workspaceId)?.sessionIds || [];
  if (!state.sessions.find(item => item.id === state.sessionId)) {
    state.sessionId = ids[0] || state.sessions[0]?.id || null;
  }
}

function workspaceTitle(item) {
  return item?.name || item?.title || String(item?.path || item?.cwd || "未命名项目").split("/").filter(Boolean).pop() || "未命名项目";
}

function renderWorkspaces() {
  const active = state.workspaces.find(item => item.id === state.workspaceId);
  $("#workspaceName").textContent = workspaceTitle(active);
  $("#workspaceMenu").innerHTML = state.workspaces.map(item => `<button data-workspace-id="${escapeHtml(item.id)}">${escapeHtml(workspaceTitle(item))}</button>`).join("") || '<p class="muted">暂无项目</p>';
}

function sessionTitle(session) {
  return session.title
    || session.projection?.title
    || session.projections?.values?.title
    || session.name
    || "新会话";
}

function sessionTimestamp(session) {
  const time = session.updatedAt || session.lastUpdatedAt || session.createdAt || session.projection?.updatedAt;
  if (!time) return "";
  const date = new Date(time);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function sessionsForWorkspace() {
  const workspace = state.workspaces.find(item => item.id === state.workspaceId);
  const ids = workspace?.sessionIds;
  const archived = new Set(state.archivedSessionIds || []);
  const visible = state.sessions.filter(item => !archived.has(item.id));
  if (state.sessionSearchResults) return visible.filter(item => state.sessionSearchResults.has(item.id));
  if (!Array.isArray(ids) || !ids.length) return visible;
  const order = new Map(ids.map((id, index) => [id, index]));
  return visible.filter(item => order.has(item.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
}

function renderSessions() {
  const sessions = sessionsForWorkspace();
  $("#sessionCount").textContent = sessions.length;
  $("#sessionList").innerHTML = sessions.map(session => `
    <button class="session-item ${session.id === state.sessionId ? "active" : ""}" data-session-id="${escapeHtml(session.id)}">
      <strong>${escapeHtml(sessionTitle(session))}</strong>
      <small><span>${session.running ? "执行中" : (session.blank ? "空白" : "待命")}</span><span>${escapeHtml(sessionTimestamp(session))}</span></small>
    </button>`).join("") || '<p class="muted">这个项目还没有会话。</p>';
  const hasSession = Boolean(state.sessionId);
  ["#renameSessionButton", "#forkSessionButton", "#archiveSessionButton", "#deleteSessionButton"].forEach(selector => { $(selector).disabled = !hasSession; });
}

async function refreshSessions({ quiet = false } = {}) {
  try {
    const value = await rpc("session.list");
    state.sessions = unpackList(value, ["sessions", "items"]);
    normalizeSessionProjections(value);
    renderSessions();
    if (!quiet) toast("会话已刷新");
  } catch (error) { if (!quiet) toast(error.message, true); }
}

async function searchSessions(query) {
  const value = query.trim();
  const searchToken = ++state.sessionSearchToken;
  if (!value) { state.sessionSearchResults = null; renderSessions(); return; }
  try {
    const result = await rpc("session.search", { query: value });
    if (searchToken !== state.sessionSearchToken) return;
    state.sessionSearchResults = new Set((result.items || []).map(item => item.sessionId));
    renderSessions();
    return;
  } catch (_) {
    // Some Harness deployments intentionally disable the session-query index.
    // Keep the product search functional by reading local histories in small
    // batches instead of leaving a dead search box in the UI.
  }

  const needle = value.toLocaleLowerCase();
  const workspace = state.workspaces.find(item => item.id === state.workspaceId);
  const workspaceIds = new Set(workspace?.sessionIds || []);
  const candidates = workspaceIds.size ? state.sessions.filter(item => workspaceIds.has(item.id)) : state.sessions.slice();
  const matches = new Set(candidates.filter(item => sessionTitle(item).toLocaleLowerCase().includes(needle)).map(item => item.id));
  state.sessionSearchResults = matches;
  renderSessions();

  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const histories = await Promise.all(batch.map(async session => {
      try {
        const value = await rpc("session.history", { sessionId: session.id });
        const text = foldHistory(historyEvents(value)).output.map(item => item.text).join("\n").toLocaleLowerCase();
        return { id: session.id, found: text.includes(needle) };
      } catch (_) {
        return { id: session.id, found: false };
      }
    }));
    if (searchToken !== state.sessionSearchToken) return;
    histories.forEach(result => { if (result.found) matches.add(result.id); });
    state.sessionSearchResults = new Set(matches);
    renderSessions();
  }
}

async function loadModels() {
  if (!state.sessionId) {
    state.models = [{ provider: state.host?.provider, model: state.host?.model }];
  } else {
    try {
      const value = await rpc("session.models", { sessionId: state.sessionId });
      state.modelDirectory = value;
      state.models = (value.groups || []).flatMap(group => (group.models || []).map(model => ({ ...model, provider: group.id, providerName: group.name })));
    } catch (_) {
      try {
        const value = await rpc("llm.models", {});
        state.models = (value.groups || []).flatMap(group => (group.models || []).map(model => ({ ...model, provider: group.id, providerName: group.name })));
      } catch (_) {
        state.models = [{ provider: state.host?.provider, model: state.host?.model }];
      }
    }
  }
  const select = $("#modelSelect");
  const current = state.modelDirectory?.current?.model || state.host?.model;
  select.innerHTML = state.models.map(item => {
    const model = typeof item === "string" ? item : item.model || item.id || item.name;
    const provider = typeof item === "string" ? "" : item.provider || item.providerId || "";
    const effort = item.reasoning?.defaultEffort || state.modelDirectory?.current?.reasoningEffort;
    return `<option value="${escapeHtml(JSON.stringify({ model, provider, reasoningEffort: effort }))}" ${model === current ? "selected" : ""}>${escapeHtml(item.name || item.label || item.displayName || model || "模型")}</option>`;
  }).join("") || `<option>${escapeHtml(current || "默认模型")}</option>`;
}

async function createSession() {
  try {
    const payload = state.workspaceId ? { workspaceId: state.workspaceId } : {};
    const value = await rpc("session.create", payload);
    const createdId = value.id || value.sessionId || value.session?.id || value.session?.sessionId;
    if (!createdId) throw new Error("Harness 没有返回新会话 ID");
    // Treat creation exactly like a session switch. Reusing the previous
    // session's history/projection/live buffer until the first blank history
    // response arrives produces a one-frame flash and can let a late delta
    // land in the new conversation.
    resetSessionView(createdId);

    // Render a local placeholder immediately. workspace.list can trail the
    // session.create response briefly, and filtering only by its stale
    // sessionIds made a valid blank session disappear from the left tape.
    const placeholder = { id: createdId, sessionId: createdId, workspaceId: state.workspaceId, blank: true, running: false, createdAt: Date.now(), title: null, projection: null };
    if (!state.sessions.some(item => item.id === createdId)) state.sessions.unshift(placeholder);
    const activeWorkspace = state.workspaces.find(item => item.id === state.workspaceId);
    if (activeWorkspace && !activeWorkspace.sessionIds?.includes(createdId)) activeWorkspace.sessionIds = [createdId, ...(activeWorkspace.sessionIds || [])];
    renderSessions();
    const [sessionValue, workspaceValue] = await Promise.all([rpc("session.list"), rpc("workspace.list")]);
    state.sessions = unpackList(sessionValue, ["sessions", "items"]);
    normalizeSessionProjections(sessionValue);
    if (!state.sessions.some(item => item.id === createdId)) state.sessions.unshift(placeholder);
    state.workspaces = normalizeWorkspaces(workspaceValue);
    const refreshedWorkspace = state.workspaces.find(item => item.id === state.workspaceId);
    if (refreshedWorkspace && !refreshedWorkspace.sessionIds?.includes(createdId)) refreshedWorkspace.sessionIds = [createdId, ...(refreshedWorkspace.sessionIds || [])];
    renderWorkspaces();
    renderSessions();
    await loadModels();
    await loadSession(createdId, { quiet: true });
    $("#promptInput").focus();
  } catch (error) { toast(`新建会话失败：${error.message}`, true); }
}

async function pickProject() {
  try {
    const picked = await rpc("host.pickDirectory", {});
    const path = picked?.path || picked?.directory || (typeof picked === "string" ? picked : "");
    if (!path) return;
    const created = await rpc("workspace.create", { path });
    const [workspaces] = await Promise.all([rpc("workspace.list")]);
    state.workspaces = normalizeWorkspaces(workspaces);
    state.workspaceId = created.id || created.workspaceId || created.workspace?.id || created.workspace?.workspaceId || state.workspaces.find(item => item.path === path)?.id;
    renderWorkspaces();
    await createSession();
    toast("新项目已加入");
  } catch (error) { if (!/cancel/i.test(error.message)) toast(error.message, true); }
}

async function selectWorkspace(id) {
  state.workspaceId = id;
  $("#workspaceMenu").classList.add("hidden");
  const ids = state.workspaces.find(item => item.id === id)?.sessionIds || [];
  const nextSessionId = ids[0] || state.sessions.find(item => item.workspaceId === id)?.id || null;
  renderWorkspaces();
  renderSessions();
  if (nextSessionId) await loadSession(nextSessionId);
  else {
    resetSessionView(null);
    renderSessions();
  }
}

function historyEvents(value) {
  return unpackList(value, ["events", "history", "items", "entries"]);
}

function renderHistoryLoading() {
  const stream = $("#messageStream");
  const empty = $("#emptyAgent");
  empty.style.display = "none";
  stream.classList.add("has-messages", "history-loading");
  stream.innerHTML = `
    <div class="history-loading-card" role="status" aria-live="polite">
      <span>LOADING SESSION</span>
      <strong>正在读取最近对话…</strong>
      <div class="history-loading-lines" aria-hidden="true"></div>
    </div>`;
}

function resetSessionView(nextSessionId, { loading = false } = {}) {
  if (state.livePumpTimer) cancelAnimationFrame(state.livePumpTimer);
  if (state.liveScrollFrame) cancelAnimationFrame(state.liveScrollFrame);
  releaseAttachmentPreviews();
  state.livePumpTimer = null;
  state.liveScrollFrame = null;
  state.scrollRestoreGeneration += 1;
  state.restoringConversationScroll = false;
  state.sessionId = nextSessionId;
  state.loadingHistory = loading;
  state.userScrolledUp = false;
  state.history = [];
  state.historyHasMore = false;
  state.historyLoadingOlder = false;
  state.projection = null;
  state.queue = [];
  state.subagents = [];
  state.liveResponse = null;
  state.lastHistorySignature = "";
  state.sessionTailSeq.delete(nextSessionId);
  state.sessionEventBuffers.delete(nextSessionId);
  renderQueue();
  if (loading) renderHistoryLoading(); else renderHistory([]);
  renderProjection();
  if (state.pendingInterrupts.length) showPendingInterruptBar(state.pendingInterrupts[0].kind);
}

async function loadSession(id, { quiet = false } = {}) {
  if (!id) return;
  const switchingSession = state.sessionId !== id;
  state.loadingHistory = true;
  if (switchingSession) resetSessionView(id, { loading: true });
  const loadToken = ++state.historyLoadToken;
  renderSessions();
  try {
    const [historyValue, models] = await Promise.all([
      rpc("session.history", { sessionId: id, maxMessages: HISTORY_FETCH_LIMIT }),
      rpc("session.models", { sessionId: id }).catch(() => null),
    ]);
    if (loadToken !== state.historyLoadToken || id !== state.sessionId) return;
    const events = historyEvents(historyValue);
    const existingFirstSeq = sessionEventSeq(state.history[0]);
    const incomingFirstSeq = sessionEventSeq(events[0]);
    if (quiet && !switchingSession && state.history.length) {
      // Polling and gap repair read a fresh tail page. Merge it into the
      // current window instead of replacing it: replacement made older rows
      // disappear immediately after the user sent the next message.
      const merged = new Map();
      for (const entry of [...state.history, ...events]) {
        const seq = sessionEventSeq(entry);
        if (seq != null) merged.set(seq, entry);
      }
      state.history = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
      if (existingFirstSeq == null || incomingFirstSeq == null || existingFirstSeq >= incomingFirstSeq) {
        state.historyHasMore = Boolean(historyValue.hasMore);
      }
    } else {
      state.history = events;
      state.historyHasMore = Boolean(historyValue.hasMore);
    }
    const lastEvent = state.history.at(-1);
    const signature = `${state.history.length}:${lastEvent?.event?.seq ?? lastEvent?.seq ?? lastEvent?.id ?? ""}`;
    const tailSeq = sessionEventSeq(lastEvent);
    state.sessionTailSeq.set(id, tailSeq ?? 0);
    // A quiet delivery poll can overlap the first streamed chunks. Never let
    // its slightly older history snapshot replace the in-memory live buffer;
    // doing so removes/recreates the assistant row and produces a visible hop.
    const hasActiveLiveResponse = state.liveResponse?.sessionId === id;
    if (!hasActiveLiveResponse) {
      restoreLiveResponse(state.history, id);
    } else {
      // A status-stop repair may find the persisted final message even though
      // its push frame was lost. Feed that canonical event through the same
      // live finalizer instead of clearing/recreating the row.
      const startSeq = state.liveResponse.startSeq;
      const persistedFinal = state.history.slice().reverse().find(entry => {
        if (eventType(entry) !== "assistant/message") return false;
        const seq = sessionEventSeq(entry);
        return startSeq == null || seq == null || seq >= startSeq;
      });
      if (persistedFinal) updateLiveResponse(persistedFinal, id);
    }
    const listedProjection = state.sessions.find(item => item.id === id)?.projection || null;
    state.projection = listedProjection ? { ...listedProjection } : (state.projection || {});
    const seededProjections = seedSessionProjections(id, historyValue.projections);
    if (!seededProjections) {
      state.projection = historyValue.projection || listedProjection || null;
    }
    if (signature !== state.lastHistorySignature) {
      renderHistory(state.history);
      state.lastHistorySignature = signature;
    }
    if (models) {
      state.modelDirectory = models;
      state.models = (models.groups || []).flatMap(group => (group.models || []).map(model => ({ ...model, provider: group.id, providerName: group.name })));
      await loadModels();
    }
    renderProjection();
    loadSubagents();
  } catch (error) {
    if (loadToken === state.historyLoadToken && id === state.sessionId && !state.history.length) renderHistory([]);
    if (!quiet) toast(error.message, true);
  }
  finally {
    if (loadToken === state.historyLoadToken) {
      state.loadingHistory = false;
      stitchBufferedSessionEvents(id);
      const subscribedLastSeq = state.sessionSubscribedLastSeq.get(id);
      const tailSeq = state.sessionTailSeq.get(id);
      if (subscribedLastSeq != null && tailSeq != null && subscribedLastSeq > tailSeq) {
        queueMicrotask(() => requestSessionGapRepair(id));
      }
      renderSessions();
    }
  }
}

async function loadOlderHistory() {
  if (!state.sessionId || !state.historyHasMore || state.historyLoadingOlder || state.loadingHistory || state.liveResponse) return;
  const firstSeq = sessionEventSeq(state.history[0]);
  if (firstSeq == null || firstSeq <= 0) {
    state.historyHasMore = false;
    return;
  }
  state.historyLoadingOlder = true;
  const stream = $("#messageStream");
  const previousHeight = stream.scrollHeight;
  try {
    const value = await rpc("session.history", {
      sessionId: state.sessionId,
      beforeSeq: firstSeq,
      maxMessages: HISTORY_FETCH_LIMIT,
    });
    const older = historyEvents(value);
    const olderTailSeq = sessionEventSeq(older.at(-1));
    if (older.length && olderTailSeq != null && olderTailSeq + 1 !== firstSeq) {
      throw new Error("历史分页不连续，已停止加载更早内容");
    }
    const known = new Set(state.history.map(sessionEventSeq).filter(seq => seq != null));
    state.history = [
      ...older.filter(entry => {
        const seq = sessionEventSeq(entry);
        return seq == null || !known.has(seq);
      }),
      ...state.history,
    ];
    state.historyHasMore = Boolean(value.hasMore);
    state.lastHistorySignature = "";
    renderHistory(state.history, { force: true });
    await new Promise(resolve => requestAnimationFrame(() => {
      stream.scrollTop += Math.max(0, stream.scrollHeight - previousHeight);
      resolve();
    }));
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.historyLoadingOlder = false;
  }
}

async function loadSubagents() {
  if (!state.sessionId) return;
  try {
    const value = await rpc("subagent.list", { parentSessionId: state.sessionId });
    state.subagents = value.entries || [];
  } catch (_) { state.subagents = []; }
  renderSubagents();
}

function renderSubagents() {
  $("#subagentList").innerHTML = state.subagents.map(item => item.kind === "child" ? `<article class="subagent-item"><p><strong>${escapeHtml(item.label || "子代理")}</strong><br>${escapeHtml(item.activity)} · ${escapeHtml(item.mode)}</p><div><button data-subagent-open="${escapeHtml(item.id)}:${escapeHtml(item.mode)}">查看</button>${item.mode === "continuable" ? `<button data-subagent-prompt="${escapeHtml(item.id)}">追问</button><button data-subagent-stop="${escapeHtml(item.id)}">中断</button>` : ""}</div></article>` : `<article class="subagent-item"><p>诊断项 · ${escapeHtml(item.reason)}</p></article>`).join("") || '<p class="muted">没有子代理。</p>';
}

async function openSubagent(id, mode) {
  try {
    const value = await rpc("subagent.history", { parentSessionId: state.sessionId, childSessionId: id, mode });
    const folded = foldHistory(historyEvents(value)).output.filter(item => item.role !== "tool");
    $("#readerPath").textContent = `SUBAGENT / ${id}`;
    $("#readerTitle").textContent = state.subagents.find(item => item.id === id)?.label || "子代理记录";
    $("#readerDelete").classList.add("hidden");
    $("#readerBody").innerHTML = folded.map(item => `<h3>${item.role === "user" ? "任务" : "子代理"}</h3>${markdown(item.text)}`).join("") || "<p>暂无记录</p>";
    $("#readerDialog").showModal();
  } catch (error) { toast(error.message, true); }
}

async function promptSubagent(id) {
  const text = prompt("继续交给这个子代理的任务");
  if (!text?.trim()) return;
  try { await rpc("subagent.prompt", { parentSessionId: state.sessionId, childSessionId: id, mode: "continuable", content: [{ type: "text", text: text.trim() }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); toast("已发送给子代理"); }
  catch (error) { toast(error.message, true); }
}

async function stopSubagent(id) {
  try { await rpc("subagent.interrupt", { parentSessionId: state.sessionId, childSessionId: id, mode: "continuable" }); toast("正在中断子代理"); }
  catch (error) { toast(error.message, true); }
}

function messagePreview(message) {
  return textFromContent(message?.content || []).slice(0, 100) || "排队任务";
}

function renderQueue() {
  $("#queueList").innerHTML = state.queue.map(item => `<article class="queue-item"><p>${escapeHtml(messagePreview(item.message))}</p><div><button data-queue-edit="${escapeHtml(item.id)}">编辑</button><button data-queue-steer="${escapeHtml(item.id)}">立即引导</button><button data-queue-remove="${escapeHtml(item.id)}">移除</button></div></article>`).join("") || '<p class="muted">没有排队任务。</p>';
}

async function mutateQueue(id, kind) {
  const item = state.queue.find(entry => entry.id === id);
  if (!item) return;
  let action = { kind };
  if (kind === "edit") {
    const text = prompt("修改排队任务", messagePreview(item.message));
    if (!text?.trim()) return;
    action = { kind: "edit", content: [{ type: "text", text: text.trim() }] };
  }
  try { await rpc("session.updateQueue", { sessionId: state.sessionId, itemId: id, action }); }
  catch (error) { toast(error.message, true); }
}

function eventType(event) { return event.type || event.kind || event.event?.type || ""; }
function eventData(event) { return event.data || event.event?.data || event.payload || event.event || {}; }

function textFromContent(content) {
  if (typeof content === "string") return stripRecallInjection(content);
  if (!Array.isArray(content)) return "";
  return content.map(part => typeof part === "string" ? stripRecallInjection(part) : (part.type === "text" || part.type === "input_text" || part.type === "output_text") ? stripRecallInjection(part.text) : part.type?.includes("image") ? "〔图片〕" : "").filter(Boolean).join("\n");
}

// Remove legacy recall injections already persisted by older Boujoy builds,
// plus the capture directive, so old sessions stay readable and matchable.
function stripRecallInjection(text = "") {
  let source = String(text);
  for (const [startTag, endTag] of [["<!-- BOUJOY_RECALL_START -->", "<!-- BOUJOY_RECALL_END -->"], ["<!-- BOUJOY_CAPTURE_START -->", "<!-- BOUJOY_CAPTURE_END -->"], ["<!-- BOUJOY_MEDIA_START -->", "<!-- BOUJOY_MEDIA_END -->"]]) {
    const start = source.indexOf(startTag);
    if (start < 0) continue;
    const end = source.indexOf(endTag, start);
    source = end < 0
      ? source.slice(0, start).trimEnd()
      : (source.slice(0, start) + source.slice(end + endTag.length)).trim();
  }
  return source;
}

function messageFromQueueItem(item = {}) {
  return item.message || item.entry?.message || item.value?.message || item;
}

function submissionMatchesMessage(pending, message = {}) {
  const messageText = textFromContent(message.content || message.message?.content).trim();
  return Boolean(
    (pending.rpcId && message.source?.rpcId && pending.rpcId === message.source.rpcId)
    || (messageText && pending.text.trim() === messageText)
  );
}

function reconcilePendingQueue(items, sessionId) {
  for (const item of items) {
    const message = messageFromQueueItem(item);
    const pending = state.pendingSubmissions.find(entry => entry.sessionId === sessionId && submissionMatchesMessage(entry, message));
    if (!pending) continue;
    pending.phase = item.placement === "steering" ? "steering" : "queued";
    pending.queueId = item.id;
  }
}

function acknowledgeSteeringEvent(event, sessionId) {
  if (eventType(event) !== "agent/inbox/spliced") return;
  const inserted = eventData(event).inserted || [];
  for (const message of inserted) {
    if (message.source?.kind !== "user") continue;
    state.pendingSubmissions = state.pendingSubmissions.filter(pending => pending.sessionId !== sessionId || !submissionMatchesMessage(pending, message));
  }
}

function streamIdentity(data = {}) {
  return `${data.turn ?? data.turnId ?? "turn"}:${data.step ?? data.stepId ?? "step"}`;
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(value = 0) {
  const n = Number(value) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function scheduleLivePump() {
  if (state.livePumpTimer || !state.liveResponse) return;
  // Upstream batches subscriber publication to the next animation frame. Do
  // the same here: render every real delta received before that frame, with no
  // synthetic typewriter delay that can lag behind the engine and jump at end.
  state.livePumpTimer = requestAnimationFrame(pumpLiveResponse);
}

function pumpLiveResponse() {
  state.livePumpTimer = null;
  const live = state.liveResponse;
  if (!live || live.sessionId !== state.sessionId) return;
  const remaining = live.receivedText.length - live.text.length;
  if (remaining > 0) {
    live.text = live.receivedText;
    renderLiveDelta();
  }
  if (live.finalEvent) {
    const finalEvent = live.finalEvent;
    state.liveResponse = null;
    state.history.push(finalEvent);
    renderHistory(state.history, { force: true });
  }
}

function updateLiveResponse(event, sessionId = state.sessionId, target = state) {
  const type = eventType(event);
  const data = eventData(event);
  // The native assembler discards abandoned chunks before retrying. Keeping
  // them makes the next model attempt look like duplicated or garbled text.
  if (type === "llm/retry" || type === "llm/retry-started") {
    const active = target.liveResponse;
    if (active && active.sessionId === sessionId && active.key === streamIdentity(data)) target.liveResponse = null;
    return false;
  }
  if (type === "assistant/chunk") {
    const chunk = data.chunk || data;
    // Consume the same block contract as native DSH. The existing Boujoy UI
    // deliberately renders text only, so raw reasoning and tool-call JSON
    // remain hidden, but completed text blocks can still land immediately.
    if (!["text-delta", "block-start", "block-end", "reasoning-delta", "tool-call-delta", "usage", "finish"].includes(chunk.type)) return true;
    if (chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta" || chunk.type === "usage" || chunk.type === "finish") return true;
    const key = streamIdentity(data);
    const index = Number.isInteger(Number(chunk.index)) ? Number(chunk.index) : 0;
    const startsText = chunk.type === "block-start" && (chunk.blockType === "text" || chunk.block?.type === "text");
    const endsText = chunk.type === "block-end" && chunk.block?.type === "text";
    if (chunk.type !== "text-delta" && !startsText && !endsText) return true;
    if (!target.liveResponse || target.liveResponse.sessionId !== sessionId || target.liveResponse.key !== key) {
      target.liveResponse = {
        sessionId,
        key,
        startSeq: sessionEventSeq(event),
        text: "",
        receivedText: "",
        textBlocks: [],
        reasoning: false,
        finalEvent: null,
      };
    }
    const live = target.liveResponse;
    const previous = live.textBlocks[index] || "";
    if (chunk.type === "block-start") live.textBlocks[index] = previous;
    if (chunk.type === "text-delta") live.textBlocks[index] = previous + String(chunk.text ?? chunk.delta ?? "");
    if (chunk.type === "block-end") live.textBlocks[index] = String(chunk.block?.text ?? previous);
    live.receivedText = live.textBlocks.filter(Boolean).join("\n");
    if (target === state) scheduleLivePump();
    return true;
  }
  if (type === "assistant/message" && target.liveResponse?.sessionId === sessionId) {
    const message = data.message || data;
    const finalText = textFromContent(message.content);
    if (finalText && finalText !== target.liveResponse.receivedText) {
      // The engine can emit the persisted final message before every text
      // delta has reached the UI. Use that real final content as the
      // canonical reveal buffer so the last words do not suddenly jump in.
      if (!finalText.startsWith(target.liveResponse.text)) target.liveResponse.text = "";
      target.liveResponse.receivedText = finalText;
    }
    if (target === state && target.liveResponse.receivedText && target.liveResponse.text.length < target.liveResponse.receivedText.length) {
      target.liveResponse.finalEvent = event;
      scheduleLivePump();
      return true;
    }
    target.liveResponse = null;
  }
  return false;
}

function restoreLiveResponse(events, sessionId) {
  const recovery = { liveResponse: null };
  for (const event of events) updateLiveResponse(event, sessionId, recovery);
  state.liveResponse = recovery.liveResponse;
  if (state.liveResponse) scheduleLivePump();
}

function foldHistory(events) {
  const output = [];
  const activities = [];
  const notices = [];
  let turnToolCount = 0;
  let currentTurn = null;
  let currentStep = 0;
  for (const event of events) {
    const type = eventType(event);
    const data = eventData(event);
    const time = event.event?.time || event.time || data.time || 0;
    if (type === "turn/start") {
      currentTurn = data.turn ?? data.turnId ?? null;
      currentStep = 0;
      turnToolCount = 0;
      notices.push({ kind: "turn", text: currentTurn != null ? `回合 ${currentTurn} 开始` : "回合开始", time, turn: currentTurn, at: output.length });
      continue;
    }
    if (type === "turn/end") {
      const reason = data.reason || {};
      let text = `回合 ${currentTurn ?? ""}`.trim() + " 结束";
      if (reason.kind === "error") text = `回合 ${currentTurn ?? ""} 失败：${reason.error?.message || reason.error || "模型请求出错"}`.trim();
      else if (reason.kind === "max-tokens") text = `回合 ${currentTurn ?? ""} 已达 token 上限，回答被截断`.trim();
      else if (reason.kind === "aborted" || reason.kind === "interrupted") text = `回合 ${currentTurn ?? ""} 已中断`.trim();
      notices.push({ kind: reason.kind === "error" ? "error" : reason.kind === "max-tokens" ? "max-tokens" : "turn", text, time, turn: currentTurn, at: output.length });
      currentTurn = null;
      continue;
    }
    if (type === "step/start") {
      currentStep = data.step ?? data.stepId ?? (currentStep + 1);
      continue;
    }
    if (type === "step/end") continue;
    if (type === "llm/retry" || type === "llm/retry-started") {
      const attempt = data.retry ?? data.attempt ?? data.retryCount ?? 1;
      const maximum = data.maxRetries ?? data.maximum ?? data.retryLimit ?? "";
      const delay = data.delayMs ?? data.delay ?? 0;
      const suffix = type === "llm/retry-started" ? "重试已开始" : `等待重试${delay ? `（${formatDuration(delay)}）` : ""}`;
      notices.push({ kind: "retry", text: `模型请求 ${suffix}${attempt || maximum ? `（${attempt || "?"}/${maximum || "?"}）` : ""}`, time, turn: currentTurn, at: output.length });
      continue;
    }
    if (type === "compaction/start" || type === "compaction/summary" || type === "compaction/end") {
      if (type === "compaction/start") {
        notices.push({ kind: "compaction", text: "正在压缩上下文…", time, turn: currentTurn, at: output.length });
      } else if (type === "compaction/summary" || type === "compaction/end") {
        const items = data.items ?? data.count ?? data.itemCount;
        const tokens = data.tokens ?? data.compactedTokens ?? data.retainedTokens;
        const bits = [];
        if (items != null) bits.push(`${items} 条历史`);
        if (tokens != null) bits.push(`~${formatTokens(tokens)} tokens`);
        notices.push({ kind: "compaction", text: `上下文已压缩${bits.length ? `（${bits.join(" · ")}）` : ""}`, time, turn: currentTurn, at: output.length });
      }
      continue;
    }
    if (type === "command/run") {
      const label = data.label || data.title || data.command || "命令";
      notices.push({ kind: "command", text: `执行命令：${label}`, time, turn: currentTurn, at: output.length });
      continue;
    }
    if (type === "command/done") {
      const label = data.label || data.title || data.command || "命令";
      const ok = data.ok ?? data.success ?? data.error == null;
      notices.push({ kind: ok ? "command" : "error", text: `${ok ? "命令完成" : "命令失败"}：${label}`, time, turn: currentTurn, at: output.length });
      continue;
    }
    if (type === "assistant/chunk" && (data.chunk || {}).type === "usage") {
      // Usage travels on the usage chunk; the final assistant/message also
      // carries it, so the live usage line below is updated there too.
      const usage = data.chunk?.usage || data.usage;
      if (usage && output.length > 0 && output[output.length - 1].role === "assistant") {
        output[output.length - 1].usage = usage;
      }
      continue;
    }
    if (type === "assistant/chunk" && (data.chunk || {}).type === "finish") {
      const finished = output[output.length - 1];
      if (finished && finished.role === "assistant" && !finished.finished) finished.finished = true;
      continue;
    }
    if (type === "user/message") {
      // Harness stores workspace instructions and runtime policy snapshots as
      // user-role events for model context. They are engine internals, not
      // messages authored by the person using Boujoy.
      if (data.source?.kind && data.source.kind !== "user") continue;
      const content = data.content || data.message?.content;
      const text = textFromContent(content);
      const media = mediaFromContent(content);
      if (/^\/permission\s+(read-only|workspace-write|danger-full-access)\s*$/i.test(text)) continue;
      if (text || media.length) {
        turnToolCount = 0;
        const id = data.id || event.id;
        const prior = output.findIndex(item => item.role === "user" && item.id === id);
        if (prior >= 0) output.splice(prior, 1);
        output.push({ role: "user", text: text || "〔图片〕", media, delivery: data.deliveryMode || null, time, id, sourceRpcId: data.source?.rpcId });
      }
    } else if (type === "agent/inbox/spliced") {
      for (const message of data.inserted || []) {
        if (message.source?.kind !== "user") continue;
        const text = textFromContent(message.content);
        const media = mediaFromContent(message.content);
        if (!text && !media.length) continue;
        const prior = output.findIndex(item => item.role === "user" && item.id === message.id);
        if (prior >= 0) output.splice(prior, 1);
        output.push({ role: "user", text: text || "〔图片〕", media, delivery: "steer", accepted: true, time, id: message.id, sourceRpcId: message.source?.rpcId });
      }
    } else if (type === "assistant/message") {
      const message = data.message || data;
      const text = textFromContent(message.content);
      const media = mediaFromContent(message.content);
      const hasReasoning = Array.isArray(message.content) && message.content.some(part => part && part.type === "reasoning");
      const usage = message.usage || data.usage || null;
      const timing = message.timing || data.timing || null;
      // Real, engine-provided step timing when present; otherwise keep the
      // summary minimal instead of inventing a fake thought chain. The raw
      // reasoning is model-internal (often English rambling) — never surface
      // it verbatim; a terse Chinese summary reads clean.
      const thought = data.interrupted === true
        ? "回答已中断"
        : timing?.stepStartTime && timing?.completedTime
          ? `模型生成 ${formatDuration(Math.max(0, timing.completedTime - timing.stepStartTime))}`
          : (turnToolCount ? `已完成 ${turnToolCount} 个工具步骤` : "已完成回答");
      if (text || media.length) output.push({ role: "assistant", text, media, thought, hasReasoning, usage, timing, id: message.id || event.id });
    } else if (type === "tool/call") {
      const view = event.view || data.view || {};
      const title = view.title || data.name || data.toolName || "工具调用";
      const detail = view.rawInput != null ? view.rawInput : (view.command || data.input || data.arguments || "");
      const activity = { kind: "call", title, detail, id: data.callId || event.id };
      activities.push(activity);
      turnToolCount += 1;
    } else if (type === "tool/result") {
      const view = event.view || data.view || {};
      const title = view.title || data.name || data.toolName || "工具结果";
      // ToolResultView has 6 variants; each carries the content in a
      // different field. Extract per card type so results are never empty.
      let detail = "";
      if (Array.isArray(view.content)) {
        // generic: content is ContentBlock[] — take the text blocks.
        detail = view.content
          .map(block => (typeof block === "string" ? block : block?.type === "text" ? block.text : block?.text || ""))
          .filter(Boolean).join("\n");
      } else if (view.card === "terminal") {
        detail = [view.output, view.exitCode != null ? `exit code ${view.exitCode}` : view.signal ? `signal ${view.signal}` : ""].filter(Boolean).join("\n");
      } else if (view.card === "diff" && Array.isArray(view.diffs)) {
        detail = view.diffs.map(diff => diff?.path ? `${diff.path}:\n${diff.text || diff.hunk || diff.patch || ""}` : (diff.text || diff.hunk || diff.patch || "")).filter(Boolean).join("\n\n");
      } else if (view.card === "search" && Array.isArray(view.matches)) {
        detail = view.matches.map(group => `${group.path}:\n${(group.matches || []).map(m => `  ${m.lineNumber}: ${m.line}`).join("\n")}`).join("\n\n");
      } else {
        detail = view.text || view.output || view.summary || view.answer || view.contentText || "";
      }
      if (!detail) detail = data.output || data.result || data.text || "";
      const activity = { kind: "result", title, detail, id: data.callId || event.id };
      activities.push(activity);
      const media = mediaFromContent(data.message?.content || data.content || view.content || [], { textKinds: ["video"] });
      if (media.length) output.push({ role: "assistant", text: "", media, mediaOnly: true, time, id: `media-${data.callId || event.id || output.length}` });
    }
  }
  return { output, activities, notices };
}

function messageMediaSource(item = {}) {
  if (item.src && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(item.src)) return escapeHtml(item.src);
  if (item.src && /^https?:\/\//i.test(item.src)) return safeHttpHref(item.src);
  if (item.path) return escapeHtml(`/api/conversation/media?path=${encodeURIComponent(item.path)}`);
  return "";
}

function renderMessageMedia(media = [], sessionId = state.sessionId, mode = state.mode) {
  if (!media.length) return "";
  const cards = media.map(item => {
    const name = escapeHtml(item.name || (item.kind === "video" ? "视频" : "图片"));
    const src = messageMediaSource(item);
    if (item.kind === "video") {
      if (!src) return "";
      return `<figure class="message-media-card loading"><div class="message-media-frame"><video controls playsinline preload="metadata" src="${src}" aria-label="${name}"></video><span class="media-loading">视频加载中…</span></div>${name ? `<figcaption>${name}</figcaption>` : ""}</figure>`;
    }
    const attachment = item.attachmentId
      ? ` data-attachment-id="${escapeHtml(item.attachmentId)}" data-attachment-session="${escapeHtml(sessionId || "")}" data-attachment-mode="${escapeHtml(mode)}"`
      : "";
    const source = src ? ` src="${src}"` : "";
    const ratio = Number(item.width) > 0 && Number(item.height) > 0 ? ` style="aspect-ratio:${Number(item.width)}/${Number(item.height)}"` : "";
    return `<figure class="message-media-card loading"><div class="message-media-frame"${ratio}><img${source}${attachment} loading="lazy" decoding="async" alt="${name}" title="点击查看原图"><span class="media-loading">图片加载中…</span></div>${name ? `<figcaption>${name}</figcaption>` : ""}</figure>`;
  }).filter(Boolean);
  return cards.length ? `<div class="message-media">${cards.join("")}</div>` : "";
}

function base64Bytes(value = "") {
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function loadAttachmentUrl(sessionId, attachmentId, mode) {
  const key = `${mode}:${sessionId}:${attachmentId}`;
  const cached = state.attachmentUrls.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = state.attachmentLoads.get(key);
  if (existing) return existing;
  const generation = state.attachmentGeneration;
  const pending = rpc("session.attachment", { sessionId, attachmentId }, mode)
    .then(value => {
      const mediaType = value.attachment?.mediaType || "image/png";
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(mediaType)) throw new Error("附件不是可预览图片");
      const url = URL.createObjectURL(new Blob([base64Bytes(value.data)], { type: mediaType }));
      if (generation !== state.attachmentGeneration) {
        URL.revokeObjectURL(url);
        throw new Error("图片所属会话已切换");
      }
      state.attachmentUrls.set(key, url);
      return url;
    })
    .finally(() => state.attachmentLoads.delete(key));
  state.attachmentLoads.set(key, pending);
  return pending;
}

function setMediaCardState(element, stateName) {
  const card = element.closest(".message-media-card");
  if (!card) return;
  card.classList.remove("loading", "ready", "error");
  card.classList.add(stateName);
  if (stateName === "error") {
    const status = card.querySelector(".media-loading");
    if (status) status.textContent = "媒体预览加载失败";
  }
}

function hydrateMessageMedia(root) {
  root.querySelectorAll(".message-media img").forEach(image => {
    image.addEventListener("load", () => setMediaCardState(image, "ready"), { once: true });
    image.addEventListener("error", () => setMediaCardState(image, "error"), { once: true });
    image.addEventListener("click", () => { if (image.src) window.open(image.src, "_blank", "noopener,noreferrer"); });
    if (image.complete && image.naturalWidth > 0) setMediaCardState(image, "ready");
  });
  root.querySelectorAll(".message-media video").forEach(video => {
    video.addEventListener("loadedmetadata", () => setMediaCardState(video, "ready"), { once: true });
    video.addEventListener("error", () => setMediaCardState(video, "error"), { once: true });
    if (video.readyState >= 1) setMediaCardState(video, "ready");
  });
  root.querySelectorAll(".message-media img[data-attachment-id]").forEach(image => {
    loadAttachmentUrl(image.dataset.attachmentSession, image.dataset.attachmentId, image.dataset.attachmentMode)
      .then(url => { if (image.isConnected) image.src = url; })
      .catch(() => { if (image.isConnected) setMediaCardState(image, "error"); });
  });
}

function releaseAttachmentPreviews() {
  state.attachmentGeneration += 1;
  for (const url of state.attachmentUrls.values()) URL.revokeObjectURL(url);
  state.attachmentUrls.clear();
  state.attachmentLoads.clear();
}

function renderHistory(events, { force = false } = {}) {
  // Hard guard: while a live response is streaming, never rebuild the whole
  // thread. Any caller (poll, queue churn, stray events) would reflow the DOM
  // and bounce the reader's position. Only the final landing (force) rebuilds.
  if (!force && state.liveResponse && state.liveResponse.sessionId === state.sessionId) {
    return;
  }
  if (state.liveScrollFrame) {
    cancelAnimationFrame(state.liveScrollFrame);
    state.liveScrollFrame = null;
  }
  const { output, activities, notices } = foldHistory(events);
  const persistedUsers = output.filter(item => item.role === "user");
  state.pendingSubmissions = state.pendingSubmissions.filter(pending => {
    if (pending.sessionId !== state.sessionId) return true;
    return !persistedUsers.some(item => (
      (pending.rpcId && item.sourceRpcId && pending.rpcId === item.sourceRpcId)
      || (item.text.trim() === pending.text.trim() && (!item.time || item.time >= pending.submittedAt - 3000))
    ));
  });
  const pendingOutput = state.pendingSubmissions
    .filter(item => item.sessionId === state.sessionId)
    .map(item => ({ role: "user", text: item.text, media: mediaFromContent(item.content), delivery: item.deliveryMode, phase: item.phase, pending: item.phase === "sending", waiting: item.phase !== "sending", id: item.localId }));
  const steeringQueueOutput = state.queue
    .filter(item => item.placement === "steering")
    .map(item => {
      const message = messageFromQueueItem(item);
      return { role: "user", text: textFromContent(message.content), media: mediaFromContent(message.content), delivery: "steer", phase: "steering", waiting: true, id: message.id || item.id };
    })
    .filter(item => (item.text || item.media.length) && !output.some(existing => existing.role === "user" && (existing.id === item.id || (item.text && existing.text.trim() === item.text.trim()))) && !pendingOutput.some(existing => item.text && existing.text.trim() === item.text.trim()));
  const liveOutput = state.liveResponse?.sessionId === state.sessionId && state.liveResponse.text
    ? [{
      role: "assistant",
      text: state.liveResponse.text,
      thought: state.liveResponse.reasoning ? "正在推理并组织回答" : "正在组织回答",
      streaming: true,
      id: `stream-${state.liveResponse.key}`,
    }]
    : [];  // Interleave engine notices (turn bounds, retries, compaction, commands,
  // max-tokens) into the persisted timeline at their recorded position.
  let persisted = output.map(item => ({ ...item, at: null }));
  const noticeRows = notices.map((notice, index) => ({ notice, index }));
  for (let i = persisted.length - 1; i >= 0; i -= 1) {
    const after = i;
    for (let n = noticeRows.length - 1; n >= 0; n -= 1) {
      const row = noticeRows[n];
      if (row.notice.at === after) {
        persisted.splice(after + 1, 0, { role: "notice", notice: row.notice, at: null });
        noticeRows.splice(n, 1);
      }
    }
  }
  persisted.push(...noticeRows.map(row => ({ role: "notice", notice: row.notice, at: null })));
  const visibleOutput = [...persisted, ...pendingOutput, ...steeringQueueOutput, ...liveOutput];
  const stream = $("#messageStream");
  const previousScrollTop = stream.scrollTop;
  const previousBottomOffset = Math.max(0, stream.scrollHeight - stream.scrollTop - stream.clientHeight);
  const wasNearBottom = previousBottomOffset < 72;
  const readerWasScrolledUp = state.userScrolledUp;
  const scrollRestoreGeneration = ++state.scrollRestoreGeneration;
  state.restoringConversationScroll = true;
  const empty = $("#emptyAgent");
  stream.classList.remove("history-loading");
  const hasMessages = visibleOutput.some(item => item.role === "user" || item.role === "assistant");
  empty.style.display = hasMessages ? "none" : "block";
  stream.classList.toggle("has-messages", hasMessages);
  stream.innerHTML = visibleOutput.map(item => {
    if (item.role === "notice") {
      const icon = { turn: "◈", error: "✕", "max-tokens": "△", retry: "↻", compaction: "▤", command: "❯" }[item.notice.kind] || "·";
      return `<div class="notice-line notice-${escapeHtml(item.notice.kind)}"><span class="notice-icon">${icon}</span><span>${escapeHtml(item.notice.text)}</span></div>`;
    }
    const stamp = messageTimeStamp(item.time);
    const stats = item.role === "assistant" ? messageStatsHtml(item) : "";
    const rawText = String(item.text || "");
    const visibleText = item.media?.length && rawText === "〔图片〕" ? "" : stripRenderedMediaMarkdown(rawText);
    const mediaHtml = renderMessageMedia(item.media || []);
    const bodyHtml = item.streaming
      ? `${escapeHtml(rawText)}<span class="stream-cursor" aria-hidden="true"></span>`
      : `${visibleText ? markdown(visibleText) : ""}${mediaHtml}`;
    const actions = visibleText ? `<div class="message-actions"><button type="button" class="message-copy" data-copy-text="${escapeHtml(rawText)}" title="复制这条消息">⧉ 复制</button></div>` : "";
    return `<article class="message ${item.role}${item.pending ? " pending" : ""}${item.waiting ? " waiting" : ""}${item.streaming ? " streaming" : ""}${item.media?.length ? " has-media" : ""}"><div class="message-label">${item.role === "user" ? `YOU / 你${item.delivery ? ` · ${item.delivery === "steer" ? "引导当前任务" : "排到下一条"}` : ""}${item.pending ? " · 发送中" : item.phase === "steering" ? " · 已送入下一步，等待当前步骤结束" : item.phase === "queued" ? " · 已排队" : item.accepted ? " · 已进入当前执行" : ""}` : `BOUJOY AGENT${item.streaming ? " · 正在生成" : item.mediaOnly ? " · 媒体" : ""}`}${stamp ? `<span class="message-stamp">${stamp}</span>` : ""}</div>${item.role === "assistant" && item.thought ? `<div class="thought-summary"><b>${item.hasReasoning ? "推理摘要" : "执行摘要"}</b><span>${escapeHtml(item.thought)}</span></div>` : ""}<div class="message-body">${bodyHtml}</div>${stats}${actions}</article>`;
  }).join("");
  hydrateMessageMedia(stream);
  // The user card intentionally has a cut-paper bottom edge. Its original
  // percentage-height diagonal looks identical for normal prompts, but can
  // overlap the last lines of a very long paste. Measure after layout so the
  // safety treatment responds to actual wrapped height, not character count.
  stream.querySelectorAll(".message.user").forEach(message => {
    const body = message.querySelector(".message-body");
    message.classList.toggle("long-content", Boolean(body && body.offsetHeight > 420));
  });
  $("#toolActivity").innerHTML = activities.slice(-12).reverse().map(item => {
    const detail = typeof item.detail === "string" ? item.detail : item.detail ? JSON.stringify(item.detail, null, 2) : "";
    return `<details class="activity-tool"><summary><strong>${escapeHtml(item.kind === "call" ? "执行" : "完成")} · ${escapeHtml(item.title)}</strong><span>详情</span></summary>${detail ? `<pre>${escapeHtml(detail.slice(0, 4000))}</pre>` : '<p class="muted">没有附加信息</p>'}</details>`;
  }).join("") || '<p class="muted">工具调用将在这里实时展开。</p>';
  // Preserve the reader's position by offset-from-bottom: after innerHTML is
  // rebuilt the old scrollTop is meaningless (content shifted), but the
  // distance from the bottom is stable. Readers scrolled up keep their place;
  // readers at the live edge follow the newest content.
  requestAnimationFrame(() => {
    if (scrollRestoreGeneration !== state.scrollRestoreGeneration) return;
    if (readerWasScrolledUp) {
      // Streaming content grows strictly below the reader. Keeping the exact
      // top offset makes a manual reading position immovable, including the
      // final plain-text -> Markdown landing render.
      stream.scrollTop = previousScrollTop;
    } else if (wasNearBottom) {
      stream.scrollTop = stream.scrollHeight;
    } else {
      stream.scrollTop = Math.max(0, stream.scrollHeight - stream.clientHeight - previousBottomOffset);
    }
    requestAnimationFrame(() => {
      if (scrollRestoreGeneration === state.scrollRestoreGeneration) {
        state.restoringConversationScroll = false;
      }
    });
  });
}

function messageTimeStamp(time) {
  if (!time) return "";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Streaming render path: only the in-flight assistant message is touched.
// The full timeline (renderHistory) is rebuilt once when the final message
// lands, so token deltas never reflow the whole stream (no jump/stutter).
function renderLiveDelta() {
  const live = state.liveResponse;
  if (!live || live.sessionId !== state.sessionId) return;
  const stream = $("#messageStream");
  const wasAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
  const shouldFollow = !state.userScrolledUp && wasAtBottom;
  let liveEl = stream.querySelector(".message.streaming");
  const thoughtHtml = live.reasoning ? `<div class="thought-summary"><b>推理摘要</b><span>正在推理并组织回答</span></div>` : "";
  if (!liveEl) {
    stream.insertAdjacentHTML("beforeend", `<article class="message assistant streaming"><div class="message-label">BOUJOY AGENT · 正在生成</div>${thoughtHtml}<div class="message-body streaming-text"></div></article>`);
    liveEl = stream.querySelector(".message.streaming");
  } else if (live.reasoning) {
    const summary = liveEl.querySelector(".thought-summary");
    if (!summary) liveEl.insertAdjacentHTML("afterbegin", thoughtHtml);
  }
  const body = liveEl.querySelector(".message-body");
  // True incremental append: track how much we already rendered and only
  // append the delta via textContent (never rebuild the whole message), so
  // wrapping changes cannot reflow and jitter the viewport. The cursor is a
  // pure-CSS ::after element (see app.css), so no DOM rebuild per delta.
  if (live.renderedLength === undefined) live.renderedLength = 0;
  if (live.text.length > live.renderedLength) {
    const delta = live.text.slice(live.renderedLength);
    body.appendChild(document.createTextNode(delta));
    live.renderedLength = live.text.length;
  }
  // Follow only while the reader is at the live edge; never steal an upward
  // read. Additionally, once the user scrolls up we latch that choice and
  // stop auto-following entirely until they return to the very bottom — this
  // prevents the "bounces between top and newest" jitter caused by height
  // changes during streaming.
  if (shouldFollow && !state.liveScrollFrame) {
    state.liveScrollFrame = requestAnimationFrame(() => {
      state.liveScrollFrame = null;
      if (!state.liveResponse || state.userScrolledUp) return;
      stream.scrollTop = stream.scrollHeight;
    });
  }
}

function messageStatsHtml(item = {}) {
  const bits = [];
  const usage = item.usage || {};
  const billedInput = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (billedInput > 0 || usage.outputTokens > 0) {
    bits.push(`输入 ${formatTokens(billedInput)} · 输出 ${formatTokens(usage.outputTokens)}`);
  }
  const timing = item.timing || {};
  if (timing.stepStartTime != null && timing.completedTime != null) {
    const llmMs = Math.max(0, timing.completedTime - timing.stepStartTime);
    if (llmMs > 0) bits.push(`LLM ${formatDuration(llmMs)}`);
  }
  if (timing.firstTokenTime != null && timing.stepStartTime != null) {
    const ttftMs = Math.max(0, timing.firstTokenTime - timing.stepStartTime);
    if (ttftMs > 0) bits.push(`首 token ${formatDuration(ttftMs)}`);
  }
  if (timing.firstTokenTime != null && timing.completedTime != null && usage.outputTokens) {
    const decodeMs = Math.max(0, timing.completedTime - timing.firstTokenTime);
    if (decodeMs > 0) bits.push(`${(usage.outputTokens / (decodeMs / 1000)).toFixed(0)} tok/s`);
  }
  if (!bits.length) return "";
  return `<div class="message-stats">${bits.map(bit => `<span>${escapeHtml(bit)}</span>`).join("")}</div>`;
}

function currentGoal() {
  const projected = state.projection?.goal;
  return projected?.current || projected?.goal || projected || state.projection?.currentGoal || null;
}

function currentGoalRef(goal = currentGoal()) {
  if (!goal) return null;
  return goal.ref || (goal.id && goal.revision ? { id: goal.id, revision: goal.revision } : null);
}

function renderProjection() {
  const projection = state.projection || {};
  const goal = currentGoal();
  const goalRef = currentGoalRef(goal);
  $("#currentGoal").textContent = typeof goal === "string" ? goal : goal?.objective || goal?.title || "尚未设定";
  const phase = goal?.phase || goal?.status;
  $("#goalActions").innerHTML = goalRef ? `<button data-goal-action="edit">编辑</button>${phase === "paused" || phase === "stopped" ? '<button data-goal-action="resume">继续</button>' : '<button data-goal-action="pause">暂停</button>'}<button data-goal-action="complete">完成</button><button data-goal-action="clear">清除</button>` : '<button id="goalButton">设定目标</button>';
  const plan = projection.plan?.items || projection.plan || projection.todos || [];
  $("#planList").innerHTML = Array.isArray(plan) && plan.length ? plan.map(item => `<div class="plan-item ${escapeHtml(item.status || "pending")}"><i></i><span>${escapeHtml(item.step || item.text || item.title || String(item))}</span></div>`).join("") : '<p class="muted">Agent 创建计划后会显示在这里。</p>';
  const running = Boolean(state.sessions.find(item => item.id === state.sessionId)?.running) || ["running", "working", "busy"].includes(String(projection.status || "").toLowerCase());
  state.running = running;
  $("#runState").className = `run-state ${running ? "running" : "idle"}`;
  $("#runState").querySelector("span").textContent = running ? "执行中" : "待命";
  setThinkingStatus(running);
  $("#sendButton").textContent = "↑";
  $("#sendButton").title = running ? (state.busyMode === "steer" ? "引导当前任务" : "排到下一条") : "发送";
  $("#cancelButton").classList.toggle("hidden", !running);
  $("#busyComposer").classList.toggle("hidden", !running);
  $$('[data-busy-mode]').forEach(button => button.classList.toggle("active", button.dataset.busyMode === state.busyMode));
  const permission = projection.permissions?.currentValue;
  if (permission && $(`#permissionSelect option[value="${permission}"]`)) {
    $("#permissionSelect").value = permission;
    $("#permissionSelect").dataset.current = permission;
  }
  renderContextMeter(projection);
}

function renderContextMeter(projection = {}) {
  const pressure = projection.contextPressure || projection.pressure || null;
  const breakdown = projection.contextBreakdown || projection.breakdown || null;
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
  const windowTokens = pressure?.contextWindow;
  const meter = $("#contextMeter");
  if (!meter) return;
  if (usedTokens == null || windowTokens == null) {
    meter.innerHTML = "";
    meter.classList.add("hidden");
    return;
  }
  meter.classList.remove("hidden");
  const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
  const segments = [];
  const rows = [
    { key: "systemTokens", label: "系统提示", color: "segment-system" },
    { key: "toolsTokens", label: "工具", color: "segment-tools" },
    { key: "messageTokens", label: "对话", color: "segment-messages" },
  ];
  let accounted = 0;
  for (const row of rows) {
    const value = breakdown?.[row.key];
    if (value == null) continue;
    const width = Math.max(2, Math.round((value / windowTokens) * 100));
    segments.push(`<div class="context-segment ${row.color}" style="width:${Math.min(width, 100 - accounted)}%"></div>`);
    row.value = value;
    accounted += Math.min(width, 100 - accounted);
  }
  if (segments.length === 0) {
    segments.push(`<div class="context-segment segment-messages" style="width:${percent}%"></div>`);
    rows[2].value = usedTokens;
  }
  const breakdownHtml = rows.filter(row => row.value != null).map(row => `<div class="context-row"><span class="context-swatch ${row.color}"></span><dt>${row.label}</dt><dd>~${formatTokens(row.value)}</dd></div>`).join("");
  meter.innerHTML = `
    <div class="context-meter-head"><span>上下文已用 ${percent}%</span><span>~${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}</span></div>
    <div class="context-meter-bar">${segments.join("")}</div>
    ${breakdownHtml ? `<div class="context-meter-rows">${breakdownHtml}</div>` : ""}`;
}

function setThinkingStatus(active) {
  const status = $("#thinkingStatus");
  status.classList.toggle("active", Boolean(active));
}

async function sendPrompt(text = $("#promptInput").value.trim()) {
  if ((!text && !state.pendingImages.length) || state.sending) return;
  if (!state.sessionId) await createSession();
  if (!state.sessionId) return;
  state.sending = true;
  $("#sendButton").disabled = true;
  $("#promptInput").value = "";
  autoResizePrompt();
  // Match the native composer: ordered image attachments precede the text
  // block in one prompt admission. Multimodal providers preserve this order.
  const admittedText = withBoujoyMediaGuidance(text);
  const content = [
    ...state.pendingImages.map(image => ({ type: "image", mediaType: image.mediaType, data: image.data, name: image.name })),
    ...(admittedText ? [{ type: "text", text: admittedText }] : []),
  ];
  const deliveryMode = state.running ? state.busyMode : "queue";
  const submissionRpcId = rpcId();
  const localSubmission = {
    localId: `local-${rpcId()}`,
    sessionId: state.sessionId,
    text: text ? String(text) : "〔图片〕",
    content,
    deliveryMode,
    rpcId: submissionRpcId,
    phase: "sending",
    submittedAt: Date.now(),
  };
  state.pendingSubmissions.push(localSubmission);
  renderHistory(state.history);
  $("#runState").className = "run-state running";
  $("#runState span").textContent = "执行中";
  setThinkingStatus(true);
  try {
    await rpc("session.prompt", { sessionId: state.sessionId, mode: deliveryMode, content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, state.mode, submissionRpcId);
    if (state.pendingSubmissions.includes(localSubmission) && localSubmission.phase === "sending") {
      localSubmission.phase = deliveryMode === "steer" ? "steering" : "queued";
      renderHistory(state.history);
    }
    state.pendingImages = [];
    renderPendingImages();
    if (state.running) toast(deliveryMode === "steer" ? "引导已送入当前执行" : "任务已排到下一条");
    pollForDelivery(localSubmission);
  } catch (error) {
    state.pendingSubmissions = state.pendingSubmissions.filter(item => item.localId !== localSubmission.localId);
    if (text && !$("#promptInput").value) $("#promptInput").value = text;
    renderHistory(state.history);
    autoResizePrompt();
    toast(error.message, true);
  }
  finally { state.sending = false; $("#sendButton").disabled = false; }
}

// Delivery-confirmation fallback. session.prompt resolves before the harness
// appends the user/message event: steer lands in the inbox and is written at
// the next step, and a dropped events-mux frame can lose the broadcast. Poll
// session.history so the pending bubble is matched away (by rpcId or text)
// even when the event stream never delivers the confirmation. Stops as soon
// as the submission is gone or the user switched sessions.
async function pollForDelivery(submission, attempts = 15, intervalMs = 2000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    if (!state.pendingSubmissions.some(item => item.localId === submission.localId)) return;
    if (state.sessionId !== submission.sessionId) return;
    // Native DSH uses its mux stream as the source of truth. Pulling an entire
    // tail page every two seconds while that stream is healthy is redundant;
    // on a long tool-heavy conversation it also needlessly parses thousands of
    // events on the WebKit main thread right as model text is arriving.
    if (eventStreamConnected("events.mux")) continue;
    await loadSession(state.sessionId, { quiet: true }).catch(() => {});
  }
}

async function selectModel() {
  try {
    const selected = JSON.parse($("#modelSelect").value);
    if (!state.sessionId || !selected.model) return;
    await rpc("session.selectModel", { sessionId: state.sessionId, model: selected.model, provider: selected.provider, reasoningEffort: selected.reasoningEffort || undefined });
    toast(`已切换到 ${selected.model}`);
  } catch (error) { toast(error.message, true); }
}

async function applyPermission(value) {
  const select = $("#permissionSelect");
  if (!state.sessionId) {
    select.value = select.dataset.current || "workspace-write";
    toast("请先创建会话", true);
    return;
  }
  select.disabled = true;
  try {
    await remoteCommand(`/permission ${value}`);
    await loadSession(state.sessionId, { quiet: true });
    const actual = state.projection?.permissions?.currentValue;
    if (actual !== value) throw new Error(`Harness 回读权限为 ${actual || "未知"}，切换未生效`);
    select.value = actual;
    select.dataset.current = actual;
    toast(`权限已切换并回读：${actual === "read-only" ? "只读" : actual === "danger-full-access" ? "完全访问" : "工作区写入"}`);
  } catch (error) {
    select.value = state.projection?.permissions?.currentValue || select.dataset.current || "workspace-write";
    toast(error.message, true);
  } finally { select.disabled = false; }
}

async function selectPermission() {
  const value = $("#permissionSelect").value;
  if (value === "danger-full-access") {
    state.pendingPermission = value;
    $("#permissionSelect").value = $("#permissionSelect").dataset.current || state.projection?.permissions?.currentValue || "workspace-write";
    $("#permissionAcknowledge").checked = false;
    $("#permissionDialog").showModal();
    return;
  }
  await applyPermission(value);
}

async function confirmFullAccess(event) {
  event.preventDefault();
  if (!$("#permissionAcknowledge").checked || state.pendingPermission !== "danger-full-access") return;
  const value = state.pendingPermission;
  state.pendingPermission = null;
  $("#permissionDialog").close();
  await applyPermission(value);
}

async function archiveCurrentSession() {
  if (!state.sessionId || !state.workspaceId) return;
  if (!confirm("归档当前会话？内容不会被删除。")) return;
  try {
    await rpc("workspace.archiveSession", { sessionId: state.sessionId });
    state.sessionId = null;
    await refreshSessions({ quiet: true });
    chooseInitialWorkspaceAndSession();
    renderSessions();
    if (state.sessionId) await loadSession(state.sessionId); else renderHistory([]);
  } catch (error) { toast(error.message, true); }
}

function openDeleteSession() {
  if (!state.sessionId) return;
  const session = state.sessions.find(item => item.id === state.sessionId);
  $("#deleteSessionName").textContent = sessionTitle(session || {});
  $("#deleteSessionDialog").showModal();
}

async function deleteCurrentSession(event) {
  event.preventDefault();
  const sessionId = state.sessionId;
  if (!sessionId) return;
  const submit = $("#deleteSessionForm button[type='submit']");
  submit.disabled = true;
  try {
    if (state.running) await rpc("session.cancel", { sessionId }).catch(() => null);
    await rpc("workspace.archiveSession", { sessionId }).catch(error => {
      if (!/session-not-found|not found/i.test(error.message)) throw error;
    });
    await jsonFetch("/api/session/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, mode: state.mode }),
    });
    $("#deleteSessionDialog").close();
    state.sessions = state.sessions.filter(item => item.id !== sessionId);
    state.workspaces.forEach(workspace => { workspace.sessionIds = (workspace.sessionIds || []).filter(id => id !== sessionId); });
    state.sessionId = sessionsForWorkspace()[0]?.id || null;
    state.history = [];
    state.projection = null;
    renderSessions();
    if (state.sessionId) await loadSession(state.sessionId); else renderHistory([]);
    toast("会话已移到废纸篓，可恢复");
  } catch (error) { toast(`删除失败：${error.message}`, true); }
  finally { submit.disabled = false; }
}

function autoResizePrompt() {
  const input = $("#promptInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mediaType: file.type, data: String(reader.result).split(",")[1] || "", size: file.size });
    reader.onerror = () => reject(reader.error || new Error("附件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  const projection = state.sessions.find(item => item.id === state.sessionId)?.projection || state.projection || {};
  const limits = projection.imageLimits || {};
  const accepted = [...files].filter(file => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type));
  if (limits.maxImagesPerMessage && state.pendingImages.length + accepted.length > limits.maxImagesPerMessage) {
    toast(`每条消息最多 ${limits.maxImagesPerMessage} 张图`, true); return;
  }
  try {
    for (const file of accepted) {
      if (limits.maxImageBytes && file.size > limits.maxImageBytes) { toast(`${file.name} 超过大小限制`, true); continue; }
      state.pendingImages.push(await fileToImage(file));
    }
    renderPendingImages();
  } catch (error) { toast(error.message, true); }
}

function renderPendingImages() {
  $("#contextChips").innerHTML = state.pendingImages.map((image, index) => `
    <div class="context-image-preview">
      <img src="data:${escapeHtml(image.mediaType)};base64,${image.data}" alt="${escapeHtml(image.name)}">
      <span>${escapeHtml(image.name)}</span>
      <button type="button" data-remove-image="${index}" aria-label="移除 ${escapeHtml(image.name)}">×</button>
    </div>`).join("");
}

async function renameSession() {
  if (!state.sessionId) return;
  const current = sessionTitle(state.sessions.find(item => item.id === state.sessionId) || {});
  const title = prompt("新的会话名称", current);
  if (!title?.trim()) return;
  try { await rpc("session.rename", { sessionId: state.sessionId, title: title.trim() }); await refreshSessions({ quiet: true }); toast("会话已重命名"); }
  catch (error) { toast(error.message, true); }
}

async function forkSession() {
  if (!state.sessionId) return;
  try {
    const value = await rpc("session.fork", { sessionId: state.sessionId });
    state.sessionId = value.sessionId;
    await refreshSessions({ quiet: true });
    await loadSession(state.sessionId);
    toast("已从当前会话分叉");
  } catch (error) { toast(error.message, true); }
}

async function cancelRun() {
  if (!state.sessionId) return;
  try { await rpc("session.cancel", { sessionId: state.sessionId }); toast("正在停止 Agent"); }
  catch (error) { toast(error.message, true); }
}

function setBusyMode(mode) {
  if (!["steer", "queue"].includes(mode)) return;
  state.busyMode = mode;
  localStorage.setItem("boujoy-busy-mode", mode);
  $$('[data-busy-mode]').forEach(button => button.classList.toggle("active", button.dataset.busyMode === mode));
  if (state.running) $("#sendButton").title = mode === "steer" ? "引导当前任务" : "排到下一条";
}

async function loadPresets() {
  try {
    const value = await rpc("agentPreset.list", {});
    state.presets = value.presets || [];
    const session = state.sessions.find(item => item.id === state.sessionId);
    $("#presetSelect").innerHTML = state.presets.map(item => `<option value="${escapeHtml(item.id)}" ${session?.agentPreset === item.id ? "selected" : ""}>${escapeHtml(item.name || item.id)}</option>`).join("");
  } catch (_) { $("#presetSelect").innerHTML = '<option value="standard">标准模式</option>'; }
}

async function selectPreset() {
  if (!state.sessionId) return;
  try { await rpc("agentPreset.select", { sessionId: state.sessionId, agentPreset: $("#presetSelect").value }); await refreshSessions({ quiet: true }); toast("Agent 预设已切换"); }
  catch (error) { toast(error.message, true); }
}

async function editGoal() {
  if (!state.sessionId) return;
  const current = currentGoal();
  $("#goalDialogTitle").textContent = currentGoalRef(current) ? "编辑当前目标" : "设定当前目标";
  $("#goalObjective").value = current?.objective || "";
  $("#goalRounds").value = current?.maxGoalRounds || "";
  $("#goalDialog").showModal();
  setTimeout(() => $("#goalObjective").focus(), 0);
}

async function saveGoal(event) {
  event.preventDefault();
  if (!state.sessionId) return;
  const current = currentGoal();
  const ref = currentGoalRef(current);
  const objective = $("#goalObjective").value.trim();
  const rounds = Number($("#goalRounds").value || 0);
  if (!objective) return;
  const submit = $("#goalForm button[type='submit']");
  submit.disabled = true;
  try {
    const payload = { sessionId: state.sessionId, objective, ...(rounds ? { maxGoalRounds: rounds } : {}) };
    if (ref) await rpc("goal.edit", { ...payload, ref });
    else await rpc("goal.create", payload);
    $("#goalDialog").close();
    await loadSession(state.sessionId, { quiet: true });
    toast(ref ? "目标已更新" : "目标已设定并开始执行");
  } catch (error) { toast(error.message, true); }
  finally { submit.disabled = false; }
}

async function goalAction(action) {
  const current = currentGoal();
  const ref = currentGoalRef(current);
  if (action === "edit") { editGoal(); return; }
  if (!ref || !state.sessionId) return;
  if (["complete", "clear"].includes(action) && !confirm(action === "complete" ? "把当前目标标记为完成？" : "清除当前目标？")) return;
  try { await rpc(`goal.${action}`, { sessionId: state.sessionId, ref }); setTimeout(() => loadSession(state.sessionId, { quiet: true }), 220); }
  catch (error) { toast(error.message, true); }
}

function classifyPath(path) {
  if (path.startsWith("02-Projects/")) return "project";
  if (path.startsWith("03-Knowledge/")) return "knowledge";
  if (path.startsWith("04-Content/")) return "content";
  if (path.startsWith("05-Prompts/")) return "prompt";
  if (path.startsWith("06-Business/")) return "business";
  if (path.startsWith("98-Skills/")) return "skill";
  if (path.startsWith("00-System/")) return "system";
  return "other";
}

function parseFrontmatter(text) {
  const fields = {};
  const source = String(text);
  if (!source.startsWith("---")) return fields;
  // Only the block between the first two "---" markers is frontmatter.
  const rest = source.slice(3);
  const end = rest.indexOf("\n---");
  if (end < 0) return fields;
  rest.slice(0, end).split("\n").forEach(line => {
    const index = line.indexOf(":");
    if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"[]|['"\]]$/g, "");
  });
  return fields;
}

function titleFromMarkdown(path, text) {
  const frontmatter = parseFrontmatter(text);
  const heading = String(text).match(/^#\s+(.+)$/m)?.[1]?.trim();
  return frontmatter.title || frontmatter.name || heading || path.split("/").pop().replace(/\.md$/i, "");
}

// Mirrors the server-side protected-markdown rules (case-insensitive roots +
// reserved files). Keeps the delete affordance hidden for anything the server
// will refuse, so users never click a button that only errors later.
function isProtectedMarkdown(path = "") {
  const normalized = String(path).replaceAll("\\", "/").toLowerCase();
  const protectedRoots = ["00-system/", "01-inbox/", "ai-second-brain-ui/", "98-skills/", "99-logs/"];
  const protectedFiles = ["agents.md", "dashboard.md", "readme.md"];
  return protectedFiles.includes(normalized) || protectedRoots.some(root => normalized.startsWith(root));
}

function parseKnowledgeFile(file) {  const text = file.text || "";
  const kind = classifyPath(file.path || "");
  const frontmatter = parseFrontmatter(text);
  const plain = stripMarkdown(text);
  const tags = String(frontmatter.tags || "").replace(/[\[\]]/g, "").split(/[,，]/).map(item => item.trim()).filter(Boolean);
  return {
    ...file, kind, frontmatter, tags,
    title: titleFromMarkdown(file.path, text),
    summary: frontmatter.summary || frontmatter.description || plain.slice(0, 150),
    search: `${file.path} ${plain} ${tags.join(" ")}`.toLowerCase(),
  };
}

async function loadKnowledge() {
  if (state.knowledgeLoading) return;
  state.knowledgeLoading = true;
  try {
    const value = await jsonFetch("/api/knowledge/vault?compact=1");
    const files = value.files || [];
    const cards = files.filter(file => file.path?.toLowerCase().endsWith(".md")).map(parseKnowledgeFile);
    const media = files.filter(file => file.media).map(file => ({
      ...file,
      kind: "media",
      title: titleFromMediaPath(file.path),
      summary: `${formatBytes(file.size)} 视频`,
      search: `${file.path} ${file.path.split("/").pop()}`.toLowerCase(),
      url: `/api/knowledge/media?path=${encodeURIComponent(file.path)}`,
    }));
    state.knowledge = [...cards, ...media];
    renderKnowledge();
  } catch (error) {
    $("#knowledgeGrid").innerHTML = `<div class="empty-records"><strong>知识服务未就绪</strong><p>${escapeHtml(error.message)}</p></div>`;
    toast(error.message, true);
  } finally { state.knowledgeLoading = false; }
}

function titleFromMediaPath(path = "") {
  const base = String(path).split("/").pop().replace(/\.(mp4|webm|mov)$/i, "");
  // Prefer the parent directory name when it carries the topic (e.g. outputs_embedding_meaning_75s_final).
  return base.replace(/_/g, " ").trim() || String(path).split("/").pop();
}

function formatBytes(size = 0) {
  const n = Number(size) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function findKnowledge(path) { return state.knowledge.find(item => item.path === path); }

function extractActionItems(text = "") {
  const lines = String(text).split("\n");
  const matches = [];
  let inActionSection = false;
  for (const line of lines) {
    // Section header like "## 下一步" / "### 后续行动" — everything below it
    // until the next heading is treated as action content.
    if (/^#{1,6}\s+/.test(line)) {
      inActionSection = /下一步|TODO|待办|行动|后续|Action/i.test(line);
      continue;
    }
    if (!inActionSection) {
      // Bare task-list checkboxes outside an action section still count.
      if (/^\s*[-*]\s*\[\s\]\s+/.test(line)) matches.push(line.replace(/^\s*[-*]\s*\[\s\]\s+/, "").trim());
      continue;
    }
    const cleaned = line
      .replace(/^\s*[-*]\s*\[\s[xX]\]\s+/, "") // done checkbox
      .replace(/^\s*[-*]\s*\[\s\]\s+/, "")     // open checkbox
      .replace(/^\s*\d+[.、)]\s*/, "")         // numbered item
      .replace(/^\s*[-*]\s+/, "")              // bullet
      .replace(/^\s*\[\s[xX]\]\s+/, "")        // checkbox after numbering
      .replace(/^\s*\[\s\]\s+/, "")            // open checkbox after numbering
      .trim();
    if (cleaned && !/^[-—–]/.test(cleaned) && !/^\s*$/.test(cleaned)) matches.push(cleaned);
  }
  return [...new Set(matches)].filter(item => item.length > 2).slice(0, 5);
}

function renderKnowledge() {
  const search = $("#knowledgeSearch").value.trim().toLowerCase();
  const remoteMatches = state.knowledgeSearchQuery === search ? new Set(state.knowledgeSearchPaths) : new Set();
  const files = state.knowledge.filter(item => (state.knowledgeFilter === "all" || item.kind === state.knowledgeFilter) && (!search || item.search.includes(search) || remoteMatches.has(item.path)));
  const now = Date.now();
  const recent = state.knowledge.filter(item => now - new Date(item.lastModified || 0).valueOf() < 7 * 86400000).length;
  $("#knowledgeFileCount").textContent = state.knowledge.length;
  $("#knowledgeProjectCount").textContent = state.knowledge.filter(item => item.kind === "project").length;
  $("#knowledgeUpdatedCount").textContent = recent;
  $("#knowledgeResultCount").textContent = `${files.length} 条`;
  const active = findKnowledge("00-System/Active-Context.md") || state.knowledge.find(item => /Active-Context/.test(item.path));
  const focusMeta = active ? parseFrontmatter(active.text) : {};
  const focusPath = (focusMeta.focus_path || focusMeta.focusPath || active?.text?.match(/focus_path:\s*[`"']?([^\n`"']+)/i)?.[1]?.trim() || "").trim();
  const focus = findKnowledge(focusPath) || state.knowledge.filter(item => item.kind === "project").sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))[0];
  $("#focusCard").innerHTML = focus ? `<span class="card-type">${escapeHtml(KIND_META[focus.kind].label)} / ACTIVE</span><h4>${escapeHtml(focus.title)}</h4><p>${escapeHtml(focus.summary)}</p><button data-open-path="${escapeHtml(focus.path)}">打开项目上下文</button>` : '<p class="muted">当前没有聚焦项目。</p>';
  const actions = extractActionItems(focus?.text || active?.text || "");
  $("#nextActionList").innerHTML = actions.map(item => `<div class="next-action"><i></i><div>${escapeHtml(item)}<small>来自当前项目</small></div></div>`).join("") || '<div class="next-action"><i></i><div>让 Agent 读取当前项目并生成下一步<small>可以直接交给 Agent</small></div></div>';
  $("#knowledgeGrid").innerHTML = files.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0)).slice(0, 90).map(item => {
    const meta = KIND_META[item.kind] || KIND_META.other;
    const date = item.lastModified ? new Date(item.lastModified).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "";
    if (item.media) {
      const thumb = `/api/knowledge/media-thumb?path=${encodeURIComponent(item.path)}`;
      return `<button class="knowledge-card media-card" data-play-media="${escapeHtml(item.url)}" data-media-path="${escapeHtml(item.path)}"><span class="media-thumb"><img src="${thumb}" alt="" loading="lazy" onerror="this.style.display='none'"><i>▶</i></span><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.summary)}</p><footer><span>视频</span><span>${escapeHtml(date)}</span></footer></button>`;
    }
    return `<button class="knowledge-card" data-kind="${item.kind}" data-open-path="${escapeHtml(item.path)}"><span class="card-icon">${meta.icon}</span><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.summary)}</p><footer><span>${escapeHtml(meta.label)}</span><span>${escapeHtml(date)}</span></footer></button>`;
  }).join("") || '<div class="empty-records"><strong>没有匹配内容</strong><p>试试其他关键词或分类。</p></div>';
}

function playMedia(url) {
  const dialog = $("#mediaDialog");
  const video = $("#mediaPlayer");
  video.src = url;
  dialog.showModal();
  video.play().catch(() => {});
}

function closeMedia() {
  const video = $("#mediaPlayer");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("#mediaDialog").close();
}

async function searchKnowledgeFull(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    state.knowledgeSearchQuery = "";
    state.knowledgeSearchPaths = [];
    renderKnowledge();
    return;
  }
  try {
    const value = await jsonFetch(`/api/knowledge/search?q=${encodeURIComponent(normalized)}`);
    if ($("#knowledgeSearch").value.trim().toLowerCase() !== normalized) return;
    state.knowledgeSearchQuery = normalized;
    state.knowledgeSearchPaths = value.paths || [];
    renderKnowledge();
  } catch (_) { /* local preview search remains available */ }
}

async function openReader(path) {
  const existing = findKnowledge(path);
  try {
    const value = existing?.text != null && !existing.truncated ? existing : await jsonFetch(`/api/knowledge/file?path=${encodeURIComponent(path)}`);
    const text = value.text ?? value.content ?? "";
    state.readerPath = path;
    $("#readerPath").textContent = path;
    $("#readerTitle").textContent = titleFromMarkdown(path, text);
    $("#readerBody").innerHTML = markdown(text);
    prepareReaderLinks(path);
    $("#readerBack").classList.toggle("hidden", state.readerStack.length === 0);
    $("#readerDelete").classList.toggle("hidden", isProtectedMarkdown(path));
    if (!$("#readerDialog").open) $("#readerDialog").showModal();
  } catch (error) { toast(error.message, true); }
}

function resolveVaultLink(sourcePath, href) {
  let decoded;
  try { decoded = decodeURIComponent(String(href).split("#")[0].split("?")[0]); }
  catch (_) { decoded = String(href).split("#")[0].split("?")[0]; }
  if (!decoded) return null;
  const parts = decoded.startsWith("/") ? [] : String(sourcePath).split("/").slice(0, -1);
  for (const part of decoded.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

function prepareReaderLinks(sourcePath) {
  $$("a", $("#readerBody")).forEach(link => {
    const href = link.getAttribute("href") || "";
    if (/^(?:https?:|mailto:|tel:)/i.test(href)) return;
    if (href.startsWith("#")) return;
    const targetPath = resolveVaultLink(sourcePath, href);
    if (!targetPath || !/\.md$/i.test(targetPath)) return;
    link.dataset.readerPath = targetPath;
    link.removeAttribute("target");
    link.setAttribute("href", "#");
    link.title = `打开知识卡：${targetPath}`;
  });
}

function openReaderLink(path) {
  if (state.readerPath && state.readerPath !== path) state.readerStack.push(state.readerPath);
  openReader(path);
}

function readerBack() {
  const previous = state.readerStack.pop();
  if (previous) openReader(previous);
}

async function deleteReaderCard() {
  const path = $("#readerPath").textContent;
  if (!path || !confirm(`把“${path}”移到废纸篓？此操作不会永久删除。`)) return;
  try {
    await jsonFetch("/api/knowledge/delete-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    $("#readerDialog").close();
    await loadKnowledge();
    toast("知识卡已移到废纸篓");
  } catch (error) { toast(error.message, true); }
}

function graphLinks(text = "") {
  const values = [];
  for (const match of String(text).matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) values.push(match[1].trim());
  for (const match of String(text).matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) values.push(decodeURIComponent(match[1]).replace(/^\.\//, ""));
  return values;
}

function openGraph() {
  const files = state.knowledge
    .filter(item => !item.media && item.kind !== "system")
    .sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0))
    .slice(0, 52);
  const width = 1080, height = 660;
  const byKey = new Map();
  files.forEach((item, index) => {
    byKey.set(item.path.replace(/\.md$/i, ""), index);
    byKey.set(item.title, index);
    byKey.set(item.path.split("/").pop().replace(/\.md$/i, ""), index);
  });
  const nodes = files.map((item, index) => {
    const ring = Math.floor(Math.sqrt(index));
    const angle = index * 2.399963;
    const radius = 45 + ring * 42;
    return { item, x: width / 2 + Math.cos(angle) * radius * 1.42, y: height / 2 + Math.sin(angle) * radius };
  });
  const edges = [];
  files.forEach((item, source) => graphLinks(item.text).forEach(link => {
    const target = byKey.get(link) ?? byKey.get(link.replace(/\.md$/i, ""));
    if (target != null && target !== source) edges.push([source, target]);
  }));
  const colors = { project: "#2439ff", knowledge: "#d2ff00", content: "#ff2b8b", prompt: "#32e4d2", business: "#ffd629", skill: "#f1eadc", other: "#ff2b8b" };
  $("#graphCanvas").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="知识关系图">
    ${edges.map(([a,b]) => `<line class="graph-line" x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${nodes[b].x}" y2="${nodes[b].y}"/>`).join("")}
    ${nodes.map(({ item, x, y }, index) => `<g class="graph-node" data-graph-path="${escapeHtml(item.path)}" transform="translate(${x} ${y})"><circle r="${item.kind === "project" ? 12 : 8}" fill="${colors[item.kind] || colors.other}"/><text x="${item.kind === "project" ? 16 : 12}" y="3">${escapeHtml(String(item.title || item.path.split("/").pop() || "").slice(0,18))}</text></g>`).join("")}
  </svg>`;
  $("#graphDialog").showModal();
}

function cleanupCandidates() {
  const report = findKnowledge("00-System/Cleanup-Candidates.md");
  if (!report) return [];
  const section = report.text.split(/^## E\. 完全重复的 Markdown\s*$/m)[0];
  return [...section.matchAll(/`([^`]+)`/g)].map(match => match[1].trim().replaceAll("\\", "/")).filter(path => path && !path.startsWith("00-System/") && !path.startsWith("tools/") && findKnowledge(path));
}

function openHealth() {
  const docs = state.knowledge.filter(item => !item.media);
  const short = docs.filter(item => stripMarkdown(item.text || "").length < 80);
  const noTitle = docs.filter(item => !/^#\s+/m.test(item.text || ""));
  const noTags = docs.filter(item => !item.tags.length && !/\btags?:/i.test(item.text || ""));
  const candidates = [...new Set(cleanupCandidates())];
  $("#healthSummary").innerHTML = `<article class="health-metric"><b>${docs.length}</b><span>Markdown 总量</span></article><article class="health-metric"><b>${short.length}</b><span>过短内容</span></article><article class="health-metric"><b>${noTitle.length}</b><span>缺少标题</span></article><article class="health-metric"><b>${candidates.length}</b><span>可清理候选</span></article>`;
  $("#healthDetails").innerHTML = `
    <section class="health-panel"><h3>需要补强的内容</h3><ul>${short.slice(0,40).map(item => `<li>${escapeHtml(item.path)}</li>`).join("") || "<li>没有过短内容</li>"}</ul></section>
    <section class="health-panel"><h3>清理候选</h3><ul>${candidates.map(path => `<li>${escapeHtml(path)}</li>`).join("") || "<li>当前没有报告中的候选</li>"}</ul>${candidates.length ? '<button class="mini-cut danger" data-cleanup-all>确认后移到废纸篓</button>' : ""}</section>
    <section class="health-panel"><h3>缺少一级标题</h3><ul>${noTitle.slice(0,40).map(item => `<li>${escapeHtml(item.path)}</li>`).join("") || "<li>标题结构正常</li>"}</ul></section>
    <section class="health-panel"><h3>标签覆盖</h3><ul><li>${noTags.length} 个文件没有显式标签</li><li>${state.knowledge.length - noTags.length} 个文件已有标签或分类</li></ul></section>`;
  $("#healthDialog").showModal();
}

async function cleanupReported() {
  const paths = [...new Set(cleanupCandidates())];
  if (!paths.length || !confirm(`把报告中的 ${paths.length} 个候选文件移到废纸篓？`)) return;
  try {
    await jsonFetch("/api/knowledge/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
    $("#healthDialog").close(); await loadKnowledge(); toast(`已移动 ${paths.length} 个候选文件`);
  } catch (error) { toast(error.message, true); }
}

async function revealReader() {
  try {
    await jsonFetch("/api/knowledge/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: $("#readerPath").textContent }) });
  } catch (error) { toast(error.message, true); }
}

function sendReaderToAgent() {
  const path = $("#readerPath").textContent;
  const title = $("#readerTitle").textContent;
  $("#readerDialog").close();
  showPage("agent");
  $("#promptInput").value = `请读取并基于知识库文件 \`${path}\`（标题：${title}）继续工作。\n\n要求：先读取该文件，理解其结论与当前状态，再基于其中的下一步行动展开。`;
  autoResizePrompt();
  $("#promptInput").focus();
}

// -- Intelligent conversation capture ---------------------------------------
// The model (not this page) decides whether the conversation has long-term
// value, scores it per 00-System/Value-Filter.md, checks 00-System/
// Dedup-Rules.md, and writes the compressed card through /api/knowledge/capture
// (which only enforces path safety). This page just hands over the material and
// reports the outcome.
async function captureCurrentConversation() {
  const button = $("#captureButton");
  const status = $("#captureStatus");
  if (!state.sessionId) { toast("请先创建会话", true); return; }
  if (button.dataset.busy === "1") return;
  button.dataset.busy = "1";
  button.disabled = true;
  status.textContent = "模型正在判断价值…";
  try {
    const value = await rpc("session.history", { sessionId: state.sessionId, maxMessages: 40 });
    const events = value.events || value.items || value.messages || value.history || [];
    const folded = foldHistory(events.map(entry => entry.event || entry));
    const transcript = folded.output
      .filter(item => item.role === "user" || item.role === "assistant")
      .slice(-24)
      .map(item => `${item.role === "user" ? "用户" : "Agent"}: ${String(item.text).slice(0, 600)}`)
      .join("\n\n");
    if (!transcript.trim()) { toast("当前会话还没有可沉淀的内容", true); return; }
    const directive = [
      "你是 Boujoy 知识库的自动捕获器。按 00-System/Value-Filter.md 打分（0-3 不存、4-5 进 Memory-Queue、6-8 存知识卡、9-10 存卡并考虑更新 Hot-Index），按 Security-Rules 脱敏，按 Dedup-Rules 去重。",
      "写入前必须先查重：用 read 工具读 00-System/Memory-Index.md 和 00-System/Hot-Index.md，同主题绝不新建，只把新判断追加到原卡'更新记录'；再检查目标目录已有文件。",
      "值得保存（6+）时按 Knowledge-Card-Template 压缩成 300-800 字知识卡，用 POST /api/knowledge/capture（body: {path, text}）写入 02-06 对应目录。若接口返回 403'检测到高度相似的知识卡'，说明已重复：改为读取返回的相似卡路径并追加更新记录（用 capture 写回原路径，text 为原卡全文+新更新记录）。",
      "4-5 分追加到 00-System/Memory-Queue.md；0-3 分不保存。完成后一句话回报：保存路径、分数或未保存原因（不展示评分明细）。",
      "",
      "以下是最近对话（已截断）：",
      transcript,
    ].join("\n");
    // Send as a steering message so an in-flight agent picks it up next step.
    // Wrapped in CAPTURE markers: the directive is model-side only and is
    // stripped from the visible bubble by stripRecallInjection.
    await rpc("session.prompt", {
      sessionId: state.sessionId,
      mode: "steer",
      content: [{ type: "text", text: `<!-- BOUJOY_CAPTURE_START -->\n${directive}\n<!-- BOUJOY_CAPTURE_END -->` }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    status.textContent = "已送入判断流程，Agent 会在下一步执行";
    toast("已把本次对话交给模型判断价值");
  } catch (error) {
    status.textContent = "";
    toast(error.message, true);
  } finally {
    button.dataset.busy = "";
    button.disabled = false;
  }
}

async function loadRecords(kind) {
  try {
    const value = await jsonFetch(`/api/records?kind=${kind}`);
    state.records[kind] = value.records || [];
    renderRecords(kind);
    if (kind === "expert" && !state.records.style.length) loadRecords("style");
  } catch (error) { toast(error.message, true); }
}

function renderRecords(kind) {
  const list = state.records[kind];
  const search = $(`#${kind}Search`).value.trim().toLowerCase();
  const filtered = list.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search));
  $(`#${kind}Count`).textContent = kind === "expert" ? `${filtered.length} 位专家` : `${filtered.length} 种风格`;
  const grid = $(`#${kind}Grid`);
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-records"><strong>${kind === "expert" ? "专家阵容还是空的" : "还没有自定义风格"}</strong><p>点击右上角新增，配置会保存为本地 Markdown。</p></div>`;
    return;
  }
  grid.innerHTML = filtered.map((item, index) => kind === "expert" ? `
    <article class="record-card ${item.enabled ? "" : "disabled"}" data-index="${String(index + 1).padStart(2, "0")}">
      <div class="record-top"><span class="record-avatar">${escapeHtml(item.name.slice(0,1).toUpperCase())}</span><span class="record-status">${item.enabled ? "ON CALL" : "OFF"}</span></div>
      <h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || "尚未填写说明")}</p>
      <div class="record-actions"><button class="call" data-record-call="expert:${escapeHtml(item.id)}">调用专家 →</button><button data-record-edit="expert:${escapeHtml(item.id)}">编辑</button><button data-record-copy="expert:${escapeHtml(item.id)}">复制</button><button data-record-delete="expert:${escapeHtml(item.id)}">删除</button></div>
    </article>` : `
    <article class="style-card record-card ${item.enabled ? "" : "disabled"}" data-index="${String(index + 1).padStart(2, "0")}">
      <div class="style-swatch"></div><div class="record-top"><span class="record-status">${item.enabled ? "ACTIVE" : "OFF"}</span></div>
      <h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || "尚未填写说明")}</p>
      <div class="record-actions"><button class="call" data-record-call="style:${escapeHtml(item.id)}">使用风格 →</button><button data-record-edit="style:${escapeHtml(item.id)}">编辑</button><button data-record-copy="style:${escapeHtml(item.id)}">复制</button><button data-record-delete="style:${escapeHtml(item.id)}">删除</button></div>
    </article>`).join("");
}

function openRecordDialog(kind, item = null, copy = false) {
  $("#recordKind").value = kind;
  $("#recordId").value = copy ? "" : item?.id || "";
  $("#recordName").value = item ? `${item.name}${copy ? " 副本" : ""}` : "";
  $("#recordDescription").value = item?.description || "";
  $("#recordInstructions").value = item?.instructions || "";
  $("#recordEnabled").checked = item?.enabled ?? true;
  $("#recordKicker").textContent = item && !copy ? "EDIT RECORD" : "NEW RECORD";
  $("#recordDialogTitle").textContent = `${item && !copy ? "编辑" : "新增"}${kind === "expert" ? "专家" : "风格"}`;
  $("#recordDialog").showModal();
}

async function saveRecord(event) {
  event.preventDefault();
  const payload = {
    kind: $("#recordKind").value,
    id: $("#recordId").value,
    name: $("#recordName").value.trim(),
    description: $("#recordDescription").value.trim(),
    instructions: $("#recordInstructions").value.trim(),
    enabled: $("#recordEnabled").checked,
  };
  try {
    await jsonFetch("/api/records/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    $("#recordDialog").close();
    await loadRecords(payload.kind);
    toast("已保存到本地 Markdown");
  } catch (error) { toast(error.message, true); }
}

async function deleteRecord(kind, id) {
  const item = state.records[kind].find(record => record.id === id);
  if (!item || !confirm(`把“${item.name}”移到废纸篓？`)) return;
  try {
    await jsonFetch("/api/records/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id }) });
    await loadRecords(kind);
    toast("已移到废纸篓");
  } catch (error) { toast(error.message, true); }
}

function openDispatch(kind, id) {
  const item = state.records[kind].find(record => record.id === id);
  if (!item) return;
  $("#dispatchKind").value = kind;
  $("#dispatchId").value = id;
  $("#dispatchTitle").textContent = kind === "expert" ? "调用专家" : "使用风格";
  $("#dispatchBadge").textContent = item.name;
  $("#dispatchStyleWrap").classList.toggle("hidden", kind !== "expert");
  $("#dispatchStyle").innerHTML = '<option value="">不叠加风格</option>' + state.records.style.filter(style => style.enabled).map(style => `<option value="${escapeHtml(style.id)}">${escapeHtml(style.name)}</option>`).join("");
  $("#dispatchTask").value = "";
  $("#dispatchDialog").showModal();
}

function confirmDispatch(event) {
  event.preventDefault();
  const kind = $("#dispatchKind").value;
  const item = state.records[kind].find(record => record.id === $("#dispatchId").value);
  const task = $("#dispatchTask").value.trim();
  if (!item || !task) return;
  const parts = [`请按以下${kind === "expert" ? "专家" : "风格"}配置完成任务。`, `【${item.name}】\n${item.instructions}`];
  if (kind === "expert" && $("#dispatchStyle").value) {
    const style = state.records.style.find(record => record.id === $("#dispatchStyle").value);
    if (style) parts.push(`【输出风格：${style.name}】\n${style.instructions}`);
  }
  parts.push(`【本次任务】\n${task}`);
  $("#dispatchDialog").close();
  showPage("agent");
  $("#promptInput").value = parts.join("\n\n");
  autoResizePrompt();
  $("#contextChips").innerHTML = `<span class="context-chip">${escapeHtml(item.name)}</span>`;
  $("#promptInput").focus();
}

async function loadSettings(tab = "general") {
  const content = $("#settingsContent");
  content.innerHTML = '<div class="skeleton-lines"></div>';
  try {
    if (tab === "general") {
      const [host, settings] = await Promise.all([rpc("host.describe"), rpc("settings.describe")]);
      content.innerHTML = `
        <div class="setting-card"><strong>运行模式</strong><small>${state.mode === "clean" ? "纯净模式 · 与 Vault 隔离" : "知识模式 · 已连接 Markdown Vault"}</small></div>
        <div class="setting-card"><strong>本地引擎</strong><small>${escapeHtml(host.provider || "-")} / ${escapeHtml(host.model || "-")} · Harness ${escapeHtml(host.version || "-")}</small></div>
        <div class="setting-card"><strong>忙碌时 Enter 行为</strong><small>选择把新任务排队，或立即引导当前执行。</small><div class="setting-actions"><button data-setting-busy="queue">排队</button><button data-setting-busy="steer">立即引导</button></div></div>
        <div class="setting-card"><strong>设置文档</strong><small>${settings.namespaces?.length || 0} 个可写命名空间 · 敏感字段始终脱敏</small><div class="setting-actions"><button data-open-settings-document>打开 Harness 设置文件</button></div></div>`;
    } else if (tab === "projects") {
      const value = await rpc("workspace.list", {});
      state.workspaces = normalizeWorkspaces(value);
      content.innerHTML = state.workspaces.map((item, index) => `<div class="setting-card"><strong>${escapeHtml(workspaceTitle(item))}</strong><small>${escapeHtml(item.path)} · ${(item.sessionIds || []).length} 个会话</small><div class="setting-actions"><button data-workspace-action="open:${escapeHtml(item.id)}">Finder</button><button data-workspace-action="rename:${escapeHtml(item.id)}">重命名</button><button data-workspace-action="up:${escapeHtml(item.id)}" ${index === 0 ? "disabled" : ""}>上移</button><button data-workspace-action="down:${escapeHtml(item.id)}" ${index === state.workspaces.length - 1 ? "disabled" : ""}>下移</button><button data-workspace-action="delete:${escapeHtml(item.id)}">移除项目</button></div></div>`).join("") || '<p class="muted">暂无项目。</p>';
    } else if (tab === "models") {
      const [providers, models, credentials] = await Promise.all([
        rpc("llm.providers", {}).catch(() => []), rpc("llm.models", {}).catch(() => ({ groups: [] })), rpc("credentials.describe", { refs: ["DEEPSEEK_API_KEY"] }).catch(() => ({})),
      ]);
      const providerList = unpackList(providers, ["providers", "items"]);
      const modelList = (models.groups || []).flatMap(group => (group.models || []).map(item => ({ ...item, providerName: group.name })));
      const credential = credentials.credentials?.DEEPSEEK_API_KEY;
      content.innerHTML = `<div class="setting-card"><strong>供应商</strong><small>${escapeHtml(providerList.filter(item => item.active).map(item => item.displayName || item.provider).join(" · ") || "使用 Harness 默认供应商")}</small><div class="setting-actions"><button data-discover-models>重新发现模型</button></div></div>${modelList.slice(0,30).map(item => `<div class="setting-card"><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.providerName || "")}${item.reasoning?.efforts?.length ? ` · 推理 ${item.reasoning.efforts.map(e => e.name).join("/")}` : ""}</small></div>`).join("")}<div class="setting-card"><strong>DeepSeek API 凭证</strong><small>${credential?.configured ? `已配置 · ${escapeHtml(credential.source || "本地凭证库")}` : "未配置"}。Boujoy 绝不回显现有密钥。</small><div class="credential-row"><input id="credentialInput" type="password" autocomplete="off" placeholder="输入新 Key（不会写入 Vault）"><button data-credential-set>保存</button><button data-credential-unset>清除</button></div></div>`;
    } else if (tab === "presets") {
      const value = await rpc("agentPreset.list", {});
      const items = unpackList(value, ["presets", "items"]);
      content.innerHTML = items.map(item => `<div class="setting-card"><strong>${escapeHtml(item.name || item.id)}${item.isDefault ? " · 默认" : ""}</strong><small>${escapeHtml(item.description || "Agent 预设")}</small><div class="setting-actions"><button data-preset-action="select:${escapeHtml(item.id)}">用于当前会话</button><button data-preset-action="read:${escapeHtml(item.id)}">查看</button><button data-preset-action="copy:${escapeHtml(item.id)}">复制为自定义</button>${item.trust === "user" ? `<button data-preset-action="open:${escapeHtml(item.id)}">打开文件</button><button data-preset-action="remove:${escapeHtml(item.id)}">删除</button>` : ""}</div></div>`).join("") || '<p class="muted">没有 Agent 预设。</p>';
  } else {
      const value = await rpc("skill.list", { sessionId: state.sessionId });
      const items = unpackList(value, ["skills", "items"]);
      content.innerHTML = items.map(item => `<div class="setting-card"><strong>${escapeHtml(item.name || item.id || item)}</strong><small>${escapeHtml(item.description || item.path || "Skill")}</small></div>`).join("") || '<p class="muted">没有可用 Skills。</p>';
    }
  } catch (error) { content.innerHTML = `<div class="setting-card"><strong>读取失败</strong><small>${escapeHtml(error.message)}</small></div>`; }
}

async function workspaceAction(action, id) {
  const item = state.workspaces.find(workspace => workspace.id === id);
  if (!item) return;
  try {
    if (action === "open") await rpc("host.openPath", { path: item.path });
    if (action === "rename") {
      const title = prompt("项目显示名称", workspaceTitle(item)); if (!title?.trim()) return;
      await rpc("workspace.rename", { workspaceId: id, title: title.trim() });
    }
    if (action === "delete") {
      if (!confirm(`从列表移除“${workspaceTitle(item)}”？不会删除磁盘目录或会话记录。`)) return;
      await rpc("workspace.delete", { workspaceId: id });
    }
    if (action === "up" || action === "down") {
      const index = state.workspaces.findIndex(workspace => workspace.id === id);
      const target = action === "up" ? state.workspaces[index - 1] : state.workspaces[index + 2];
      await rpc("workspace.insertBefore", { workspaceId: id, ...(target ? { beforeWorkspaceId: target.id } : {}) });
    }
    await loadSettings("projects");
    const listed = await rpc("workspace.list", {}); state.workspaces = normalizeWorkspaces(listed); renderWorkspaces();
  } catch (error) { toast(error.message, true); }
}

async function presetAction(action, id) {
  try {
    if (action === "select") { await rpc("agentPreset.select", { sessionId: state.sessionId, agentPreset: id }); await loadPresets(); }
    if (action === "read") {
      const value = await rpc("agentPreset.read", { agentPreset: id });
      $("#readerPath").textContent = `AGENT PRESET / ${id}`; $("#readerTitle").textContent = value.name || id; $("#readerDelete").classList.add("hidden"); $("#readerBody").innerHTML = markdown(value.content); $("#readerDialog").showModal();
    }
    if (action === "copy") {
      const target = prompt("新预设 ID（英文、数字或连字符）", `${id}-custom`); if (!target?.trim()) return;
      await rpc("agentPreset.copy", { from: id, agentPreset: target.trim(), name: `${target.trim()}` });
    }
    if (action === "open") await rpc("agentPreset.openDocument", { agentPreset: id });
    if (action === "remove") { if (!confirm(`删除自定义预设 ${id}？`)) return; await rpc("agentPreset.remove", { agentPreset: id }); }
    if (["copy", "remove"].includes(action)) await loadSettings("presets");
  } catch (error) { toast(error.message, true); }
}

async function settingsAction(target) {
  try {
    if (target.matches("[data-open-settings-document]")) await rpc("settings.openDocument", {});
    if (target.matches("[data-setting-busy]")) { const described = await rpc("settings.describe", {}); const ns = described.namespaces?.find(item => item.ns === "ui-conversation"); await rpc("settings.update", { ns: "ui-conversation", patch: { busyEnter: target.dataset.settingBusy }, expectedRevision: ns?.revision }); setBusyMode(target.dataset.settingBusy); toast("输入行为已更新"); }
    if (target.matches("[data-credential-set]")) { const value = $("#credentialInput")?.value.trim(); if (!value) return; await rpc("credentials.set", { ref: "DEEPSEEK_API_KEY", value }); $("#credentialInput").value = ""; toast("凭证已保存到 Harness 本地凭证库"); }
    if (target.matches("[data-credential-unset]")) { if (!confirm("清除 DeepSeek API 凭证？")) return; await rpc("credentials.unset", { ref: "DEEPSEEK_API_KEY" }); toast("凭证已清除"); }
    if (target.matches("[data-discover-models]")) { const value = await rpc("llm.discoverModels", { settingsNs: "llm-deepseek", provider: "deepseek-official" }); toast(`发现 ${value.models?.length || 0} 个模型`); }
  } catch (error) { toast(error.message, true); }
}

const COMMANDS = [
  { name: "打开 Agent", hint: "01", run: () => showPage("agent") },
  { name: "打开知识库", hint: "02", run: () => showPage("knowledge") },
  { name: "打开专家", hint: "03", run: () => showPage("experts") },
  { name: "打开风格", hint: "04", run: () => showPage("styles") },
  { name: "新建会话", hint: "⌘ N", run: createSession },
  { name: "选择新项目", hint: "⌘ O", run: pickProject },
  { name: "切换明暗主题", hint: "", run: () => setTheme(state.theme === "dark" ? "light" : "dark") },
  { name: "切换知识 / 纯净模式", hint: "", run: () => setMode(state.mode === "knowledge" ? "clean" : "knowledge") },
  { name: "重启 Boujoy Harness", hint: "安全重启", run: restartBoujoy },
];

function renderCommands(query = "") {
  const items = COMMANDS.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
  $("#commandList").innerHTML = items.map((item, index) => `<button type="button" class="command-item" data-command-index="${COMMANDS.indexOf(item)}"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.hint)}</small></button>`).join("");
}

function bindEvents() {
  document.addEventListener("click", event => {
    const mediaButton = event.target.closest("[data-play-media]");
    if (mediaButton) {
      const url = mediaButton.dataset.playMedia;
      const path = mediaButton.dataset.mediaPath || "";
      $("#mediaTitle").textContent = path.split("/").pop() || "视频播放";
      playMedia(url);
      return;
    }
    const copyButton = event.target.closest("[data-copy-text]");
    if (copyButton) {
      const text = copyButton.dataset.copyText || "";
      navigator.clipboard?.writeText(text).then(() => toast("已复制到剪贴板")).catch(() => {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand("copy"); toast("已复制到剪贴板"); } catch (_) { toast("复制失败", true); }
        textarea.remove();
      });
      return;
    }
    const codeCopyButton = event.target.closest("[data-code]");
    if (codeCopyButton) {
      const text = codeCopyButton.dataset.code || "";
      navigator.clipboard?.writeText(text).then(() => {
        const original = codeCopyButton.textContent;
        codeCopyButton.textContent = "✓ 已复制";
        setTimeout(() => { codeCopyButton.textContent = original; }, 1400);
      }).catch(() => toast("复制失败", true));
      return;
    }
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) { showPage(pageButton.dataset.page); return; }
    const sessionButton = event.target.closest("[data-session-id]");
    if (sessionButton) { loadSession(sessionButton.dataset.sessionId); return; }
    const workspaceButton = event.target.closest("[data-workspace-id]");
    if (workspaceButton) { selectWorkspace(workspaceButton.dataset.workspaceId); return; }
    const readerLink = event.target.closest("[data-reader-path]");
    if (readerLink) { event.preventDefault(); openReaderLink(readerLink.dataset.readerPath); return; }
    const openButton = event.target.closest("[data-open-path]");
    if (openButton) { event.preventDefault(); state.readerStack = []; openReader(openButton.dataset.openPath); return; }
    const starter = event.target.closest("[data-starter]");
    if (starter) { $("#promptInput").value = starter.dataset.starter; autoResizePrompt(); $("#promptInput").focus(); return; }
    for (const action of ["call", "edit", "copy", "delete"]) {
      const target = event.target.closest(`[data-record-${action}]`);
      if (target) {
        const [kind, id] = target.dataset[`record${action[0].toUpperCase()}${action.slice(1)}`].split(":");
        const item = state.records[kind].find(record => record.id === id);
        if (action === "call") openDispatch(kind, id);
        if (action === "edit") openRecordDialog(kind, item);
        if (action === "copy") openRecordDialog(kind, item, true);
        if (action === "delete") deleteRecord(kind, id);
        return;
      }
    }
    const command = event.target.closest("[data-command-index]");
    if (command) { $("#commandDialog").close(); COMMANDS[Number(command.dataset.commandIndex)].run(); }
    const removeImage = event.target.closest("[data-remove-image]");
    if (removeImage) { state.pendingImages.splice(Number(removeImage.dataset.removeImage), 1); renderPendingImages(); }
    const subagentOpen = event.target.closest("[data-subagent-open]");
    if (subagentOpen) { const [id, mode] = subagentOpen.dataset.subagentOpen.split(":"); openSubagent(id, mode); return; }
    const subagentPromptButton = event.target.closest("[data-subagent-prompt]");
    if (subagentPromptButton) { promptSubagent(subagentPromptButton.dataset.subagentPrompt); return; }
    const subagentStopButton = event.target.closest("[data-subagent-stop]");
    if (subagentStopButton) { stopSubagent(subagentStopButton.dataset.subagentStop); return; }
    for (const kind of ["edit", "steer", "remove"]) {
      const queueButton = event.target.closest(`[data-queue-${kind}]`);
      if (queueButton) { mutateQueue(queueButton.dataset[`queue${kind[0].toUpperCase()}${kind.slice(1)}`], kind); return; }
    }
    const workspaceActionButton = event.target.closest("[data-workspace-action]");
    if (workspaceActionButton) { const [action, id] = workspaceActionButton.dataset.workspaceAction.split(":"); workspaceAction(action, id); return; }
    const presetActionButton = event.target.closest("[data-preset-action]");
    if (presetActionButton) { const [action, id] = presetActionButton.dataset.presetAction.split(":"); presetAction(action, id); return; }
    const settingsActionButton = event.target.closest("[data-open-settings-document],[data-setting-busy],[data-credential-set],[data-credential-unset],[data-discover-models]");
    if (settingsActionButton) { settingsAction(settingsActionButton); return; }
    const goalActionButton = event.target.closest("[data-goal-action]");
    if (goalActionButton) { goalAction(goalActionButton.dataset.goalAction); return; }
    if (event.target.closest("#goalButton")) { editGoal(); return; }
    const busyModeButton = event.target.closest("[data-busy-mode]");
    if (busyModeButton) { setBusyMode(busyModeButton.dataset.busyMode); return; }
  });
  $("#themeButton").addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  // Mobile hamburger drawer (DeepSeek-app style ☰ menu)
  const mobileDrawer = $("#mobileDrawer");
  const renderMobileSessions = () => {
    const list = $("#mobileSessionList");
    if (!list) return;
    const archived = new Set(state.archivedSessionIds || []);
    // Only real, titled conversations: skip placeholder "新会话" blobs and
    // archived ones so the drawer shows a clean pick list, never clutter.
    const sessions = state.sessions
      .filter(item => {
        if (archived.has(item.id)) return false;
        const title = sessionTitle(item);
        return title && title !== "新会话" && !/^session-/.test(title);
      })
      .sort((a, b) => {
        if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    $("#mobileSessionCount").textContent = sessions.length;
    list.innerHTML = sessions.map(session => {
      const id = session.id || session.sessionId;
      const title = sessionTitle(session);
      const running = session.running ? '<i class="mobile-sess-run"></i>' : "";
      return `<button class="mobile-session-item ${id === state.sessionId ? "active" : ""}" data-mobile-session="${escapeHtml(id)}">${running}<span>${escapeHtml(title)}</span></button>`;
    }).join("") || '<p class="mobile-sess-empty">还没有会话</p>';
  };
  const openDrawer = () => {
    if (!mobileDrawer) return;
    mobileDrawer.classList.remove("hidden");
    $("#mobileMenuButton")?.setAttribute("aria-expanded", "true");
    refreshSessions({ quiet: true }).then(renderMobileSessions);
  };
  const closeDrawer = () => {
    if (!mobileDrawer) return;
    mobileDrawer.classList.add("hidden");
    $("#mobileMenuButton")?.setAttribute("aria-expanded", "false");
  };
  const openPairDialog = async () => {
    const dialog = $("#pairDialog");
    if (!dialog) return;
    const urlEl = $("#pairUrl"), codeEl = $("#pairCode"), errEl = $("#pairError");
    urlEl.textContent = "加载中…"; codeEl.textContent = "…"; errEl.textContent = "";
    try {
      const info = await jsonFetch("/api/access-info");
      urlEl.textContent = info.url || "http://<Mac 局域网IP>:8766";
      codeEl.textContent = info.accessCode || "—";
    } catch (error) {
      errEl.textContent = "读取失败：" + error.message + "（可查看 Mac 桌面 Boujoy-访问码.txt）";
    }
    dialog.showModal();
  };
  $("#mobileMenuButton")?.addEventListener("click", openDrawer);
  $("#mobileDrawerClose")?.addEventListener("click", closeDrawer);
  mobileDrawer?.addEventListener("click", (e) => { if (e.target === mobileDrawer) closeDrawer(); });
  $("#mobileSessionList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mobile-session]");
    if (!btn) return;
    const id = btn.dataset.mobileSession;
    if (!id || id === state.sessionId) { closeDrawer(); return; }
    state.sessionId = id;
    loadSession(id, { quiet: true });
    renderSessions();
    renderMobileSessions();
    closeDrawer();
  });
  $$(".mobile-nav-item").forEach(button => {
    button.addEventListener("click", () => {
      const page = button.dataset.page;
      if (page) showPage(page);
      else if (button.id === "mobileNavSettings") $("#settingsButton")?.click();
      else if (button.id === "mobileNavPair") openPairDialog();
      else if (button.id === "mobileNavNewSession") createSession();
      closeDrawer();
    });
  });
  $("#pairCopyCode")?.addEventListener("click", () => {
    const code = $("#pairCode")?.textContent || "";
    if (code && code !== "…") {
      navigator.clipboard?.writeText(code).then(() => toast("访问码已复制")).catch(() => {});
    }
  });
  $("#modeSwitch").addEventListener("click", () => setMode(state.mode === "knowledge" ? "clean" : "knowledge"));
  $("#newSessionButton").addEventListener("click", createSession);
  $("#pickProjectButton").addEventListener("click", pickProject);
  $("#workspacePicker").addEventListener("click", () => $("#workspaceMenu").classList.toggle("hidden"));
  $("#refreshSessions").addEventListener("click", () => refreshSessions());
  let sessionSearchTimer;
  $("#sessionSearch").addEventListener("input", event => { clearTimeout(sessionSearchTimer); sessionSearchTimer = setTimeout(() => searchSessions(event.target.value), 260); });
  $("#archiveSessionButton").addEventListener("click", archiveCurrentSession);
  $("#deleteSessionButton").addEventListener("click", openDeleteSession);
  $("#deleteSessionForm").addEventListener("submit", deleteCurrentSession);
  $("#renameSessionButton").addEventListener("click", renameSession);
  $("#forkSessionButton").addEventListener("click", forkSession);
  $("#promptInput").addEventListener("input", autoResizePrompt);
  $("#promptInput").addEventListener("keydown", event => {
    // Ignore Enter while an IME composition is active: confirming a candidate
    // (Chinese/Japanese/Korean) fires keydown with key === "Enter" and must not
    // submit the message. isComposing covers Safari/WKWebView on macOS.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendPrompt(); }
  });
  $("#sendButton").addEventListener("click", () => sendPrompt());
  // Track user scroll intent on the message stream: scrolling up means "leave
  // my place alone" — stop auto-following until the user returns to bottom.
  const messageStream = $("#messageStream");
  const suspendLiveFollow = () => {
    // A real wheel/touch gesture always wins over an in-flight programmatic
    // restore. Invalidate its animation frame before it can pull the reader
    // back to the previous edge.
    if (state.restoringConversationScroll) {
      state.scrollRestoreGeneration += 1;
      state.restoringConversationScroll = false;
    }
    state.lastManualScrollAt = performance.now();
    state.userScrolledUp = true;
    if (state.liveScrollFrame) {
      cancelAnimationFrame(state.liveScrollFrame);
      state.liveScrollFrame = null;
    }
  };
  // Capture user intent before the browser emits `scroll`: otherwise an
  // already queued live-edge animation frame can win the race and pull the
  // reader back down after the first trackpad/touch movement.
  messageStream.addEventListener("wheel", event => {
    if (Math.abs(event.deltaY) > 0) suspendLiveFollow();
  }, { passive: true });
  let lastTouchY = null;
  messageStream.addEventListener("touchstart", event => {
    lastTouchY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  messageStream.addEventListener("touchmove", event => {
    const nextTouchY = event.touches[0]?.clientY ?? null;
    if (lastTouchY != null && nextTouchY != null && nextTouchY !== lastTouchY) suspendLiveFollow();
    lastTouchY = nextTouchY;
  }, { passive: true });
  messageStream.addEventListener("touchend", () => { lastTouchY = null; }, { passive: true });
  messageStream.addEventListener("scroll", () => {
    // Replacing the timeline and restoring its anchor emits browser scroll
    // events too. They are layout bookkeeping, not evidence that the user
    // scrolled up; treating them as manual intent caused the end-of-answer hop.
    if (state.restoringConversationScroll) return;
    const stream = messageStream;
    const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
    if (!atBottom) {
      state.userScrolledUp = true;
    } else if (!state.liveResponse || performance.now() - state.lastManualScrollAt < 600) {
      state.userScrolledUp = false;
    }
    if (stream.scrollTop < 160 && state.historyHasMore && !state.historyLoadingOlder) {
      loadOlderHistory();
    }
  }, { passive: true });
  $("#cancelButton").addEventListener("click", cancelRun);
  $("#modelSelect").addEventListener("change", selectModel);
  $("#permissionSelect").addEventListener("change", selectPermission);
  $("#presetSelect").addEventListener("change", selectPreset);
  $("#attachButton").addEventListener("click", () => $("#imageInput").click());
  $("#imageInput").addEventListener("change", event => { addImages(event.target.files); event.target.value = ""; });
  let knowledgeSearchTimer;
  $("#knowledgeSearch").addEventListener("input", event => {
    renderKnowledge();
    clearTimeout(knowledgeSearchTimer);
    knowledgeSearchTimer = setTimeout(() => searchKnowledgeFull(event.target.value), 260);
  });
  $("#knowledgeRefresh").addEventListener("click", loadKnowledge);
  $("#knowledgeFilters").addEventListener("click", event => {
    const button = event.target.closest("button[data-filter]"); if (!button) return;
    state.knowledgeFilter = button.dataset.filter;
    $$("#knowledgeFilters button").forEach(item => item.classList.toggle("active", item === button));
    renderKnowledge();
  });
  $("#knowledgeGraphButton").addEventListener("click", openGraph);
  $("#knowledgeHealthButton").addEventListener("click", openHealth);
  $("#openActiveContext").addEventListener("click", () => openReader("00-System/Active-Context.md"));
  $("#readerClose").addEventListener("click", () => $("#readerDialog").close());
  $("#readerBack").addEventListener("click", readerBack);
  $("#readerReveal").addEventListener("click", revealReader);
  $("#readerSend").addEventListener("click", sendReaderToAgent);
  $("#readerDelete").addEventListener("click", deleteReaderCard);
  $("#captureButton").addEventListener("click", captureCurrentConversation);
  $("#graphClose").addEventListener("click", () => $("#graphDialog").close());
  $("#healthClose").addEventListener("click", () => $("#healthDialog").close());
  $("#mediaClose").addEventListener("click", closeMedia);
  $("#mediaDialog").addEventListener("click", event => { if (event.target === $("#mediaDialog")) closeMedia(); });
  $("#monitorRefresh").addEventListener("click", async () => {
    if (state.sessionId) await loadSession(state.sessionId, { quiet: true });
    renderMonitor();
    toast("监控数据已刷新");
  });
  $("#monitorEffortApply").addEventListener("click", applyMonitorEffort);
  $("#newsRefresh").addEventListener("click", async () => {
    const btn = $("#newsRefresh");
    btn.disabled = true;
    btn.textContent = "↻ 爬取中…";
    await loadNews(true);
    btn.disabled = false;
    btn.textContent = "↻ 刷新爬取";
  });
  $("#graphCanvas").addEventListener("click", event => { const node = event.target.closest("[data-graph-path]"); if (node) { $("#graphDialog").close(); openReader(node.dataset.graphPath); } });
  $("#healthDetails").addEventListener("click", event => { if (event.target.closest("[data-cleanup-all]")) cleanupReported(); });
  $("#addExpertButton").addEventListener("click", () => openRecordDialog("expert"));
  $("#addStyleButton").addEventListener("click", () => openRecordDialog("style"));
  $("#expertSearch").addEventListener("input", () => renderRecords("expert"));
  $("#styleSearch").addEventListener("input", () => renderRecords("style"));
  $("#recordForm").addEventListener("submit", saveRecord);
  $("#dispatchForm").addEventListener("submit", confirmDispatch);
  $("#goalForm").addEventListener("submit", saveGoal);
  $("#permissionForm").addEventListener("submit", confirmFullAccess);
  $("#permissionDialog").addEventListener("close", () => { state.pendingPermission = null; });
  $$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => {
    const dialog = $(`#${button.dataset.closeDialog}`);
    if (dialog?.open) dialog.close();
  }));
  $("#settingsButton").addEventListener("click", () => { $("#settingsDialog").showModal(); loadSettings(); });
  $$("[data-settings]").forEach(button => button.addEventListener("click", () => {
    $$("[data-settings]").forEach(item => item.classList.toggle("active", item === button)); loadSettings(button.dataset.settings);
  }));
  $("#commandButton").addEventListener("click", () => { renderCommands(); $("#commandDialog").showModal(); setTimeout(() => $("#commandSearch").focus(), 0); });
  $("#commandSearch").addEventListener("input", event => renderCommands(event.target.value));
  $("#interruptAllow").addEventListener("click", event => { event.preventDefault(); resolveInterrupt(true); });
  $("#interruptReject").addEventListener("click", event => { event.preventDefault(); resolveInterrupt(false); });
  // The persistent bar re-opens the pending dialog if the user dismissed it.
  $("#pendingInterruptBar").addEventListener("click", () => {
    if (!state.pendingInterrupts.length) return;
    if (!$("#interruptDialog").open) showNextInterrupt();
  });
  window.addEventListener("keydown", event => {
    const platformModifier = event.metaKey || event.ctrlKey;
    if (platformModifier && event.key.toLowerCase() === "k") { event.preventDefault(); state.page === "knowledge" ? $("#knowledgeSearch").focus() : $("#commandButton").click(); }
    if (platformModifier && event.key.toLowerCase() === "n") { event.preventDefault(); createSession(); }
    if (platformModifier && event.key.toLowerCase() === "o") { event.preventDefault(); pickProject(); }
  });
}

async function init() {
  setTheme(state.theme);
  bindEvents();
  showPage("agent");
  try {
    const config = await jsonFetch("/api/config");
    $("#modeHint").textContent = `${config.vaultName} 已连接`;
  } catch (_) { /* non-blocking */ }
  await waitForHarness();
  loadKnowledge();
  loadRecords("expert");
  loadRecords("style");
  state.poll = setInterval(async () => {
    if (document.hidden || state.sending || !state.sessionId) return;
    // Match the native client: WebSocket events are the primary source of
    // truth. Poll only as a degraded-mode repair when a stream is actually
    // unavailable. This avoids rebuilding a healthy live thread underneath
    // the reader and eliminates the last source of periodic micro-jumps.
    if (!eventStreamConnected("events.host")) await refreshSessions({ quiet: true });
    if (!eventStreamConnected("events.mux") && !state.liveResponse) {
      await loadSession(state.sessionId, { quiet: true });
    }
  }, 5000);
  setInterval(() => { if (!document.hidden && state.page === "knowledge") loadKnowledge(); }, 15000);
}


// -- Monitor page (05) -------------------------------------------------------
// Token usage / cache hit / trajectory / reasoning effort, all from real data.

function monitorSessionLabel() {
  const session = state.sessions.find(item => item.id === state.sessionId);
  return session ? sessionTitle(session) : "未选择会话";
}

function renderMonitor() {
  const projection = state.projection || {};
  const usage = projection.tokenUsage || {};
  const input = usage.uncachedInputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cache = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const billed = input + cache + cacheWrite;
  const total = billed + output;
  $("#tokenSessionLabel").textContent = monitorSessionLabel();
  $("#tokenInput").textContent = formatTokens(input);
  $("#tokenOutput").textContent = formatTokens(output);
  $("#tokenCache").textContent = formatTokens(cache);
  $("#tokenTotal").textContent = formatTokens(total);
  const hitPct = billed > 0 ? Math.round((cache / billed) * 100) : 0;
  $("#cacheHitPct").textContent = `${hitPct}%`;
  $("#cacheHitBar").style.width = `${Math.min(100, hitPct)}%`;

  // Context meter reuses the agent-page renderer.
  const meter = $("#monitorContextMeter");
  if (meter) {
    meter.classList.remove("hidden");
    const pressure = projection.contextPressure || projection.pressure || null;
    const breakdown = projection.contextBreakdown || projection.breakdown || null;
    const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
    const windowTokens = pressure?.contextWindow;
    if (usedTokens == null || windowTokens == null) {
      meter.innerHTML = '<p class="muted">上下文数据未就绪（需要会话投影）。</p>';
    } else {
      const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
      const segments = [];
      const rows = [
        { key: "systemTokens", label: "系统提示", color: "segment-system" },
        { key: "toolsTokens", label: "工具", color: "segment-tools" },
        { key: "messageTokens", label: "对话", color: "segment-messages" },
      ];
      let accounted = 0;
      for (const row of rows) {
        const value = breakdown?.[row.key];
        if (value == null) continue;
        const width = Math.max(2, Math.round((value / windowTokens) * 100));
        segments.push(`<div class="context-segment ${row.color}" style="width:${Math.min(width, 100 - accounted)}%"></div>`);
        row.value = value;
        accounted += Math.min(width, 100 - accounted);
      }
      if (segments.length === 0) {
        segments.push(`<div class="context-segment segment-messages" style="width:${percent}%"></div>`);
        rows[2].value = usedTokens;
      }
      const breakdownHtml = rows.filter(row => row.value != null).map(row => `<div class="context-row"><span class="context-swatch ${row.color}"></span><dt>${row.label}</dt><dd>~${formatTokens(row.value)}</dd></div>`).join("");
      meter.innerHTML = `
        <div class="context-meter-head"><span>上下文已用 ${percent}%</span><span>~${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}</span></div>
        <div class="context-meter-bar">${segments.join("")}</div>
        ${breakdownHtml ? `<div class="context-meter-rows">${breakdownHtml}</div>` : ""}`;
    }
  }

  // Reasoning effort select.
  const effortSelect = $("#monitorEffortSelect");
  if (effortSelect && !effortSelect.dataset.built) {
    effortSelect.dataset.built = "1";
    const current = state.modelDirectory?.current || {};
    const efforts = current.reasoning?.efforts || state.modelDirectory?.reasoning?.efforts || ["low", "medium", "high"];
    const currentEffort = current.reasoningEffort || current.reasoning?.defaultEffort || "";
    effortSelect.innerHTML = ['<option value="">默认强度</option>', ...efforts.map(e => `<option value="${escapeHtml(String(e))}" ${String(e) === String(currentEffort) ? "selected" : ""}>${escapeHtml(String(e))}</option>`)].join("");
  }

  // Trajectory from session history.
  renderTrajectory();
}

function renderTrajectory() {
  const list = $("#trajectoryList");
  const summary = $("#trajectorySummary");
  if (!state.sessionId) {
    list.innerHTML = '<p class="muted">先选择会话，再查看轨迹。</p>';
    summary.textContent = "—";
    return;
  }
  const events = state.history || [];
  const folded = foldHistory(events);
  const { output, activities } = folded;
  const turns = output.filter(item => item.role === "assistant" || item.role === "user").length;
  const calls = activities.length;
  summary.textContent = `回合 ${turns} · 工具 ${calls}`;
  // Build a timeline: user prompt → assistant step → tools, newest first.
  const timeline = [];
  let currentUser = null;
  for (const item of output) {
    if (item.role === "user") {
      currentUser = { role: "user", text: String(item.text).slice(0, 60), tools: [] };
      timeline.push(currentUser);
    } else if (item.role === "assistant" && currentUser) {
      currentUser.answer = String(item.text).slice(0, 80);
    }
  }
  const toolByTurn = new Map();
  let toolIndex = 0;
  for (const act of activities) {
    const userIndex = timeline.findIndex(item => item.role === "user");
    const bucket = userIndex >= 0 ? timeline[userIndex] : null;
    if (bucket) {
      if (!bucket.tools) bucket.tools = [];
      bucket.tools.push(act);
    }
    toolIndex += 1;
  }
  const rows = timeline.slice(-14).reverse().map((item, i) => `
    <div class="traj-turn">
      <div class="traj-head"><i></i><span>${escapeHtml(item.text || "（空提示）")}</span></div>
      ${item.answer ? `<div class="traj-answer">↳ ${escapeHtml(item.answer)}${item.answer.length >= 80 ? "…" : ""}</div>` : ""}
      ${(item.tools || []).length ? `<div class="traj-tools">${item.tools.slice(-4).map(t => `<span class="traj-tool">${escapeHtml(t.kind === "call" ? "⚡" : "✓")} ${escapeHtml(String(t.title).slice(0, 22))}</span>`).join("")}</div>` : ""}
    </div>`).join("");
  list.innerHTML = rows || '<p class="muted">当前会话还没有轨迹。</p>';
}

async function applyMonitorEffort() {
  const select = $("#monitorEffortSelect");
  const raw = select.value;
  if (!state.sessionId) { toast("请先创建会话", true); return; }
  if (!raw) { toast("请选择思考强度", true); return; }
  try {
    const current = state.modelDirectory?.current || {};
    await rpc("session.selectModel", {
      sessionId: state.sessionId,
      model: current.model,
      provider: current.provider,
      ...(raw ? { reasoningEffort: raw } : {}),
    });
    toast(`思考强度已设为 ${raw}`);
  } catch (error) { toast(error.message, true); }
}



// -- News page (06) ----------------------------------------------------------
// Two feeds (news + tools), each up to 10 items from the last 3 days.
// Clicking refresh forces a live crawl on the gateway.

function renderNewsFeed(listEl, items, kind) {
  if (!items || !items.length) {
    listEl.innerHTML = `<p class="muted">${kind === "news" ? "近三天暂无新闻。" : "近三天暂无工具更新。"}</p>`;
    return;
  }
  listEl.innerHTML = items.map(item => {
    const time = item.time ? new Date(item.time).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const summary = item.summary ? `<p>${escapeHtml(item.summary)}</p>` : "";
    const source = String(item.source || "AI");
    const image = typeof item.image === "string" && /^https?:\/\//i.test(item.image) ? item.image : "";
    const imageSrc = image ? `/api/news/image?url=${encodeURIComponent(image)}&article=${encodeURIComponent(String(item.url || ""))}` : "";
    const thumbCode = Array.from(source).slice(0, 2).join("").toUpperCase();
    const thumb = `<div class="news-thumb${image ? "" : " is-fallback"}" aria-hidden="true">
      ${imageSrc ? `<img src="${escapeHtml(imageSrc)}" alt="" loading="lazy" decoding="async">` : ""}
      <span class="news-thumb-mark"><b>${escapeHtml(thumbCode)}</b><i>${kind === "news" ? "NEWS" : "TOOLS"}</i></span>
    </div>`;
    return `<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
      ${thumb}<div class="news-copy">
        <div class="news-item-head"><span class="news-source">${escapeHtml(source)}</span>${time ? `<span class="news-time">${escapeHtml(time)}</span>` : ""}</div>
        <strong>${escapeHtml(item.title)}</strong>${summary}
        <span class="news-open">阅读原文 <i>↗</i></span>
      </div>
    </a>`;
  }).join("");
  listEl.querySelectorAll(".news-thumb img").forEach(img => {
    img.addEventListener("error", () => {
      img.closest(".news-thumb")?.classList.add("is-fallback");
      img.remove();
    }, { once: true });
  });
}

async function loadNews(force = false) {
  const url = force ? "/api/news?refresh=1" : "/api/news";
  try {
    const data = await jsonFetch(url);
    const fetched = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
    $("#newsUpdated").textContent = fetched ? `更新于 ${fetched}` : "";
    renderNewsFeed($("#newsList"), data.news || [], "news");
    renderNewsFeed($("#toolsList"), data.tools || [], "tools");
    return true;
  } catch (error) {
    $("#newsList").innerHTML = `<p class="muted">新闻拉取失败：${escapeHtml(error.message)}</p>`;
    toast(error.message, true);
    return false;
  }
}


window.Boujoy = {
  nativeModeReady(clean) { if (Boolean(clean) === (state.mode === "clean")) waitForHarness(); },
  receivePrompt(text, send = false) { showPage("agent"); $("#promptInput").value = text; autoResizePrompt(); if (send) sendPrompt(text); },
};

init();
