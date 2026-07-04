import test from 'node:test';
import assert from 'node:assert/strict';
// core/poller.tsはvscodeに依存しないため、data層のnode:testハーネスから直接検証できる。
import {
  computeNextOAuthAttemptAt,
  OAUTH_BACKOFF_BASE_MS,
  OAUTH_BACKOFF_MAX_MS,
  Poller,
  type PollerDeps,
} from '../../core/poller';
import type { JsonlAggregator } from '../../data/jsonlAggregator';
import type { Logger } from '../../core/logger';
import type { OAuthUsageResult, StatuslineReadResult } from '../../data/types';

const NOW = 1_000_000;

test('computeNextOAuthAttemptAt: retry-afterがあれば最優先で尊重する(04_critique.md Round2対応)', () => {
  const next = computeNextOAuthAttemptAt({ ok: false, reason: 'rate_limited', retryAfterMs: 1_802_000 }, 1, NOW);
  assert.equal(next, NOW + 1_802_000);
});

test('computeNextOAuthAttemptAt: retry-afterが無いrate_limitedは指数バックオフになる', () => {
  const first = computeNextOAuthAttemptAt({ ok: false, reason: 'rate_limited' }, 1, NOW);
  const second = computeNextOAuthAttemptAt({ ok: false, reason: 'rate_limited' }, 2, NOW);
  assert.equal(first, NOW + OAUTH_BACKOFF_BASE_MS * 2 ** 1);
  assert.equal(second, NOW + OAUTH_BACKOFF_BASE_MS * 2 ** 2);
  assert.ok(second > first); // 連続失敗が増えるほど間隔が伸びる
});

test('computeNextOAuthAttemptAt: 指数バックオフは上限(OAUTH_BACKOFF_MAX_MS)で頭打ちになる', () => {
  const next = computeNextOAuthAttemptAt({ ok: false, reason: 'network' }, 100, NOW);
  assert.equal(next, NOW + OAUTH_BACKOFF_MAX_MS);
});

test('computeNextOAuthAttemptAt: plan_not_applicableは上限値に固定される(頻繁な再試行を避ける)', () => {
  const next = computeNextOAuthAttemptAt({ ok: false, reason: 'plan_not_applicable' }, 1, NOW);
  assert.equal(next, NOW + OAUTH_BACKOFF_MAX_MS);
});

test('computeNextOAuthAttemptAt: unauthenticatedも指数バックオフに従う', () => {
  const next = computeNextOAuthAttemptAt({ ok: false, reason: 'unauthenticated' }, 1, NOW);
  assert.equal(next, NOW + OAUTH_BACKOFF_BASE_MS * 2 ** 1);
});

// ---- v0.2: Poller本体の3系統(statusline/credit/jsonl)配線の検証 ----

interface FakeDepsOptions {
  creditEnabled: boolean;
  statuslineResult?: StatuslineReadResult;
}

function buildFakeDeps(options: FakeDepsOptions): {
  deps: PollerDeps;
  oauthCalls: () => number;
} {
  let oauthCallCount = 0;
  const deps: PollerDeps = {
    statuslineSource: {
      async read(): Promise<StatuslineReadResult> {
        return (
          options.statuslineResult ?? {
            ok: true,
            data: { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_783_170_600 } } },
            capturedAt: Date.now(),
          }
        );
      },
    },
    oauthClient: {
      async fetchUsage(): Promise<OAuthUsageResult> {
        oauthCallCount += 1;
        return { ok: true, data: { extra_usage: { is_enabled: true, used_credits: 1.5, monthly_limit: 50 } } };
      },
    },
    jsonlAggregator: {
      async estimate() {
        return {
          ok: true as const,
          data: {
            totals: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
            displayTokens: 6,
            costUsd: 1.23,
            windowDays: 7,
            fileCount: 1,
          },
        };
      },
    } as unknown as JsonlAggregator,
    logger: { info() {}, warn() {} } as unknown as Logger,
    getIntervalMs: () => 60_000,
    isCreditEnabled: () => options.creditEnabled,
    getStaleMinutes: () => 15,
    onUpdate: () => {},
  };
  return { deps, oauthCalls: () => oauthCallCount };
}

test('Poller: showCredit=false(既定)ではoauth側を一切呼ばない', async () => {
  const { deps, oauthCalls } = buildFakeDeps({ creditEnabled: false });
  const poller = new Poller(deps);
  await poller.pollNow();
  poller.dispose();

  assert.equal(oauthCalls(), 0);
  const model = poller.lastViewModel;
  assert.equal(model.credit.kind, 'disabled');
  assert.equal(model.rateLimits.kind, 'ok');
  assert.equal(model.jsonl.kind, 'ok');
});

test('Poller: showCredit=trueならoauth側を呼び、creditがokになる', async () => {
  const { deps, oauthCalls } = buildFakeDeps({ creditEnabled: true });
  const poller = new Poller(deps);
  await poller.pollNow();
  poller.dispose();

  assert.equal(oauthCalls(), 1);
  const model = poller.lastViewModel;
  assert.equal(model.credit.kind, 'ok');
  if (model.credit.kind === 'ok') {
    assert.equal(model.credit.data.extra_usage?.used_credits, 1.5);
  }
});

test('Poller: stateファイル不在でもクラッシュせず、rateLimitsはセットアップ誘導になる', async () => {
  const { deps } = buildFakeDeps({
    creditEnabled: false,
    statuslineResult: { ok: false, reason: 'not_found' },
  });
  const poller = new Poller(deps);
  await poller.pollNow();
  poller.dispose();

  const model = poller.lastViewModel;
  assert.equal(model.rateLimits.kind, 'unavailable');
  if (model.rateLimits.kind === 'unavailable') {
    assert.equal(model.rateLimits.reason, 'bridge_not_configured');
  }
  assert.equal(model.jsonl.kind, 'ok'); // ③は独立して動き続ける(05_final.md 1.4節)
});

test('Poller: refreshStatuslineNowはstatusline側だけ読み直して即描画する', async () => {
  const { deps, oauthCalls } = buildFakeDeps({ creditEnabled: true });
  const poller = new Poller(deps);
  await poller.pollNow();
  const callsAfterPoll = oauthCalls();
  await poller.refreshStatuslineNow();
  poller.dispose();

  assert.equal(oauthCalls(), callsAfterPoll); // oauth側は追加で呼ばれない
  assert.equal(poller.lastViewModel.rateLimits.kind, 'ok');
});
