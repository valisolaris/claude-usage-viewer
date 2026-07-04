/**
 * data層の共有型。vscodeモジュールに依存しない。
 *
 * v0.2 のデータ源は3系統:
 * - ①5h/②週次: Claude Code の statusline 機能が stdin に渡す JSON をブリッジが
 *   `statusline-state.json` へ書き出したもの(公式計算値)。構造は 2026-07-04 に
 *   実キャプチャで検証済み(r2_verification.md 9章)。`resets_at` は epoch秒。
 * - ③推定コスト: ローカルJSONL集計(v0.1から不変)。
 * - ④クレジット: 非公式API `/api/oauth/usage`(オプトイン)。誠実UAでの実測は
 *   一貫して429で、200の本体は未取得のまま。実フィールドの型・実在は
 *   コミュニティ情報(01_plan.md出典)を根拠にした「未検証」の推測でしかない。
 *   全フィールドをoptionalにし、欠落・型不一致時はUI側で項目ごと非表示に倒す。
 */

/** `five_hour` / `seven_day` / `seven_day_opus` に共通する使用率ウィンドウの形。 */
export interface UsageWindow {
  utilization?: number;
  resets_at?: string;
}

/** extra usage(クレジット)。is_enabledがfalseの場合は他フィールドがnullになりうる。 */
export interface ExtraUsage {
  is_enabled?: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
}

/**
 * `/api/oauth/usage` の推測レスポンス形。全フィールドoptional。
 * `seven_day_sonnet` は00_criteria.mdの確定仕様に無い項目のため、
 * 実在してもUI表示対象にはしない(型としてのみ許容し、無視する)。
 */
export interface OAuthUsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  extra_usage?: ExtraUsage;
}

/**
 * oauthUsageClientの取得失敗理由。
 * `plan_not_applicable`はRound2破壊者裁定で追加(04_critique.md Round2 3章)。
 * `rate_limits`が存在しないプラン(APIキー従量課金等)向け。05_final.md 1.6節の
 * 「APIキー従量課金→対象外固定表示」に対応する。
 */
export type OAuthErrorReason = 'unauthenticated' | 'rate_limited' | 'network' | 'unexpected_schema' | 'plan_not_applicable';

export type OAuthUsageResult =
  | { ok: true; data: OAuthUsageResponse }
  | { ok: false; reason: OAuthErrorReason; detail?: string; retryAfterMs?: number };

/** jsonlAggregatorのトークン集計結果。 */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CostEstimate {
  totals: TokenTotals;
  /** cache_readを除いた「体感トークン量」。表示用の主要な量指標(04_critique.md C案指摘対応)。 */
  displayTokens: number;
  costUsd: number;
  windowDays: number;
  fileCount: number;
}

export type JsonlErrorReason = 'not_found' | 'read_error';

export type JsonlEstimateResult =
  | { ok: true; data: CostEstimate }
  | { ok: false; reason: JsonlErrorReason; detail?: string };

/** credentialStoreの読取結果。 */
export interface ClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export type CredentialErrorReason = 'not_found' | 'parse_error' | 'missing_token' | 'expired';

export type CredentialResult =
  | { ok: true; data: ClaudeCredentials }
  | { ok: false; reason: CredentialErrorReason; detail?: string };

/**
 * 表示用の統一エラー理由(05_final.md 1.1節)。
 * oauth系5値(Round2で`plan_not_applicable`を追加) + jsonl系1値 +
 * statuslineブリッジ系2値(v0.2で追加)。
 */
export type ErrorReason =
  | 'unauthenticated'
  | 'rate_limited'
  | 'network'
  | 'unexpected_schema'
  | 'jsonl_unavailable'
  | 'plan_not_applicable'
  | 'bridge_not_configured'
  | 'bridge_unreadable';

/**
 * statusline stdin JSON 由来のレート制限ウィンドウ。
 * 実キャプチャ(r2_verification.md 9章)で `used_percentage` + `resets_at` の実在を確認済み。
 * `resets_at` は epoch秒(OAuth API系のISO文字列と形式が異なる点に注意)。
 */
export interface StatuslineRateLimitWindow {
  used_percentage?: number;
  resets_at?: number;
}

export interface StatuslineRateLimits {
  five_hour?: StatuslineRateLimitWindow;
  seven_day?: StatuslineRateLimitWindow;
}

/**
 * `statusline-state.json` のうちこの拡張が利用するフィールドのみを保持する
 * (session_id/transcript_path 等の他フィールドは読み捨てる)。
 * `rate_limits` は Pro/Max の初回API応答後にのみ現れるため欠落しうる。
 */
export interface StatuslinePayload {
  rate_limits?: StatuslineRateLimits;
  context_window?: { used_percentage?: number };
}

export type StatuslineErrorReason = 'not_found' | 'read_error' | 'parse_error';

export type StatuslineReadResult =
  /** capturedAt はファイルの mtime(ms)。鮮度判定(stale切替)に使う。 */
  | { ok: true; data: StatuslinePayload; capturedAt: number }
  | { ok: false; reason: StatuslineErrorReason; detail?: string };
