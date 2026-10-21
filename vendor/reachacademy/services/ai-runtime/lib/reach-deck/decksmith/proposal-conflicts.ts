import type { RunRecord } from '../../contracts.js';
import type { RuntimeStore } from '../../store/store.js';
import { getReachDeckMaterializedDocument } from '../content-service-client.js';
import type { DecksmithAdoptionProof } from './adoption.js';
import {
  evaluateDecksmithProposalConflicts,
  type DecksmithProposalConflictReport,
} from './lease-policy.js';
import type { DecksmithFrozenRunInput } from './page-stream-contracts.js';

/** Stable 409 codes the Teacher client turns into an override prompt or a reject-only notice. */
export const DECKSMITH_PROPOSAL_PAGE_CONFLICT = 'DECKSMITH_PROPOSAL_PAGE_CONFLICT';
export const DECKSMITH_PROPOSAL_NOT_ADOPTABLE = 'DECKSMITH_PROPOSAL_NOT_ADOPTABLE';
export const DECKSMITH_PROPOSAL_EXPIRED = 'DECKSMITH_PROPOSAL_EXPIRED';

/**
 * Evaluate a Decksmith proposal against the other turns on its deck and the deck as it is now.
 *
 * 数据源：ai_thread.context.decksmithDeckLease（本课件全部租约及其未决提案）、content-service
 * 当前物化文档。
 *
 * 核心逻辑：
 * 1. 读取本课件全部租约条目（含占用方状态与未决提案改动页）；
 * 2. 读取当前权威文档，用于判断提案改动页自生成后是否被改、页结构是否变化；
 * 3. 汇总为冲突报告：可覆盖（他人占用、页已被改）与不可覆盖（他人已批准待保存、页结构变化）。
 */
export async function loadDecksmithProposalConflictReport(input: {
  readonly store: RuntimeStore;
  readonly run: RunRecord;
  readonly frozen: DecksmithFrozenRunInput;
  readonly proof: DecksmithAdoptionProof;
  readonly signal?: AbortSignal;
}): Promise<DecksmithProposalConflictReport> {
  const [entries, materialized] = await Promise.all([
    input.store.listDecksmithDeckLeaseEntries({
      actor: input.run.actor,
      resourceScope: input.frozen.resourceScope,
      pageId: input.frozen.stream.pageId,
    }),
    getReachDeckMaterializedDocument({
      actorId: input.run.actor.subject,
      billingGroupId: input.run.actor.billingGroupId ?? null,
      roleGrantId: input.frozen.authorization.roleGrantId,
      resourceScope: input.frozen.resourceScope,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  ]);
  return evaluateDecksmithProposalConflicts({
    ownerRunId: input.run.id,
    proof: input.proof,
    entries,
    currentDocument: materialized.materialized === true ? materialized.learnerDocument : undefined,
  });
}

export function publicDecksmithProposalConflictReport(
  report: DecksmithProposalConflictReport,
): Record<string, unknown> {
  return {
    structural: report.structural,
    changedPageIds: report.changedPageIds,
    envelopeChanged: report.envelopeChanged,
    overridable: report.overridable,
    conflicts: report.conflicts.map((conflict) => ({
      kind: conflict.kind,
      pageIds: conflict.pageIds,
      ...('holder' in conflict
        ? {
            holder: {
              originPageId: conflict.holder.originPageId,
              state: conflict.holder.state,
            },
          }
        : {}),
    })),
  };
}
