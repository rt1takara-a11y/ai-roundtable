// 依存パッケージ0のHTTPサーバー。web/ を配信し、/api/* を提供する。
// 起動: node server/index.js  → http://localhost:4321
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { PORT, WEB_DIR, MAX_AUTORUN_TURNS } from "./config.js";
import {
  listAgents,
  saveAgents,
  listConversations,
  getMeta,
  getMessages,
  createConversation,
  appendMessage,
  getSecrets,
  saveSecrets,
} from "./store.js";
import { takeTurn, runTurns, nextAgentId } from "./orchestrator.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// APIキーは値そのものを返さず「登録済みか」だけ返す（漏えい防止）。
function maskedSecrets() {
  const s = getSecrets();
  return {
    openai: Boolean(s.openai),
    gemini: Boolean(s.gemini),
    claude: Boolean(s.claude),
  };
}

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const method = req.method;

  // /api/agents
  if (seg[0] === "agents" && seg.length === 1) {
    if (method === "GET") return sendJson(res, 200, listAgents());
    if (method === "PUT" || method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.agents)) return sendJson(res, 400, { error: "agents 配列が必要です" });
      return sendJson(res, 200, saveAgents(body.agents));
    }
  }

  // /api/settings （APIキー登録）
  if (seg[0] === "settings" && seg.length === 1) {
    if (method === "GET") return sendJson(res, 200, maskedSecrets());
    if (method === "POST" || method === "PUT") {
      const body = await readBody(req);
      const patch = {};
      for (const k of ["openai", "gemini", "claude"]) {
        if (typeof body[k] === "string" && body[k].trim()) patch[k] = body[k].trim();
        if (body[k] === null) patch[k] = ""; // 明示的な削除
      }
      saveSecrets(patch);
      return sendJson(res, 200, maskedSecrets());
    }
  }

  // /api/conversations
  if (seg[0] === "conversations" && seg.length === 1) {
    if (method === "GET") return sendJson(res, 200, listConversations());
    if (method === "POST") {
      const body = await readBody(req);
      const meta = createConversation(body);
      // 最初の依頼（人間の発言 = GitHubへの最初のプッシュにあたる）があれば記録。
      if (body.prompt && body.prompt.trim()) {
        appendMessage(meta.id, { role: "human", name: "依頼者", content: body.prompt.trim() });
      }
      return sendJson(res, 201, getMeta(meta.id));
    }
  }

  // /api/conversations/:id ...
  if (seg[0] === "conversations" && seg[1]) {
    const id = seg[1];
    const meta = getMeta(id);
    if (!meta) return sendJson(res, 404, { error: "会議が見つかりません" });

    // GET /api/conversations/:id  → meta + messages + 次の話者
    if (seg.length === 2 && method === "GET") {
      const messages = getMessages(id);
      return sendJson(res, 200, { meta, messages, nextAgentId: nextAgentId(meta, messages) });
    }

    // POST /api/conversations/:id/message  … 人間が発言（＝新たなプッシュ）
    if (seg[2] === "message" && method === "POST") {
      const body = await readBody(req);
      if (!body.content?.trim()) return sendJson(res, 400, { error: "content が必要です" });
      const msg = appendMessage(id, { role: "human", name: "依頼者", content: body.content.trim() });
      return sendJson(res, 201, msg);
    }

    // POST /api/conversations/:id/turn  … AI1体だけ発言（動線を1歩進める）
    if (seg[2] === "turn" && method === "POST") {
      const r = await takeTurn(id);
      if (r.error && r.status) return sendJson(res, r.status, r);
      return sendJson(res, 200, r);
    }

    // POST /api/conversations/:id/run  … 会議を自動で回す（上限あり）
    if (seg[2] === "run" && method === "POST") {
      const body = await readBody(req);
      const max = Math.min(Number(body.maxTurns) || MAX_AUTORUN_TURNS, MAX_AUTORUN_TURNS);
      const results = await runTurns(id, max);
      return sendJson(res, 200, { results, meta: getMeta(id) });
    }
  }

  return sendJson(res, 404, { error: "不明なエンドポイント" });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(WEB_DIR, path.normalize(rel));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  AI Roundtable ▶  http://localhost:${PORT}\n`);
});
