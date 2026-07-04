/**
 * OutputChannelラッパー。トークン・認証情報を絶対に出力しないフィルタを内蔵する。
 * `Logger`自体はvscodeの`OutputChannel`型に依存させず、`{ appendLine }` だけを
 * 要求する最小インターフェースにして、data層からのimportでも扱いやすくする。
 */
export interface LogSink {
  appendLine(value: string): void;
}

const SENSITIVE_KEY_PATTERN = /access[_-]?token|refresh[_-]?token|authorization|secret|password|credential/i;

/**
 * ログに渡す文字列・オブジェクトからトークンらしき値を機械的に除去する。
 * 完全な保証ではないが、うっかり `JSON.stringify(credentials)` を渡した
 * 場合の事故を軽減する最終防衛ラインとして機能する。
 */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    // 40文字以上の英数字/./-混在トークンらしき文字列は伏せる(過剰検知でも実害が小さいため広めに取る)
    return value.replace(/[A-Za-z0-9._-]{40,}/g, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor(private readonly sink: LogSink) {}

  private write(level: string, message: string, extra?: unknown): void {
    const safeMessage = redact(message);
    const timestamp = new Date().toISOString();
    if (extra !== undefined) {
      const safeExtra = redact(extra);
      this.sink.appendLine(`[${timestamp}] [${level}] ${safeMessage} ${JSON.stringify(safeExtra)}`);
    } else {
      this.sink.appendLine(`[${timestamp}] [${level}] ${safeMessage}`);
    }
  }

  info(message: string, extra?: unknown): void {
    this.write('INFO', message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.write('WARN', message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.write('ERROR', message, extra);
  }
}
