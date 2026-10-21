import { parseGenerationWorkspace, type GenerationWorkspace } from '@reachany/reach-deck-dsl';

import {
  ContentServiceClientError,
  createReachDeckWorkspace as createContentWorkspace,
  getReachDeckWorkspace,
  putReachDeckWorkspace,
  type ContentServiceRequestOptions,
  type ReachDeckWorkspaceResource as ContentWorkspaceResource,
} from './content-service-client.js';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';

export type ReachDeckWorkspaceContext = ContentServiceRequestOptions;

export interface ReachDeckAuthoringWorkspaceResource extends ReachDeckResourceScope {
  draftRevision: number;
  workspace: GenerationWorkspace;
  materializedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReachDeckWorkspaceTransitionResult {
  resource: ReachDeckAuthoringWorkspaceResource;
  applied: boolean;
}

export type ReachDeckWorkspaceTransition = (workspace: GenerationWorkspace) => unknown;

export class ReachDeckWorkspaceRevisionConflictError extends Error {
  readonly status = 409;

  constructor() {
    super('Reach Deck authoring workspace changed since it was loaded');
    this.name = 'ReachDeckWorkspaceRevisionConflictError';
  }
}

export async function loadReachDeckWorkspace(
  context: ReachDeckWorkspaceContext,
): Promise<ReachDeckAuthoringWorkspaceResource> {
  return toWorkspaceResource(await getReachDeckWorkspace(context), context.resourceScope);
}

export async function createReachDeckWorkspace(
  context: ReachDeckWorkspaceContext,
  workspaceValue: unknown,
): Promise<ReachDeckAuthoringWorkspaceResource> {
  const workspace = parseOwnedWorkspace(workspaceValue, context.resourceScope);
  const created = toWorkspaceResource(
    await createContentWorkspace(
      workspace,
      { schemaVersion: 'reach-deck-workspace-recovery/v1', jobs: {}, results: {} },
      context,
    ),
    context.resourceScope,
  );
  if (created.draftRevision !== 0 || created.workspace.documentId !== workspace.documentId) {
    throw new Error('content-service returned an invalid initial workspace revision');
  }
  return created;
}

export async function saveReachDeckWorkspace(
  context: ReachDeckWorkspaceContext,
  workspaceValue: unknown,
  expectedDraftRevision: number,
): Promise<ReachDeckAuthoringWorkspaceResource> {
  return persistReachDeckWorkspace(context, workspaceValue, expectedDraftRevision);
}

export async function transitionReachDeckWorkspace(
  context: ReachDeckWorkspaceContext,
  transition: ReachDeckWorkspaceTransition,
  options: { maxConflicts?: number } = {},
): Promise<ReachDeckWorkspaceTransitionResult> {
  const maxConflicts = options.maxConflicts ?? 3;
  assertNonnegativeInteger(maxConflicts, 'maxConflicts');
  let current = await loadReachDeckWorkspace(context);
  let conflicts = 0;
  while (true) {
    const input = immutableTransitionInput(current.workspace);
    const candidate = transition(input);
    const next = parseOwnedWorkspace(candidate, context.resourceScope);
    if (candidate === input) return { resource: current, applied: false };
    try {
      return {
        resource: await saveReachDeckWorkspace(context, next, current.draftRevision),
        applied: true,
      };
    } catch (error) {
      if (
        !(error instanceof ReachDeckWorkspaceRevisionConflictError) ||
        conflicts >= maxConflicts
      ) {
        throw error;
      }
      conflicts += 1;
      current = await loadReachDeckWorkspace(context);
    }
  }
}

export async function transitionReachDeckWorkspaceAtRevision(
  context: ReachDeckWorkspaceContext,
  expectedDraftRevision: number,
  transition: ReachDeckWorkspaceTransition,
): Promise<ReachDeckWorkspaceTransitionResult> {
  assertNonnegativeInteger(expectedDraftRevision, 'expectedDraftRevision');
  const current = await loadReachDeckWorkspace(context);
  if (current.draftRevision !== expectedDraftRevision) {
    throw new ReachDeckWorkspaceRevisionConflictError();
  }
  const input = immutableTransitionInput(current.workspace);
  const candidate = transition(input);
  const next = parseOwnedWorkspace(candidate, context.resourceScope);
  if (candidate === input) return { resource: current, applied: false };
  return {
    resource: await saveReachDeckWorkspace(context, next, expectedDraftRevision),
    applied: true,
  };
}

/**
 * The teacher-visible identity of one page: its run, request attempt and state. Any other page
 * landing, a narration writing back or a batch advancing bumps the shared draft revision without
 * touching this identity, so page-scoped actions compare it instead of the whole-deck revision.
 */
export function reachDeckPageRevisionIdentity(
  workspace: GenerationWorkspace,
  pageId: string,
): string {
  const request = workspace.records[pageId]?.request;
  const status = workspace.statuses[pageId];
  return JSON.stringify([
    workspace.runId,
    workspace.stage,
    workspace.paused,
    request?.attempt,
    request?.requestedRevision,
    status?.state,
    status?.attempt,
  ]);
}

/**
 * Page-scoped CAS. Other pages landing, narration writing back or a batch advancing bump the
 * shared draft revision without touching this page, so a caller that names the page attempt it
 * acted on (`expectedPageAttempt`) need not hold the current revision: the transition is rebased on
 * the latest workspace and saved with the ordinary conflict retry, and rejected once the page moved
 * to another attempt or changed between this request's first read and the save.
 * Without `expectedPageAttempt` (older clients, commands persisted before the field existed) nothing
 * says which page version the caller saw, so the whole-deck revision must still be current. Callers
 * recover their own landed replay from the conflict by requestKey, as with any CAS conflict.
 * The transition owns the page's own preconditions (for example "the page is ready or failed").
 */
export async function transitionReachDeckWorkspaceForPage(
  context: ReachDeckWorkspaceContext,
  expectedDraftRevision: number,
  pageId: string,
  transition: ReachDeckWorkspaceTransition,
  expectedPageAttempt?: number,
): Promise<ReachDeckWorkspaceTransitionResult> {
  if (expectedPageAttempt === undefined)
    return transitionReachDeckWorkspaceAtRevision(context, expectedDraftRevision, transition);
  assertNonnegativeInteger(expectedDraftRevision, 'expectedDraftRevision');
  const current = await loadReachDeckWorkspace(context);
  if (current.draftRevision < expectedDraftRevision)
    throw new ReachDeckWorkspaceRevisionConflictError();
  const pageIdentity = reachDeckPageRevisionIdentity(current.workspace, pageId);
  return transitionReachDeckWorkspace(context, (workspace) => {
    if (
      reachDeckPageRevisionIdentity(workspace, pageId) !== pageIdentity ||
      workspace.records[pageId]?.request?.attempt !== expectedPageAttempt
    )
      throw new ReachDeckWorkspaceRevisionConflictError();
    return transition(workspace);
  });
}

async function persistReachDeckWorkspace(
  context: ReachDeckWorkspaceContext,
  workspaceValue: unknown,
  expectedDraftRevision: number,
): Promise<ReachDeckAuthoringWorkspaceResource> {
  assertNonnegativeInteger(expectedDraftRevision, 'expectedDraftRevision');
  const workspace = parseOwnedWorkspace(workspaceValue, context.resourceScope);
  try {
    const saved = toWorkspaceResource(
      await putReachDeckWorkspace(workspace, expectedDraftRevision, context),
      context.resourceScope,
    );
    if (saved.draftRevision !== expectedDraftRevision + 1) {
      throw new Error('content-service returned a non-contiguous workspace draft revision');
    }
    return saved;
  } catch (error) {
    if (error instanceof ContentServiceClientError && error.status === 409) {
      throw new ReachDeckWorkspaceRevisionConflictError();
    }
    throw error;
  }
}

export function toWorkspaceResource(
  resource: ContentWorkspaceResource,
  expectedScopeValue: ReachDeckResourceScope,
): ReachDeckAuthoringWorkspaceResource {
  const expectedScope = parseReachDeckResourceScope(expectedScopeValue);
  if (!sameReachDeckResourceScope(resource, expectedScope)) {
    throw new Error('content-service returned the wrong Reach Deck workspace identity');
  }
  return {
    ...expectedScope,
    draftRevision: resource.draftRevision,
    workspace: parseOwnedWorkspace(resource.workspace, expectedScope),
    materializedAt: resource.materializedAt,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function parseOwnedWorkspace(
  value: unknown,
  scopeValue: ReachDeckResourceScope,
): GenerationWorkspace {
  const scope = parseReachDeckResourceScope(scopeValue);
  const workspace = parseGenerationWorkspace(stripPersistedNulCharacters(value));
  if (workspace.documentId !== scope.moduleVersionId) {
    throw new Error('Reach Deck workspace documentId must match moduleVersionId');
  }
  return workspace;
}

const NUL = String.fromCharCode(0);

/**
 * 新的模型输出在解析时就会因 U+0000 被要求纠正（structured-text-safety），但在那之前落库的
 * 大纲仍可能带着它。Postgres jsonb 拒收 U+0000：互动页的冻结 run input 写库失败，整条生成链
 * 停在该页。工作区的读写边界都经过这里，存量数据下次写回时即被修复；NUL 本身不可见，
 * 去掉不改变任何教学文字。
 */
function stripPersistedNulCharacters(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(NUL, '');
  if (Array.isArray(value)) return value.map(stripPersistedNulCharacters);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll(NUL, ''),
        stripPersistedNulCharacters(entry),
      ]),
    );
  }
  return value;
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(label + ' must be a nonnegative integer');
  }
}

function immutableTransitionInput(workspace: GenerationWorkspace): GenerationWorkspace {
  return deepFreeze(structuredClone(workspace));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
