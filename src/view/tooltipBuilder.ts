import * as vscode from 'vscode';
import type { UsageViewModel } from '../core/poller';
import type { ClaudeUsageViewerConfig } from '../core/config';
import { presentErrorReason } from '../core/errorState';
import { formatElapsedMinutes, formatResetEpochSeconds, formatTokenCount, formatUsd, roundPercent } from './formatting';

/**
 * ホバー用MarkdownStringの組み立て(05_final.md 1.2節)。
 * 並びは statusBarController.render() と同じ: ③(JSONLコスト・推定値)を
 * 常に先頭のアンカーにし、①②(statusline公式値)、④(クレジット・オプトイン)と続ける。
 * 末尾にデータ源の性質(公式値/推定値/非公式API)の固定文言を必ず入れる。
 */
export function buildTooltip(model: UsageViewModel, config: ClaudeUsageViewerConfig): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;

  md.appendMarkdown('**Claude Usage Viewer**\n\n');

  const { rateLimits, credit, jsonl } = model;

  // ③ アンカー: JSONLコスト層(認証情報・通信に依存しないため常に先頭で表示)
  if (config.showCost) {
    md.appendMarkdown('| 項目 | 値 | 期間 |\n');
    md.appendMarkdown('|---|---|---|\n');
    if (jsonl.kind === 'ok') {
      const est = jsonl.data;
      md.appendMarkdown(
        `| 推定コスト(JSONL集計・**推定値**) | ${formatUsd(est.costUsd)} / ${formatTokenCount(est.displayTokens)} tok | 直近${est.windowDays}日 |\n`,
      );
    } else {
      const presentation = presentErrorReason('jsonl_unavailable');
      md.appendMarkdown(`| 推定コスト・トークン | ${presentation.shortLabel} | — |\n`);
    }
    md.appendMarkdown('\n');
  }

  // ①②(+Ctx%): statuslineブリッジ由来の公式値
  if (rateLimits.kind === 'unavailable') {
    const presentation = presentErrorReason(rateLimits.reason);
    md.appendMarkdown(`$(${presentation.icon}) ${presentation.shortLabel}\n\n`);
    md.appendMarkdown(`${presentation.tooltipHint}\n\n`);
  } else {
    md.appendMarkdown(`公式値の最終受信: ${formatElapsedMinutes(rateLimits.capturedAt)}`);
    if (rateLimits.kind === 'stale') {
      md.appendMarkdown(' (Claude Code の稼働中に自動更新されます)');
    }
    md.appendMarkdown('\n\n');

    md.appendMarkdown('| 項目 | 値 | リセット |\n');
    md.appendMarkdown('|---|---|---|\n');

    const rl = rateLimits.data.rate_limits;
    if (config.showFiveHour) {
      const fiveHour = rl?.five_hour;
      const value = typeof fiveHour?.used_percentage === 'number' ? roundPercent(fiveHour.used_percentage) : '不明';
      md.appendMarkdown(`| 5時間ウィンドウ | ${value} | ${formatResetEpochSeconds(fiveHour?.resets_at)} |\n`);
    }
    if (config.showWeekly) {
      const weekly = rl?.seven_day;
      const value = typeof weekly?.used_percentage === 'number' ? roundPercent(weekly.used_percentage) : '不明';
      md.appendMarkdown(`| 週次(全体) | ${value} | ${formatResetEpochSeconds(weekly?.resets_at)} |\n`);
    }
    if (config.showContextPercentage) {
      const ctx = rateLimits.data.context_window?.used_percentage;
      const value = typeof ctx === 'number' ? roundPercent(ctx) : '不明';
      md.appendMarkdown(`| コンテキスト使用率 | ${value} | — |\n`);
    }
    md.appendMarkdown('\n');
  }

  // ④ クレジット(オプトイン)。disabledの場合は項目自体を出さない。
  if (config.showCredit && credit.kind !== 'disabled') {
    if (credit.kind === 'error') {
      const presentation = presentErrorReason(credit.reason);
      md.appendMarkdown(`クレジット(extra usage): $(${presentation.icon}) ${presentation.shortLabel} — ${presentation.tooltipHint}\n\n`);
    } else {
      const extra = credit.data.extra_usage;
      if (extra?.is_enabled === true && typeof extra.used_credits === 'number') {
        const limit = typeof extra.monthly_limit === 'number' ? formatUsd(extra.monthly_limit) : '不明';
        md.appendMarkdown(`| クレジット(extra usage) | 値 | 月次上限 |\n`);
        md.appendMarkdown(`|---|---|---|\n`);
        md.appendMarkdown(`| 追加使用の累計額 | ${formatUsd(extra.used_credits)} | ${limit} |\n\n`);
      }
    }
  }

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(
    '5h/週次はClaude Code本体が計算した公式値(statusline経由)です。推定コストはローカルログからの概算で、実際の請求額と一致しない場合があります。\n\n',
  );
  if (config.showCredit) {
    md.appendMarkdown('⚠️ クレジットは非公式API `/api/oauth/usage` を使用しており、Anthropic公式サポート対象外です。\n\n');
  }
  md.appendMarkdown('クリックで詳細を表示 / 設定から更新間隔を変更できます。');

  return md;
}
