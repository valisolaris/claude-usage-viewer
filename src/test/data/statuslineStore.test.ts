import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractStatuslinePayload, STATUSLINE_STATE_FILENAME, StatuslineStore } from '../../data/statuslineStore';

/** 2026-07-04 の実キャプチャ(r2_verification.md 9章)と同形のフィクスチャ(値は丸め・匿名化)。 */
const CAPTURED_FIXTURE = {
  session_id: '00000000-0000-0000-0000-000000000000',
  transcript_path: 'C:\\Users\\someone\\.claude\\projects\\x\\y.jsonl',
  cwd: 'C:\\work',
  model: { id: 'claude-fable-5', display_name: 'Fable 5' },
  version: '2.1.199',
  cost: { total_cost_usd: 81.82 },
  context_window: { used_percentage: 11, remaining_percentage: 89 },
  rate_limits: {
    five_hour: { used_percentage: 0, resets_at: 1783170600 },
    seven_day: { used_percentage: 9, resets_at: 1783605600 },
  },
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-viewer-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function storeFor(statePath: string): StatuslineStore {
  return new StatuslineStore(() => ({ statuslineStatePathOverride: statePath }));
}

test('extractStatuslinePayload: 実キャプチャ形からrate_limitsとcontext_windowだけを抽出する', () => {
  const payload = extractStatuslinePayload(CAPTURED_FIXTURE);
  assert.ok(payload);
  assert.equal(payload.rate_limits?.five_hour?.used_percentage, 0);
  assert.equal(payload.rate_limits?.five_hour?.resets_at, 1783170600);
  assert.equal(payload.rate_limits?.seven_day?.used_percentage, 9);
  assert.equal(payload.context_window?.used_percentage, 11);
  // 無関係フィールドは持ち込まない
  assert.equal('session_id' in payload, false);
});

test('extractStatuslinePayload: 型不一致のフィールドは欠落扱いに倒す(寛容パース)', () => {
  const payload = extractStatuslinePayload({
    rate_limits: {
      five_hour: { used_percentage: 'high', resets_at: 1783170600 },
      seven_day: 'broken',
    },
    context_window: { used_percentage: '11%' },
  });
  assert.ok(payload);
  assert.equal(payload.rate_limits?.five_hour?.used_percentage, undefined);
  assert.equal(payload.rate_limits?.five_hour?.resets_at, 1783170600);
  assert.equal(payload.rate_limits?.seven_day, undefined);
  assert.equal(payload.context_window, undefined);
});

test('extractStatuslinePayload: rate_limits未着(初回API応答前)のJSONもokとして受け入れる', () => {
  const payload = extractStatuslinePayload({ session_id: 'x', model: { id: 'y' } });
  assert.ok(payload);
  assert.equal(payload.rate_limits, undefined);
});

test('extractStatuslinePayload: オブジェクトでない値はundefined', () => {
  assert.equal(extractStatuslinePayload(null), undefined);
  assert.equal(extractStatuslinePayload('str'), undefined);
  assert.equal(extractStatuslinePayload([1, 2]), undefined);
});

test('StatuslineStore.read: 実キャプチャ形のファイルをok+capturedAt(mtime)で返す', async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, STATUSLINE_STATE_FILENAME);
    await fs.writeFile(statePath, JSON.stringify(CAPTURED_FIXTURE), 'utf8');

    const result = await storeFor(statePath).read();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.rate_limits?.seven_day?.used_percentage, 9);
      assert.ok(result.capturedAt > 0);
    }
  });
});

test('StatuslineStore.read: ファイル不在はnot_found(セットアップ誘導の起点)', async () => {
  await withTempDir(async (dir) => {
    const result = await storeFor(path.join(dir, 'missing.json')).read();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_found');
  });
});

test('StatuslineStore.read: 壊れたJSONはparse_error', async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, STATUSLINE_STATE_FILENAME);
    await fs.writeFile(statePath, '{"rate_limits": {', 'utf8');

    const result = await storeFor(statePath).read();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'parse_error');
  });
});

test('StatuslineStore.resolvePath: override > CLAUDE_CONFIG_DIR > ~/.claude の順で解決する', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join('C:', 'config-dir');

    const overridden = new StatuslineStore(() => ({ statuslineStatePathOverride: 'C:/explicit/state.json' }));
    assert.equal(overridden.resolvePath(), 'C:/explicit/state.json');

    const fromEnv = new StatuslineStore(() => ({ statuslineStatePathOverride: '' }));
    assert.equal(fromEnv.resolvePath(), path.join('C:', 'config-dir', STATUSLINE_STATE_FILENAME));

    delete process.env.CLAUDE_CONFIG_DIR;
    const fromHome = new StatuslineStore(() => ({ statuslineStatePathOverride: '' }));
    assert.equal(fromHome.resolvePath(), path.join(os.homedir(), '.claude', STATUSLINE_STATE_FILENAME));
  } finally {
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }
  }
});
