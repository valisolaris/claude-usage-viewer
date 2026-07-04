import * as vscode from 'vscode';

const SECTION = 'claudeUsageViewer';

export interface ClaudeUsageViewerConfig {
  pollingIntervalSeconds: number;
  showFiveHour: boolean;
  showWeekly: boolean;
  showCost: boolean;
  /** ④クレジット。v0.2からオプトイン(既定false)。trueの時だけ非公式API+認証情報読取を使う。 */
  showCredit: boolean;
  showContextPercentage: boolean;
  warningThreshold: number;
  criticalThreshold: number;
  statusBarAlignment: 'left' | 'right';
  credentialsPathOverride: string;
  statuslineStatePathOverride: string;
  /** statusline-state.json のmtimeがこの分数より古いとstale表示に切り替える。 */
  statuslineStaleMinutes: number;
}

const DEFAULTS: ClaudeUsageViewerConfig = {
  pollingIntervalSeconds: 300,
  showFiveHour: true,
  showWeekly: true,
  showCost: true,
  showCredit: false,
  showContextPercentage: false,
  warningThreshold: 70,
  criticalThreshold: 90,
  statusBarAlignment: 'right',
  credentialsPathOverride: '',
  statuslineStatePathOverride: '',
  statuslineStaleMinutes: 15,
};

/**
 * `workspace.getConfiguration` の読み取りラッパー。設定変更イベントの購読も提供する。
 * data層・core/poller.tsからは `getConfig()` を通じて常に最新値を取得する
 * (キャッシュせず毎回 `workspace.getConfiguration` を呼ぶことで、設定変更を
 * ポーリング間隔の変更なしに即座に反映できる)。
 */
export class ConfigStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        this.emitter.fire();
      }
    });
  }

  readonly onDidChange = this.emitter.event;

  get(): ClaudeUsageViewerConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
      pollingIntervalSeconds: clampMin(cfg.get('pollingIntervalSeconds', DEFAULTS.pollingIntervalSeconds), 30),
      showFiveHour: cfg.get('showFiveHour', DEFAULTS.showFiveHour),
      showWeekly: cfg.get('showWeekly', DEFAULTS.showWeekly),
      showCost: cfg.get('showCost', DEFAULTS.showCost),
      showCredit: cfg.get('showCredit', DEFAULTS.showCredit),
      showContextPercentage: cfg.get('showContextPercentage', DEFAULTS.showContextPercentage),
      warningThreshold: cfg.get('warningThreshold', DEFAULTS.warningThreshold),
      criticalThreshold: cfg.get('criticalThreshold', DEFAULTS.criticalThreshold),
      statusBarAlignment: cfg.get('statusBarAlignment', DEFAULTS.statusBarAlignment),
      credentialsPathOverride: cfg.get('credentialsPathOverride', DEFAULTS.credentialsPathOverride),
      statuslineStatePathOverride: cfg.get('statuslineStatePathOverride', DEFAULTS.statuslineStatePathOverride),
      statuslineStaleMinutes: clampMin(cfg.get('statuslineStaleMinutes', DEFAULTS.statuslineStaleMinutes), 1),
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function clampMin(value: number, min: number): number {
  return typeof value === 'number' && value >= min ? value : min;
}
