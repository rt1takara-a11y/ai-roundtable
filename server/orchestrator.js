// オーケストレーター ＝ AI同士の「動線」の心臓部。
// 「誰の番か」を決め → そのAIを呼び → 発言をファイルに追記し → 終了条件を判定する。
// この1ターンの積み重ねが、GitHub上での“AI同士の会議”になる。
import { getAgent, getMeta, getMessages, appendMessage, updateMeta } from "./store.js";
import { callLLM } from "./providers.js";

// 次に発言すべきエージェントIDを決める。
// 基本はラウンドロビン（参加者を順番に）。直前に人間が話した場合は先頭の参加者から。
export function nextAgentId(meta, messages) {
  const participants = meta.participants || [];
  if (!participants.length) return null;

  const aiMessages = messages.filter((m) => m.role === "ai");
  const lastAi = [...aiMessages].reverse()[0];

  if (!lastAi) return participants[0];
  const idx = participants.indexOf(lastAi.agentId);
  return participants[(idx + 1) % participants.length];
}

// 会話が終了条件に達したか。
export function isFinished(meta, messages) {
  if (meta.status === "done") return true;
  const aiMessages = messages.filter((m) => m.role === "ai");
  if (aiMessages.length >= (meta.turnLimit || 8)) return true;
  // 直近のAI発言に終了サイン（[END] / [APPROVED]）があれば終了。
  const last = [...aiMessages].reverse()[0];
  if (last && /\[(END|APPROVED)\]/i.test(last.content)) return true;
  return false;
}

// 1ターンだけ進める。戻り値は追記されたメッセージ（または終了情報）。
export async function takeTurn(convId) {
  const meta = getMeta(convId);
  if (!meta) return { error: "会議が見つかりません", status: 404 };

  let messages = getMessages(convId);
  if (isFinished(meta, messages)) {
    updateMeta(convId, { status: "done" });
    return { finished: true, reason: "終了条件に到達しました" };
  }

  const agentId = nextAgentId(meta, messages);
  const agent = getAgent(agentId);
  if (!agent) return { error: `エージェント ${agentId} が未定義です`, status: 400 };

  const result = await callLLM({ agent, meta, messages });
  if (!result.ok) {
    // 呼び出し失敗はシステムメッセージとして残す（動線が見えるように）。
    const sys = appendMessage(convId, {
      agentId: agent.id,
      name: agent.name,
      role: "system",
      content: `⚠️ ${agent.name} の応答に失敗しました: ${result.error}`,
    });
    return { message: sys, error: result.error };
  }

  const msg = appendMessage(convId, {
    agentId: agent.id,
    name: agent.name,
    role: "ai",
    content: result.text + (result.note ? `\n\n_（${result.note}）_` : ""),
  });

  // 追記後に終了判定を更新。
  messages = getMessages(convId);
  if (isFinished(getMeta(convId), messages)) updateMeta(convId, { status: "done" });

  return { message: msg, agent: { id: agent.id, name: agent.name }, mocked: result.mocked };
}

// 複数ターンをまとめて進める（上限つき）。
export async function runTurns(convId, maxTurns) {
  const out = [];
  for (let i = 0; i < maxTurns; i++) {
    const r = await takeTurn(convId);
    out.push(r);
    if (r.finished || r.error) break;
    const meta = getMeta(convId);
    if (meta.status === "done") break;
  }
  return out;
}
