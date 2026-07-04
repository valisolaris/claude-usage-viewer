import * as path from 'node:path';
import * as os from 'node:os';
import { STATUSLINE_STATE_FILENAME } from './statuslineStore';

/**
 * statuslineブリッジのセットアップ用純ロジック(vscode非依存)。
 * ファイルI/Oと確認ダイアログは view/setupCommand.ts 側が担い、
 * ここでは「何をどこに書くべきか」の決定だけを行う(単体テスト可能にするため)。
 */

export const BRIDGE_SCRIPT_FILENAME = 'claude-usage-viewer-bridge.js';

export function resolveClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function resolveSettingsPath(): string {
  return path.join(resolveClaudeDir(), 'settings.json');
}

export function resolveBridgeScriptPath(): string {
  return path.join(resolveClaudeDir(), BRIDGE_SCRIPT_FILENAME);
}

/** settings.json に書く statusLine コマンド文字列。スペース入りパスに備えて常に引用する。 */
export function buildBridgeCommand(bridgeScriptPath: string): string {
  return `node "${bridgeScriptPath.replace(/\\/g, '/')}"`;
}

/**
 * statusline 未設定ユーザー向けに設置する自己完結ブリッジスクリプト。
 * stdin の JSON を state ファイルへアトミックに書き出し、CLI 側の statusline
 * 表示としても簡潔な公式値ラインを返す(空表示にしない)。
 * 書き出し失敗で表示を壊さないこと(全て握りつぶす)が唯一の必須制約。
 */
export function buildBridgeScript(): string {
  return `#!/usr/bin/env node
// Claude Usage Viewer statusline bridge.
// Claude Code invokes this as the statusLine command with a JSON payload on
// stdin. The payload is persisted for the VS Code extension (atomic tmp ->
// rename so readers never see a half-written file), then a compact usage
// line is printed for the CLI statusline itself.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}
if (!data) process.exit(0);

try {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dest = path.join(dir, ${JSON.stringify(STATUSLINE_STATE_FILENAME)});
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, dest);
} catch {
  /* persisting must never break statusline rendering */
}

const parts = [];
const rl = data.rate_limits || {};
if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') {
  parts.push('5h ' + Math.round(rl.five_hour.used_percentage) + '%');
}
if (rl.seven_day && typeof rl.seven_day.used_percentage === 'number') {
  parts.push('7d ' + Math.round(rl.seven_day.used_percentage) + '%');
}
if (data.context_window && typeof data.context_window.used_percentage === 'number') {
  parts.push('Ctx ' + Math.round(data.context_window.used_percentage) + '%');
}
process.stdout.write(parts.length > 0 ? parts.join(' | ') : 'Claude Code');
`;
}

export type SettingsInspection =
  | { kind: 'no_file' }
  | { kind: 'unparseable' }
  | { kind: 'no_statusline' }
  | { kind: 'has_statusline'; command: string };

export function inspectSettings(raw: string | undefined): SettingsInspection {
  if (raw === undefined) return { kind: 'no_file' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unparseable' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unparseable' };
  }
  const statusLine = (parsed as Record<string, unknown>).statusLine;
  if (statusLine === undefined || statusLine === null) {
    return { kind: 'no_statusline' };
  }
  const command =
    typeof statusLine === 'object' && typeof (statusLine as Record<string, unknown>).command === 'string'
      ? String((statusLine as Record<string, unknown>).command)
      : '';
  return { kind: 'has_statusline', command };
}

/**
 * settings.json に statusLine 設定を追加した新しい本文を返す。
 * 既に statusLine がある場合は上書きしない(既存 statusline の持ち主には
 * 手動追記の案内を出す方針。勝手な差し替えは利用者の表示を壊す)。
 */
export function applyBridgeToSettings(
  raw: string | undefined,
  bridgeCommand: string,
): { ok: true; next: string } | { ok: false; reason: 'unparseable' | 'already_configured' } {
  const inspection = inspectSettings(raw);
  if (inspection.kind === 'unparseable') return { ok: false, reason: 'unparseable' };
  if (inspection.kind === 'has_statusline') return { ok: false, reason: 'already_configured' };

  const settings: Record<string, unknown> = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
  settings.statusLine = { type: 'command', command: bridgeCommand };
  return { ok: true, next: `${JSON.stringify(settings, null, 2)}\n` };
}

/**
 * 既存 statusline スクリプトの持ち主向けの手動追記手順。
 * 実際に本プロジェクトの開発環境(statusline.js)で動作確認済みの数行と同等。
 */
export function buildManualSetupInstructions(statePath: string): string {
  return `# Claude Usage Viewer — 既存 statusline への追記手順

お使いの Claude Code には既に statusline コマンドが設定されています。
Claude Usage Viewer はその設定を**上書きしません**。代わりに、お使いの
statusline スクリプトへ「stdin の JSON を state ファイルへ書き出す」処理を
数行追記してください(表示には影響しません)。

## Node.js スクリプトの場合

stdin の JSON をパースした直後に、次の関数を呼び出すコードを追加します:

\`\`\`js
function persistStateForUsageViewer(raw) {
  // Claude Usage Viewer(VS Code拡張)が読む state ファイルを書き出す。
  // 失敗しても statusline の表示は壊さない。
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const dest = path.join(dir, 'statusline-state.json');
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, dest);
  } catch {
    /* ignore */
  }
}
\`\`\`

呼び出し例(stdin を読み込んだ直後):

\`\`\`js
const raw = fs.readFileSync(0, 'utf8');
persistStateForUsageViewer(raw); // ← この1行を追加
\`\`\`

## シェル/その他の言語の場合

statusline に渡ってくる stdin をそのまま
\`${statePath}\`
へ書き出す処理を追加してください(一時ファイルに書いてから rename すると安全です)。

## 動作確認

追記後、Claude Code を1ターン実行すると state ファイルが生成され、
VS Code のステータスバーに公式値(5h/7d)が表示されます。
コマンド「Claude Usage: Set Up Statusline Bridge」を再実行すると受信状態を確認できます。
`;
}
