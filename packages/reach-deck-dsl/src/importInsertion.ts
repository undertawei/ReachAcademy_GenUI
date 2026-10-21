import {
  assertReachDeckDocumentTransition,
  parseReachDeckDocument,
  parseReachDeckDocumentV2,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
  type ReachDeckImportApplicationV2,
  type ReachDeckInsertedResourceIdsV2,
  type ReachDeckPublishedPage,
  type ReachDeckResourcesV2,
} from './document.js';

export interface ReachDeckImportApplicationIdentityV2 {
  applicationId: string;
  requestFingerprint: string;
  sourceDigest: string;
  candidateDigest: string;
  profileDigest: string;
  mediaDigest: string;
}

export type ReachDeckImportInsertionTarget =
  | {
      /** Stable identity captured from a page-adjacent insertion position. */
      mode?: 'insert-after';
      afterPageId: string;
    }
  | {
      /** Explicitly insert above page one; this mode intentionally has no fabricated anchor. */
      mode: 'before-first';
      afterPageId?: never;
    };

export type InsertReachDeckImportedPagesOptions = ReachDeckImportApplicationIdentityV2 &
  ReachDeckImportInsertionTarget;

export type InsertReachDeckImportedPagesResult =
  | {
      status: 'applied';
      document: ReachDeckDocumentV2;
      application: ReachDeckImportApplicationV2;
    }
  | {
      status: 'already-applied';
      document: ReachDeckDocumentV2;
      application: ReachDeckImportApplicationV2;
    };

export class ReachDeckImportApplicationConflictError extends Error {
  constructor(readonly applicationId: string) {
    super(`Reach Deck import application ${applicationId} conflicts with its durable request.`);
    this.name = 'ReachDeckImportApplicationConflictError';
  }
}

/**
 * Strictly insert a mapper-produced external-import document into an existing Reach Deck.
 *
 * This helper is deliberately narrower than a general document merge: every imported page must
 * be a new revision-one native slide, an insert-after anchor must still exist, and both documents
 * must use the same stage. The explicit before-first mode has no anchor. Resource ids may be reused
 * only when their complete values are identical. A durable import application marker makes a
 * lost-response retry an unchanged `already-applied` result.
 */
export function insertReachDeckImportedPages(
  targetValue: unknown,
  importedValue: unknown,
  options: InsertReachDeckImportedPagesOptions,
): InsertReachDeckImportedPagesResult {
  assertApplicationIdentity(options);
  const target = parseReachDeckDocument(targetValue);
  const existingApplication = target.importApplications?.find(
    (application) => application.applicationId === options.applicationId,
  );
  if (existingApplication !== undefined) {
    assertExactRetry(existingApplication, options);
    return {
      status: 'already-applied',
      document: target,
      application: existingApplication,
    };
  }

  const imported = parseReachDeckDocumentV2(importedValue);
  if (imported.provenance?.source !== 'pptx' && imported.provenance?.source !== 'maic') {
    throw new Error('Reach Deck imported pages must come from a supported import document.');
  }
  if (imported.provenance.sourceDigest !== options.sourceDigest) {
    throw new Error('Reach Deck insertion source digest does not match the imported document.');
  }
  if (options.mode !== 'before-first' && options.afterPageId.trim().length === 0) {
    throw new Error('Reach Deck insert-after mode requires a non-empty anchor pageId.');
  }
  assertMatchingStage(target, imported);

  const targetPages = sortedPages(target.pages);
  const anchorIndex =
    options.mode === 'before-first'
      ? -1
      : targetPages.findIndex((page) => page.pageId === options.afterPageId);
  if (options.mode !== 'before-first' && anchorIndex < 0) {
    throw new Error(`Reach Deck insertion anchor ${options.afterPageId} no longer exists.`);
  }

  const importedPages = sortedPages(imported.pages);
  if (importedPages.some((page) => page.revision !== 1)) {
    throw new Error('Reach Deck imported pages must start at revision 1.');
  }
  const importedBindingsByPage = new Map<string, number>();
  for (const binding of imported.nativeSlides) {
    importedBindingsByPage.set(
      binding.pageId,
      (importedBindingsByPage.get(binding.pageId) ?? 0) + 1,
    );
  }
  for (const page of importedPages) {
    const count = importedBindingsByPage.get(page.pageId) ?? 0;
    if (page.sceneType === 'slide' && count !== 1) {
      throw new Error(
        `Imported slide page ${page.pageId} must have exactly one native slide binding.`,
      );
    }
    if (page.sceneType !== 'slide' && count !== 0) {
      throw new Error(`Imported non-slide page ${page.pageId} cannot have a native slide binding.`);
    }
  }

  assertNoIdentityCollisions(target, imported);
  const mergedResources = mergeResources(target.resources, imported.resources);
  const pages = [...targetPages];
  pages.splice(anchorIndex + 1, 0, ...importedPages);
  const normalizedPages = pages.map(
    (page, index) => ({ ...page, order: index + 1 }) as ReachDeckPublishedPage,
  );
  const bindingsByPageId = new Map(
    [...target.nativeSlides, ...imported.nativeSlides].map((binding) => [binding.pageId, binding]),
  );
  const application: ReachDeckImportApplicationV2 = {
    applicationId: options.applicationId,
    requestFingerprint: options.requestFingerprint,
    sourceDigest: options.sourceDigest,
    candidateDigest: options.candidateDigest,
    profileDigest: options.profileDigest,
    mediaDigest: options.mediaDigest,
    mode: options.mode ?? 'insert-after',
    ...(options.mode === 'before-first' ? {} : { anchorPageId: options.afterPageId }),
    insertedPageIds: importedPages.map((page) => page.pageId),
    insertedResourceIds: mergedResources.insertedIds,
  };

  const document = parseReachDeckDocumentV2({
    ...target,
    resources: mergedResources.resources,
    pages: normalizedPages,
    nativeSlides: normalizedPages.flatMap((page) => {
      const binding = bindingsByPageId.get(page.pageId);
      return binding === undefined ? [] : [binding];
    }),
    importApplications: [...(target.importApplications ?? []), application],
  });
  assertReachDeckDocumentTransition(target, document);
  return { status: 'applied', document, application };
}

