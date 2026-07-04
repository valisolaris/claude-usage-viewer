import * as vscode from 'vscode';
import { CredentialStore } from './data/credentialStore';
import { OAuthUsageClient } from './data/oauthUsageClient';
import { JsonlAggregator } from './data/jsonlAggregator';
import { StatuslineStore } from './data/statuslineStore';
import { createMockSources } from './data/mockUsage';
import { ConfigStore } from './core/config';
import { Logger } from './core/logger';
import { Poller, type OAuthUsageSource, type StatuslineSource, type UsageViewModel } from './core/poller';
import { StatusBarController } from './view/statusBarController';
import { showDetails } from './view/detailCommand';
import { runSetupStatusline } from './view/setupCommand';

/**
 * Round3 E2E検証用のintrospection API。`activate()`の戻り値(`context.exports`)として
 * 公開する。package.jsonでは文書化しない非公開API(統合テスト専用、機能追加ではない)。
 */
export interface ClaudeUsageViewerTestApi {
  getStatusBarText(): string;
  getLastViewModel(): UsageViewModel;
  /** 起動後に1回でもポーリングが完了したか(E2Eテストの待機条件用)。 */
  hasCompletedFirstPoll(): boolean;
}

/** activate/deactivateのみを置く薄いエントリポイント(05_final.md 2章)。 */
export async function activate(context: vscode.ExtensionContext): Promise<ClaudeUsageViewerTestApi> {
  const outputChannel = vscode.window.createOutputChannel('Claude Usage Viewer');
  const logger = new Logger(outputChannel);
  const config = new ConfigStore();

  const version = String(context.extension.packageJSON.version ?? '0.0.0');

  const statuslineStore = new StatuslineStore(() => ({
    statuslineStatePathOverride: config.get().statuslineStatePathOverride,
  }));
  let statuslineSource: StatuslineSource = statuslineStore;

  const credentialStore = new CredentialStore(() => ({
    credentialsPathOverride: config.get().credentialsPathOverride,
  }));
  let oauthClient: OAuthUsageSource = new OAuthUsageClient(credentialStore, logger, version);

  // 開発検証専用: 環境変数で①②(statusline)と④(credit)を偽データに差し替える(data/mockUsage.ts参照)。
  const mockSpec = process.env.CLAUDE_USAGE_MOCK;
  let mocked = false;
  if (mockSpec !== undefined) {
    const mock = createMockSources(mockSpec);
    if (mock) {
      statuslineSource = mock.statusline;
      oauthClient = mock.oauth;
      mocked = true;
      logger.warn(`CLAUDE_USAGE_MOCK=${mockSpec}: 偽の使用率データを表示します(開発検証専用)`);
    } else {
      logger.warn(`CLAUDE_USAGE_MOCK="${mockSpec}" を解釈できないため無視します(書式: "65" / "65,30" / "65,30,12.5")`);
    }
  }

  const jsonlAggregator = new JsonlAggregator(() => ({ windowDays: 7 }));

  const statusBar = new StatusBarController(config);
  let firstPollCompleted = false;

  const poller = new Poller({
    statuslineSource,
    oauthClient,
    jsonlAggregator,
    logger,
    getIntervalMs: () => config.get().pollingIntervalSeconds * 1000,
    isCreditEnabled: () => config.get().showCredit,
    getStaleMinutes: () => config.get().statuslineStaleMinutes,
    onUpdate: (model) => {
      firstPollCompleted = true;
      statusBar.render(model);
    },
  });

  // stateファイルの更新をfs.watchで検知し、ポーリング周期を待たずに公式値を反映する。
  // モック時は監視不要。パスoverride変更に追従するため、設定変更時に張り直す。
  let statuslineWatcher = mocked ? { dispose: () => {} } : statuslineStore.watch(() => void poller.refreshStatuslineNow());

  context.subscriptions.push(
    outputChannel,
    config,
    statusBar,
    { dispose: () => poller.dispose() },
    { dispose: () => statuslineWatcher.dispose() },
    vscode.commands.registerCommand('claudeUsageViewer.showDetails', () => showDetails(poller, config.get())),
    vscode.commands.registerCommand('claudeUsageViewer.refreshNow', () => poller.pollNow()),
    vscode.commands.registerCommand('claudeUsageViewer.setupStatusline', () =>
      runSetupStatusline(statuslineStore, config.get().statuslineStaleMinutes, logger),
    ),
    config.onDidChange(() => {
      poller.reschedule();
      statusBar.onConfigChanged();
      if (!mocked) {
        statuslineWatcher.dispose();
        statuslineWatcher = statuslineStore.watch(() => void poller.refreshStatuslineNow());
      }
      // showCredit等の反映は次のポーリングを待たず即座に行う
      void poller.pollNow();
    }),
  );

  poller.start();
  logger.info(`Claude Usage Viewer activated (v${version})`);

  return {
    getStatusBarText: () => statusBar.getText(),
    getLastViewModel: () => poller.lastViewModel,
    hasCompletedFirstPoll: () => firstPollCompleted,
  };
}

export function deactivate(): void {
  // StatusBar/Poller/Config/WatcherはDisposableとしてsubscriptionsに登録済み。VS Codeが自動dispose。
}
