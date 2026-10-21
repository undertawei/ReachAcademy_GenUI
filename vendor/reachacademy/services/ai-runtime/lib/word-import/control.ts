import type { RunRecord, RuntimeActor, ValidatedArtifactRecord } from '../contracts.js';
import { wordImportInput } from './input.js';

export interface WordImportControl {
  schema: 'word-import-control/v1';
  deadlineAt: string;
  attempts: number;
  modelCalls: number;
  reservedTokens: number;
  owner?: string;
  leaseUntil?: string;
  activeModelPhase?: string;
  checkpoints: Record<string, { artifactId: string; contentSha256: string }>;
  timings: Record<string, number>;
}

export type WordImportTransition =
  | { kind: 'claim'; owner: string }
  | { kind: 'heartbeat'; owner: string }
  | { kind: 'reserve-model'; owner: string; phase: string; tokens: number }
  | {
      kind: 'checkpoint';
      owner: string;
      phase: string;
      elapsedMs: number;
      artifact: Omit<ValidatedArtifactRecord, 'runId'>;
    }
  | { kind: 'finish'; owner: string }
  | { kind: 'fail'; owner: string; code: string }
  | { kind: 'retry'; actor: RuntimeActor }
  | { kind: 'cancel'; actor: RuntimeActor };

export const WORD_IMPORT_TARGET_UNAVAILABLE = 'word-import.target-unavailable' as const;

export function isWordImportTargetUnavailableRun(run: RunRecord): boolean {
  return run.error?.code === WORD_IMPORT_TARGET_UNAVAILABLE;
}

export function canRetryWordImportRun(run: RunRecord, now: Date): boolean {
  if (run.status !== 'failed' || isWordImportTargetUnavailableRun(run)) return false;
  const control = parseWordImportControl(run.runtimeState?.wordImport);
  return (
    control !== undefined &&
    run.error?.code !== 'word-import.model-budget-exhausted' &&
    run.error?.code !== 'word-import.diagnostic-version-reparse-required' &&
    now.getTime() < Date.parse(control.deadlineAt) &&
    control.attempts < 3
  );
}

/** Called only while the store owns the run row / in-memory critical section. */
export function terminalizeWordImportTargetUnavailableRun(
  original: RunRecord,
  now: Date,
  hasAuthoritativePreview: boolean,
): RunRecord | null {
  if (isWordImportTargetUnavailableRun(original)) return structuredClone(original);
  const persistedControl = original.runtimeState?.wordImport;
  const control = parseWordImportControl(persistedControl);
  if (persistedControl !== undefined && !control) return null;
  const eligible =
    original.status === 'queued' ||
    (original.status === 'running' && control !== undefined) ||
    canRetryWordImportRun(original, now) ||
    (original.status === 'completed' &&
      control?.checkpoints.preview !== undefined &&
      hasAuthoritativePreview);
  if (!eligible) return null;
  const run = structuredClone(original);
  if (control) {
    delete control.owner;
    delete control.leaseUntil;
    run.runtimeState = { ...run.runtimeState, wordImport: control };
  }
  run.status = 'failed';
  run.finishedAt = now.toISOString();
  delete run.cancelledAt;
  run.error = {
    code: WORD_IMPORT_TARGET_UNAVAILABLE,
    message: 'Word import requires attention',
  };
  run.version = (run.version ?? 0) + 1;
  return run;
}

export function parseWordImportControl(value: unknown): WordImportControl | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const control = value as WordImportControl;
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item);
  const phase = (item: string): boolean =>
    /^(download|preprocess|parse:\d{1,2}|media|preview)$/.test(item);
  if (
    control.schema !== 'word-import-control/v1' ||
    !Number.isFinite(Date.parse(control.deadlineAt)) ||
    !Number.isSafeInteger(control.attempts) ||
    control.attempts < 0 ||
    control.attempts > 3 ||
    !Number.isSafeInteger(control.modelCalls) ||
    control.modelCalls < 0 ||
    control.modelCalls > 16 ||
    !Number.isSafeInteger(control.reservedTokens) ||
    control.reservedTokens < 0 ||
    control.reservedTokens > 100_000 ||
    !record(control.checkpoints) ||
    !record(control.timings) ||
    (control.owner !== undefined && (typeof control.owner !== 'string' || !control.owner)) ||
    (control.leaseUntil !== undefined && !Number.isFinite(Date.parse(control.leaseUntil))) ||
    (control.owner === undefined) !== (control.leaseUntil === undefined) ||
    (control.activeModelPhase !== undefined && !/^parse:\d{1,2}$/.test(control.activeModelPhase)) ||
    Object.entries(control.checkpoints).some(
      ([key, item]) =>
        !phase(key) ||
        !record(item) ||
        typeof item.artifactId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(item.artifactId) ||
        typeof item.contentSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.contentSha256),
    ) ||
    Object.entries(control.timings).some(
      ([key, item]) =>
        !phase(key) || typeof item !== 'number' || !Number.isFinite(item) || item < 0,
    )
  )
    return;
  return structuredClone(control);
}

