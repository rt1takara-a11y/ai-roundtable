// CLI ＝ GitHub Actions（＝GitHubを媒介にする動線）から呼ぶ入口。
// push で起動した workflow が、これを実行して「次のAIの1ターン」を進め、
// 生成された発言ファイルを commit / push する。サーバー不要で回せる。
//
//   node server/cli.js turn <conversationId>          … 1ターンだけ
//   node server/cli.js run  <conversationId> [max]    … 上限まで自動で
//   node server/cli.js auto                            … 進行中の全会議を1ターンずつ進める（Actions用）
//   node server/cli.js list                           … 会議一覧
import { listConversations, getMeta } from "./store.js";
import { takeTurn, runTurns } from "./orchestrator.js";

const [, , cmd, id, arg] = process.argv;

async function main() {
  if (cmd === "list") {
    for (const c of listConversations()) {
      console.log(`${c.id}  [${c.status}] ${c.mode}  ${c.title}  (発言${c.messageCount})`);
    }
    return;
  }

  // GitHubを媒介にする動線の中核：push で起動し、進行中の会議を「1ターンだけ」進める。
  // 生成物を commit/push すると、その push が再びこの workflow を起こし、次のAIが続きを考える。
  // 進行中の会議が無ければ何も出力せず終了 → 差分ゼロ → push されず、ループは自然に止まる。
  if (cmd === "auto") {
    const active = listConversations().filter((c) => c.status !== "done");
    if (!active.length) { console.log("進行中の会議はありません。"); return; }
    let advanced = 0;
    for (const c of active) {
      const r = await takeTurn(c.id);
      if (r.message) { advanced++; console.log(`▶ ${c.id}: ${r.agent?.name || "system"} が発言`); }
    }
    console.log(`${advanced} 件の会議を1ターン進めました。`);
    return;
  }

  if (!id) {
    console.error("会議IDを指定してください。例: node server/cli.js turn 2026-08-25-xxxxxxxx");
    process.exit(1);
  }
  if (!getMeta(id)) {
    console.error(`会議 ${id} が見つかりません`);
    process.exit(1);
  }

  if (cmd === "turn") {
    const r = await takeTurn(id);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "run") {
    const max = Number(arg) || 8;
    const r = await runTurns(id, max);
    console.log(`${r.length} ターン進めました。`);
  } else {
    console.error("使い方: node server/cli.js <turn|run|list> [conversationId] [max]");
    process.exit(1);
  }
}

main();
