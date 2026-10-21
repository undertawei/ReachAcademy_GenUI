import { describe, expect, it, vi } from 'vitest';
import { logReachDeckSaveConflict } from '../../lib/reach-deck/save-conflict-diagnostics';

const scope = {
  organizationId: '01a0d7bb-67ea-738e-bc63-b8b50c7f0c85',
  courseId: '59763237-38f6-4077-86bc-4031920ee4a0',
  courseNodeId: '5ac8de15-9d62-4cf3-9e97-9af2b682c397',
  moduleId: '2ebc5bc7-d183-431f-9728-d565b93304c6',
  moduleVersionId: 'c5781259-9538-4223-8d88-0c7086560b6f',
  courseWorkspaceType: 'draft' as const,
};

describe('save conflict diagnostics', () => {
  it('correlates a stale request with its prewrite observation without accepting content', () => {
    const log = vi.fn();
    logReachDeckSaveConflict(
      {
        scope,
        expectedDigest: 'a'.repeat(64),
        observedDigest: 'b'.repeat(64),
        expectedRevision: 2,
        observedRevision: 3,
      },
      log,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleVersionId: scope.moduleVersionId,
        expected_digest: 'a'.repeat(64),
        prewrite_observed_digest: 'b'.repeat(64),
        digest_differed_before_write: true,
        revision_differed_before_write: true,
      }),
    );
  });

  it('redacts malformed digests and tolerates a failed logging sink', () => {
    const log = vi.fn();
    const input = {
      scope,
      expectedDigest: 'private input',
      observedDigest: 'b'.repeat(64),
      expectedRevision: 0,
      observedRevision: 0,
    };
    logReachDeckSaveConflict(input, log);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private input');
    expect(() =>
      logReachDeckSaveConflict(input, () => {
        throw new Error('sink');
      }),
    ).not.toThrow();
  });
});
