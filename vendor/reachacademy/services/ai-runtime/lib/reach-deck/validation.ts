import { parseReachDeckDocument } from '@reachany/reach-deck-dsl';

import type { ReachDeckGenerationAttempt, ReachDeckGenerationRequest } from './contracts.js';

const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const PAGE_ID_PATTERN = /^[a-zA-Z0-9_.:+@-]{1,256}$/;
const ATTEMPTS = new Set<ReachDeckGenerationAttempt>(['initial', 'regenerate', 'repair']);
const MAX_PROMPT_CHARACTERS = 100_000;
const MAX_RUN_ID_CHARACTERS = 100;

export function parseReachDeckGenerationRequest(value: unknown): ReachDeckGenerationRequest {
  const input = readRecord(value, 'generation request');
  const prompt = readNonEmptyString(input.prompt, 'prompt');
  if (prompt.length > MAX_PROMPT_CHARACTERS) {
    throw new Error('prompt exceeds 100000 characters');
  }
  if (input.language !== undefined && input.language !== 'zh-CN') {
    throw new Error('language must be zh-CN');
  }
  const expectedRevisionToken = readOptionalString(
    input.expectedRevisionToken,
    'expectedRevisionToken',
  );
  const document =
    input.document === undefined ? undefined : parseReachDeckDocument(input.document);
  return {
    prompt,
    ...(input.language === undefined ? {} : { language: 'zh-CN' as const }),
    ...(document === undefined ? {} : { document }),
    ...(expectedRevisionToken === undefined ? {} : { expectedRevisionToken }),
  };
}

export function parsePageRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('pageRevision must be a positive integer');
  }
  return value;
}

export function parsePageId(value: unknown): string {
  const pageId = readNonEmptyString(value, 'pageId');
  if (!PAGE_ID_PATTERN.test(pageId)) {
    throw new Error('pageId contains unsupported characters');
  }
  return pageId;
}

export function parseGenerationAttempt(value: unknown): ReachDeckGenerationAttempt {
  if (value === undefined) return 'initial';
  if (typeof value !== 'string' || !ATTEMPTS.has(value as ReachDeckGenerationAttempt)) {
    throw new Error('attempt is invalid');
  }
  return value as ReachDeckGenerationAttempt;
}

export function parseRunId(value: unknown): string {
  const runId = readNonEmptyString(value, 'runId');
  if (runId.length > MAX_RUN_ID_CHARACTERS) {
    throw new Error('runId exceeds 100 characters');
  }
  return runId;
}

export function isReachDeckJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' is required');
  }
  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return readNonEmptyString(value, label);
}