function assertApplicationIdentity(identity: ReachDeckImportApplicationIdentityV2): void {
  if (identity.applicationId.trim().length === 0) {
    throw new Error('Reach Deck import applicationId must be non-empty.');
  }
  for (const [field, digest] of Object.entries({
    requestFingerprint: identity.requestFingerprint,
    sourceDigest: identity.sourceDigest,
    candidateDigest: identity.candidateDigest,
    profileDigest: identity.profileDigest,
    mediaDigest: identity.mediaDigest,
  })) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Reach Deck import ${field} must be a lowercase sha256 digest.`);
    }
  }
}

function assertExactRetry(
  application: ReachDeckImportApplicationV2,
  options: InsertReachDeckImportedPagesOptions,
): void {
  const expected = {
    applicationId: options.applicationId,
    requestFingerprint: options.requestFingerprint,
    sourceDigest: options.sourceDigest,
    candidateDigest: options.candidateDigest,
    profileDigest: options.profileDigest,
    mediaDigest: options.mediaDigest,
    mode: options.mode ?? 'insert-after',
    ...(options.mode === 'before-first' ? {} : { anchorPageId: options.afterPageId }),
  };
  const actual = {
    applicationId: application.applicationId,
    requestFingerprint: application.requestFingerprint,
    sourceDigest: application.sourceDigest,
    candidateDigest: application.candidateDigest,
    profileDigest: application.profileDigest,
    mediaDigest: application.mediaDigest,
    mode: application.mode,
    ...(application.anchorPageId === undefined ? {} : { anchorPageId: application.anchorPageId }),
  };
  if (!valuesEqual(actual, expected)) {
    throw new ReachDeckImportApplicationConflictError(options.applicationId);
  }
}

function assertMatchingStage(target: ReachDeckDocumentV2, imported: ReachDeckDocumentV2): void {
  if (
    target.stage.width !== imported.stage.width ||
    target.stage.height !== imported.stage.height ||
    target.stage.aspectRatio !== imported.stage.aspectRatio
  ) {
    throw new Error(
      `Reach Deck insertion stage mismatch: target is ${target.stage.width}x${target.stage.height} (${target.stage.aspectRatio}), imported presentation is ${imported.stage.width}x${imported.stage.height} (${imported.stage.aspectRatio}).`,
    );
  }
}

function assertNoIdentityCollisions(
  target: ReachDeckDocumentV2,
  imported: ReachDeckDocumentV2,
): void {
  assertDisjoint(
    target.pages.map((page) => page.pageId),
    imported.pages.map((page) => page.pageId),
    'page id',
  );
  assertDisjoint(
    target.pages.flatMap((page) =>
      'scene' in page && page.scene !== undefined ? [page.scene.id] : [],
    ),
    imported.pages.flatMap((page) =>
      'scene' in page && page.scene !== undefined ? [page.scene.id] : [],
    ),
    'scene id',
  );
  assertDisjoint(
    target.nativeSlides.map((binding) => binding.slide.id),
    imported.nativeSlides.map((binding) => binding.slide.id),
    'native slide id',
  );
}

function assertDisjoint(current: string[], incoming: string[], label: string): void {
  const reserved = new Set(current);
  const collision = incoming.find((value) => reserved.has(value));
  if (collision !== undefined) {
    throw new Error(
      `Reach Deck insertion ${label} collision for ${collision}; imported identities must be namespaced for this apply operation.`,
    );
  }
}

function mergeResources(
  target: ReachDeckResourcesV2,
  imported: ReachDeckResourcesV2,
): { resources: ReachDeckResourcesV2; insertedIds: ReachDeckInsertedResourceIdsV2 } {
  const themes = mergeResourceArray(target.themes, imported.themes, 'theme');
  const masters = mergeResourceArray(target.masters, imported.masters, 'master');
  const layouts = mergeResourceArray(target.layouts, imported.layouts, 'layout');
  const media = mergeResourceArray(target.media, imported.media, 'media');
  return {
    resources: {
      themes: themes.resources,
      masters: masters.resources,
      layouts: layouts.resources,
      media: media.resources,
    },
    insertedIds: {
      themeIds: themes.insertedIds,
      masterIds: masters.insertedIds,
      layoutIds: layouts.insertedIds,
      mediaIds: media.insertedIds,
    },
  };
}

function mergeResourceArray<T extends { id: string }>(
  target: T[],
  imported: T[],
  kind: string,
): { resources: T[]; insertedIds: string[] } {
  const merged = [...target];
  const insertedIds: string[] = [];
  const byId = new Map(target.map((resource) => [resource.id, resource]));
  for (const resource of imported) {
    const current = byId.get(resource.id);
    if (current === undefined) {
      merged.push(resource);
      insertedIds.push(resource.id);
      byId.set(resource.id, resource);
      continue;
    }
    if (!valuesEqual(current, resource)) {
      throw new Error(
        `Reach Deck insertion ${kind} resource ${resource.id} conflicts with the existing document.`,
      );
    }
  }
  return { resources: merged, insertedIds };
}

function sortedPages(pages: ReachDeckPublishedPage[]): ReachDeckPublishedPage[] {
  return [...pages].sort((left, right) => left.order - right.order);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/** Explicit name for callers that already deal in the Reach Deck document union. */
export type ReachDeckImportTargetDocument = ReachDeckDocument;
