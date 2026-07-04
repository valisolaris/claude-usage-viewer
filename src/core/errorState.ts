import type { ErrorReason, OAuthUsageResponse, StatuslinePayload, StatuslineReadResult } from '../data/types';

/**
 * 劣化表示の一元管理(05_final.md 1.6節の劣化動作マトリクスの実装)。
 * `data/*` からの取得失敗理由(ErrorReason)を、表示用の状態に変換する。
 */

/** 連続失敗がこの回数を超えたら、直前値の継続表示から明示エラー表示へ切り替える。 */
export const STALE_ESCALATION_THRESHOLD = 3;

/**
 * 直前値を継続表示できない理由(=再ログインなど利用者の対応が要るもの、
 * またはそもそも直前値が存在しえないもの)。`plan_not_applicable`はoauthUsageClient側で
 * API呼び出し自体をスキップするため、継続表示すべき「直前の正常値」が生まれない。
 */
const NO_CONTINUATION_REASONS: ReadonlySet<ErrorReason> = new Set(['unauthenticated', 'plan_not_applicable']);

export interface OAuthAttemptState {
  lastGoodData?: OAuthUsageResponse;
  lastGoodFetchedAt?: number;
  consecutiveFailures: number;
  lastErrorReason?: ErrorReason;
}

export type OAuthDisplayState =
  | { kind: 'ok'; data: OAuthUsageResponse; fetchedAt: number }
  | { kind: 'stale'; data: OAuthUsageResponse; fetchedAt: number; reason: ErrorReason }
  | { kind: 'error'; reason: ErrorReason };

export function resolveOAuthDisplayState(state: OAuthAttemptState): OAuthDisplayState {
  if (state.consecutiveFailures === 0) {
    if (state.lastGoodData && state.lastGoodFetchedAt !== undefined) {
      return { kind: 'ok', data: state.lastGoodData, fetchedAt: state.lastGoodFetchedAt };
    }
    // 成功も失敗もまだ記録がない(起動直後の理論上の状態)。ネットワーク未確定として扱う。
    return { kind: 'error', reason: 'network' };
  }

  const reason = state.lastErrorReason ?? 'network';
  if (NO_CONTINUATION_REASONS.has(reason)) {
    return { kind: 'error', reason };
  }

  if (state.lastGoodData && state.lastGoodFetchedAt !== undefined && state.consecutiveFailures < STALE_ESCALATION_THRESHOLD) {
    return { kind: 'stale', data: state.lastGoodData, fetchedAt: state.lastGoodFetchedAt, reason };
  }
  return { kind: 'error', reason };
}

/**
 * ①②(+コンテキスト%)の表示状態(v0.2: statuslineブリッジが主データ源)。
 * ok/stale の区別はファイル mtime の鮮度のみで決まる: statusline は Claude Code の
 * セッション活動中しか更新されないため、古い mtime は「エラー」ではなく
 * 「最後に観測した公式値」を意味する。だから stale でも値は表示し続ける。
 */
export type RateLimitsDisplayState =
  | { kind: 'ok'; data: StatuslinePayload; capturedAt: number }
  | { kind: 'stale'; data: StatuslinePayload; capturedAt: number }
  | { kind: 'unavailable'; reason: ErrorReason };

export function resolveRateLimitsDisplayState(
  result: StatuslineReadResult | undefined,
  staleMinutes: number,
  now: number = Date.now(),
): RateLimitsDisplayState {
  if (result === undefined) {
    // 起動直後でまだ一度も読んでいない。ファイル不在と同じ案内(セットアップ誘導)に倒す。
    return { kind: 'unavailable', reason: 'bridge_not_configured' };
  }
  if (!result.ok) {
    return {
      kind: 'unavailable',
      reason: result.reason === 'not_found' ? 'bridge_not_configured' : 'bridge_unreadable',
    };
  }
  const ageMs = now - result.capturedAt;
  const kind = ageMs > staleMinutes * 60_000 ? 'stale' : 'ok';
  return { kind, data: result.data, capturedAt: result.capturedAt };
}

/**
 * ④クレジット(オプトイン)の表示状態。`disabled` は設定OFF(既定)で、
 * OAuth API・認証情報に一切触れていないことを意味する。
 */
export type CreditDisplayState = { kind: 'disabled' } | OAuthDisplayState;

export interface ErrorPresentation {
  /** codiconのID(`$()`は含まない)。 */
  icon: string;
  shortLabel: string;
  /** ツールチップ内で使う、再ログイン手順などの補足。 */
  tooltipHint: string;
}

/**
 * ステータスバー背景色を警告色にすべきか(04_critique.md Round2「視覚アラーム残件」対応)。
 * 判定基準は「表示中で最も深刻な状態か」ではなく「利用者が実際に対応すべき状態か」。
 * `unauthenticated`(再ログインが要る)だけがtrue。429/オフライン/スキーマ不一致/
 * プラン対象外は利用者側の対応でどうにかなるものではなく、③(JSONLコスト)が
 * 正常に表示できていることも多いため、常時アラーム色にするのは過剰(誤警報)。
 */
export function requiresUserAction(reason: ErrorReason): boolean {
  return reason === 'unauthenticated';
}

export function presentErrorReason(reason: ErrorReason): ErrorPresentation {
  switch (reason) {
    case 'unauthenticated':
      return {
        icon: 'circle-slash',
        shortLabel: 'Claude未ログイン',
        tooltipHint: 'ターミナルで `claude` を実行してログインしてください。',
      };
    case 'rate_limited':
      return {
        icon: 'warning',
        shortLabel: '一時取得不可(429)',
        tooltipHint: '非公式APIがレート制限中です。しばらく待つと自動的に再取得します。',
      };
    case 'network':
      return {
        icon: 'cloud-offline',
        shortLabel: 'オフライン',
        tooltipHint: 'ネットワークに接続できません。',
      };
    case 'unexpected_schema':
      return {
        icon: 'warning',
        shortLabel: '応答形式エラー',
        tooltipHint: '非公式APIの応答形式が想定と異なります。拡張の更新をご確認ください。',
      };
    case 'jsonl_unavailable':
      return {
        icon: 'circle-slash',
        shortLabel: 'トークン集計データなし',
        tooltipHint: 'ローカルの使用ログ(.claude/projects)が見つからないか読み取れません。',
      };
    case 'plan_not_applicable':
      return {
        icon: 'circle-slash',
        shortLabel: 'プラン対象外',
        tooltipHint: 'このプラン(APIキー従量課金等)では5h/週次の使用率・クレジット表示は提供されません。ローカルログからの推定コストのみ表示します。',
      };
    case 'bridge_not_configured':
      return {
        icon: 'plug',
        shortLabel: '5h/7d 未受信',
        tooltipHint:
          'コマンド「Claude Usage: Set Up Statusline Bridge」を実行してブリッジを設定すると、Claude Code の公式値(5h/週次使用率)が表示されます。',
      };
    case 'bridge_unreadable':
      return {
        icon: 'warning',
        shortLabel: '受信データ読取エラー',
        tooltipHint: 'statusline-state.json を読み取れません。ファイルの破損またはアクセス権を確認してください。',
      };
  }
}
