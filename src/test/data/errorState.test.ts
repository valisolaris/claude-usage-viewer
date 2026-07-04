import test from 'node:test';
import assert from 'node:assert/strict';
// core/errorState.tsはvscodeに依存しないため、data層のnode:testハーネスから直接検証できる。
import { presentErrorReason, requiresUserAction, resolveOAuthDisplayState, resolveRateLimitsDisplayState } from '../../core/errorState';
import type { ErrorReason, StatuslinePayload } from '../../data/types';

test('presentErrorReason: plan_not_applicable(04_critique.md Round2追加分)の表示内容', () => {
  const presentation = presentErrorReason('plan_not_applicable');
  assert.equal(presentation.icon, 'circle-slash');
  assert.equal(presentation.shortLabel, 'プラン対象外');
  assert.ok(presentation.tooltipHint.length > 0);
});

test('resolveOAuthDisplayState: plan_not_applicableは直前値があっても継続表示しない', () => {
  const state = resolveOAuthDisplayState({
    lastGoodData: { five_hour: { utilization: 10 } },
    lastGoodFetchedAt: Date.now() - 60_000,
    consecutiveFailures: 1,
    lastErrorReason: 'plan_not_applicable',
  });
  assert.equal(state.kind, 'error');
  if (state.kind === 'error') assert.equal(state.reason, 'plan_not_applicable');
});

test('resolveOAuthDisplayState: rate_limitedは直前値があれば継続表示(stale)する', () => {
  const state = resolveOAuthDisplayState({
    lastGoodData: { five_hour: { utilization: 10 } },
    lastGoodFetchedAt: Date.now() - 60_000,
    consecutiveFailures: 1,
    lastErrorReason: 'rate_limited',
  });
  assert.equal(state.kind, 'stale');
});

test('resolveOAuthDisplayState: 連続失敗がSTALE_ESCALATION_THRESHOLD以上でerrorに昇格する', () => {
  const state = resolveOAuthDisplayState({
    lastGoodData: { five_hour: { utilization: 10 } },
    lastGoodFetchedAt: Date.now() - 60_000,
    consecutiveFailures: 3,
    lastErrorReason: 'rate_limited',
  });
  assert.equal(state.kind, 'error');
});

// 04_critique.md Round2「視覚アラーム残件」対応: 警告色は「利用者が対応すべき状態」のみで点灯させる
test('requiresUserAction: unauthenticatedのみtrue(再ログインが要る)', () => {
  assert.equal(requiresUserAction('unauthenticated'), true);
});

test('requiresUserAction: 429/オフライン/スキーマ不一致/プラン対象外は利用者側で対応できないためfalse(誤警報を避ける)', () => {
  const nonActionableReasons: ErrorReason[] = ['rate_limited', 'network', 'unexpected_schema', 'plan_not_applicable', 'jsonl_unavailable'];
  for (const reason of nonActionableReasons) {
    assert.equal(requiresUserAction(reason), false, `${reason} should not require user action`);
  }
});

// ---- v0.2: statuslineブリッジ(①②)の表示状態解決 ----

const PAYLOAD: StatuslinePayload = {
  rate_limits: { five_hour: { used_percentage: 0, resets_at: 1_783_170_600 }, seven_day: { used_percentage: 9 } },
};
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0);

test('resolveRateLimitsDisplayState: 鮮度内のmtimeならok', () => {
  const state = resolveRateLimitsDisplayState({ ok: true, data: PAYLOAD, capturedAt: NOW - 5 * 60_000 }, 15, NOW);
  assert.equal(state.kind, 'ok');
  if (state.kind === 'ok') {
    assert.equal(state.data.rate_limits?.seven_day?.used_percentage, 9);
  }
});

test('resolveRateLimitsDisplayState: しきい値より古いmtimeはstale(値は保持して表示し続ける)', () => {
  const state = resolveRateLimitsDisplayState({ ok: true, data: PAYLOAD, capturedAt: NOW - 60 * 60_000 }, 15, NOW);
  assert.equal(state.kind, 'stale');
  if (state.kind === 'stale') {
    assert.equal(state.data.rate_limits?.five_hour?.used_percentage, 0);
  }
});

test('resolveRateLimitsDisplayState: 未読(undefined)とnot_foundはbridge_not_configured(セットアップ誘導)', () => {
  const unread = resolveRateLimitsDisplayState(undefined, 15, NOW);
  assert.equal(unread.kind, 'unavailable');
  if (unread.kind === 'unavailable') assert.equal(unread.reason, 'bridge_not_configured');

  const notFound = resolveRateLimitsDisplayState({ ok: false, reason: 'not_found' }, 15, NOW);
  assert.equal(notFound.kind, 'unavailable');
  if (notFound.kind === 'unavailable') assert.equal(notFound.reason, 'bridge_not_configured');
});

test('resolveRateLimitsDisplayState: read_error/parse_errorはbridge_unreadable', () => {
  for (const reason of ['read_error', 'parse_error'] as const) {
    const state = resolveRateLimitsDisplayState({ ok: false, reason }, 15, NOW);
    assert.equal(state.kind, 'unavailable');
    if (state.kind === 'unavailable') assert.equal(state.reason, 'bridge_unreadable');
  }
});

test('presentErrorReason: bridge系の新理由はセットアップ誘導/読取エラーの文言を持つ', () => {
  const notConfigured = presentErrorReason('bridge_not_configured');
  assert.equal(notConfigured.icon, 'plug');
  assert.ok(notConfigured.tooltipHint.includes('Set Up Statusline Bridge'));

  const unreadable = presentErrorReason('bridge_unreadable');
  assert.ok(unreadable.shortLabel.length > 0);
});

test('requiresUserAction: bridge系の理由は背景警告色を付けない(③だけ使う利用者への誤警報を避ける)', () => {
  assert.equal(requiresUserAction('bridge_not_configured'), false);
  assert.equal(requiresUserAction('bridge_unreadable'), false);
});
