import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const discovery = vi.hoisted(() => vi.fn());
vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: discovery,
}));
import { assertReachDeckMaterialAdmission } from '../../lib/reach-deck/material-admission.js';
import { assertReachDeckMaterialDispatchCapacity } from '../../lib/reach-deck/material-dispatch-capacity.js';

const context = {
  actorId: '11111111-1111-4111-8111-111111111111',
  billingGroupId: null,
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  jobId: 'test',
  runId: 'test',
};
const capacity = {
  provenance: { kind: 'model-service' },
  reservedOutputCapacity: 16_384,
  thresholds: { blocked: 900_000 },
  estimatedInput: 20_000,
};

describe('authoritative material admission and dispatch', () => {
  beforeEach(() => discovery.mockReset().mockResolvedValue(capacity));
  it('rejects long complete source before capacity discovery without truncation', async () => {
    await expect(
      assertReachDeckMaterialAdmission({ source: 'x'.repeat(95_001), context }),
    ).rejects.toMatchObject({
      code: 'MATERIAL_SOURCE_TOO_LONG',
      details: { actual: 95_001, limit: 95_000 },
    });
    expect(discovery).not.toHaveBeenCalled();
  });
  it('rejects excessive caller references before discovery', async () => {
    await expect(
      assertReachDeckMaterialAdmission({
        source: 'brief',
        context,
        materialReferences: Array.from({ length: 65 }, (_, i) => ({
          id: `text:${i}`,
          fileName: `${i}.txt`,
          kind: 'text',
          sha256: 'a'.repeat(64),
        })),
      }),
    ).rejects.toMatchObject({ code: 'MATERIAL_REFERENCES_TOO_MANY' });
    expect(discovery).not.toHaveBeenCalled();
  });
  it('measures the complete structured lesson request and reserves downstream space', async () => {
    const first = await assertReachDeckMaterialAdmission({ source: 'brief', context });
    const firstBytes = discovery.mock.calls[0]?.[0].measure.serializedInputUtf8Bytes;
    await assertReachDeckMaterialAdmission({
      source: 'brief with more evidence',
      prompt: 'teacher customization',
      context,
    });
    expect(discovery.mock.calls[1]?.[0].measure.serializedInputUtf8Bytes).toBeGreaterThan(
      firstBytes,
    );
    expect(discovery.mock.calls[0]?.[0]).toMatchObject({ stage: 'lesson-plan', context });
    expect(first.allowedInput).toBe(Math.floor((900_000 - (32_000 - 16_384)) / 3));
  });
  it('refuses unavailable policy and transport fallback', async () => {
    discovery.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      assertReachDeckMaterialAdmission({ source: 'brief', context }),
    ).rejects.toMatchObject({ code: 'MATERIAL_CAPACITY_UNAVAILABLE' });
    discovery.mockResolvedValueOnce({ ...capacity, provenance: { kind: 'conservative-fallback' } });
    await expect(
      assertReachDeckMaterialAdmission({ source: 'brief', context }),
    ).rejects.toMatchObject({ code: 'MATERIAL_CAPACITY_UNAVAILABLE' });
  });
  it('rejects full first request above its conservative admission budget', async () => {
    discovery.mockResolvedValueOnce({ ...capacity, estimatedInput: 400_000 });
    await expect(
      assertReachDeckMaterialAdmission({ source: 'brief', context }),
    ).rejects.toMatchObject({
      code: 'MATERIAL_CAPACITY_EXCEEDED',
      details: { estimatedInput: 400_000 },
    });
  });
  it('rechecks each exact dispatched input including larger correction rounds', async () => {
    const payload = {
      stage: 'paged-outline' as const,
      modelInput: { messages: [{ role: 'user', content: 'base' }] },
      serializedModelInput: '',
      serializedBody: '',
    };
    await assertReachDeckMaterialDispatchCapacity(payload, context);
    const firstBytes = discovery.mock.calls[0]?.[0].measure.serializedInputUtf8Bytes;
    discovery.mockResolvedValueOnce({ ...capacity, estimatedInput: 895_000 });
    await expect(
      assertReachDeckMaterialDispatchCapacity(
        {
          ...payload,
          modelInput: {
            messages: [
              ...payload.modelInput.messages,
              { role: 'assistant', content: 'large rejected output' },
            ],
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'MATERIAL_CAPACITY_EXCEEDED',
      details: { stage: 'paged-outline' },
    });
    expect(discovery.mock.calls[1]?.[0].measure.serializedInputUtf8Bytes).toBeGreaterThan(
      firstBytes,
    );
  });
  it('returns stable dispatch diagnostics when policy discovery fails', async () => {
    discovery.mockRejectedValueOnce(new Error('policy disabled'));
    await expect(
      assertReachDeckMaterialDispatchCapacity(
        {
          stage: 'slide',
          modelInput: { messages: [] },
          serializedModelInput: '',
          serializedBody: '',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'MATERIAL_CAPACITY_UNAVAILABLE', details: { stage: 'slide' } });
  });
});
