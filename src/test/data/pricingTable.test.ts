import test from 'node:test';
import assert from 'node:assert/strict';
import { getPricingForModel } from '../../data/pricingTable';

test('getPricingForModel: 完全一致するモデル名はそのまま返す', () => {
  const pricing = getPricingForModel('claude-opus-4-8');
  assert.equal(pricing.inputPerM, 15);
});

test('getPricingForModel: 未知のバージョン番号でもfamily名で判定する', () => {
  const pricing = getPricingForModel('claude-sonnet-9-9-unknown-future');
  assert.equal(pricing.inputPerM, 3);
  assert.equal(pricing.outputPerM, 15);
});

test('getPricingForModel: 完全に未知のモデルはフォールバック値を返す(例外を投げない)', () => {
  const pricing = getPricingForModel('totally-unknown-model-xyz');
  assert.ok(pricing.inputPerM > 0);
  assert.ok(pricing.outputPerM > 0);
});
