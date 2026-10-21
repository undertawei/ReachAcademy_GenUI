import { createHash, randomUUID } from 'node:crypto';

import { parseReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';

import { getReachDeckMaterializedDocument } from '../content-service-client.js';
import { loadReachDeckWorkspace } from '../workspace-store.js';
import {
  actorOrganizationIdFromPayload,
  parseReachDeckDecksmithOutcome,
  type ReachDeckDecksmithOutcome,
} from '../contracts.js';
import {
  ReachDeckPageLockedError,
  type AuthorizedWorkspaceRouteContext,
} from '../workspace-route.js';
import { buildDecksmithDocumentHash } from '../job-identity.js';
import { getRuntimeStore } from '../../store/index.js';
import {
  DECKSMITH_CONTROL_LEASE_PREFIX,
  DecksmithDeckLeaseConflictError,
  DecksmithDeckWriterConflictError,
  DecksmithPageStreamService,
  type DecksmithApprovedAdoption,
  type DecksmithPageHistoryPage,
  type DecksmithPageStreamRecord,
  type DecksmithPageStreamOwnerScope,
} from './page-stream.js';
import {
  parseDecksmithCapacityApplicationMessage,
  parseDecksmithFrozenRunInput,
  parseDecksmithPageControlBoundary,
  type DecksmithContextRef,
  type DecksmithPageStreamPosition,
} from './page-stream-contracts.js';
import { DecksmithContextValidationError } from './execution-context.js';
import { validateDecksmithAdoptionTransition } from './adoption.js';
import { boundDecksmithAssistantText } from './turn-memory.js';
import { reconcileReachDeckOrphanedDecksmithLease } from '../workspace-recovery.js';
import {
  reconcileReachDeckStructuralMutationCleanup,
  reconcileReachDeckAsyncWriterLease,
  withReachDeckAdoptionDocumentWriterLease,
  withReachDeckOrdinaryDocumentWriterLease,
  type ReachDeckDocumentWriterContext,
  type ReachDeckDocumentWriterSession,
} from './document-writer.js';

export type PublicDecksmithContextRef =
  | Readonly<{
      schemaVersion: 'reach-deck-decksmith-context-ref/v1';
      kind: 'page';
      pageId: string;
      label: string;
      order: number;
      revision: number;
    }>
  | Readonly<{
      schemaVersion: 'reach-deck-decksmith-context-ref/v1';
      kind: 'native-element' | 'interactive-component';
      pageId: string;
      pageLabel: string;
      pageOrder: number;
      pageRevision: number;
      sceneId: string;
      sceneType: 'slide' | 'interactive';
      componentId: string;
      componentType: string;
      display: Readonly<{ label: string; detail?: string }>;
    }>;

export interface PublicDecksmithPageHistoryResponse {
  readonly stream: Readonly<{
    threadId: string;
    domainScope: Readonly<{ pageId: string }>;
    context: Readonly<{
      streamSequence: number;
      contextRevision: number;
      currentEpoch: Readonly<{ epoch: number }>;
    }>;
  }>;
  readonly history: Readonly<{
    items: readonly PublicDecksmithPageHistoryItem[];
    nextCursor?: Readonly<{ queuedAt: string; runId: string }>;
  }>;
}

export interface PublicDecksmithPageHistoryItem {
  readonly runId: string;
  readonly status: string;
  readonly queuedAt: string;
  readonly input:
    | Readonly<{
        kind: 'decksmith-turn';
        message: string;
        stream: DecksmithPageStreamPosition;
        contextRefs: readonly PublicDecksmithContextRef[];
      }>
    | Readonly<{
        kind: 'decksmith-control';
        control: Extract<
          ReturnType<typeof parseDecksmithPageControlBoundary>,
          { readonly kind: 'new-topic' }
        >;
      }>;
  readonly events: readonly Readonly<{
    type: 'decksmith.result' | 'decksmith.application-message';
    payload: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>[];
}

export function projectPublicDecksmithPageHistory(input: {
  readonly stream: DecksmithPageStreamRecord;
  readonly history: DecksmithPageHistoryPage;
}): PublicDecksmithPageHistoryResponse {
  const items = input.history.items.map(projectPublicHistoryItem);
  return Object.freeze({
    stream: Object.freeze({
      threadId: input.stream.threadId,
      domainScope: Object.freeze({ pageId: input.stream.domainScope.pageId }),
      context: Object.freeze({
        streamSequence: input.stream.context.streamSequence,
        contextRevision: input.stream.context.contextRevision,
        currentEpoch: Object.freeze({ epoch: input.stream.context.currentEpoch.epoch }),
      }),
    }),
    history: Object.freeze({
      items: Object.freeze(items),
      ...(input.history.nextCursor === undefined
        ? {}
        : { nextCursor: Object.freeze({ ...input.history.nextCursor }) }),
    }),
  });
}

function projectPublicHistoryItem(
  item: DecksmithPageHistoryPage['items'][number],
): PublicDecksmithPageHistoryItem {
  let publicInput: PublicDecksmithPageHistoryItem['input'];
  if (item.input.kind === 'decksmith-turn') {
    const frozen = parseDecksmithFrozenRunInput(item.input);
    publicInput = Object.freeze({
      kind: 'decksmith-turn',
      message: frozen.message,
      stream: Object.freeze({ ...frozen.stream }),
      contextRefs: Object.freeze(frozen.contextRefs.map(projectPublicContextRef)),
    });
  } else if (item.input.kind === 'decksmith-control') {
    const control = parseDecksmithPageControlBoundary(item.input.control);
    if (control.kind !== 'new-topic') {
      throw new Error('Soft-deleted Decksmith controls must not be visible in public history');
    }
    publicInput = Object.freeze({ kind: 'decksmith-control', control });
  } else {
    throw new Error('Decksmith public history contains an unsupported Run input');
  }
  return Object.freeze({
    runId: item.runId,
    status: item.status,
    queuedAt: item.queuedAt,
    input: publicInput,
    events: Object.freeze(item.events.flatMap(projectPublicHistoryEvent)),
  });
}

function projectPublicContextRef(ref: DecksmithContextRef): PublicDecksmithContextRef {
  if (ref.kind === 'page') {
    return Object.freeze({
      schemaVersion: ref.schemaVersion,
      kind: ref.kind,
      pageId: ref.pageId,
      label: ref.label,
      order: ref.order,
      revision: ref.revision,
    });
  }
  return Object.freeze({
    schemaVersion: ref.schemaVersion,
    kind: ref.kind,
    pageId: ref.pageId,
    pageLabel: ref.pageLabel,
    pageOrder: ref.pageOrder,
    pageRevision: ref.pageRevision,
    sceneId: ref.sceneId,
    sceneType: ref.sceneType,
    componentId: ref.componentId,
    componentType: ref.componentType,
    display: Object.freeze({ ...ref.display }),
  });
}

function projectPublicHistoryEvent(
  event: DecksmithPageHistoryPage['items'][number]['events'][number],
): readonly PublicDecksmithPageHistoryItem['events'][number][] {
  if (event.type === 'decksmith.result') {
    if (typeof event.payload.message !== 'string') return [];
    const changed = typeof event.payload.changed === 'boolean' ? event.payload.changed : undefined;
    const outcome = publicDecksmithOutcome(event.payload.outcome, changed);
    return [
      Object.freeze({
        type: 'decksmith.result' as const,
        payload: Object.freeze({
          message: event.payload.message.slice(0, 100_000),
          // 跨轮记忆（WP1）：模型实际答复；旧事件没有此字段时不输出。
          ...(typeof event.payload.assistantText === 'string'
            ? { assistantText: boundDecksmithAssistantText(event.payload.assistantText) }
            : {}),
          ...(changed === undefined ? {} : { changed }),
          ...(outcome === undefined ? {} : { outcome }),
        }),
        createdAt: event.createdAt,
      }),
    ];
  }
  if (event.type === 'decksmith.application-message') {
    try {
      const message = parseDecksmithCapacityApplicationMessage(event.payload);
      return [
        Object.freeze({
          type: 'decksmith.application-message' as const,
          payload: Object.freeze({ ...message }),
          createdAt: event.createdAt,
        }),
      ];
    } catch {
      return [];
    }
  }
  return [];
}

function publicDecksmithOutcome(
  value: unknown,
  changed: boolean | undefined,
): ReachDeckDecksmithOutcome | undefined {
  if (value !== undefined) {
    try {
      return parseReachDeckDecksmithOutcome(value);
    } catch {
      // A malformed or future outcome must not expose server-owned fallback copy.
    }
  }
  if (changed === undefined) return undefined;
  return {
    schemaVersion: 'reach-deck-decksmith-outcome/v1',
    mutationStatus: changed ? 'proposal' : 'none',
    rejectedFontFamilies: [],
    toolErrorCount: 0,
  };
}

export async function authorizedDecksmithPage(input: {
  readonly scoped: AuthorizedWorkspaceRouteContext;
  readonly pageId: string;
}) {
  const materialized = await getReachDeckMaterializedDocument(input.scoped.workspaceContext);
  if (materialized.materialized !== true || materialized.learnerDocument === undefined) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_ORIGIN_PAGE_STALE',
      'Decksmith authoritative baseline is unavailable',
    );
  }
  const document = parseReachDeckDocument(materialized.learnerDocument);
  if (
    document.schemaVersion !== 'reach-deck-document/v2' ||
    !document.pages.some((page) => page.pageId === input.pageId)
  ) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_ORIGIN_PAGE_STALE',
      'Decksmith page is stale or deleted',
    );
  }
  const scope: DecksmithPageStreamOwnerScope = {
    actor: {
      subject: input.scoped.actorId,
      orgId: actorOrganizationIdFromPayload(input.scoped),
      roles: ['teacher'],
      ...(input.scoped.billingGroupId === null
        ? {}
        : { billingGroupId: input.scoped.billingGroupId }),
    },
    resourceScope: input.scoped.resourceScope,
    pageId: input.pageId,
  };
  const store = getRuntimeStore();
  await reconcileReachDeckAsyncWriterLease(input.scoped.workspaceContext);
  await reconcileReachDeckOrphanedDecksmithLease(input.scoped.workspaceContext);
  const service = new DecksmithPageStreamService(store);
  const stream = await service.pageStream(scope);
  return { store, service, scope, stream };
}

