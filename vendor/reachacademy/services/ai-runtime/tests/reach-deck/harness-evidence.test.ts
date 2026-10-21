import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HARNESS_EVIDENCE_MAX_BYTES,
  listDeckHarnessEvidence,
  readDeckHarnessEvidence,
  writeDeckHarnessEvidence,
  type DeckHarnessGenerationEvidence,
} from '../../lib/reach-deck/harness-evidence.js';

const scope = {
  actorId: randomUUID(),
  roleGrantId: randomUUID(),
  resourceScope: {
    organizationId: randomUUID(),
    courseId: randomUUID(),
    courseWorkspaceType: 'draft' as const,
    courseNodeId: randomUUID(),
    moduleId: randomUUID(),
    moduleVersionId: randomUUID(),
  },
};
const resource = scope.resourceScope;
const directory = path.resolve(
  import.meta.dirname,
  '../../../../tmp/reach-deck-generation-evidence',
  createHash('sha256')
    .update(
      JSON.stringify([
        scope.actorId,
        scope.roleGrantId,
        resource.organizationId,
        resource.courseId,
        resource.courseWorkspaceType,
        resource.courseNodeId,
        resource.moduleId,
        resource.moduleVersionId,
      ]),
    )
    .digest('hex'),
);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const env = { REACH_DECK_HARNESS_MODE: 'on' };
const evidence: DeckHarnessGenerationEvidence = {
  schemaVersion: 'reach-deck-harness-evidence/v1',
  jobId: 'job-' + randomUUID(),
  runId: 'run-' + randomUUID(),
  kind: 'page-generation',
  pageId: 'page-1',
  updatedAt: new Date().toISOString(),
  status: 'capturing',
  request: { page: { designIntent: { layoutReferenceIds: ['layout-1'] } } },
  prompts: [{ stage: 'slide', serializedModelInput: '{"actual":"provider input"}' }],
  html: '<main id="slide">Original HTML</main>',
};
describe('local same-generation harness evidence', () => {
  it('is absent without the explicit harness gate', async () => {
    await writeDeckHarnessEvidence(scope, evidence, {});
    expect(await readDeckHarnessEvidence(scope, evidence.jobId, {})).toBeUndefined();
    expect(await listDeckHarnessEvidence(scope, evidence.runId, {})).toEqual([]);
  });
  it('preserves raw precompile output then failure in the same identity', async () => {
    await writeDeckHarnessEvidence(scope, evidence, env);
    expect(await readDeckHarnessEvidence(scope, evidence.jobId, env)).toEqual(evidence);
    const failed = {
      ...evidence,
      status: 'failed' as const,
      error: 'Unsupported resource',
      diagnostics: ['TEXT_COLLISION'],
    };
    await writeDeckHarnessEvidence(scope, failed, env);
    expect(await readDeckHarnessEvidence(scope, evidence.jobId, env)).toEqual(failed);
    expect(await listDeckHarnessEvidence(scope, evidence.runId, env)).toEqual([
      expect.objectContaining({ jobId: evidence.jobId, status: 'failed' }),
    ]);
    expect(await listDeckHarnessEvidence(scope, 'other-run', env)).toEqual([]);
  });
  it('isolates actor, grant and resource scope and hashes arbitrary job IDs', async () => {
    expect(
      await readDeckHarnessEvidence({ ...scope, actorId: randomUUID() }, evidence.jobId, env),
    ).toBeUndefined();
    expect(
      await readDeckHarnessEvidence({ ...scope, roleGrantId: randomUUID() }, evidence.jobId, env),
    ).toBeUndefined();
    expect(
      await readDeckHarnessEvidence(
        { ...scope, resourceScope: { ...resource, moduleId: randomUUID() } },
        evidence.jobId,
        env,
      ),
    ).toBeUndefined();
    expect(await readDeckHarnessEvidence(scope, '../../outside', env)).toBeUndefined();
  });
  it('rejects oversized capture without replacing existing evidence', async () => {
    await expect(
      writeDeckHarnessEvidence(
        scope,
        { ...evidence, html: 'x'.repeat(HARNESS_EVIDENCE_MAX_BYTES) },
        env,
      ),
    ).rejects.toThrow('capture limit');
    expect((await readDeckHarnessEvidence(scope, evidence.jobId, env))?.status).toBe('failed');
  });
});
