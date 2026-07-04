import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * E2E統合テスト(Round3で新設、v0.2で更新)。
 * 実データで動作する: ③はローカルJSONL集計、①②は実際の
 * `~/.claude/statusline-state.json`(このマシンではブリッジ導入済みのため実在する)。
 * ④クレジットは既定OFFのため、オプトインが効いていること(disabled)を検証する。
 */

const EXTENSION_ID = 'valisolaris.claude-usage-viewer';

const KNOWN_ERROR_REASONS = new Set([
  'unauthenticated',
  'rate_limited',
  'network',
  'unexpected_schema',
  'jsonl_unavailable',
  'plan_not_applicable',
  'bridge_not_configured',
  'bridge_unreadable',
]);

interface TestApi {
  getStatusBarText(): string;
  getLastViewModel(): {
    rateLimits: { kind: 'ok' | 'stale' | 'unavailable'; reason?: string; data?: unknown; capturedAt?: number };
    credit: { kind: 'disabled' | 'ok' | 'stale' | 'error'; reason?: string; data?: unknown };
    jsonl: { kind: 'ok' | 'unavailable'; reason?: string; data?: unknown };
  };
  hasCompletedFirstPoll(): boolean;
}

function resolveRealStatePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) return path.join(configDir, 'statusline-state.json');
  return path.join(os.homedir(), '.claude', 'statusline-state.json');
}

async function activateExtension(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} was not found by VS Code`);
  const api = await ext.activate();
  assert.ok(api, 'activate() did not return the test API');
  return api;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  // タイムアウトしても例外にはせず、呼び出し側のアサーションに現状を判断させる。
}

suite('Claude Usage Viewer E2E', () => {
  test('(a) 拡張が例外なくactivateし、テストAPIを返す', async () => {
    const api = await activateExtension();
    assert.strictEqual(typeof api.getStatusBarText, 'function');
    assert.strictEqual(typeof api.getLastViewModel, 'function');
  });

  test('(b) ステータスバーが実データで描画され、③コストセグメントが載る', async function () {
    this.timeout(15_000);
    const api = await activateExtension();

    // activate()内でpoller.start()が非同期に1回実行される。完了(onUpdate発火)を待つ。
    await waitFor(() => api.hasCompletedFirstPoll(), 10_000);
    assert.ok(api.hasCompletedFirstPoll(), 'first poll did not complete within 10s');

    const text = api.getStatusBarText();
    assert.strictEqual(typeof text, 'string');
    assert.ok(text.length > 0, 'status bar text should not be empty');
    console.log('[e2e] status bar text =', text);

    const model = api.getLastViewModel();
    console.log(
      '[e2e] jsonl.kind =', model.jsonl.kind,
      'rateLimits.kind =', model.rateLimits.kind,
      'credit.kind =', model.credit.kind,
    );

    if (model.jsonl.kind === 'ok') {
      // formatCostSegmentは「推定$」で始まる(view/formatting.ts)
      assert.ok(text.includes('推定$'), `expected status bar text to include a "推定$" cost segment, got: ${text}`);
    }
  });

  test('(c) showDetails / refreshNow / setupStatusline コマンドが登録されている', async function () {
    this.timeout(15_000);
    await activateExtension();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('claudeUsageViewer.showDetails'), 'showDetails command not registered');
    assert.ok(commands.includes('claudeUsageViewer.refreshNow'), 'refreshNow command not registered');
    assert.ok(commands.includes('claudeUsageViewer.setupStatusline'), 'setupStatusline command not registered');

    // refreshNowはUIを開かないため直接awaitできる
    await vscode.commands.executeCommand('claudeUsageViewer.refreshNow');

    // showDetailsはQuickPickを開いてユーザー選択を待つため、少し待ってから閉じる
    const showDetailsPromise = vscode.commands.executeCommand('claudeUsageViewer.showDetails');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await showDetailsPromise;
  });

  test('(d) 3系統とも既知の状態のいずれかになり、クラッシュしない', async function () {
    this.timeout(15_000);
    const api = await activateExtension();
    await waitFor(() => api.hasCompletedFirstPoll(), 10_000);

    const model = api.getLastViewModel();

    assert.ok(['ok', 'stale', 'unavailable'].includes(model.rateLimits.kind), `unexpected rateLimits.kind: ${model.rateLimits.kind}`);
    if (model.rateLimits.kind === 'unavailable') {
      const reason = model.rateLimits.reason;
      assert.ok(reason && KNOWN_ERROR_REASONS.has(reason), `rateLimits reason should be a known ErrorReason, got: ${reason}`);
    }

    // ④は既定OFF: オプトインが効いていて、OAuth側に一切触れていないことの表明
    assert.strictEqual(model.credit.kind, 'disabled', `credit should be disabled by default, got: ${model.credit.kind}`);

    assert.ok(['ok', 'unavailable'].includes(model.jsonl.kind), `unexpected jsonl.kind: ${model.jsonl.kind}`);
  });

  test('(e) 実statusline-state.jsonが存在する環境では公式値(①②)が表示される', async function () {
    this.timeout(15_000);
    const statePath = resolveRealStatePath();
    if (!fs.existsSync(statePath)) {
      console.log('[e2e] statusline-state.json not found; skipping real-value assertion:', statePath);
      this.skip();
      return;
    }

    const api = await activateExtension();
    await waitFor(() => api.hasCompletedFirstPoll(), 10_000);

    const model = api.getLastViewModel();
    assert.ok(
      model.rateLimits.kind === 'ok' || model.rateLimits.kind === 'stale',
      `state file exists at ${statePath} but rateLimits.kind = ${model.rateLimits.kind}`,
    );

    const text = api.getStatusBarText();
    console.log('[e2e] status bar with real official values =', text);
    // 実キャプチャ済みの構造(rate_limits.five_hour/seven_day)が使えていれば、
    // 既定設定(showFiveHour/showWeekly=true)で 5h/7d のどちらかは必ず載る。
    assert.ok(text.includes('5h ') || text.includes('7d '), `expected official 5h/7d values in status bar, got: ${text}`);
  });
});
