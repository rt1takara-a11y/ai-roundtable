// AI Roundtable — フロントエンド（ビルド不要のバニラJS）
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  agents: [],
  settings: {},
  conversations: [],
  current: null, // { meta, messages, nextAgentId }
  running: false,
  stop: false,
};

const api = {
  async get(p) { return (await fetch("/api" + p)).json(); },
  async post(p, body) {
    return (await fetch("/api" + p, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    })).json();
  },
  async put(p, body) {
    return (await fetch("/api" + p, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    })).json();
  },
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const initials = (name) => (name || "?").trim().slice(0, 2);
const agentById = (id) => state.agents.find((a) => a.id === id);
const MODE_LABEL = { review: "相互チェック", collaborate: "協働", debate: "議論" };

/* ---------------- ルーティング ---------------- */
function show(view) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $("#view-" + view)?.classList.add("active");
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
}
$$(".nav-item").forEach((n) => n.addEventListener("click", () => {
  const v = n.dataset.view;
  if (v === "meeting" && !state.current) { toast("先に会議を作成/選択してください"); show("dashboard"); return; }
  show(v);
}));

/* ---------------- 初期化 ---------------- */
async function boot() {
  state.agents = await api.get("/agents");
  state.settings = await api.get("/settings");
  await refreshConversations();
  renderDashboard();
  renderAgents();
  renderSettings();
  renderKeyStatus();
  // ?c=<会議ID> が付いていれば、その会議を直接開く（共有リンク用）
  const openId = new URLSearchParams(location.search).get("c");
  if (openId && state.conversations.some((c) => c.id === openId)) openMeeting(openId);
  else show("dashboard");
}

async function refreshConversations() {
  state.conversations = await api.get("/conversations");
  renderRecent();
}

/* ---------------- サイドバー：最近の会議 ---------------- */
function renderRecent() {
  const el = $("#recent-list");
  if (!state.conversations.length) { el.innerHTML = `<div class="muted small" style="padding:6px">まだありません</div>`; return; }
  el.innerHTML = state.conversations.slice(0, 12).map((c) => `
    <button class="recent-item" data-id="${c.id}">
      <div>${esc(c.title)}</div>
      <div class="r-sub"><span>${MODE_LABEL[c.mode] || c.mode}</span>·<span>発言${c.messageCount}</span>·<span>${c.status === "done" ? "終了" : "進行中"}</span></div>
    </button>`).join("");
  $$(".recent-item", el).forEach((b) => b.addEventListener("click", () => openMeeting(b.dataset.id)));
}

function renderKeyStatus() {
  const s = state.settings;
  const on = ["openai", "gemini", "claude"].filter((k) => s[k]);
  $("#key-status").textContent = on.length ? `🔑 登録済: ${on.join(", ")}` : "🔑 キー未登録（擬似応答モード）";
}

