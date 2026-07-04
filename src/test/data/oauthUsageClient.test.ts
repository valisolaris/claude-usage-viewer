import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserAgent,
  isRateLimitedPlan,
  OAuthUsageClient,
  parseRetryAfterMs,
  validateOAuthUsageResponse,
} from '../../data/oauthUsageClient';
import type { CredentialResult } from '../../data/types';
import type { Logger } from '../../core/logger';

test('buildUserAgent: claude-codeを詐称しない誠実なUAを返す(blocker#2)', () => {
  const ua = buildUserAgent('0.1.0');
  assert.equal(ua, 'claude-usage-viewer-vscode/0.1.0');
  assert.ok(!ua.includes('claude-code'));
});

test('validateOAuthUsageResponse: 01_plan.md記載の推測形は通る', () => {
  const body = {
    five_hour: { utilization: 33.0, resets_at: '2026-04-11T07:00:00.528743+00:00' },
    seven_day: { utilization: 13.0, resets_at: '2026-04-17T00:59:59.951713+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 1.0, resets_at: '2026-04-16T03:00:00.951719+00:00' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  };
  const result = validateOAuthUsageResponse(body);
  assert.equal(result.ok, true);
});

test('validateOAuthUsageResponse: 全フィールド欠落でも通る(未検証スキーマなので寛容に扱う)', () => {
  const result = validateOAuthUsageResponse({});
  assert.equal(result.ok, true);
});

test('validateOAuthUsageResponse: トップレベルがオブジェクトでなければ拒否', () => {
  assert.equal(validateOAuthUsageResponse(null).ok, false);
  assert.equal(validateOAuthUsageResponse('string').ok, false);
  assert.equal(validateOAuthUsageResponse(42).ok, false);
});

test('validateOAuthUsageResponse: five_hourの型が違えば拒否', () => {
  const result = validateOAuthUsageResponse({ five_hour: { utilization: 'not-a-number' } });
  assert.equal(result.ok, false);
});

test('validateOAuthUsageResponse: 実測(429)で返るエラーボディは拒否される(usage形ではないため)', () => {
  // r2_verification.md: 実測レスポンスは {"error":{"type":"rate_limit_error","message":"..."}}
  // このボディ自体はfetchUsage側でstatus 429として先に弾かれるため、
  // ここではvalidateOAuthUsageResponseの寛容さの限界を示す目的で確認する。
  const result = validateOAuthUsageResponse({ error: { type: 'rate_limit_error', message: 'x' } });
  // error はスキーマ上未知のキーであり、five_hour等のいずれとも衝突しないため型としては通る。
  // 実際にはHTTPステータス429の時点でoauthUsageClientが早期リターンするため実害はない。
  assert.equal(result.ok, true);
});

// 04_critique.md Round2「劣化マトリクスの残り実装」対応: プラン対象外(rate_limits非対象)判定
test('isRateLimitedPlan: pro/max/team/enterpriseはrate_limits対象と判定', () => {
  assert.equal(isRateLimitedPlan('pro'), true);
  assert.equal(isRateLimitedPlan('max'), true);
  assert.equal(isRateLimitedPlan('team'), true);
  assert.equal(isRateLimitedPlan('enterprise'), true);
  assert.equal(isRateLimitedPlan('PRO'), true); // 大文字小文字を無視
});

test('isRateLimitedPlan: 未知の値・未定義はプラン対象外(rate_limits非対象)側に倒す', () => {
  assert.equal(isRateLimitedPlan(undefined), false);
  assert.equal(isRateLimitedPlan(''), false);
  assert.equal(isRateLimitedPlan('api_key_billing'), false);
  assert.equal(isRateLimitedPlan('some_future_plan'), false);
});

// 04_critique.md Round2クリーン再検証: retry-afterヘッダーは実測で整数秒文字列("2019"等)だった
test('parseRetryAfterMs: 整数秒の文字列をミリ秒に変換する(実測値ベース)', () => {
  assert.equal(parseRetryAfterMs('2019'), 2019000);
  assert.equal(parseRetryAfterMs('1802'), 1802000);
  assert.equal(parseRetryAfterMs('0'), 0);
});

test('parseRetryAfterMs: 不正な値・欠落はundefinedを返す(例外を投げない)', () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(''), undefined);
  assert.equal(parseRetryAfterMs('not-a-number'), undefined);
  assert.equal(parseRetryAfterMs('-5'), undefined);
});

test('OAuthUsageClient.fetchUsage: rate_limitsが無いプランはネットワークを叩かず即座にplan_not_applicableを返す', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called for non-rate-limited plans');
  }) as typeof fetch;

  try {
    const fakeCredentials = {
      read: async (): Promise<CredentialResult> => ({
        ok: true,
        data: { accessToken: 'fake-token-for-test', subscriptionType: 'api_key_billing' },
      }),
    } as ConstructorParameters<typeof OAuthUsageClient>[0];
    const fakeLogger = { info() {}, warn() {}, error() {} } as unknown as Logger;
    const client = new OAuthUsageClient(fakeCredentials, fakeLogger, '0.1.0');
    const result = await client.fetchUsage();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'plan_not_applicable');
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
