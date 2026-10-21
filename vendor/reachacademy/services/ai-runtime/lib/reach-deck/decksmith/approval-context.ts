import { actorOwnsRun } from '../../auth.js';
import type { ApprovalRecord, ArtifactProposal, RunRecord, RuntimeActor } from '../../contracts.js';
import type { RuntimeStore } from '../../store/store.js';
import { parseReachDeckResourceScope, sameReachDeckResourceScope } from '../resource-scope.js';
import { parseDecksmithAdoptionProof, type DecksmithAdoptionProof } from './adoption.js';
import { canonicalPageStreamScope } from './page-stream.js';
import {
  parseDecksmithFrozenRunInput,
  type DecksmithFrozenRunInput,
} from './page-stream-contracts.js';

export type DecksmithApprovalMutationContext =
  | {
      readonly kind: 'v2';
      readonly run: RunRecord;
      readonly frozen: DecksmithFrozenRunInput;
      readonly proof: DecksmithAdoptionProof;
    }
  | {
      readonly kind: 'legacy';
      readonly run: RunRecord;
    };

export async function loadDecksmithApprovalMutationContext(
  store: RuntimeStore,
  approval: ApprovalRecord,
  knownRun?: RunRecord,
): Promise<DecksmithApprovalMutationContext | null> {
  const run = knownRun ?? (await store.getRun(approval.runId));
  if (
    run === null ||
    run.id !== approval.runId ||
    run.sceneKey !== 'teacher.deck' ||
    !actorOwnsRun(approval.actor, run.actor) ||
    !run.actor.roles.includes('teacher')
  ) {
    return null;
  }
  const artifact = await store.getArtifact(approval.artifactId);
  if (artifact === null || artifact.id !== approval.artifactId || artifact.runId !== run.id) {
    return null;
  }

  try {
    const frozen = parseDecksmithFrozenRunInput(run.input);
    const expectedDomain = canonicalPageStreamScope({
      actor: run.actor,
      resourceScope: frozen.resourceScope,
      pageId: frozen.stream.pageId,
    }).domainScope;
    const proof = parseDecksmithAdoptionProof(artifact.proposal.changeSet.adoptionProof);
    if (
      !sameStringRecord(run.domainScope, expectedDomain) ||
      !sameStringRecord(artifact.proposal.domainRef, expectedDomain) ||
      artifact.proposal.artifactType !== 'deck-change-set' ||
      artifact.proposal.baseRevision !== frozen.baseline.contentDigest ||
      !hash(artifact.proposal.contentSha256) ||
      artifact.proposal.changeSet.source !== 'reach-deck.decksmith' ||
      artifact.proposal.changeSet.baseDocumentSha256 !== proof.baselineDocumentHash ||
      artifact.proposal.changeSet.contentSha256 !== artifact.proposal.contentSha256 ||
      proof.candidateDocumentHash !== artifact.proposal.contentSha256
    ) {
      return null;
    }
    return Object.freeze({ kind: 'v2', run, frozen, proof });
  } catch {
    return isLegacyDecksmithApproval(approval, run, artifact.proposal)
      ? Object.freeze({ kind: 'legacy', run })
      : null;
  }
}

/**
 * The caller may act on a v2 Decksmith approval only under the role grant and organization the
 * proposal was frozen with, and for the same module scope the request carries (the Teacher BFF
 * sends it on every approval request). Legacy approvals carry no frozen authorization.
 */
export function authorizesDecksmithApproval(input: {
  readonly actor: RuntimeActor;
  readonly headers: Headers;
  readonly context: DecksmithApprovalMutationContext;
}): boolean {
  if (input.context.kind === 'legacy') return true;
  const { frozen } = input.context;
  if (
    input.actor.roleGrantId === undefined ||
    input.actor.roleGrantId !== frozen.authorization.roleGrantId ||
    input.actor.orgId !== frozen.resourceScope.organizationId
  ) {
    return false;
  }
  const header = (name: string) => input.headers.get(`x-reachany-${name}`)?.trim();
  try {
    return sameReachDeckResourceScope(
      parseReachDeckResourceScope({
        organizationId: header('organization-id'),
        courseId: header('course-id'),
        courseWorkspaceType: header('course-workspace-type'),
        courseNodeId: header('course-node-id'),
        moduleId: header('module-id'),
        moduleVersionId: header('module-version-id'),
      }),
      frozen.resourceScope,
    );
  } catch {
    return false;
  }
}

function isLegacyDecksmithApproval(
  approval: ApprovalRecord,
  run: RunRecord,
  proposal: ArtifactProposal,
): boolean {
  const domainKeys = [
    'organizationId',
    'courseId',
    'courseWorkspaceType',
    'courseNodeId',
    'moduleId',
    'moduleVersionId',
    'reachDeckJobId',
    'reachDeckRunId',
    'reachDeckJobKind',
    'requestSha256',
    'roleGrantSha256',
    'baseDocumentSha256',
  ];
  if (
    run.status !== 'completed' ||
    Object.keys(run.input).length !== 2 ||
    run.input.kind !== 'message' ||
    run.input.message !== 'Reach Deck decksmith job' ||
    Object.keys(run.domainScope).length !== domainKeys.length ||
    domainKeys.some((key) => !(key in run.domainScope)) ||
    run.domainScope.organizationId !== run.actor.orgId ||
    run.domainScope.courseWorkspaceType !== 'draft' ||
    run.domainScope.reachDeckJobKind !== 'decksmith' ||
    run.requestKey !== run.domainScope.reachDeckJobId ||
    typeof run.domainScope.reachDeckRunId !== 'string' ||
    run.domainScope.reachDeckRunId.trim().length === 0 ||
    !hash(run.domainScope.requestSha256) ||
    !hash(run.domainScope.roleGrantSha256) ||
    !hash(run.domainScope.baseDocumentSha256) ||
    proposal.artifactType !== 'deck-change-set' ||
    proposal.baseRevision !== undefined ||
    !hash(proposal.contentSha256) ||
    !sameStringRecord(proposal.domainRef, run.domainScope) ||
    proposal.changeSet.source !== 'reach-deck.decksmith' ||
    proposal.changeSet.baseDocumentSha256 !== run.domainScope.baseDocumentSha256 ||
    proposal.changeSet.contentSha256 !== proposal.contentSha256
  ) {
    return false;
  }
  try {
    parseReachDeckResourceScope({
      organizationId: run.domainScope.organizationId,
      courseId: run.domainScope.courseId,
      courseWorkspaceType: run.domainScope.courseWorkspaceType,
      courseNodeId: run.domainScope.courseNodeId,
      moduleId: run.domainScope.moduleId,
      moduleVersionId: run.domainScope.moduleVersionId,
    });
    const proof = parseDecksmithAdoptionProof(proposal.changeSet.adoptionProof);
    return (
      proof.baselineDocumentHash === run.domainScope.baseDocumentSha256 &&
      proof.candidateDocumentHash === proposal.contentSha256 &&
      approval.runId === run.id
    );
  } catch {
    return false;
  }
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
