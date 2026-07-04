import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ClaudeCredentials, CredentialResult } from './types';

/**
 * `.credentials.json` の構造(2026-07-04 実機検証済み。r2_verification.md参照)。
 * トップレベルに `claudeAiOauth` を持ち、その下に accessToken 等が入る。
 */
interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export interface CredentialStoreConfig {
  /** `claudeUsageViewer.credentialsPathOverride` 設定値。空文字なら自動解決。 */
  credentialsPathOverride: string;
}

/**
 * `.credentials.json` のパス解決・読取専用アクセス。
 * このモジュールはJSONL集計(jsonlAggregator)とは完全に独立しており、
 * 認証情報を読むのはoauthUsageClientの利用時のみ(05_final.md 1.4節)。
 * 書き込みは一切行わない(トークンのリフレッシュはCLI本体に委ねる)。
 */
export class CredentialStore {
  constructor(private readonly getConfig: () => CredentialStoreConfig) {}

  resolvePath(): string {
    const override = this.getConfig().credentialsPathOverride?.trim();
    if (override) return override;

    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir) return path.join(configDir, '.credentials.json');

    return path.join(os.homedir(), '.claude', '.credentials.json');
  }

  async read(): Promise<CredentialResult> {
    const credPath = this.resolvePath();

    let raw: string;
    try {
      raw = await fs.readFile(credPath, 'utf8');
    } catch (err) {
      return { ok: false, reason: 'not_found', detail: describeFsError(err) };
    }

    let parsed: CredentialsFile;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'parse_error' };
    }

    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
      return { ok: false, reason: 'missing_token' };
    }

    if (typeof oauth.expiresAt === 'number' && Date.now() > oauth.expiresAt) {
      return { ok: false, reason: 'expired' };
    }

    const data: ClaudeCredentials = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
    return { ok: true, data };
  }
}

function describeFsError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return 'unknown';
}