/* ---------------- ダッシュボード ---------------- */
function renderDashboard() {
  const active = state.conversations.filter((c) => c.status !== "done").length;
  const keys = ["openai", "gemini", "claude"].filter((k) => state.settings[k]).length;
  $("#stats").innerHTML = [
    ["会議の総数", state.conversations.length],
    ["進行中", active],
    ["登録エージェント", state.agents.length],
    ["接続済みAPI", `${keys}/3`],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

  // 参加AIチップ
  const chips = $("#nm-participants");
  chips.innerHTML = state.agents.map((a) => `
    <div class="chip on" data-id="${a.id}">
      <span class="dot" style="background:${a.color}"></span>${esc(a.name)}
      <span class="muted" style="font-size:11px">${esc(a.role || "")}</span>
    </div>`).join("");
  $$(".chip", chips).forEach((c) => c.addEventListener("click", () => c.classList.toggle("on")));
}

$("#nm-create").addEventListener("click", async () => {
  const topic = $("#nm-topic").value.trim();
  if (!topic) { toast("テーマ / 依頼を入力してください"); return; }
  const participants = $$("#nm-participants .chip.on").map((c) => c.dataset.id);
  if (!participants.length) { toast("参加AIを1体以上選んでください"); return; }
  const meta = await api.post("/conversations", {
    topic,
    title: topic.slice(0, 40),
    mode: $("#nm-mode").value,
    turnLimit: Number($("#nm-limit").value) || 6,
    participants,
    prompt: topic,
  });
  $("#nm-topic").value = "";
  await refreshConversations();
  toast("会議を作成しました");
  openMeeting(meta.id);
});

/* ---------------- 会議ルーム ---------------- */
async function openMeeting(id) {
  state.current = await api.get("/conversations/" + id);
  show("meeting");
  renderMeeting();
}

function renderMeeting() {
  const { meta, messages, nextAgentId } = state.current;
  $("#mtg-title").textContent = meta.title;
  $("#mtg-topic").textContent = meta.topic;
  $("#mtg-mode").textContent = MODE_LABEL[meta.mode] || meta.mode;
  $("#mtg-status").textContent =
    meta.status === "done" ? "終了" : `進行中 ${messages.filter((m) => m.role === "ai").length}/${meta.turnLimit}`;

  renderSeats(meta, nextAgentId);
  renderChat(messages);

  const done = meta.status === "done";
  $("#btn-step").disabled = done || state.running;
  $("#btn-run").disabled = done || state.running;
  $("#btn-run").textContent = done ? "会議は終了しました" : "⏩ 自動で回す";
}

// 円卓に参加者を円形配置。speakingId のシートを光らせる。
function renderSeats(meta, speakingId) {
  const table = $("#round-table");
  $$(".seat", table).forEach((s) => s.remove());
  const ps = meta.participants || [];
  const R = 118, cx = 105, cy = 105;
  ps.forEach((pid, i) => {
    const a = agentById(pid) || { name: pid, color: "#888", role: "" };
    const ang = (-90 + (360 / ps.length) * i) * (Math.PI / 180);
    const x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang);
    const seat = document.createElement("div");
    seat.className = "seat" + (pid === speakingId ? " speaking" : "");
    seat.style.left = x + "px"; seat.style.top = y + "px";
    seat.innerHTML = `
      <div class="avatar" style="background:${a.color}">${esc(initials(a.name))}</div>
      <div class="seat-name">${esc(a.name)}</div>
      <div class="seat-role">${esc(a.role || "")}</div>`;
    table.appendChild(seat);
  });
}

function tagify(text) {
  return esc(text)
    .replace(/\[APPROVED\]/gi, '<span class="tag-approved">[✔ 承認]</span>')
    .replace(/\[NEEDS_FIX\]/gi, '<span class="tag-fix">[要修正]</span>')
    .replace(/\[END\]/gi, '<span class="tag-end">[議論終了]</span>');
}

function renderChat(messages) {
  const chat = $("#chat");
  if (!messages.length) { chat.innerHTML = `<div class="empty">「次の1人が発言」または「自動で回す」で会議を始めましょう。</div>`; return; }
  chat.innerHTML = messages.map((m) => {
    if (m.role === "human")
      return `<div class="msg human"><div class="avatar" style="background:#3b5bdb">👤</div>
        <div class="bubble"><div class="who">${esc(m.name)}</div><div class="text">${esc(m.content)}</div></div></div>`;
    if (m.role === "system")
      return `<div class="msg system"><div class="bubble text">${esc(m.content)}</div></div>`;
    const a = agentById(m.agentId) || { color: "#888", role: "" };
    return `<div class="msg"><div class="avatar" style="background:${a.color}">${esc(initials(m.name))}</div>
      <div class="bubble"><div class="who">${esc(m.name)} <span class="role">${esc(a.role || "")}</span></div>
      <div class="text">${tagify(m.content)}</div></div></div>`;
  }).join("");
  chat.scrollTop = chat.scrollHeight;
}

async function stepOnce() {
  const id = state.current.meta.id;
  // 発言予定のシートを先に光らせる
  renderSeats(state.current.meta, state.current.nextAgentId);
  $("#typing").hidden = false;
  const r = await api.post(`/conversations/${id}/turn`, {});
  $("#typing").hidden = true;
  state.current = await api.get("/conversations/" + id);
  renderMeeting();
  await refreshConversations();
  return r;
}

$("#btn-step").addEventListener("click", async () => {
  if (state.running) return;
  await stepOnce();
});

$("#btn-run").addEventListener("click", async () => {
  if (state.running) return;
  state.running = true; state.stop = false;
  $("#btn-run").hidden = true; $("#btn-stop").hidden = false; $("#btn-step").disabled = true;
  for (let i = 0; i < 12; i++) {
    if (state.stop) break;
    const r = await stepOnce();
    if (r.finished || state.current.meta.status === "done") break;
    await new Promise((res) => setTimeout(res, 700)); // 会議っぽい“間”
  }
  state.running = false;
  $("#btn-run").hidden = false; $("#btn-stop").hidden = true;
  renderMeeting();
});

$("#btn-stop").addEventListener("click", () => { state.stop = true; toast("停止します"); });

