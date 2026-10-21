import { createHash } from 'node:crypto';

import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

import type { ContentServiceRequestOptions } from './content-service-client.js';
import type { ReachDeckResourceScope } from './resource-scope.js';

export interface ReachDeckContentContext extends ContentServiceRequestOptions {
  title?: string;
}

export interface ReachDeckDraftResource extends ReachDeckResourceScope {
  moduleType: 'reach-deck';
  status: 'draft';
  document: ReachDeckDocument;
  draftRevision: number;
  revisionToken: string;
}

export interface ReachDeckPublishResult extends ReachDeckResourceScope {
  status: 'published';
  versionNo: number;
  publishedAt: string;
  document: ReachDeckDocument;
}

export class ReachDeckRevisionConflictError extends Error {
  readonly status = 409;

  constructor() {
    super('Reach Deck draft changed since it was loaded');
    this.name = 'ReachDeckRevisionConflictError';
  }
}

export class ReachDeckLegacyDraftRetiredError extends Error {
  readonly status = 410;

  constructor() {
    super('Direct Reach Deck drafts are retired; use the authoring workspace flow');
    this.name = 'ReachDeckLegacyDraftRetiredError';
  }
}

export async function loadReachDeckDraft(
  _context: ReachDeckContentContext,
): Promise<ReachDeckDraftResource> {
  throw new ReachDeckLegacyDraftRetiredError();
}

export async function saveReachDeckDraft(
  _context: ReachDeckContentContext,
  _documentValue: unknown,
  _expectedRevisionToken?: string,
): Promise<ReachDeckDraftResource> {
  throw new ReachDeckLegacyDraftRetiredError();
}

export async function publishReachDeck(
  _context: ReachDeckContentContext,
  _input: { document?: unknown; expectedRevisionToken?: string } = {},
): Promise<ReachDeckPublishResult> {
  throw new ReachDeckLegacyDraftRetiredError();
}

export function reachDeckRevisionToken(document: ReachDeckDocument): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(document)).digest('hex');
}