/** Called under the store's run-row CAS. No network/model/asset work takes place under this lock. */
export function transitionWordImportRun(
  original: RunRecord,
  command: WordImportTransition,
  now: Date,
): RunRecord | null {
  const input = wordImportInput(original);
  if (isWordImportTargetUnavailableRun(original)) return null;
  const run = structuredClone(original);
  const persistedControl = run.runtimeState?.wordImport;
  const parsedControl = parseWordImportControl(persistedControl);
  // Malformed durable state must never reset paid-call counters or start a fresh deadline.
  if (persistedControl !== undefined && !parsedControl) return null;
  const control = parsedControl ?? {
    schema: 'word-import-control/v1' as const,
    deadlineAt: new Date(Date.parse(run.queuedAt) + 30 * 60_000).toISOString(),
    attempts: 0,
    modelCalls: 0,
    reservedTokens: 0,
    checkpoints: {},
    timings: {},
  };
  if (
    'actor' in command &&
    (command.actor.subject !== run.actor.subject || command.actor.orgId !== run.actor.orgId)
  )
    return null;
  if (command.kind === 'cancel') {
    if (run.status === 'completed' || run.status === 'cancelled') return null;
    run.status = 'cancelled';
    run.cancelledAt = now.toISOString();
    run.finishedAt = now.toISOString();
    delete control.owner;
    delete control.leaseUntil;
  } else if (command.kind === 'retry') {
    if (
      run.status !== 'failed' ||
      run.error?.code === 'word-import.model-budget-exhausted' ||
      run.error?.code === 'word-import.diagnostic-version-reparse-required' ||
      now.getTime() >= Date.parse(control.deadlineAt) ||
      control.attempts >= 3
    )
      return null;
    // Only an explicit teacher retry releases an ambiguous paid phase. Counters remain charged.
    delete control.activeModelPhase;
    delete control.owner;
    delete control.leaseUntil;
    run.status = 'queued';
    delete run.error;
    delete run.finishedAt;
  } else if (command.kind === 'claim') {
    if (!command.owner || !['queued', 'running'].includes(run.status)) return null;
    if (run.status === 'running' && Date.parse(control.leaseUntil ?? '') > now.getTime())
      return null;
    if (
      now.getTime() >= Date.parse(control.deadlineAt) ||
      control.attempts >= 3 ||
      control.activeModelPhase
    ) {
      run.status = 'failed';
      run.finishedAt = now.toISOString();
      run.error = {
        code: control.activeModelPhase
          ? 'word-import.model-result-uncertain'
          : 'word-import.budget-exhausted',
        message: 'Word import requires attention',
      };
      delete control.owner;
      delete control.leaseUntil;
    } else {
      control.attempts += 1;
      control.owner = command.owner;
      control.leaseUntil = new Date(now.getTime() + 90_000).toISOString();
      run.status = 'running';
      run.startedAt ??= now.toISOString();
    }
  } else {
    if (
      run.status !== 'running' ||
      control.owner !== command.owner ||
      Date.parse(control.leaseUntil ?? '') <= now.getTime()
    )
      return null;
    if (now.getTime() >= Date.parse(control.deadlineAt) && command.kind !== 'fail') return null;
    if (command.kind === 'heartbeat')
      control.leaseUntil = new Date(now.getTime() + 90_000).toISOString();
    if (command.kind === 'reserve-model') {
      if (
        input.mode !== 'smart' ||
        control.activeModelPhase ||
        !/^parse:\d{1,2}$/.test(command.phase) ||
        !Number.isSafeInteger(command.tokens) ||
        command.tokens <= 0 ||
        control.modelCalls >= 16 ||
        control.reservedTokens + command.tokens > run.tokenBudget
      )
        return null;
      control.modelCalls += 1;
      control.reservedTokens += command.tokens;
      control.activeModelPhase = command.phase;
    }
    if (command.kind === 'checkpoint') {
      if (
        !/^(download|preprocess|parse:\d{1,2}|media|preview)$/.test(command.phase) ||
        !Number.isFinite(command.elapsedMs) ||
        command.elapsedMs < 0 ||
        !/^[a-f0-9]{64}$/.test(command.artifact.contentSha256) ||
        (control.activeModelPhase && command.phase !== control.activeModelPhase)
      )
        return null;
      const prior = control.checkpoints[command.phase];
      if (
        prior &&
        (prior.artifactId !== command.artifact.id ||
          prior.contentSha256 !== command.artifact.contentSha256)
      )
        return null;
      control.checkpoints[command.phase] = {
        artifactId: command.artifact.id,
        contentSha256: command.artifact.contentSha256,
      };
      control.timings[command.phase] = command.elapsedMs;
      if (control.activeModelPhase === command.phase) delete control.activeModelPhase;
    }
    if (command.kind === 'finish') {
      if (!control.checkpoints.preview || control.activeModelPhase) return null;
      run.status = 'completed';
      run.finishedAt = now.toISOString();
      delete control.owner;
      delete control.leaseUntil;
    }
    if (command.kind === 'fail') {
      if (!/^word-import\.[a-z0-9.-]{1,100}$/.test(command.code)) return null;
      run.status = 'failed';
      run.finishedAt = now.toISOString();
      run.error = { code: command.code, message: 'Word import requires attention' };
      delete control.owner;
      delete control.leaseUntil;
    }
  }
  run.version = (run.version ?? 0) + 1;
  run.runtimeState = { ...run.runtimeState, wordImport: control };
  return run;
}
