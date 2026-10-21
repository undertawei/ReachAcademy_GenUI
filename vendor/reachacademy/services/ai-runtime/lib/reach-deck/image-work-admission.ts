import type { ReachDeckWorkspaceBatch } from './workspace-batches.js';
import type { ReachDeckRecoveredJobMetadata } from './workspace-recovery.js';

/** 停止或终结批次不占图片通道；批次回收后的独立在途任务仍保留占用。 */
export function activeReachDeckImagePageIds(
  runId: string,
  batches: readonly ReachDeckWorkspaceBatch[],
  jobs: readonly ReachDeckRecoveredJobMetadata[],
): Set<string> {
  const active = new Set<string>();
  for (const batch of batches) {
    if (batch.runId !== runId || batch.phase === 'terminal' || batch.phase === 'stopped') continue;
    for (const member of batch.members)
      if (!member.terminalOutcome && member.regeneration?.stage === 'image')
        active.add(member.pageId);
  }
  for (const job of jobs)
    if (
      job.pageId &&
      !job.done &&
      !['failed', 'cancelled', 'completed'].includes(job.status) &&
      job.affectedLanes?.length === 1 &&
      job.affectedLanes[0] === 'image'
    )
      active.add(job.pageId);
  return active;
}
