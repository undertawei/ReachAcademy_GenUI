/** Queue-independent terminal error. BullMQ adapters may translate it at their boundary. */
export class FeedforwardUnrecoverableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UnrecoverableError';
  }
}

export class FeedforwardModelServiceError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FeedforwardModelServiceError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function isRetryableFeedforwardError(error: unknown): boolean {
  if (guardrailCode(error)) return false;
  if (typeof error !== 'object' || error === null || !('retryable' in error)) return false;
  return (error as { retryable?: unknown }).retryable === true;
}
export type GuardrailCode = 'GUARDRAIL_BLOCKED' | 'GUARDRAIL_UNAVAILABLE';

/** Only recognize the gateway's stable error contract, never arbitrary provider prose. */
export function guardrailCode(
  value: unknown,
  seen = new Set<unknown>(),
): GuardrailCode | undefined {
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (typeof value === 'string') {
    if (value === 'GUARDRAIL_BLOCKED' || value === 'GUARDRAIL_UNAVAILABLE') return value;
    const http = value.match(/^(?:422|503)\s+(.+)$/s);
    if (http) return guardrailCode(http[1], seen);
    for (const frame of value.split(/\r?\n\r?\n/)) {
      const lines = frame.split(/\r?\n/);
      if (!lines.some((line) => /^event:\s*error\s*$/.test(line))) continue;
      if (!lines.every((line) => /^(?:event:|data:|id:|retry:|:|$)/.test(line))) continue;
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      try {
        const code = guardrailCode(JSON.parse(data), seen);
        if (code) return code;
      } catch {
        /* Non-JSON SSE frames are not gateway error envelopes. */
      }
    }
    try {
      return guardrailCode(JSON.parse(value), seen);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.code === 4601 || entry.code === '4601') return 'GUARDRAIL_BLOCKED';
  if (entry.code === 5601 || entry.code === '5601') return 'GUARDRAIL_UNAVAILABLE';
  for (const item of [entry.code, entry.message, entry.error, entry.cause]) {
    if (item !== value) {
      const code = guardrailCode(item, seen);
      if (code) return code;
    }
  }
  return undefined;
}

export class GuardrailError extends Error {
  readonly retryable = false;
  constructor(readonly code: GuardrailCode) {
    super(code);
    this.name = 'GuardrailError';
  }
}
