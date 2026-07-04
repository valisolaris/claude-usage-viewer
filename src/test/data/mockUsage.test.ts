import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMockStatuslinePayload, createMockSources, parseMockSpec } from '../../data/mockUsage';

const NOW = Date.UTC(2026, 6, 4, 12, 0, 0);

test('parseMockSpec: 1〜3値のspecを解釈する(v0.1と互換の書式)', () => {
  assert.deepEqual(parseMockSpec('65'), { fiveHour: 65, sevenDay: undefined, usedCredits: undefined });
  assert.deepEqual(parseMockSpec('65,30'), { fiveHour: 65, sevenDay: 30, usedCredits: undefined });
  assert.deepEqual(parseMockSpec('65,30,12.5'), { fiveHour: 65, sevenDay: 30, usedCredits: 12.5 });
});

test('parseMockSpec: 解釈できないspecはundefinedを返す', () => {
  assert.equal(parseMockSpec(''), undefined);
  assert.equal(parseMockSpec('abc'), undefined);
  assert.equal(parseMockSpec('65,'), undefined);
  assert.equal(parseMockSpec('-5'), undefined);
  assert.equal(parseMockSpec('65,30,12.5,99'), undefined);
});

test('buildMockStatuslinePayload: 5h/7dをused_percentage+resets_at(epoch秒)で組み立てる', () => {
  const payload = buildMockStatuslinePayload('65,30', NOW);
  assert.ok(payload);
  assert.equal(payload.rate_limits?.five_hour?.used_percentage, 65);
  assert.equal(payload.rate_limits?.seven_day?.used_percentage, 30);

  const fiveResets = payload.rate_limits?.five_hour?.resets_at;
  const sevenResets = payload.rate_limits?.seven_day?.resets_at;
  // epoch秒であること(ms値だと13桁になる。実キャプチャ準拠の10桁前後の秒値を期待)
  assert.ok(typeof fiveResets === 'number' && fiveResets > NOW / 1000);
  assert.ok(typeof sevenResets === 'number' && sevenResets > fiveResets);
});

test('buildMockStatuslinePayload: コンテキスト%(表示確認用の固定値)を含む', () => {
  const payload = buildMockStatuslinePayload('65', NOW);
  assert.equal(payload?.context_window?.used_percentage, 50);
});

test('createMockSources: statusline側はok+capturedAt、oauth側はextra_usageを返す', async () => {
  const sources = createMockSources('65,30,12.5');
  assert.ok(sources);

  const stateResult = await sources.statusline.read();
  assert.equal(stateResult.ok, true);
  if (stateResult.ok) {
    assert.equal(stateResult.data.rate_limits?.five_hour?.used_percentage, 65);
    assert.ok(stateResult.capturedAt > 0);
  }

  const oauthResult = await sources.oauth.fetchUsage();
  assert.equal(oauthResult.ok, true);
  if (oauthResult.ok) {
    assert.equal(oauthResult.data.extra_usage?.is_enabled, true);
    assert.equal(oauthResult.data.extra_usage?.used_credits, 12.5);
  }
});

test('createMockSources: クレジット未指定ならextra_usageはis_enabled=falseになる', async () => {
  const sources = createMockSources('65,30');
  assert.ok(sources);
  const oauthResult = await sources.oauth.fetchUsage();
  assert.equal(oauthResult.ok, true);
  if (oauthResult.ok) {
    assert.equal(oauthResult.data.extra_usage?.is_enabled, false);
  }
});

test('createMockSources: 無効specはundefinedを返す', () => {
  assert.equal(createMockSources('abc'), undefined);
});
