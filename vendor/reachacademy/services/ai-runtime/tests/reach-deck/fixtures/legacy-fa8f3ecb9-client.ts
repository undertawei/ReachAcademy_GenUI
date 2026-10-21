// 固定 fa8f3ecb9 客户端的原始解析函数及依赖，仅增加导出和类型导入；勿随新客户端放宽通道校验。
import { parseReachDeckSpeechMarkupV1 } from '@reachany/reach-deck-dsl';
import type {
  ReachDeckStagedGenerationJobKind,
  ReachDeckWorkspaceBatchKind,
  ReachDeckWorkspaceBatchStatus,
  ReachDeckWorkspaceBatchRegistration,
  ReachDeckWorkspaceBatchView,
  ReachDeckWorkspaceJobMetadata,
} from '@reachany/reach-deck-client';

function parseWorkspaceBatchRegistration(
  value: unknown,
  requireDone: boolean,
): ReachDeckWorkspaceBatchRegistration {
  const batch = requireRecord(value, 'workspace batch response');
  const members = requireArray(batch.members, 'workspace batch members').map(
    (value, index): ReachDeckWorkspaceBatchView['members'][number] => {
      const member = requireRecord(value, `workspace batch member ${index}`);
      if (requireDone && typeof member.done !== 'boolean') {
        throw new Error(`workspace batch member ${index} done must be a boolean`);
      }
      const generationKind = member.generationKind;
      if (
        generationKind !== undefined &&
        generationKind !== 'page-generation' &&
        generationKind !== 'narration-generation'
      )
        throw new Error('workspace batch member generationKind is invalid');
      const affectedLanes =
        member.affectedLanes === undefined
          ? undefined
          : requireArray(member.affectedLanes, 'batch member affectedLanes').map((lane) => {
              if (
                lane !== 'layout' &&
                lane !== 'narration' &&
                lane !== 'audio' &&
                lane !== 'animation'
              )
                throw new Error('batch member lane is invalid');
              return lane;
            });
      return {
        pageId: readRequiredString(member, 'pageId'),
        ...(generationKind === undefined ? {} : { generationKind }),
        ...(affectedLanes === undefined ? {} : { affectedLanes }),
        order: readNonnegativeInteger(member, 'order'),
        status: readRequiredString(member, 'status'),
        ...(member.requestedRevision === undefined
          ? {}
          : { requestedRevision: readNonnegativeInteger(member, 'requestedRevision') }),
        ...(typeof member.done === 'boolean' ? { done: member.done } : {}),
        ...(member.jobId === undefined ? {} : { jobId: readRequiredString(member, 'jobId') }),
        ...(member.reason === undefined ? {} : { reason: readRequiredString(member, 'reason') }),
        ...(member.blockedByPageId === undefined
          ? {}
          : { blockedByPageId: readRequiredString(member, 'blockedByPageId') }),
      };
    },
  );
  if (members.some((member, index) => member.order !== index)) {
    throw new Error('workspace batch member order is invalid');
  }
  const skipped = requireArray(batch.skipped, 'workspace batch skipped pages').map(
    (value, index) => {
      const skipped = requireRecord(value, `workspace batch skipped page ${index}`);
      return {
        pageId: readRequiredString(skipped, 'pageId'),
        order: readNonnegativeInteger(skipped, 'order'),
        reason: readRequiredString(skipped, 'reason'),
      };
    },
  );
  return {
    batchId: readRequiredString(batch, 'batchId'),
    runId: readRequiredString(batch, 'runId'),
    kind: readWorkspaceBatchKind(batch.kind),
    status: readWorkspaceBatchStatus(batch.status),
    revision: readNonnegativeInteger(batch, 'revision'),
    members,
    skipped,
  };
}