$("#btn-say").addEventListener("click", sayHuman);
$("#human-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sayHuman(); });
async function sayHuman() {
  const input = $("#human-input");
  const content = input.value.trim();
  if (!content || !state.current) return;
  await api.post(`/conversations/${state.current.meta.id}/message`, { content });
  input.value = "";
  state.current = await api.get("/conversations/" + state.current.meta.id);
  renderMeeting();
}

/* ---------------- エージェント管理 ---------------- */
const PROVIDERS = [
  { v: "openai", label: "OpenAI (ChatGPT)" },
  { v: "gemini", label: "Google Gemini" },
  { v: "claude", label: "Anthropic Claude" },
  { v: "mock", label: "Mock（擬似・キー不要）" },
];

function renderAgents() {
  const list = $("#agents-list");
  list.innerHTML = state.agents.map((a, i) => `
    <div class="agent-card" data-i="${i}">
      <div class="ac-head">
        <div class="ac-avatar" style="background:${a.color}">${esc(initials(a.name))}</div>
        <strong>${esc(a.name)}</strong>
        <span class="muted small">${esc(a.role || "")}</span>
        <button class="btn danger" data-del="${i}" style="margin-left:auto">削除</button>
      </div>
      <div class="agent-grid">
        <label>表示名<input data-f="name" value="${esc(a.name)}"></label>
        <label>プロバイダ<select data-f="provider">${PROVIDERS.map((p) => `<option value="${p.v}" ${p.v === a.provider ? "selected" : ""}>${p.label}</option>`).join("")}</select></label>
        <label>モデル<input data-f="model" value="${esc(a.model || "")}"></label>
        <label>担当ロール<input data-f="role" value="${esc(a.role || "")}"></label>
        <label>カラー<input data-f="color" type="color" value="${a.color || "#6c8cff"}"></label>
        <label>ID<input data-f="id" value="${esc(a.id)}"></label>
        <label class="full">人格 / 指示（persona）<textarea data-f="persona" rows="2">${esc(a.persona || "")}</textarea></label>
      </div>
    </div>`).join("");

  $$(".agent-card", list).forEach((card) => {
    const i = Number(card.dataset.i);
    $$("[data-f]", card).forEach((inp) => inp.addEventListener("input", () => {
      state.agents[i][inp.dataset.f] = inp.value;
    }));
    $("[data-del]", card).addEventListener("click", () => {
      state.agents.splice(i, 1); renderAgents();
    });
  });
}

$("#btn-add-agent").addEventListener("click", () => {
  const n = state.agents.length + 1;
  state.agents.push({ id: "agent" + n, name: "新しいAI", provider: "mock", model: "", color: "#8b5cf6", role: "参加者", persona: "" });
  renderAgents();
});

$("#btn-save-agents").addEventListener("click", async () => {
  await api.put("/agents", { agents: state.agents });
  $("#agents-saved").textContent = "保存しました ✓";
  setTimeout(() => ($("#agents-saved").textContent = ""), 2000);
  renderDashboard();
});

/* ---------------- 設定（APIキー） ---------------- */
function renderSettings() {
  const grid = $("#settings-grid");
  const rows = [
    { k: "openai", label: "OpenAI (ChatGPT)", icon: "🟢", ph: "sk-..." },
    { k: "gemini", label: "Google Gemini", icon: "🔵", ph: "AIza..." },
    { k: "claude", label: "Anthropic Claude", icon: "🟠", ph: "sk-ant-..." },
  ];
  grid.innerHTML = rows.map((r) => {
    const ok = state.settings[r.k];
    return `<div class="provider-row">
      <div class="p-name">${r.icon} ${r.label}</div>
      <input data-key="${r.k}" type="password" placeholder="${ok ? "登録済み（変更する場合のみ入力）" : r.ph}">
      <span class="status-pill ${ok ? "ok" : "no"}">${ok ? "登録済み" : "未登録"}</span>
    </div>`;
  }).join("");
  const bar = document.createElement("div");
  bar.className = "actions-bar";
  bar.innerHTML = `<button class="btn primary" id="btn-save-keys">キーを保存</button>`;
  grid.appendChild(bar);
  $("#btn-save-keys").addEventListener("click", saveKeys);
}

async function saveKeys() {
  const patch = {};
  $$("[data-key]").forEach((inp) => { if (inp.value.trim()) patch[inp.dataset.key] = inp.value.trim(); });
  if (!Object.keys(patch).length) { toast("入力がありません"); return; }
  state.settings = await api.post("/settings", patch);
  renderSettings(); renderKeyStatus(); renderDashboard();
  toast("APIキーを保存しました");
}

boot();
