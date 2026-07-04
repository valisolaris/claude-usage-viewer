import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBridgeToSettings,
  buildBridgeCommand,
  buildBridgeScript,
  buildManualSetupInstructions,
  inspectSettings,
} from '../../data/statuslineSetup';

test('inspectSettings: ファイル無し/壊れたJSON/未設定/既設を判別する', () => {
  assert.deepEqual(inspectSettings(undefined), { kind: 'no_file' });
  assert.deepEqual(inspectSettings('{broken'), { kind: 'unparseable' });
  assert.deepEqual(inspectSettings('[]'), { kind: 'unparseable' });
  assert.deepEqual(inspectSettings('{"model": "opus"}'), { kind: 'no_statusline' });

  const existing = inspectSettings(
    JSON.stringify({ statusLine: { type: 'command', command: 'node C:/Users/x/.claude/statusline.js' } }),
  );
  assert.equal(existing.kind, 'has_statusline');
  if (existing.kind === 'has_statusline') {
    assert.ok(existing.command.includes('statusline.js'));
  }
});

test('applyBridgeToSettings: 既存キーを保持したままstatusLineを追加する', () => {
  const raw = JSON.stringify({ model: 'opus', permissions: { allow: ['x'] } });
  const result = applyBridgeToSettings(raw, 'node "C:/Users/x/.claude/claude-usage-viewer-bridge.js"');
  assert.equal(result.ok, true);
  if (result.ok) {
    const next = JSON.parse(result.next);
    assert.equal(next.model, 'opus');
    assert.deepEqual(next.permissions, { allow: ['x'] });
    assert.equal(next.statusLine.type, 'command');
    assert.ok(String(next.statusLine.command).includes('claude-usage-viewer-bridge.js'));
  }
});

test('applyBridgeToSettings: settings.jsonが無い場合はstatusLineだけの新規本文を作る', () => {
  const result = applyBridgeToSettings(undefined, 'node "bridge.js"');
  assert.equal(result.ok, true);
  if (result.ok) {
    const next = JSON.parse(result.next);
    assert.deepEqual(Object.keys(next), ['statusLine']);
  }
});

test('applyBridgeToSettings: 既存statusLineは上書きしない(利用者の表示を壊さない)', () => {
  const raw = JSON.stringify({ statusLine: { type: 'command', command: 'node my-statusline.js' } });
  const result = applyBridgeToSettings(raw, 'node "bridge.js"');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'already_configured');
});

test('applyBridgeToSettings: 壊れたJSONには手を加えない', () => {
  const result = applyBridgeToSettings('{broken', 'node "bridge.js"');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unparseable');
});

test('buildBridgeScript: state書き出し(tmp→rename)と表示フォールバックを含む自己完結スクリプト', () => {
  const script = buildBridgeScript();
  assert.ok(script.includes('statusline-state.json'));
  assert.ok(script.includes('renameSync'));
  assert.ok(script.includes('CLAUDE_CONFIG_DIR'));
  // 書き出し失敗でも表示を壊さない(握りつぶしの存在)
  assert.ok(script.includes('never break statusline rendering'));
  // スクリプト本体が構文として妥当であること(shebang行を除きパースのみ検証、実行はしない)
  assert.doesNotThrow(() => new Function(script.replace(/^#!.*\n/, '')));
});

test('buildBridgeCommand: パスを引用しスラッシュ区切りに正規化する', () => {
  const command = buildBridgeCommand('C:\\Users\\x y\\.claude\\claude-usage-viewer-bridge.js');
  assert.equal(command, 'node "C:/Users/x y/.claude/claude-usage-viewer-bridge.js"');
});

test('buildManualSetupInstructions: statePathと安全上の説明を含む', () => {
  const text = buildManualSetupInstructions('C:/Users/x/.claude/statusline-state.json');
  assert.ok(text.includes('statusline-state.json'));
  assert.ok(text.includes('上書きしません'));
});
