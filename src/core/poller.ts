import type { JsonlAggregator } from '../data/jsonlAggregator';
import type { Logger } from './logger';
import type { CostEstimate, JsonlErrorReason, OAuthUsageResult, StatuslineReadResult } from '../data/types';
import {
  type CreditDisplayState,
  type OAuthAttemptState,
  type RateLimitsDisplayState,
  resolveOAuthDisplayState,
  resolveRateLimitsDisplayState,
} from './errorState';

/**
 * Pollerが必要とするoauth取得側の最小インターフェース(LogSinkと同じ縮小パターン)。
 * v0.2では④クレジット(オプトイン)専用。実体はOAuthUsageClient、
 * 開発検証時のみmockUsageのモックが入る。
 */
export interface OAuthUsageSource {
  fetchUsage(): Promise<OAuthUsageResult>;
}

/**
 * ①②の主データ源(v0.2)。実体はStatuslineStore(ローカルファイル読取のみ)、
 * 開発検証時のみmockUsageのモックが入る。
 */
export interface StatuslineSource {
  read(): Promise<StatuslineReadResult>;
}

export const OAUTH_BACKOFF_BASE_MS = 60_000; // 1分
export const OAUTH_BACKOFF_MAX_MS = 30 * 60_000; // 30分上限

/**
 * 429用の実バックオフ(04_critique.md Round2「劣化マトリクスの残り実装」対応)。
 * `retry-after`ヘッダーがあれば最優先で尊重する(r2_verification.mdのクリーン再検証で
 * 実時間と正確に連動する本物の時限レート制限と確認済み。サーバー指示に従うのが最も誠実)。
 * 無ければ連続失敗回数に応じた指数バックオフ(上限30分)。`plan_not_applicable`は
 * プラン設定がほぼ変わらないため上限値に固定し、無駄な再試行を避ける。
 */
export function computeNextOAuthAttemptAt(
  result: Extract<OAuthUsageResult, { ok: false }>,
  consecutiveFailures: number,
  now: number = Date.now(),
): number {
  if (result.reason === 'rate_limited' && typeof result.retryAfterMs === 'number') {
    return now + result.retryAfterMs;
  }
  if (result.reason === 'plan_not_applicable') {
    return now + OAUTH_BACKOFF_MAX_MS;
  }
  const exponent = Math.min(consecutiveFailures, 5); // 2^5倍(32倍)で頭打ち
  const backoffMs = Math.min(OAUTH_BACKOFF_BASE_MS * 2 ** exponent, OAUTH_BACKOFF_MAX_MS);
  return now + backoffMs;
}

export interface JsonlAttemptState {
  lastGoodData?: CostEstimate;
  lastGoodFetchedAt?: number;
  lastErrorReason?: JsonlErrorReason;
}

export type JsonlDisplayState =
  | { kind: 'ok'; data: CostEstimate; fetchedAt: number }
  | { kind: 'unavailable'; reason: JsonlErrorReason };

export interface UsageViewModel {
  /** ①5h/②週次(+コンテキスト%)。statuslineブリッジ由来の公式値。 */
  rateLimits: RateLimitsDisplayState;
  /** ④クレジット(オプトイン)。既定は`disabled`でOAuth側に一切触れない。 */
  credit: CreditDisplayState;
  /** ③推定コスト。ローカルJSONL集計(v0.1から不変の常設アンカー)。 */
  jsonl: JsonlDisplayState;
}

export interface PollerDeps {
  statuslineSource: StatuslineSource;
  oauthClient: OAuthUsageSource;
  jsonlAggregator: JsonlAggregator;
  logger: Logger;
  /** ミリ秒単位のポーリング間隔。呼び出す度に最新の設定値を返すこと。 */
  getIntervalMs: () => number;
  /** ④クレジット(showCredit)。falseの間はoauthClientを一切呼ばない=認証情報にも触れない。 */
  isCreditEnabled: () => boolean;
  /** statusline鮮度のしきい値(分)。これを超えたmtimeはstale表示に切り替える。 */
  getStaleMinutes: () => number;
  onUpdate: (model: UsageViewModel) => void;
}