function parseWorkspaceJobMetadata(value: unknown): ReachDeckWorkspaceJobMetadata {
  const job = requireRecord(value, 'workspace job response');
  if (
    job.sourceKind !== undefined &&
    ![
      'workspace',
      'workspace-interactive',
      'materialized-native',
      'materialized-interactive',
    ].includes(String(job.sourceKind))
  )
    throw new Error('workspace job sourceKind is invalid');
  if (
    job.affectedLanes !== undefined &&
    (!Array.isArray(job.affectedLanes) ||
      !job.affectedLanes.every((lane) =>
        ['layout', 'narration', 'audio', 'animation'].includes(lane),
      ))
  )
    throw new Error('workspace job affectedLanes is invalid');
  const nativeAudioFailure =
    job.nativeAudioFailure === undefined
      ? undefined
      : parseNativeAudioFailureMetadata(job.nativeAudioFailure);
  return {
    jobId: readRequiredString(job, 'jobId'),
    ...(job.sourceKind === undefined
      ? {}
      : { sourceKind: job.sourceKind as ReachDeckWorkspaceJobMetadata['sourceKind'] }),
    ...(job.affectedLanes === undefined
      ? {}
      : {
          affectedLanes: [...job.affectedLanes] as ReachDeckWorkspaceJobMetadata['affectedLanes'],
        }),
    ...(typeof job.done === 'boolean' ? { done: job.done } : {}),
    kind: readStagedJobKind(job.kind),
    runId: readRequiredString(job, 'runId'),
    status: readRequiredString(job, 'status'),
    pollPath: readRequiredString(job, 'pollPath'),
    eventsPath: readRequiredString(job, 'eventsPath'),
    pollIntervalMs: readNonnegativeInteger(job, 'pollIntervalMs'),
    ...(typeof job.pageId === 'string' ? { pageId: readRequiredString(job, 'pageId') } : {}),
    ...(job.requestedRevision === undefined
      ? {}
      : { requestedRevision: readNonnegativeInteger(job, 'requestedRevision') }),
    ...(job.chainId === undefined ? {} : { chainId: readRequiredString(job, 'chainId') }),
    ...(job.queuedAt === undefined ? {} : { queuedAt: readRequiredTimestamp(job, 'queuedAt') }),
    ...(nativeAudioFailure === undefined ? {} : { nativeAudioFailure }),
  };
}

function parseNativeAudioFailureMetadata(
  value: unknown,
): NonNullable<ReachDeckWorkspaceJobMetadata['nativeAudioFailure']> {
  const failure = requireRecord(value, 'native audio failure');
  const pageId = readRequiredString(failure, 'pageId');
  const requestedRevision = readNonnegativeInteger(failure, 'requestedRevision');
  const markdown = readRequiredString(failure, 'markdown');
  const speechMarkup =
    failure.speechMarkup === undefined
      ? undefined
      : parseReachDeckSpeechMarkupV1(failure.speechMarkup, markdown);
  const audioFailureCode = readRequiredString(failure, 'audioFailureCode');
  return {
    pageId,
    requestedRevision,
    markdown,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    audioFailureCode,
  };
}

function readWorkspaceBatchKind(value: unknown): ReachDeckWorkspaceBatchKind {
  if (value === 'narration' || value === 'media' || value === 'regeneration') return value;
  throw new Error('workspace batch kind is invalid');
}

function readWorkspaceBatchStatus(value: unknown): ReachDeckWorkspaceBatchStatus {
  if (
    value === 'active' ||
    value === 'cancelling' ||
    value === 'completed' ||
    value === 'partial-failure' ||
    value === 'cancelled' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw new Error('workspace batch status is invalid');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = readRecord(value);
  if (record === undefined) throw new Error(`${label} must be an object`);
  return record;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`);
  return value;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const result = readString(value, key);
  if (result === undefined) throw new Error(`${key} is required`);
  return result;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function readNonnegativeInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new Error(key + ' must be a nonnegative integer');
  }
  return candidate as number;
}

function readRequiredTimestamp(value: Record<string, unknown>, key: string): string {
  const timestamp = readRequiredString(value, key);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(key + ' must be an ISO timestamp');
  }
  return timestamp;
}

function readStagedJobKind(value: unknown): ReachDeckStagedGenerationJobKind {
  if (
    value !== 'lesson-plan' &&
    value !== 'page-outline' &&
    value !== 'page-generation' &&
    value !== 'narration-generation'
  ) {
    throw new Error('Reach Deck staged job kind is invalid');
  }
  return value;
}

export { parseWorkspaceBatchRegistration, parseWorkspaceJobMetadata };
