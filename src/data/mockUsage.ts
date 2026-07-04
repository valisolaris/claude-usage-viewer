import type { ExtraUsage, OAuthUsageResult, StatuslinePayload, StatuslineReadResult } from './types';

/**
 * 開発検証専用のモックデータ注入(環境変数 `CLAUDE_USAGE_MOCK`)。
 *
 * v0.2では①②がstatuslineブリッジ由来になったため、モックも2ソース
 * (statusline側=5h/7d/コンテキスト%、oauth側=クレジット)を注入する。
 * 書式はv0.1(Run 4/5の実機検証で使用)と互換:
 *   "65"          → 5h 65%
 *   "65,30"       → 5h 65% / 7d 30%
 *   "65,30,12.5"  → 5h 65% / 7d 30% / extra usage $12.50
 * コンテキスト%は常に50を注入する(showContextPercentageの表示確認用)。
 * 環境変数が未設定の製品動作ではこのモジュールは一切使われない。
 */
export function parseMockSpec(spec: string): { fiveHour: number; sevenDay?: number; usedCredits?: number } | undefined {
  const parts = spec.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => p === '')) return undefined;

  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return undefined;

  const [fiveHour, sevenDay, usedCredits] = numbers;
  return { fiveHour, sevenDay, usedCredits };
}

export function buildMockStatuslinePayload(spec: string, now: number = Date.now()): StatuslinePayload | undefined {
  const parsed = parseMockSpec(spec);
  if (!parsed) return undefined;

  const payload: StatuslinePayload = {
    rate_limits: {
      five_hour: {
        used_percentage: parsed.fiveHour,
        resets_at: Math.floor((now + 90 * 60_000) / 1000),
      },
    },
    context_window: { used_percentage: 50 },
  };
  if (parsed.sevenDay !== undefined && payload.rate_limits) {
    payload.rate_limits.seven_day = {
      used_percentage: parsed.sevenDay,
      resets_at: Math.floor((now + 3 * 24 * 60 * 60_000) / 1000),
    };
  }
  return payload;
}

export interface MockSources {
  statusline: { read(): Promise<StatuslineReadResult> };
  oauth: { fetchUsage(): Promise<OAuthUsageResult> };
}

/**
 * Poller(core/poller.tsのStatuslineSource/OAuthUsageSource)に差し込むモック実装を返す。
 * specが解釈できない場合はundefinedを返し、呼び出し側は実クライアントに
 * フォールバックする。resets_at/capturedAtが現在時刻から相対で意味を持ち続けるよう、
 * レスポンスは呼び出しの度に組み立て直す。
 */
export function createMockSources(spec: string): MockSources | undefined {
  if (parseMockSpec(spec) === undefined) return undefined;
  return {
    statusline: {
      async read(): Promise<StatuslineReadResult> {
        const data = buildMockStatuslinePayload(spec);
        if (data === undefined) return { ok: false, reason: 'parse_error' };
        return { ok: true, data, capturedAt: Date.now() };
      },
    },
    oauth: {
      async fetchUsage(): Promise<OAuthUsageResult> {
        const parsed = parseMockSpec(spec);
        if (parsed?.usedCredits === undefined) {
          // クレジット指定なし: 対象アカウントでextra usageが無効な状態を模す
          return { ok: true, data: { extra_usage: { is_enabled: false } } };
        }
        const monthlyLimit = 50;
        const extraUsage: ExtraUsage = {
          is_enabled: true,
          monthly_limit: monthlyLimit,
          used_credits: parsed.usedCredits,
          utilization: Math.min(100, (parsed.usedCredits / monthlyLimit) * 100),
        };
        return { ok: true, data: { extra_usage: extraUsage } };
      },
    },
  };
}
