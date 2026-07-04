import * as vscode from 'vscode';
import type { ConfigStore } from '../core/config';
import type { UsageViewModel } from '../core/poller';
import { presentErrorReason, requiresUserAction } from '../core/errorState';
import { buildCreditSegment, buildRateLimitBody, formatCostSegment, formatElapsedMinutes, iconForLevel, thresholdLevel } from './formatting';
import { buildTooltip } from './tooltipBuilder';

function toAlignment(value: 'left' | 'right'): vscode.StatusBarAlignment {
  return value === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
}

/**
 * `StatusBarItem` を1個だけ生成・更新する(05_final.md 1.1節、02_design未確定事項6のA案決定)。
 * alignmentはVS Code APIの制約で生成後に変更できないため、変更時はitemを破棄して作り直す。
 */
export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private alignment: vscode.StatusBarAlignment;
  private lastModel: UsageViewModel | undefined;

  constructor(private readonly config: ConfigStore) {
    this.alignment = toAlignment(config.get().statusBarAlignment);
    this.item = this.createItem(this.alignment);
  }

  private createItem(alignment: vscode.StatusBarAlignment): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(alignment, 100);
    item.name = 'Claude Usage Viewer';
    item.command = 'claudeUsageViewer.showDetails';
    item.text = '$(pulse) Claude Usage';
    item.show();
    return item;
  }

  /**
   * 設定変更時に呼ぶ。alignmentが変わっていればitemを作り直し、いずれの場合も
   * 直近のViewModelで再描画する(showCost/showFiveHour/しきい値等を次回ポーリングを
   * 待たずに反映するため)。
   */
  onConfigChanged(): void {
    const next = toAlignment(this.config.get().statusBarAlignment);
    if (next !== this.alignment) {
      this.item.dispose();
      this.alignment = next;
      this.item = this.createItem(next);
    }
    if (this.lastModel) {
      this.render(this.lastModel);
    }
  }

  /**
   * 04_critique.md Round2の破壊者裁定「③を常設アンカーに」はv0.2でも維持する。
   * v0.2の並び: ③JSONLコスト(アンカー) → ①②(+Ctx%)statusline公式値 →
   * ④クレジット(オプトイン・取得成功時のみ)。①②が未受信の場合は
   * セットアップ誘導の理由ラベルを出す。④のエラーはバーに出さず
   * ツールチップに限定する(オプトインの副次機能でバーを騒がせない)。
   */
  render(model: UsageViewModel): void {
    this.lastModel = model;
    const cfg = this.config.get();
    const { rateLimits, credit, jsonl } = model;

    const segments: string[] = [];

    // ③ アンカー: JSONLコスト層。config.showCostで明示OFFの場合は出さない。
    if (cfg.showCost && jsonl.kind === 'ok') {
      segments.push(formatCostSegment(jsonl.data));
    }

    // ①②(+Ctx%): statuslineブリッジ由来の公式値。staleは経過時間つきで値を出し続ける
    // (更新が止まるのはClaude Code非稼働時で正常。エラーではない)。
    let icon: string;
    let backgroundColor: vscode.ThemeColor | undefined;
    if (rateLimits.kind === 'ok' || rateLimits.kind === 'stale') {
      const level = thresholdLevel(rateLimits.data.rate_limits, cfg);
      const body = buildRateLimitBody(rateLimits.data, cfg);
      if (body.length > 0) {
        const suffix = rateLimits.kind === 'stale' ? `(${formatElapsedMinutes(rateLimits.capturedAt)})` : '';
        segments.push(`${body}${suffix}`);
      }
      icon = iconForLevel(level);
      backgroundColor =
        level === 'critical'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : level === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
    } else {
      // 04_critique.md Round2「視覚アラーム残件」の基準を踏襲: 警告色は「利用者が
      // 実際に対応すべき状態」のみ。未セットアップはコマンド実行で解決できるが、
      // ③だけ使いたい利用者に常時アラームを出すのは過剰なので背景色は付けない。
      const presentation = presentErrorReason(rateLimits.reason);
      segments.push(presentation.shortLabel);
      icon = presentation.icon;
      backgroundColor = undefined;
    }

    // ④ クレジット(オプトイン): 取得できた時だけバーに付加。エラー詳細はツールチップへ。
    if (cfg.showCredit && (credit.kind === 'ok' || credit.kind === 'stale')) {
      const creditSegment = buildCreditSegment(credit.data.extra_usage);
      if (creditSegment) segments.push(creditSegment);
    }
    if (cfg.showCredit && credit.kind === 'error' && requiresUserAction(credit.reason)) {
      backgroundColor = backgroundColor ?? new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    this.item.text = segments.length > 0 ? `$(${icon}) ${segments.join(' · ')}` : `$(${icon}) Claude Usage`;
    this.item.backgroundColor = backgroundColor;
    this.item.tooltip = buildTooltip(model, cfg);
  }

  /** 統合テスト専用の introspection フック。公開APIではない(Round3 E2E検証対応)。 */
  getText(): string {
    return this.item.text;
  }

  dispose(): void {
    this.item.dispose();
  }
}
