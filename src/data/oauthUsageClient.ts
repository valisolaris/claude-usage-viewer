import type { CredentialStore } from './credentialStore';
import type { OAuthUsageResponse, OAuthUsageResult, UsageWindow } from './types';
import type { Logger } from '../core/logger';

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * blocker#2実測結果(r2_verification.md): 誠実UA `claude-usage-viewer-vscode/<version>`
 * (claude-code詐称なし)で複数回実測しすべて429(rate_limit_error)。claude-codeへの
 * なりすましは診断目的でも行わない(04_critique.md Round2の破壊者裁定で確定)。
 * Round2クリーン再検証で`retry-after`ヘッダーが実経過時間と正確に連動して減少する
 * (2019秒→217秒後に1802秒、差分217秒で一致)ことを確認し、静的なUA拒否ではなく
 * 本物の時限レート制限であると判明した(r2_verification.md参照)。429時はリトライせず
 * 理由とretry-afterを返すのみ。バックオフ・retry-after尊重はcore/poller側で扱う。
 */
export function buildUserAgent(version: string): string {
  return `claude-usage-viewer-vscode/${version}`;
}

/**
 * `rate_limits`(5h/週次/クレジット)が存在すると期待できるプランのsubscriptionType。
 * 01_plan.mdの調査通り、APIキー従量課金ユーザーにはrate_limitsが存在しない
 * (Pro/Max等のサブスクリプション専用)。未知の値は「対象外」側に倒す保守的な判定にする
 * (04_critique.md Round2 3章「劣化マトリクスの残り実装」対応)。
 */
const RATE_LIMITED_SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set(['pro', 'max', 'team', 'enterprise']);

export function isRateLimitedPlan(subscriptionType: string | undefined): boolean {
  if (!subscriptionType) return false;
  return RATE_LIMITED_SUBSCRIPTION_TYPES.has(subscriptionType.toLowerCase());
}

/** `Retry-After`ヘッダー(秒数の整数文字列)をミリ秒に変換する。パース不能ならundefined。 */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

function isUsageWindow(value: unknown): value is UsageWindow {
  if (value === null || value === undefined) return true; // null許容(seven_day_opus対策)
  if (typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if ('utilization' in v && v.utilization !== undefined && typeof v.utilization !== 'number') return false;
  if ('resets_at' in v && v.resets_at !== undefined && typeof v.resets_at !== 'string') return false;
  return true;
}

/**
 * 非公式スキーマのためランタイム型検証を必須にする(05_final.md 2章)。
 * 未検証フィールドは全てoptionalなので、ここでは「型が来た場合に一致するか」
 * だけを見る緩い検証にする。トップレベルがオブジェクトでない場合のみ拒否する。
 */
export function validateOAuthUsageResponse(body: unknown): { ok: true; data: OAuthUsageResponse } | { ok: false } {
  if (body === null || typeof body !== 'object') return { ok: false };
  const v = body as Record<string, unknown>;

  if ('five_hour' in v && !isUsageWindow(v.five_hour)) return { ok: false };
  if ('seven_day' in v && !isUsageWindow(v.seven_day)) return { ok: false };
  if ('seven_day_opus' in v && !isUsageWindow(v.seven_day_opus)) return { ok: false };
  if ('seven_day_sonnet' in v && !isUsageWindow(v.seven_day_sonnet)) return { ok: false };

  if ('extra_usage' in v && v.extra_usage !== undefined && v.extra_usage !== null) {
    if (typeof v.extra_usage !== 'object') return { ok: false };
  }

  return { ok: true, data: v as OAuthUsageResponse };
}

export class OAuthUsageClient {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly logger: Logger,
    private readonly extensionVersion: string,
  ) {}

  async fetchUsage(): Promise<OAuthUsageResult> {
    const cred = await this.credentials.read();
    if (!cred.ok) {
      const reason = cred.reason === 'expired' ? 'unauthenticated' : 'unauthenticated';
      return { ok: false, reason, detail: cred.reason };
    }

    if (!isRateLimitedPlan(cred.data.subscriptionType)) {
      // rate_limitsが存在しないプラン(APIキー従量課金等)。無駄なAPI呼び出しをせず即座に対象外を返す。
      return { ok: false, reason: 'plan_not_applicable', detail: cred.data.subscriptionType ?? 'unknown' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(OAUTH_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${cred.data.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': buildUserAgent(this.extensionVersion),
        },
        signal: controller.signal,
      });

      if (res.status === 401) return { ok: false, reason: 'unauthenticated' };
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        return { ok: false, reason: 'rate_limited', retryAfterMs };
      }
      if (!res.ok) return { ok: false, reason: 'network', detail: String(res.status) };

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        this.logger.warn('oauth/usage: response body was not valid JSON');
        return { ok: false, reason: 'unexpected_schema' };
      }

      const parsed = validateOAuthUsageResponse(json);
      if (!parsed.ok) {
        // レスポンス本文・トークンはログに出さない(構造検証の失敗のみ記録)
        this.logger.warn('oauth/usage: unexpected schema');
        return { ok: false, reason: 'unexpected_schema' };
      }
      return { ok: true, data: parsed.data };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      return { ok: false, reason: 'network', detail: name };
    } finally {
      clearTimeout(timeout);
    }
  }
}
