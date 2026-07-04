import type { CostEstimate, ExtraUsage, StatuslinePayload, StatuslineRateLimits } from '../data/types';
import type { ClaudeUsageViewerConfig } from '../core/config';

export type ThresholdLevel = 'normal' | 'warning' | 'critical';

/**
 * 表示対象のused_percentage値のうち最大のものでしきい値レベルを決める。
 * v0.2: 入力はstatuslineブリッジ由来の公式値。コンテキスト%はしきい値判定に
 * 含めない(自動コンパクトで自然に解消するため、レート制限の警告と混ぜない)。
 */
export function thresholdLevel(rateLimits: StatuslineRateLimits | undefined, config: ClaudeUsageViewerConfig): ThresholdLevel {
  const values: number[] = [];
  if (config.showFiveHour && typeof rateLimits?.five_hour?.used_percentage === 'number') {
    values.push(rateLimits.five_hour.used_percentage);
  }
  if (config.showWeekly && typeof rateLimits?.seven_day?.used_percentage === 'number') {
    values.push(rateLimits.seven_day.used_percentage);
  }
  if (values.length === 0) return 'normal';

  const max = Math.max(...values);
  if (max >= config.criticalThreshold) return 'critical';
  if (max >= config.warningThreshold) return 'warning';
  return 'normal';
}

export function iconForLevel(level: ThresholdLevel): string {
  switch (level) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    case 'normal':
      return 'pulse';
  }
}

export function roundPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatElapsedMinutes(fetchedAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - fetchedAt) / 60_000));
  if (minutes < 1) return 'たった今';
  return `${minutes}分前`;
}

/**
 * extra_usageの金額セグメントを組み立てる。`is_enabled`がtrueでない
 * アカウント(大半と推定)では冗長になるため何も返さない(05_final.md 1.1節)。
 */
export function buildCreditSegment(extraUsage: ExtraUsage | undefined): string | undefined {
  if (!extraUsage || extraUsage.is_enabled !== true) return undefined;
  if (typeof extraUsage.used_credits !== 'number') return undefined;
  return `$${extraUsage.used_credits.toFixed(2)} extra`;
}

/**
 * ①②(+コンテキスト%)の本文(アイコンを除く部分)を組み立てる純関数。
 * 表示する項目が1つもない場合(設定で全部OFF、またはrate_limits未着)は空文字を返す。
 */
export function buildRateLimitBody(payload: StatuslinePayload, config: ClaudeUsageViewerConfig): string {
  const parts: string[] = [];
  const rateLimits = payload.rate_limits;
  if (config.showFiveHour && typeof rateLimits?.five_hour?.used_percentage === 'number') {
    parts.push(`5h ${roundPercent(rateLimits.five_hour.used_percentage)}`);
  }
  if (config.showWeekly && typeof rateLimits?.seven_day?.used_percentage === 'number') {
    parts.push(`7d ${roundPercent(rateLimits.seven_day.used_percentage)}`);
  }
  if (config.showContextPercentage && typeof payload.context_window?.used_percentage === 'number') {
    parts.push(`Ctx ${roundPercent(payload.context_window.used_percentage)}`);
  }
  return parts.join(' · ');
}

/**
 * statusline由来の`resets_at`(epoch秒)を「絶対時刻 (あとNhNm)」形式にする。
 * 実キャプチャ(r2_verification.md 9章)でepoch秒であることを確認済み。
 */
export function formatResetEpochSeconds(epochSeconds: number | undefined): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '—';
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';

  const now = Date.now();
  const diffMs = date.getTime() - now;
  if (diffMs <= 0) return formatAbsolute(date);

  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const relative = hours > 0 ? `あと${hours}h${minutes}m` : `あと${minutes}m`;
  return `${formatAbsolute(date)} (${relative})`;
}

function formatAbsolute(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * ステータスバーの常設アンカー(③JSONLコスト層)用の短い表示文字列。
 * 04_critique.md Round2の破壊者裁定「③を製品の第一義に」対応: 認証情報・ネットワークに
 * 依存しない③は常に表示可能なため、①②④が取得できていなくても
 * この文字列だけは出し続けられる。「推定」を明記し過大な正確性を装わない。
 */
export function formatCostSegment(estimate: CostEstimate): string {
  return `推定${formatUsd(estimate.costUsd)}`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
