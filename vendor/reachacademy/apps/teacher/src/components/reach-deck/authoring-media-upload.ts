import type { ReachDeckModuleContext } from '@reachany/reach-deck-client';
import type { ReachDeckAuthoringMediaKind } from '@reachany/reach-deck-editor';

interface AuthoringMediaFinalizeResponse {
  assetId: string;
  kind: ReachDeckAuthoringMediaKind;
  objectKey: string;
  downloadUrl: string;
  contentType: string;
  name?: string;
  sizeBytes?: number;
}

export async function uploadReachDeckAuthoringMedia(input: {
  context: ReachDeckModuleContext;
  file: File;
  kind: ReachDeckAuthoringMediaKind;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{
  objectKey: string;
  contentType: string;
  digest: string;
  downloadUrl: string;
  assetId: string;
  name?: string;
  sizeBytes?: number;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const path = buildReachDeckAuthoringMediaPath(input.context);
  const session = await fetchImpl(path, { cache: 'no-store', method: 'GET', signal: input.signal });
  if (!session.ok) throw uploadError('session', session.status);
  const response = await fetchImpl(path, {
    body: input.file,
    headers: {
      'content-type': input.file.type,
      'x-reach-deck-file-name': encodeURIComponent(input.file.name),
      'x-reach-deck-file-size': String(input.file.size),
      'x-reach-deck-media-kind': input.kind,
    },
    method: 'POST',
    signal: input.signal,
  });
  if (!response.ok) throw uploadError('upload', response.status);
  return uploadedMedia(parseFinalized(await response.json()), input.kind);
}

function uploadedMedia(
  finalized: AuthoringMediaFinalizeResponse,
  kind: ReachDeckAuthoringMediaKind,
) {
  if (finalized.kind !== kind) {
    throw new Error('Reach Deck authoring media kind did not match the upload.');
  }
  return {
    objectKey: finalized.objectKey,
    contentType: finalized.contentType,
    digest: `objectkey:${finalized.objectKey}`,
    downloadUrl: finalized.downloadUrl,
    assetId: finalized.assetId,
    ...(finalized.name ? { name: finalized.name } : {}),
    ...(finalized.sizeBytes !== undefined ? { sizeBytes: finalized.sizeBytes } : {}),
  };
}

export function buildReachDeckAuthoringMediaPath(context: ReachDeckModuleContext): string {
  const query = new URLSearchParams({
    organizationId: context.organizationId,
    courseId: context.courseId,
    courseWorkspaceType: context.courseWorkspaceType,
    courseNodeId: context.courseNodeId,
    moduleId: context.moduleId,
    moduleVersionId: context.moduleVersionId,
  });
  return `/api/reach-deck/tools/authoring-media/upload?${query}`;
}

function parseFinalized(value: unknown): AuthoringMediaFinalizeResponse {
  const record = requireRecord(value, 'finalize');
  const kind = record.kind;
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'attachment') {
    throw new Error('Reach Deck authoring media kind was invalid.');
  }
  return {
    assetId: requireString(record.assetId, 'assetId'),
    kind,
    objectKey: requireString(record.objectKey, 'objectKey'),
    downloadUrl: requireString(record.downloadUrl, 'downloadUrl'),
    contentType: requireString(record.contentType, 'contentType'),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Reach Deck authoring media ${label} response was invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Reach Deck authoring media response ${label} was invalid.`);
  }
  return value;
}

function uploadError(stage: string, status: number): Error {
  return new Error(`Reach Deck authoring media ${stage} failed with HTTP ${status}.`);
}
