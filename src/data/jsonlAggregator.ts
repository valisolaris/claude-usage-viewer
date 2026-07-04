import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { getPricingForModel } from './pricingTable';
import type { CostEstimate, JsonlEstimateResult, TokenTotals } from './types';

/**
 * `~/.claude/projects/**\/*.jsonl` を集計する独立層(05_final.md 1.4節)。
 * `.credentials.json` を一切読まず、ネットワーク通信も一切行わない。
 * API(oauthUsageClient)が401/429/オフラインのいずれであっても、
 * このモジュール単体で完動し続けることが設計原則。
 */

export interface JsonlAggregatorConfig {
  /** `claudeUsageViewer.credentialsPathOverride` とは別枠。projectsルート自体はCLAUDE_CONFIG_DIR優先で解決する。 */
  windowDays: number;
}

interface SessionFile {
  filePath: string;
  mtimeMs: number;
}

function resolveProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) return path.join(configDir, 'projects');
  return path.join(os.homedir(), '.claude', 'projects');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listJsonlFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsonlFilesRecursive(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

async function listRecentSessionFiles(root: string, windowDays: number): Promise<SessionFile[]> {
  const all = await listJsonlFilesRecursive(root);
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const result: SessionFile[] = [];
  for (const filePath of all) {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.mtimeMs >= cutoff) {
        result.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // 走査中に削除された等は無視して続行
    }
  }
  return result;
}

interface ParsedUsageLine {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * 1行分の`.jsonl`をパースし、`type: "assistant"` かつ `message.usage` を
 * 持つ行からトークン使用量を抽出する。実データで確認済みの形
 * (r2_verification.md参照): `message.usage.{input_tokens,output_tokens,
 * cache_creation_input_tokens,cache_read_input_tokens}` + `message.model`。
 */
export function tryParseUsageLine(line: string): ParsedUsageLine | undefined {
  if (!line.trim()) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== 'assistant') return undefined;

  const message = rec.message;
  if (message === null || typeof message !== 'object') return undefined;
  const msg = message as Record<string, unknown>;
  const usage = msg.usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;

  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const cacheCreationTokens = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const cacheReadTokens = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const model = typeof msg.model === 'string' ? msg.model : 'unknown';

  return { model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}

async function forEachJsonlLine(filePath: string, onLine: (line: string) => void): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      onLine(line);
    }
  } finally {
    rl.close();
    stream.close();
  }
}

function zeroTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

export class JsonlAggregator {
  private cache: { mtimeKey: string; windowDays: number; result: CostEstimate } | undefined;

  constructor(private readonly getConfig: () => JsonlAggregatorConfig) {}

  async estimate(): Promise<JsonlEstimateResult> {
    const windowDays = this.getConfig().windowDays;
    const root = resolveProjectsDir();

    if (!(await pathExists(root))) {
      return { ok: false, reason: 'not_found', detail: root };
    }

    let files: SessionFile[];
    try {
      files = await listRecentSessionFiles(root, windowDays);
    } catch (err) {
      return { ok: false, reason: 'read_error', detail: err instanceof Error ? err.message : 'unknown' };
    }

    const mtimeKey = files.map((f) => `${f.filePath}:${f.mtimeMs}`).sort().join('|');
    if (this.cache && this.cache.mtimeKey === mtimeKey && this.cache.windowDays === windowDays) {
      return { ok: true, data: this.cache.result };
    }

    const totals = zeroTotals();
    /** モデル別に分けて保持し、コスト計算だけモデル単価を反映する。 */
    const perModelTotals = new Map<string, TokenTotals>();

    for (const file of files) {
      try {
        await forEachJsonlLine(file.filePath, (line) => {
          const parsed = tryParseUsageLine(line);
          if (!parsed) return;

          totals.inputTokens += parsed.inputTokens;
          totals.outputTokens += parsed.outputTokens;
          totals.cacheCreationTokens += parsed.cacheCreationTokens;
          totals.cacheReadTokens += parsed.cacheReadTokens;

          const existing = perModelTotals.get(parsed.model) ?? zeroTotals();
          existing.inputTokens += parsed.inputTokens;
          existing.outputTokens += parsed.outputTokens;
          existing.cacheCreationTokens += parsed.cacheCreationTokens;
          existing.cacheReadTokens += parsed.cacheReadTokens;
          perModelTotals.set(parsed.model, existing);
        });
      } catch {
        // 個別ファイルの読取失敗は無視して他ファイルの集計を続行する
      }
    }

    let costUsd = 0;
    for (const [model, modelTotals] of perModelTotals) {
      const pricing = getPricingForModel(model);
      costUsd +=
        (modelTotals.inputTokens / 1_000_000) * pricing.inputPerM +
        (modelTotals.outputTokens / 1_000_000) * pricing.outputPerM +
        (modelTotals.cacheCreationTokens / 1_000_000) * pricing.cacheWritePerM +
        (modelTotals.cacheReadTokens / 1_000_000) * pricing.cacheReadPerM;
    }

    // cache_readは桁違いに嵩みやすく生合算すると「量」表示が水増しされる(04_critique.md C案指摘対応)。
    // 表示用トークン量からは除外し、コスト計算にのみ反映する。
    const displayTokens = totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens;

    const result: CostEstimate = {
      totals,
      displayTokens,
      costUsd,
      windowDays,
      fileCount: files.length,
    };
    this.cache = { mtimeKey, windowDays, result };
    return { ok: true, data: result };
  }
}
