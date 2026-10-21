import { beforeEach, describe, expect, it, vi } from 'vitest';

const content = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  abort: vi.fn(),
}));
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  createReachDeckGenerationAudit: content.create,
  updateReachDeckGenerationAudit: content.update,
  abortReachDeckGenerationAudit: content.abort,
}));

import {
  abortReachDeckGenerationAudit,
  createReachDeckGenerationAudit,
  updateReachDeckGenerationAudit,
} from '../../lib/reach-deck/generation-audit.js';
import {
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  type ReachDeckLessonPlanJobPayload,
} from '../../lib/reach-deck/contracts.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const resourceScope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};
const payload: ReachDeckLessonPlanJobPayload = {
  schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  kind: 'lesson-plan',
  jobId: 'deck-v4-job-1',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorOrganizationId: '77777777-7777-4777-8777-777777777777',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope,
  runId: 'run-1',
  createdFromDraftRevision: 2,
  requestHash: 'a'.repeat(64),
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  request: { source: 'source' },
};
const stored = {
  id: payload.jobId,
  jobId: payload.jobId,
  actorId: payload.actorId,
  billingGroupId: null,
  ...resourceScope,
  requestHash: payload.requestHash,
  status: 'queued' as const,
  executionAttempt: 0,
  createdAt: '2026-07-21T00:00:00Z',
  updatedAt: '2026-07-21T00:00:00Z',
};

describe('Reach Deck canonical generation lifecycle adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    content.create.mockResolvedValue(stored);
    content.update.mockResolvedValue({ ...stored, status: 'running', executionAttempt: 1 });
    content.abort.mockResolvedValue({ ...stored, status: 'aborted' });
  });

  it('creates a Java generation descriptor with staged provenance and full scope options', async () => {
    await createReachDeckGenerationAudit(payload);
    expect(content.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: payload.jobId,
        runId: payload.runId,
        generationKind: 'lesson-plan',
        requestHash: payload.requestHash,
      }),
      {
        actorId: payload.actorId,
        actorOrganizationId: payload.actorOrganizationId,
        billingGroupId: null,
        roleGrantId: payload.roleGrantId,
        resourceScope,
      },
    );
  });

  it('threads job id, request hash, and UUID scope through transitions', async () => {
    await updateReachDeckGenerationAudit(payload, { status: 'running' });
    await abortReachDeckGenerationAudit(payload, {});
    expect(content.update).toHaveBeenCalledWith(
      payload.jobId,
      payload.requestHash,
      { status: 'running' },
      expect.objectContaining({ resourceScope }),
    );
    expect(content.abort).toHaveBeenCalledWith(
      payload.jobId,
      payload.requestHash,
      {},
      expect.objectContaining({ resourceScope }),
    );
  });
});