/**
 * `setInterval`相当のポーリング管理。多重実行防止、手動リフレッシュ、
 * data層呼び出しの直列化を担う。3系統(statusline/jsonl/oauth)は互いに
 * 独立して失敗しうるため、状態は別々に保持する
 * (05_final.md 1.4節: 認証情報に触れない層は単独で動き続ける)。
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;

  private statuslineLast: StatuslineReadResult | undefined;
  private oauthState: OAuthAttemptState = { consecutiveFailures: 0 };
  private jsonlState: JsonlAttemptState = {};
  /** このタイムスタンプ(ms)以降でないとoauth取得を試みない(バックオフ/retry-after尊重)。 */
  private nextOAuthAttemptAt = 0;

  constructor(private readonly deps: PollerDeps) {}

  get lastViewModel(): UsageViewModel {
    return this.buildViewModel();
  }

  start(): void {
    void this.pollNow();
  }

  /** 設定変更時に呼び出し、次回タイマーを新しい間隔で張り直す。実行中のポーリングには影響しない。 */
  reschedule(): void {
    this.clearTimer();
    this.scheduleNext();
  }

  async pollNow(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clearTimer();
    try {
      await Promise.all([this.pollStatusline(), this.pollOAuth(), this.pollJsonl()]);
      this.deps.onUpdate(this.buildViewModel());
    } finally {
      this.running = false;
      if (!this.disposed) this.scheduleNext();
    }
  }

  /**
   * fs.watchがstateファイルの更新を検知した時に呼ぶ軽量経路。
   * statusline側だけ読み直して即描画する(③④のポーリング周期は乱さない)。
   */
  async refreshStatuslineNow(): Promise<void> {
    if (this.disposed) return;
    await this.pollStatusline();
    if (!this.disposed) this.deps.onUpdate(this.buildViewModel());
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private async pollStatusline(): Promise<void> {
    const result = await this.deps.statuslineSource.read();
    this.statuslineLast = result;
    if (!result.ok) {
      this.deps.logger.info(`statusline state read failed: ${result.reason}`);
    }
  }

  private async pollOAuth(): Promise<void> {
    if (!this.deps.isCreditEnabled()) {
      // オプトインOFF(既定)。API呼び出しどころか.credentials.jsonの読取もしない。
      return;
    }
    const now = Date.now();
    if (now < this.nextOAuthAttemptAt) {
      this.deps.logger.info(`oauth fetch skipped (backoff until ${new Date(this.nextOAuthAttemptAt).toISOString()})`);
      return;
    }

    const result = await this.deps.oauthClient.fetchUsage();
    if (result.ok) {
      this.oauthState = { lastGoodData: result.data, lastGoodFetchedAt: Date.now(), consecutiveFailures: 0 };
      this.nextOAuthAttemptAt = 0;
    } else {
      const consecutiveFailures = this.oauthState.consecutiveFailures + 1;
      this.oauthState = {
        lastGoodData: this.oauthState.lastGoodData,
        lastGoodFetchedAt: this.oauthState.lastGoodFetchedAt,
        consecutiveFailures,
        lastErrorReason: result.reason,
      };
      this.nextOAuthAttemptAt = computeNextOAuthAttemptAt(result, consecutiveFailures);
      this.deps.logger.warn(`oauth fetch failed: ${result.reason}`);
    }
  }

  private async pollJsonl(): Promise<void> {
    const result = await this.deps.jsonlAggregator.estimate();
    if (result.ok) {
      this.jsonlState = { lastGoodData: result.data, lastGoodFetchedAt: Date.now() };
    } else {
      this.jsonlState = { ...this.jsonlState, lastErrorReason: result.reason };
      this.deps.logger.warn(`jsonl estimate failed: ${result.reason}`);
    }
  }

  private buildViewModel(): UsageViewModel {
    const rateLimits = resolveRateLimitsDisplayState(this.statuslineLast, this.deps.getStaleMinutes());
    const credit: CreditDisplayState = this.deps.isCreditEnabled()
      ? resolveOAuthDisplayState(this.oauthState)
      : { kind: 'disabled' };
    const jsonl: JsonlDisplayState =
      this.jsonlState.lastGoodData && this.jsonlState.lastGoodFetchedAt !== undefined
        ? { kind: 'ok', data: this.jsonlState.lastGoodData, fetchedAt: this.jsonlState.lastGoodFetchedAt }
        : { kind: 'unavailable', reason: this.jsonlState.lastErrorReason ?? 'not_found' };
    return { rateLimits, credit, jsonl };
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.pollNow();
    }, this.deps.getIntervalMs());
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
