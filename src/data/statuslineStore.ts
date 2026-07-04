import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { StatuslinePayload, StatuslineRateLimitWindow, StatuslineReadResult } from './types';

export const STATUSLINE_STATE_FILENAME = 'statusline-state.json';

export interface StatuslineStoreConfig {
  /** `claudeUsageViewer.statuslineStatePathOverride` 設定値。空文字なら自動解決。 */
  statuslineStatePathOverride: string;
}

/**
 * `statusline-state.json` の読取専用アクセス(v0.2 の①②主データ源)。
 *
 * このファイルは、Claude Code が statusline コマンドの stdin へ渡す JSON を
 * ブリッジ(セットアップコマンドが設置するスクリプト、または既存 statusline への
 * 追記)がそのまま書き出したもの。値はサーバー計算の公式値であり、実キャプチャで
 * 構造検証済み(r2_verification.md 9章)。credentialStore とは完全に独立で、
 * 認証情報にもネットワークにも一切触れない。
 */
export class StatuslineStore {
  constructor(private readonly getConfig: () => StatuslineStoreConfig) {}

  resolvePath(): string {
    const override = this.getConfig().statuslineStatePathOverride?.trim();
    if (override) return override;

    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir) return path.join(configDir, STATUSLINE_STATE_FILENAME);

    return path.join(os.homedir(), '.claude', STATUSLINE_STATE_FILENAME);
  }

  async read(): Promise<StatuslineReadResult> {
    const statePath = this.resolvePath();

    let raw: string;
    let mtimeMs: number;
    try {
      const [stat, content] = await Promise.all([fs.stat(statePath), fs.readFile(statePath, 'utf8')]);
      mtimeMs = stat.mtimeMs;
      raw = content;
    } catch (err) {
      const code = describeFsError(err);
      return { ok: false, reason: code === 'ENOENT' ? 'not_found' : 'read_error', detail: code };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // tmp→rename のアトミック書込を前提にすると通常発生しないが、
      // ブリッジ未対応の書き方(直接書込)と競合した場合に備える。
      return { ok: false, reason: 'parse_error' };
    }

    const payload = extractStatuslinePayload(parsed);
    if (payload === undefined) {
      return { ok: false, reason: 'parse_error', detail: 'not_an_object' };
    }
    return { ok: true, data: payload, capturedAt: mtimeMs };
  }

  /**
   * state ファイルの更新を監視する。ブリッジは tmp→rename で書くため、
   * ファイル単体ではなくディレクトリを監視して rename イベントを拾う。
   * 書込みバーストをまとめるため短いデバウンスを入れる。
   * fs.watch が使えない環境では何もしない(通常ポーリングにフォールバック)。
   */
  watch(onChange: () => void): { dispose(): void } {
    try {
      const statePath = this.resolvePath();
      const dir = path.dirname(statePath);
      const base = path.basename(statePath);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = fsSync.watch(dir, (_event, filename) => {
        if (filename && filename !== base && filename !== `${base}.tmp`) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, 1_000);
      });
      // ディレクトリ削除等で watcher が壊れても拡張全体を巻き込まない
      watcher.on('error', () => watcher.close());
      return {
        dispose: () => {
          if (timer) clearTimeout(timer);
          watcher.close();
        },
      };
    } catch {
      return { dispose: () => {} };
    }
  }
}

/**
 * 利用フィールドのみを寛容に抽出する。statusline JSON には session_id 等の
 * 無関係なフィールドが多数含まれるため、既知の形に一致する値だけを拾い、
 * 型不一致のフィールドは欠落扱いにする(項目ごと非表示に倒す方針)。
 */
export function extractStatuslinePayload(body: unknown): StatuslinePayload | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const v = body as Record<string, unknown>;

  const payload: StatuslinePayload = {};

  if (v.rate_limits !== null && typeof v.rate_limits === 'object' && v.rate_limits !== undefined) {
    const rl = v.rate_limits as Record<string, unknown>;
    const fiveHour = extractWindow(rl.five_hour);
    const sevenDay = extractWindow(rl.seven_day);
    if (fiveHour || sevenDay) {
      payload.rate_limits = {};
      if (fiveHour) payload.rate_limits.five_hour = fiveHour;
      if (sevenDay) payload.rate_limits.seven_day = sevenDay;
    }
  }

  if (v.context_window !== null && typeof v.context_window === 'object' && v.context_window !== undefined) {
    const cw = v.context_window as Record<string, unknown>;
    if (typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)) {
      payload.context_window = { used_percentage: cw.used_percentage };
    }
  }

  return payload;
}

function extractWindow(value: unknown): StatuslineRateLimitWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const window: StatuslineRateLimitWindow = {};
  if (typeof v.used_percentage === 'number' && Number.isFinite(v.used_percentage)) {
    window.used_percentage = v.used_percentage;
  }
  if (typeof v.resets_at === 'number' && Number.isFinite(v.resets_at)) {
    window.resets_at = v.resets_at;
  }
  return window.used_percentage !== undefined || window.resets_at !== undefined ? window : undefined;
}

function describeFsError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return 'unknown';
}
