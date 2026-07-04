/**
 * モデル別の単価テーブル(ハードコード)。単位: USD / 100万トークン。
 * 最終更新: 2026-07-04(推測値。Anthropicの公式価格改定に追従できないため、
 * ここに載っていないモデル名は family 判定でフォールバックする)。
 * このテーブルに基づくコストは常に「推定値」であり、実際の請求額とは
 * 一致しない場合がある(05_final.md 1.2節の固定文言に対応)。
 */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
}

const EXACT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerM: 15, outputPerM: 75, cacheWritePerM: 18.75, cacheReadPerM: 1.5 },
  'claude-sonnet-5': { inputPerM: 3, outputPerM: 15, cacheWritePerM: 3.75, cacheReadPerM: 0.3 },
  'claude-fable-5': { inputPerM: 15, outputPerM: 75, cacheWritePerM: 18.75, cacheReadPerM: 1.5 },
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5, cacheWritePerM: 1.25, cacheReadPerM: 0.1 },
};

/** 完全一致しない場合のfamily別フォールバック(モデル名にfamily名が含まれるかで判定)。 */
const FAMILY_FALLBACK: Array<{ pattern: RegExp; pricing: ModelPricing }> = [
  { pattern: /opus/i, pricing: { inputPerM: 15, outputPerM: 75, cacheWritePerM: 18.75, cacheReadPerM: 1.5 } },
  { pattern: /sonnet/i, pricing: { inputPerM: 3, outputPerM: 15, cacheWritePerM: 3.75, cacheReadPerM: 0.3 } },
  { pattern: /haiku/i, pricing: { inputPerM: 1, outputPerM: 5, cacheWritePerM: 1.25, cacheReadPerM: 0.1 } },
];

/** 上記のいずれにも一致しない未知モデル用の既定値(Sonnet相当・中庸な値)。 */
const UNKNOWN_MODEL_PRICING: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3,
};

export function getPricingForModel(model: string): ModelPricing {
  const exact = EXACT_PRICING[model];
  if (exact) return exact;

  for (const { pattern, pricing } of FAMILY_FALLBACK) {
    if (pattern.test(model)) return pricing;
  }
  return UNKNOWN_MODEL_PRICING;
}
