import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlAggregator, tryParseUsageLine } from '../../data/jsonlAggregator';

test('tryParseUsageLine: 実データで確認済みの構造(message.usage)を抽出できる', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 400,
      },
    },
  });
  const parsed = tryParseUsageLine(line);
  assert.ok(parsed);
  assert.equal(parsed?.model, 'claude-opus-4-8');
  assert.equal(parsed?.inputTokens, 100);
  assert.equal(parsed?.outputTokens, 20);
  assert.equal(parsed?.cacheCreationTokens, 30);
  assert.equal(parsed?.cacheReadTokens, 400);
});

test('tryParseUsageLine: type!==assistant は無視する', () => {
  const line = JSON.stringify({ type: 'user', message: { usage: { input_tokens: 1 } } });
  assert.equal(tryParseUsageLine(line), undefined);
});

test('tryParseUsageLine: usageが無い行は無視する', () => {
  const line = JSON.stringify({ type: 'assistant', message: { model: 'x' } });
  assert.equal(tryParseUsageLine(line), undefined);
});

test('tryParseUsageLine: 壊れた行は無視する(クラッシュしない)', () => {
  assert.equal(tryParseUsageLine('{not valid json'), undefined);
  assert.equal(tryParseUsageLine(''), undefined);
});

test('JsonlAggregator.estimate: 実ファイルからdisplayTokensはcache_readを含まない', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-viewer-jsonl-'));
  const configDir = path.join(dir, 'config');
  const projectDir = path.join(configDir, 'projects', 'fake-project');
  await fs.mkdir(projectDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: 'user', message: {} }),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000 },
      },
    }),
  ];
  await fs.writeFile(path.join(projectDir, 'session.jsonl'), lines.join('\n'), 'utf8');

  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const aggregator = new JsonlAggregator(() => ({ windowDays: 7 }));
    const result = await aggregator.estimate();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.totals.inputTokens, 1000);
      assert.equal(result.data.totals.outputTokens, 200);
      assert.equal(result.data.totals.cacheCreationTokens, 300);
      assert.equal(result.data.totals.cacheReadTokens, 5000);
      // cache_readを除外した「体感量」であること(04_critique.md C案指摘対応)
      assert.equal(result.data.displayTokens, 1000 + 200 + 300);
      assert.ok(result.data.costUsd > 0);
      assert.equal(result.data.fileCount, 1);
    }
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('JsonlAggregator.estimate: projectsディレクトリが無ければ not_found', async () => {
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'usage-viewer-does-not-exist-' + Date.now());
  try {
    const aggregator = new JsonlAggregator(() => ({ windowDays: 7 }));
    const result = await aggregator.estimate();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_found');
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  }
});
