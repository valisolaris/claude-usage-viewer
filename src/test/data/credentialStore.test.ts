import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialStore } from '../../data/credentialStore';

async function withTempCredentialsFile(content: string, fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-viewer-test-'));
  const filePath = path.join(dir, '.credentials.json');
  await fs.writeFile(filePath, content, 'utf8');
  try {
    await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('resolvePath: credentialsPathOverride が優先される', () => {
  const store = new CredentialStore(() => ({ credentialsPathOverride: 'C:/fake/override.json' }));
  assert.equal(store.resolvePath(), 'C:/fake/override.json');
});

test('resolvePath: CLAUDE_CONFIG_DIR が設定されていればそちらを使う', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/tmp/fake-config-dir';
  try {
    const store = new CredentialStore(() => ({ credentialsPathOverride: '' }));
    assert.equal(store.resolvePath(), path.join('/tmp/fake-config-dir', '.credentials.json'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('read: 実機で確認済みの claudeAiOauth 構造を正しくパースする', async () => {
  const fixture = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-access-token-for-test',
      refreshToken: 'fake-refresh-token-for-test',
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai',
    },
    mcpOAuth: {},
  });

  await withTempCredentialsFile(fixture, async (filePath) => {
    const store = new CredentialStore(() => ({ credentialsPathOverride: filePath }));
    const result = await store.read();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.accessToken, 'fake-access-token-for-test');
      assert.equal(result.data.subscriptionType, 'pro');
      assert.equal(result.data.rateLimitTier, 'default_claude_ai');
    }
  });
});

test('read: 期限切れのトークンは expired として扱う', async () => {
  const fixture = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-access-token-for-test',
      expiresAt: Date.now() - 1000,
    },
  });

  await withTempCredentialsFile(fixture, async (filePath) => {
    const store = new CredentialStore(() => ({ credentialsPathOverride: filePath }));
    const result = await store.read();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'expired');
  });
});

test('read: accessToken が無い場合は missing_token', async () => {
  const fixture = JSON.stringify({ claudeAiOauth: {} });
  await withTempCredentialsFile(fixture, async (filePath) => {
    const store = new CredentialStore(() => ({ credentialsPathOverride: filePath }));
    const result = await store.read();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_token');
  });
});

test('read: ファイルが存在しない場合は not_found', async () => {
  const store = new CredentialStore(() => ({ credentialsPathOverride: 'C:/definitely/not/exist/.credentials.json' }));
  const result = await store.read();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not_found');
});

test('read: 壊れたJSONは parse_error', async () => {
  await withTempCredentialsFile('{ not valid json', async (filePath) => {
    const store = new CredentialStore(() => ({ credentialsPathOverride: filePath }));
    const result = await store.read();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'parse_error');
  });
});
