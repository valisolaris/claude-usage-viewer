import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import type { StatuslineStore } from '../data/statuslineStore';
import {
  applyBridgeToSettings,
  buildBridgeCommand,
  buildBridgeScript,
  buildManualSetupInstructions,
  inspectSettings,
  resolveBridgeScriptPath,
  resolveSettingsPath,
} from '../data/statuslineSetup';
import type { Logger } from '../core/logger';

/**
 * 「Claude Usage: Set Up Statusline Bridge」コマンド。
 * 公式値(5h/週次)の受け皿となる statusline ブリッジを診断・設置する。
 *
 * 方針(同意ベース):
 * - 既に受信できていれば何も変更せず状態だけ報告する。
 * - statusline 未設定なら、モーダルで明示同意を得てから settings.json を
 *   バックアップ付きで書き換え、自己完結ブリッジスクリプトを設置する。
 * - 既存 statusline がある場合は一切上書きせず、手動追記の手順書を開く。
 */
export async function runSetupStatusline(store: StatuslineStore, staleMinutes: number, logger: Logger): Promise<void> {
  const state = await store.read();
  if (state.ok && Date.now() - state.capturedAt <= staleMinutes * 60_000) {
    void vscode.window.showInformationMessage(
      `Claude Usage: ブリッジは動作中です(最終受信 ${new Date(state.capturedAt).toLocaleTimeString()})。追加の設定は不要です。`,
    );
    return;
  }

  const settingsPath = resolveSettingsPath();
  let raw: string | undefined;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    raw = undefined;
  }

  const inspection = inspectSettings(raw);

  if (inspection.kind === 'unparseable') {
    void vscode.window.showErrorMessage(
      `Claude Usage: ${settingsPath} を解析できないため、自動設定を中止しました(壊す恐れがあるため手を加えません)。ファイルの内容を確認してください。`,
    );
    return;
  }

  if (inspection.kind === 'has_statusline') {
    // 既存 statusline の持ち主。上書きせず手動追記の手順書を開く。
    if (state.ok) {
      // stateファイルはあるが古い: ブリッジ自体は入っており、Claude Code が最近動いていないだけ。
      void vscode.window.showInformationMessage(
        'Claude Usage: ブリッジは設定済みです。Claude Code を実行すると公式値が更新されます。',
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: buildManualSetupInstructions(store.resolvePath()),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(
      'Claude Usage: 既存の statusline 設定を検出しました。開いた手順に従ってスクリプトへ数行追記してください(この拡張からは上書きしません)。',
    );
    return;
  }

  // statusline 未設定(またはsettings.json自体が無い): 同意を取って自動設置する。
  const bridgePath = resolveBridgeScriptPath();
  const choice = await vscode.window.showWarningMessage(
    `Claude Code のグローバル設定を変更します。\n\n・ブリッジスクリプトを作成: ${bridgePath}\n・statusLine 設定を追加: ${settingsPath}(既存ファイルはバックアップを作成)\n\nこの変更で、Claude Code が計算した公式の使用率(5h/週次)がステータスバーに表示されるようになります。`,
    { modal: true },
    '設定する',
  );
  if (choice !== '設定する') {
    logger.info('setup statusline: cancelled by user');
    return;
  }

  try {
    await fs.writeFile(bridgePath, buildBridgeScript(), 'utf8');

    if (raw !== undefined) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      await fs.writeFile(`${settingsPath}.claude-usage-viewer-${stamp}.bak`, raw, 'utf8');
    }

    const applied = applyBridgeToSettings(raw, buildBridgeCommand(bridgePath));
    if (!applied.ok) {
      void vscode.window.showErrorMessage(`Claude Usage: settings.json の更新に失敗しました(${applied.reason})。`);
      return;
    }
    await fs.writeFile(settingsPath, applied.next, 'utf8');

    logger.info(`setup statusline: bridge installed at ${bridgePath}`);
    void vscode.window.showInformationMessage(
      'Claude Usage: ブリッジを設定しました。Claude Code を1ターン実行すると公式値(5h/週次)が届き、ステータスバーに自動反映されます。',
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`setup statusline failed: ${detail}`);
    void vscode.window.showErrorMessage(`Claude Usage: ブリッジ設定中にエラーが発生しました: ${detail}`);
  }
}
