import * as vscode from 'vscode';
import type { Poller, UsageViewModel } from '../core/poller';
import type { ClaudeUsageViewerConfig } from '../core/config';
import { presentErrorReason } from '../core/errorState';
import { formatElapsedMinutes, formatResetEpochSeconds, formatTokenCount, formatUsd, roundPercent } from './formatting';

interface DetailItem extends vscode.QuickPickItem {
  action?: 'refreshNow' | 'openSettings';
}

/**
 * クリック時のQuickPick表示(05_final.md 1.3節)。ツールチップと同内容を
 * 項目別リストで見せ、「今すぐ更新」「設定を開く」の2アクションを添える。
 * Webview化は今回のスコープ外(1周目〜2周目ではQuickPickのまま)。
 */
export async function showDetails(poller: Poller, config: ClaudeUsageViewerConfig): Promise<void> {
  const model = poller.lastViewModel;
  const items: DetailItem[] = [...buildInfoItems(model, config), ...buildActionItems()];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Usage Viewer',
    placeHolder: '5h/7d/コスト/クレジットの内訳',
  });

  if (picked?.action === 'refreshNow') {
    await poller.pollNow();
    void vscode.window.showInformationMessage('Claude Usage: 更新しました。');
  } else if (picked?.action === 'openSettings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeUsageViewer');
  }
}

/**
 * 並びは statusBarController.render() / buildTooltip() と同じ:
 * ③(JSONLコスト)を先頭アンカーに、①②(statusline公式値)、④(クレジット・
 * オプトイン)と続ける。どの系統が落ちていても他の系統の項目は消さない。
 */
function buildInfoItems(model: UsageViewModel, config: ClaudeUsageViewerConfig): DetailItem[] {
  const { rateLimits, credit, jsonl } = model;
  const items: DetailItem[] = [];

  // ③ アンカー: JSONLコスト層
  if (config.showCost) {
    if (jsonl.kind === 'ok') {
      const est = jsonl.data;
      items.push({
        label: `推定コスト(推定値): ${formatUsd(est.costUsd)}`,
        detail: `${formatTokenCount(est.displayTokens)} tok / 直近${est.windowDays}日(JSONLログ集計)`,
      });
    } else {
      const presentation = presentErrorReason('jsonl_unavailable');
      items.push({ label: `推定コスト・トークン: ${presentation.shortLabel}`, detail: presentation.tooltipHint });
    }
  }

  // ①②(+Ctx%): statuslineブリッジ由来の公式値
  if (rateLimits.kind === 'unavailable') {
    const presentation = presentErrorReason(rateLimits.reason);
    items.push({ label: `$(${presentation.icon}) ${presentation.shortLabel}`, detail: presentation.tooltipHint });
  } else {
    const staleNote = rateLimits.kind === 'stale' ? '(Claude Code の稼働中に自動更新されます)' : '';
    items.push({
      label: `公式値の最終受信: ${formatElapsedMinutes(rateLimits.capturedAt)} ${staleNote}`.trim(),
      detail: '',
    });

    const rl = rateLimits.data.rate_limits;
    if (config.showFiveHour) {
      const fiveHour = rl?.five_hour;
      const value = typeof fiveHour?.used_percentage === 'number' ? roundPercent(fiveHour.used_percentage) : '不明';
      items.push({ label: `5時間ウィンドウ: ${value}`, detail: `リセット: ${formatResetEpochSeconds(fiveHour?.resets_at)}` });
    }
    if (config.showWeekly) {
      const weekly = rl?.seven_day;
      const value = typeof weekly?.used_percentage === 'number' ? roundPercent(weekly.used_percentage) : '不明';
      items.push({ label: `週次(全体): ${value}`, detail: `リセット: ${formatResetEpochSeconds(weekly?.resets_at)}` });
    }
    if (config.showContextPercentage) {
      const ctx = rateLimits.data.context_window?.used_percentage;
      const value = typeof ctx === 'number' ? roundPercent(ctx) : '不明';
      items.push({ label: `コンテキスト使用率: ${value}`, detail: '' });
    }
  }

  // ④ クレジット(オプトイン)
  if (config.showCredit && credit.kind !== 'disabled') {
    if (credit.kind === 'error') {
      const presentation = presentErrorReason(credit.reason);
      items.push({ label: `クレジット: $(${presentation.icon}) ${presentation.shortLabel}`, detail: presentation.tooltipHint });
    } else {
      const extra = credit.data.extra_usage;
      if (extra?.is_enabled === true && typeof extra.used_credits === 'number') {
        const limit = typeof extra.monthly_limit === 'number' ? formatUsd(extra.monthly_limit) : '不明';
        items.push({ label: `クレジット: ${formatUsd(extra.used_credits)}`, detail: `月次上限 ${limit}(非公式API)` });
      }
    }
  }

  return items;
}

function buildActionItems(): DetailItem[] {
  return [
    { label: '$(sync) 今すぐ更新', action: 'refreshNow' },
    { label: '$(gear) 設定を開く', action: 'openSettings' },
  ];
}
