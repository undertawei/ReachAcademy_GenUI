import { createHash } from 'node:crypto';

import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';
import type { loadReachDeckMaterializedWorkspaceDocument } from './workspace-jobs.js';

type CurrentDocument = Awaited<ReturnType<typeof loadReachDeckMaterializedWorkspaceDocument>>;
export function withoutReachDeckImportBytes<T extends { bytes: Uint8Array }>(
  upload: T,
): Omit<T, 'bytes'> {
  const { bytes: _bytes, ...input } = upload;
  return input;
}
const shared = globalThis as typeof globalThis & {
  __reachanyReachDeckImportPreparation?: Map<string, Promise<void>>;
};

/** Preparation never holds the writer gate or a PostgreSQL connection. */
export async function withReachDeckImportPreparation<T>(
  scopeValue: ReachDeckResourceScope,
  operation: () => Promise<T>,
): Promise<T> {
  const scope = parseReachDeckResourceScope(scopeValue);
  const key = JSON.stringify([
    'reach-deck-import-preparation/v1',
    scope.organizationId,
    scope.courseId,
    scope.courseNodeId,
    scope.moduleId,
    scope.moduleVersionId,
  ]);
  const queues = (shared.__reachanyReachDeckImportPreparation ??= new Map());
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, turn);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === turn) queues.delete(key);
  }
}

/** The same extraction is used for preparation and the authoritative locked read. */
export function reachDeckImportMappingInputs(
  current: CurrentDocument,
  identity: {
    kind: 'pptx' | 'maic';
    mode: 'create' | 'insert-after' | 'before-first';
    applicationId: string;
    documentId: string;
    generatedAt: string;
    fallbackTitle: string;
    fallbackLanguage: string;
  },
) {
  const document = current.materialized ? current.document : undefined;
  return {
    materialized: current.materialized,
    documentPresent: document !== undefined,
    applicationId: identity.applicationId,
    documentId: identity.documentId,
    generatedAt: identity.generatedAt,
    title: document?.title ?? identity.fallbackTitle,
    language:
      document?.schemaVersion === 'reach-deck-document/v2'
        ? document.metadata.language
        : identity.fallbackLanguage,
    compatibilityTheme: document?.theme ?? null,
    documentStage: document?.stage ?? null,
    targetStage:
      identity.kind === 'pptx' && identity.mode !== 'create' ? (document?.stage ?? null) : null,
  };
}

export function reachDeckImportPreparationDigest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const object = item as Record<string, unknown>;
          return Object.fromEntries(
            Object.keys(object)
              .sort()
              .map((key) => [key, object[key]]),
          );
        }
        return item;
      }),
    )
    .digest('hex');
}
