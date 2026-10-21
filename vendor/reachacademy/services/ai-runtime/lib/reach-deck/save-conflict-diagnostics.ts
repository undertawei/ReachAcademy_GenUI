import { observationLogContext } from '@reachany/observability/tracing';
import type { ReachDeckResourceScope } from './resource-scope.js';

/** The observation precedes the write; it is not the authoritative state at rejection. */
export function logReachDeckSaveConflict(
  input: {
    scope: ReachDeckResourceScope;
    expectedDigest: string;
    observedDigest: string;
    expectedRevision: number;
    observedRevision: number;
  },
  log: (entry: Record<string, unknown>) => void = (entry) => console.warn(JSON.stringify(entry)),
): void {
  try {
    const digest = (value: string) => (/^[a-f0-9]{64}$/i.test(value) ? value : 'invalid');
    const id = (value: string) => (/^[a-f0-9-]{36}$/i.test(value) ? value : 'invalid');
    log({
      ...observationLogContext(),
      event: 'reach_deck_save_conflict',
      route: '/api/reach-deck/workspace/rematerialize',
      organizationId: id(input.scope.organizationId),
      courseId: id(input.scope.courseId),
      courseNodeId: id(input.scope.courseNodeId),
      moduleId: id(input.scope.moduleId),
      moduleVersionId: id(input.scope.moduleVersionId),
      expected_digest: digest(input.expectedDigest),
      prewrite_observed_digest: digest(input.observedDigest),
      expected_revision: input.expectedRevision,
      prewrite_observed_revision: input.observedRevision,
      digest_differed_before_write: input.expectedDigest !== input.observedDigest,
      revision_differed_before_write: input.expectedRevision !== input.observedRevision,
    });
  } catch {
    // Diagnostics must never change save failure semantics.
  }
}