export async function withDecksmithControlLease<T>(input: {
  readonly threadId: string;
  readonly scope: DecksmithPageStreamOwnerScope;
  readonly operationKind: 'new-topic' | 'soft-delete';
  readonly idempotencyKey: string;
  readonly operation: (ownerRunId: string, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const store = getRuntimeStore();
  const ownerRunId = randomUUID();
  const acquired = await store.acquireDecksmithDeckLease({
    threadId: input.threadId,
    scope: input.scope,
    ownerRunId,
    ownerRequestKey: `${DECKSMITH_CONTROL_LEASE_PREFIX}${createHash('sha256')
      .update(
        JSON.stringify({
          operationKind: input.operationKind,
          pageId: input.scope.pageId,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .digest('hex')}`,
  });
  if (!acquired.acquired) {
    // A same-key request may observe the first request's provisional lease before its control
    // record commits. It must never execute under that other owner. Once the first lease releases,
    // a retry acquires its own lease and the store-level control idempotency returns the committed
    // result (or performs the operation exactly once if the first request failed before commit).
    throw new DecksmithDeckLeaseConflictError(acquired.lease);
  }
  const controller = new AbortController();
  let renewing = false;
  const renew = async () => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    try {
      if (!(await store.renewDecksmithDeckLease(ownerRunId))) {
        controller.abort(new DecksmithDeckLeaseConflictError(acquired.lease));
      }
    } catch (error) {
      controller.abort(error);
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => void renew(), 10_000);
  timer.unref?.();
  try {
    controller.signal.throwIfAborted();
    const result = await input.operation(ownerRunId, controller.signal);
    controller.signal.throwIfAborted();
    if (!(await store.ownsActiveDecksmithDeckLease(ownerRunId))) {
      throw new DecksmithDeckLeaseConflictError(acquired.lease);
    }
    return result;
  } finally {
    clearInterval(timer);
    await store.releaseDecksmithDeckLease(ownerRunId);
  }
}

export async function withReachDeckDocumentWriterLease<T>(input: {
  readonly scoped: AuthorizedWorkspaceRouteContext;
  readonly pageId?: string;
  readonly operationKind: 'page-save' | 'rematerialize';
  readonly asyncRunId?: string;
  readonly operation: (context: {
    readonly signal: AbortSignal;
    readonly approvedAdoption: DecksmithApprovedAdoption | null;
    readonly approvedAdoptions: readonly DecksmithApprovedAdoption[];
    readonly writerContext: ReachDeckDocumentWriterContext;
    readonly asyncRunId?: string;
  }) => Promise<T>;
}): Promise<T> {
  const asyncRunId =
    input.asyncRunId ??
    (input.operationKind === 'page-save'
      ? (await loadReachDeckWorkspace(input.scoped.workspaceContext)).workspace.runId
      : undefined);
  return withReachDeckAdoptionDocumentWriterLease({
    context: input.scoped.workspaceContext,
    pageId: input.pageId,
    operationKind: input.operationKind,
    ...(asyncRunId === undefined ? {} : { asyncRunId }),
    // Teacher saves proceed beside an unresolved Decksmith turn; structure stays guarded by the
    // routes (page saves cannot change it, rematerialize checks it explicitly).
    coexistWithDecksmithTurn: true,
    operation: async ({ context, approvedAdoption, approvedAdoptions }) =>
      input.operation({
        signal: context.signal!,
        approvedAdoption,
        approvedAdoptions,
        writerContext: context,
        asyncRunId,
      }),
  });
}

/** Route/workflow-start fence. Ordinary writers can never consume an approved adoption lease. */
export async function withReachDeckOrdinaryWriterLease<T>(input: {
  readonly scoped: AuthorizedWorkspaceRouteContext;
  readonly pageId?: string;
  readonly operationKind: string;
  readonly asyncRunId?: string;
  readonly workspaceMayBeAbsent?: boolean;
  readonly operation: (
    context: ReachDeckDocumentWriterContext,
    session: ReachDeckDocumentWriterSession,
  ) => Promise<T>;
}): Promise<T> {
  return withReachDeckOrdinaryDocumentWriterLease({
    context: input.scoped.workspaceContext,
    pageId: input.pageId,
    operationKind: input.operationKind,
    ...(input.asyncRunId === undefined ? {} : { asyncRunId: input.asyncRunId }),
    ...(input.workspaceMayBeAbsent === undefined
      ? {}
      : { workspaceMayBeAbsent: input.workspaceMayBeAbsent }),
    operation: async ({ context, session }) => input.operation(context, session),
  });
}

export async function reconcileReachDeckStructuralMutationBeforeRoute(
  context: ReachDeckDocumentWriterContext,
): Promise<void> {
  if ((await reconcileReachDeckStructuralMutationCleanup(context)) === 'waiting') {
    throw new DecksmithDeckWriterConflictError();
  }
}

/**
 * Check a whole-document write against every approved proposal it carries (non-structural
 * proposals on different pages; see `selectDecksmithApprovedAdoptions`). Each proof is checked on
 * its own. `alreadyAdopted` only when every proposal already is and the write carries nothing
 * else: a proof covers only its own pages, so a save that also edits another page must still be
 * written. `supersede` lists the approvals the write overrides with the teacher's own edit.
 */
export function assertDecksmithApprovedAdoptions(input: {
  readonly approvedAdoptions: readonly DecksmithApprovedAdoption[];
  readonly baselineDocument: ReachDeckDocument;
  readonly baselineContentDigest: string;
  readonly candidateDocument: ReachDeckDocument;
  /** 教师已确认放弃未结清的 Decksmith 修改，结构提案也按最新写入结清。 */
  readonly allowStructuralSupersede?: boolean;
}): { readonly alreadyAdopted: boolean; readonly supersede: readonly string[] } {
  const results = input.approvedAdoptions.map((adoption) => ({
    approvalId: adoption.approvalId,
    result: assertDecksmithApprovedAdoption({
      approvedAdoption: adoption,
      baselineDocument: input.baselineDocument,
      baselineContentDigest: input.baselineContentDigest,
      candidateDocument: input.candidateDocument,
      operation: { kind: 'rematerialize' },
      ...(input.allowStructuralSupersede === true ? { allowStructuralSupersede: true } : {}),
    }),
  }));
  return {
    alreadyAdopted:
      results.length > 0 &&
      results.every(({ result }) => result === 'already-adopted') &&
      buildDecksmithDocumentHash(input.candidateDocument) ===
        buildDecksmithDocumentHash(input.baselineDocument),
    supersede: results
      .filter(({ result }) => result === 'supersede-adoption')
      .map(({ approvalId }) => approvalId),
  };
}

export function assertDecksmithApprovedAdoption(input: {
  readonly approvedAdoption: DecksmithApprovedAdoption | null;
  readonly baselineDocument: ReachDeckDocument;
  readonly baselineContentDigest: string;
  readonly candidateDocument: ReachDeckDocument;
  readonly operation:
    | { readonly kind: 'page-save'; readonly pageId: string }
    | { readonly kind: 'rematerialize' };
  readonly allowStructuralSupersede?: boolean;
}):
  | 'ordinary-write'
  | 'partial-adoption'
  | 'approved-adoption'
  | 'already-adopted'
  | 'supersede-adoption' {
  const adoption = input.approvedAdoption;
  if (adoption === null) return 'ordinary-write';
  let result: ReturnType<typeof validateDecksmithAdoptionTransition>;
  try {
    result = validateDecksmithAdoptionTransition({
      proof: adoption.proof,
      currentDocument: input.baselineDocument,
      candidateDocument: input.candidateDocument,
      operation: input.operation,
      ...(input.allowStructuralSupersede === true ? { allowStructuralSupersede: true } : {}),
    });
  } catch {
    throw new ReachDeckPageLockedError(
      'A structural Decksmith proposal is awaiting adoption; the deck structure is locked',
    );
  }
  switch (result) {
    case 'already-adopted':
      return 'already-adopted';
    case 'final':
      return 'approved-adoption';
    case 'partial':
      return 'partial-adoption';
    case 'ordinary':
      return 'ordinary-write';
    case 'supersede':
      return 'supersede-adoption';
  }
}
