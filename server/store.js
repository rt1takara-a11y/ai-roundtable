// ストア層 ＝「GitHubを媒介にする」ための読み書き。
// 会話もエージェントも“ただのファイル”として置く。だから git で履歴が残り、
// push すれば別のAI（別プロセス/別workflow）がそのファイルを読んで続きを考えられる。
//
// 保存レイアウト:
//   agents.json                                  … 参加AIの人格定義
//   conversations/<id>/meta.json                 … 会議のメタ情報
//   conversations/<id>/messages/<0001>-<agent>.json … 1発言 = 1ファイル（衝突しにくい）
//
// 「1発言1ファイル」なのは、複数のAIが同時に push しても merge 衝突が起きにくいから。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  AGENTS_FILE,
  CONVERSATIONS_DIR,
  SECRETS_DIR,
  SECRETS_FILE,
} from "./config.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/* ------------------------------ エージェント ------------------------------ */

// 初期エージェント。キーが無くても mock で会議が回るようにしてある。
const DEFAULT_AGENTS = [
  {
    id: "gpt",
    name: "ChatGPT",
    provider: "openai",
    model: "gpt-4o-mini",
    color: "#10a37f",
    role: "提案役",
    persona:
      "あなたは実装と発想が得意なエンジニア気質のAI。まず具体的な案を出す。簡潔に、箇条書きも使って要点から話す。",
  },
  {
    id: "gemini",
    name: "Gemini",
    provider: "gemini",
    model: "gemini-1.5-flash",
    color: "#4285f4",
    role: "調査・検証役",
    persona:
      "あなたは事実確認と抜け漏れ探しが得意なAI。他のAIの発言の前提・数字・リスクを具体的に指摘する。褒めるより穴を見つける。",
  },
  {
    id: "claude",
    name: "Claude",
    provider: "claude",
    model: "claude-3-5-sonnet-latest",
    color: "#d97757",
    role: "まとめ役",
    persona:
      "あなたは論点整理と意思決定が得意なAI。議論を要約し、対立点を明確にし、次の一手を1つに絞って提案する。",
  },
];

export function listAgents() {
  if (!fs.existsSync(AGENTS_FILE)) {
    writeJson(AGENTS_FILE, DEFAULT_AGENTS);
    return DEFAULT_AGENTS;
  }
  return readJson(AGENTS_FILE, DEFAULT_AGENTS);
}

export function saveAgents(agents) {
  writeJson(AGENTS_FILE, agents);
  return agents;
}

export function getAgent(id) {
  return listAgents().find((a) => a.id === id) || null;
}

/* ------------------------------ 会話（会議） ------------------------------ */

function convDir(id) {
  return path.join(CONVERSATIONS_DIR, id);
}
function metaFile(id) {
  return path.join(convDir(id), "meta.json");
}
function messagesDir(id) {
  return path.join(convDir(id), "messages");
}

export function listConversations() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) return [];
  return fs
    .readdirSync(CONVERSATIONS_DIR)
    .map((id) => getMeta(id))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export function getMeta(id) {
  const meta = readJson(metaFile(id), null);
  if (!meta) return null;
  const msgs = getMessages(id);
  return { ...meta, messageCount: msgs.length };
}

export function createConversation({
  title,
  topic,
  participants,
  mode = "collaborate",
  turnLimit = 8,
}) {
  const id = new Date().toISOString().slice(0, 10) + "-" + crypto.randomUUID().slice(0, 8);
  const meta = {
    id,
    title: title || topic?.slice(0, 40) || "無題の会議",
    topic: topic || "",
    participants: participants && participants.length ? participants : ["gpt", "gemini", "claude"],
    mode, // collaborate | review | debate
    status: "active", // active | done
    turnLimit, // AIターンの上限（人間の発言は数えない）
    createdAt: new Date().toISOString(),
  };
  ensureDir(messagesDir(id));
  writeJson(metaFile(id), meta);
  return meta;
}

export function updateMeta(id, patch) {
  const meta = readJson(metaFile(id), null);
  if (!meta) return null;
  const next = { ...meta, ...patch };
  writeJson(metaFile(id), next);
  return next;
}

export function getMessages(id) {
  const dir = messagesDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean);
}

// 1発言を追記する。seq は連番で、ファイル名にもする（0001-gpt.json）。
export function appendMessage(id, { agentId, name, role, content }) {
  const dir = messagesDir(id);
  ensureDir(dir);
  const seq = getMessages(id).length + 1;
  const msg = {
    seq,
    agentId: agentId || null, // 人間の場合は null
    name: name || (agentId ? agentId : "あなた"),
    role: role || (agentId ? "ai" : "human"), // ai | human | system
    content,
    createdAt: new Date().toISOString(),
  };
  const padded = String(seq).padStart(4, "0");
  const safeAgent = (agentId || "human").replace(/[^a-z0-9_-]/gi, "");
  writeJson(path.join(dir, `${padded}-${safeAgent}.json`), msg);
  return msg;
}

/* ------------------------------ 秘密情報（APIキー） ------------------------------ */

export function getSecrets() {
  return readJson(SECRETS_FILE, {});
}

export function saveSecrets(patch) {
  ensureDir(SECRETS_DIR);
  const current = getSecrets();
  const next = { ...current, ...patch };
  writeJson(SECRETS_FILE, next);
  return next;
}

// 環境変数 > secrets.json の順でキーを解決する（CI/Actionsでは環境変数を使う想定）。
export function resolveApiKey(provider) {
  const env = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
  }[provider];
  if (env) return env;
  const s = getSecrets();
  return s[provider] || null;
}
