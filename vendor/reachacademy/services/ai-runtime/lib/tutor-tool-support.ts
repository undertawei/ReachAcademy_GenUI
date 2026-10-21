import { createHash } from 'node:crypto';

import type { AgentTool } from '@mariozechner/pi-agent-core';

import type { RunRecord } from './contracts.js';
import { DomainServiceError } from './domain-client.js';
import { projectForTutor } from './projection.js';
import type { RuntimeStore } from './store/index.js';

/** Tutor 工具的运行时定义：统一超时、输出上限与审计执行边界。 */
export interface RuntimeTool {
  name: string;
  label: string;
  description: string;
  parameters: AgentTool['parameters'];
  timeoutMs: number;
  outputBytes: number;
  execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function executeAuditedTool(
  tool: RuntimeTool,
  run: RunRecord,
  store: RuntimeStore,
  input: Record<string, unknown>,
  outerSignal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: undefined }> {
  const started = performance.now();
  const inputSha256 = digest(input);
  const timeout = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeout.abort(new DOMException(`${tool.name} timed out`, 'TimeoutError')),
    tool.timeoutMs,
  );
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout.signal]) : timeout.signal;
  try {
    signal.throwIfAborted();
    const raw = await raceWithAbort(tool.execute(input, signal), signal);
    const projected = projectForTutor(raw);
    let text = JSON.stringify(projected);
    if (Buffer.byteLength(text, 'utf8') > tool.outputBytes) {
      text = JSON.stringify({
        truncated: true,
        preview: truncateUtf8(text, Math.max(0, tool.outputBytes - 100)),
      });
    }
    await store.recordToolAudit(run, {
      toolName: tool.name,
      inputSha256,
      outputSha256: digest(projected),
      outcome: 'succeeded',
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return { content: [{ type: 'text', text }], details: undefined };
  } catch (error) {
    const errorCode =
      error instanceof Error && error.name === 'TimeoutError' ? 'TOOL_TIMEOUT' : 'TOOL_FAILED';
    await store.recordToolAudit(run, {
      toolName: tool.name,
      inputSha256,
      outcome: 'failed',
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      errorCode,
    });
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Tool execution aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

export function contextRecord(value: unknown, label: string): Record<string, unknown> {
  const result = optionalRecord(value);
  if (!result) throw contextMismatch(`${label} is invalid`);
  return result;
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function requireContextIdentity(
  record: Record<string, unknown>,
  key: string,
  expected: string,
  label = 'Reach Deck',
): void {
  if (record[key] !== expected) {
    throw contextMismatch(`${label} Tutor context ${key} does not match the authorized scope`);
  }
}

export function contextMismatch(message: string): DomainServiceError {
  return new DomainServiceError(message, 409, false);
}
