// 実行環境の設定を1か所に集約する。
// パスはすべて ai-roundtable/ プロジェクトルート基準。
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// プロジェクトルート（= ai-roundtable/）
export const ROOT = path.resolve(__dirname, "..");

// GitHub を媒介にする「会話の置き場」。ここに置いたものが commit / push され、
// 別のAI（別プロセス / 別 workflow）が読み取って続きを考える。
export const CONVERSATIONS_DIR = path.join(ROOT, "conversations");

// エージェント（＝会議に参加するAIの人格）の定義ファイル。
export const AGENTS_FILE = path.join(ROOT, "agents.json");

// APIキーなどの秘密情報。gitignore 済みでコミットされない。
export const SECRETS_DIR = path.join(ROOT, ".data");
export const SECRETS_FILE = path.join(SECRETS_DIR, "secrets.json");

export const WEB_DIR = path.join(ROOT, "web");

export const PORT = Number(process.env.PORT || 4321);

// 1回の「自動で回す」で進める最大ターン数の上限（暴走・課金事故の保険）。
export const MAX_AUTORUN_TURNS = Number(process.env.RT_MAX_AUTORUN || 12);
