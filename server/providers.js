// プロバイダ層 ＝ 各社AIへの実際の呼び出し。
// 入力は共通形式にそろえ、出力は { ok, text, error } に統一する。
// キーが無い / provider="mock" のときは、キー無しでもUIと動線が確認できるよう
// 文脈に応じた擬似応答を返す。
import { resolveApiKey } from "./store.js";

// 会話の履歴を1本のテキストにする（複数AIの発言をそのまま渡すのが最も互換性が高い）。
export function renderTranscript(messages) {
  if (!messages.length) return "(まだ発言はありません)";
  return messages
    .map((m) => {
      const who = m.role === "human" ? "👤 " + (m.name || "依頼者") : "🤖 " + (m.name || m.agentId);
      return `${who}:\n${m.content}`;
    })
    .join("\n\n---\n\n");
}

// モードごとの共通ルール（司会役の台本のようなもの）。
function modeRules(mode) {
  switch (mode) {
    case "review":
      return [
        "これは『相互チェック（ダブルチェック）』の会議です。",
        "他のAIの成果物や主張を鵜呑みにせず、前提・事実・数字・抜け漏れ・リスクを具体的に検証してください。",
        "問題がなければ発言の最後に必ず `[APPROVED]` と書き、まだ直すべき点があれば `[NEEDS_FIX]` と書いてから箇条書きで指摘してください。",
      ].join(" ");
    case "debate":
      return [
        "これは『議論』の会議です。安易に同意せず、異なる視点や反証を出して論点を深めてください。",
        "結論が出た、またはこれ以上議論が深まらないと判断したら、発言の最後に `[END]` と書いてください。",
      ].join(" ");
    default: // collaborate
      return [
        "これは複数AIによる『協働』の会議です。前の発言を踏まえ、重複を避けて前進させてください。",
        "抜けている観点があれば補い、間違いに気づいたら指摘してください。",
        "議論が十分にまとまったと判断したら、発言の最後に `[END]` と書いてください。",
      ].join(" ");
  }
}

// 1エージェント分のプロンプト（system + user）を組み立てる。
export function buildPrompt({ agent, meta, messages }) {
  const others = (meta.participants || [])
    .filter((p) => p !== agent.id)
    .join(", ");
  const system = [
    `あなたは「${agent.name}」という名前で、複数のAIが参加する会議（円卓会議）の参加者です。`,
    agent.persona,
    `あなたの担当ロール: ${agent.role || "参加者"}。他の参加者: ${others || "なし"}。`,
    modeRules(meta.mode),
    "重要: あなたの発言だけを日本語で書いてください。他の参加者のセリフを代弁しないこと。",
    "長すぎず、要点を絞って（目安200〜400字）。同じことの繰り返しは避ける。",
  ].join("\n");

  const user = [
    `# 会議のテーマ\n${meta.topic || meta.title}`,
    `# これまでの発言\n${renderTranscript(messages)}`,
    `# あなた（${agent.name} / ${agent.role || "参加者"}）の番です。上を踏まえて発言してください。`,
  ].join("\n\n");

  return { system, user };
}

/* ------------------------------ 各社API ------------------------------ */

async function callOpenAI({ apiKey, model, system, user }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI ${res.status}`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function callGemini({ apiKey, model, system, user }) {
  const m = model || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini ${res.status}`);
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim() || ""
  );
}

async function callClaude({ apiKey, model, system, user }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || "claude-3-5-sonnet-latest",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic ${res.status}`);
  return data.content?.map((c) => c.text).join("").trim() || "";
}

// キーが無いときの擬似応答。ロールごとに切り口を変えて“会議らしさ”を出す（デモ用）。
// 本物のキーを入れれば当然この関数は使われず、各AIが実際に考える。
function mockReply({ agent, meta, messages }) {
  const turn = messages.filter((m) => m.role === "ai").length;
  const last = [...messages].reverse().find((m) => m.role === "ai" && m.agentId !== agent.id);
  const ref = last ? `${last.name}の案を受けて、` : "";
  const role = (agent.role || "").toString();

  const pick = (arr) => arr[turn % arr.length];

  if (meta.mode === "review") {
    // まとめ役は最終盤で承認、それ以外は具体的な指摘（[NEEDS_FIX]）
    const isCloser = /まとめ|決定|司会/.test(role);
    if (isCloser && turn >= 2) {
      return `【${role}】${ref}指摘は「①スコープの過大 ②根拠となる数字の欠落 ③失敗時の代替」の3点に集約できます。①②が解消されたので、この範囲でリリース可と判断します。 [APPROVED]`;
    }
    const points = /提案|実装|エンジニア/.test(role)
      ? "最初のリリースは『よくある質問トップ10への回答』に絞るべき。全マニュアル対応は過大です。"
      : "『回答が見つからない時にどう振る舞うか』が未定義です。誤答リスクが高いので、分からない時は人へ促す挙動を必須に。";
    return `【${role}】${ref}検証しました。${points} [NEEDS_FIX]`;
  }

  if (meta.mode === "debate") {
    return `【${role}】${ref}` + pick([
      "あえて反対します。前提にしている『需要がある』が未検証では? まず1店舗で試すべきです。",
      "コスト面が抜けています。AIの誤答が1件でも起きた時の信頼低下は、効率化の利得を上回りかねません。",
      "論点を整理すると、争点は『対応範囲の広さ』と『誤答時の安全網』の2つ。ここで合意できれば前進します。",
    ]);
  }

  // collaborate
  return `【${role}】${ref}` + pick([
    "次の一手を提案します。①対象を『新人が最初の1週間で聞くこと』に絞る ②既存マニュアルから10問だけ抜く ③スタッフ3人で試す。",
    "①に賛成。加えて、回答の末尾に『出典ページ』を必ず付けると、誤答チェックがしやすくなります。",
    "ここまでを統合します。範囲=頻出10問／安全網=不明時は人へ／検証=3人で1週間。これで着手しましょう。 [END]",
  ]);
}

// 統一エントリ。ok=true なら text、失敗なら ok=false と error（＋mockフォールバック）。
export async function callLLM({ agent, meta, messages }) {
  const { system, user } = buildPrompt({ agent, meta, messages });

  if (agent.provider === "mock") {
    return { ok: true, text: mockReply({ agent, meta, messages }), mocked: true };
  }

  const apiKey = resolveApiKey(agent.provider);
  if (!apiKey) {
    // キー未登録 → 落とさず擬似応答で継続（設定画面でキーを入れれば本物になる）。
    return {
      ok: true,
      text: mockReply({ agent, meta, messages }),
      mocked: true,
      note: `${agent.provider} のAPIキー未登録のため擬似応答`,
    };
  }

  try {
    let text = "";
    if (agent.provider === "openai") text = await callOpenAI({ apiKey, ...agent, system, user });
    else if (agent.provider === "gemini") text = await callGemini({ apiKey, ...agent, system, user });
    else if (agent.provider === "claude") text = await callClaude({ apiKey, ...agent, system, user });
    else throw new Error(`未知のプロバイダ: ${agent.provider}`);
    return { ok: true, text: text || "(空の応答)" };
  } catch (e) {
    return { ok: false, error: String(e.message || e), text: "" };
  }
}
