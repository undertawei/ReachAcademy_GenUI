import { describe, expect, it, vi } from 'vitest';
import {
  createReachDeckGenerationMediaResolvers,
  type ReachDeckGenerationMediaDependencies,
} from '../../lib/reach-deck/generation-media.js';
import type { ReachDeckDiagramAssetEntry } from '../../lib/reach-deck/generation-pipeline.js';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { protectReachDeckMediaAccounting } from '../../lib/reach-deck/media-failure-boundary.js';
import { ReachDeckMediaCheckpointOutcomeUnknownError } from '../../lib/reach-deck/media-generation-checkpoint.js';

describe('diagram batch outcomes', () => {
  it.each(['accounting', 'admission', 'unknown'] as const)(
    'preserves a fatal %s source failure when its budget also expires',
    async (kind) => {
      const controller = new AbortController();
      const failure =
        kind === 'unknown'
          ? new ReachDeckMediaCheckpointOutcomeUnknownError()
          : Object.assign(new Error('source boundary failed'), {
              name: kind === 'admission' ? 'UnrecoverableError' : 'Error',
            });
      const fail = protectReachDeckMediaAccounting(async () => {
        controller.abort(new DOMException('Image budget expired', 'TimeoutError'));
        throw failure;
      })!;
      const produce = async () => {
        if (kind === 'accounting') await fail(undefined);
        else {
          controller.abort(new DOMException('Image budget expired', 'TimeoutError'));
          throw failure;
        }
        return '<svg/>';
      };
      const deps = {
        find: vi.fn(async () => undefined),
      } as unknown as ReachDeckGenerationMediaDependencies;
      const payload = {
        ...TEST_REACH_DECK_SCOPE,
        kind: 'page-generation',
        runId: 'run',
        jobId: 'job',
        request: {},
      } as unknown as ReachDeckPageGenerationJobPayload;
      const resolver = createReachDeckGenerationMediaResolvers(
        payload,
        async () => undefined,
        deps,
      );
      resolver.setMediaResolutionSignal!(controller.signal);
      const entry = {
        input: {
          pageId: 'p',
          assetId: 'a',
          plan: { kind: 'diagram', representation: 'chart' },
          width: 800,
          height: 450,
        },
        produce,
      } as unknown as ReachDeckDiagramAssetEntry;
      await expect(resolver.resolveDiagramAssetsSettled!([entry])).rejects.toBe(failure);
    },
  );
  it.each([true, false])(
    'audits partially failed render batches accurately and preserves successful siblings: %s',
    async (renderFails) => {
      const sourceFailure = new Error('source unavailable');
      const renderFailure = new Error('invalid second render');
      const rendered = {
        bytes: Buffer.from([1]),
        contentType: 'image/png' as const,
        sourceDigest: 'a'.repeat(64),
      };
      const render = vi.fn<
        NonNullable<ReachDeckGenerationMediaDependencies['renderDiagramBatchSettled']>
      >(async () => [
        renderFails
          ? { status: 'rejected' as const, reason: renderFailure }
          : { status: 'fulfilled' as const, value: rendered },
        { status: 'fulfilled' as const, value: rendered },
      ]);
      const store = vi.fn(async (input) => ({
        objectKey: `generated/${input.idempotencyKey}.png`,
        contentType: 'image/png',
        sizeBytes: 1,
        checksumSha256: 'a'.repeat(64),
        downloadUrl: 'https://signed.example/media',
      }));
      const deps = {
        find: vi.fn(async () => undefined),
        store,
        renderDiagramBatchSettled: render,
      } as unknown as ReachDeckGenerationMediaDependencies;
      const payload = {
        ...TEST_REACH_DECK_SCOPE,
        kind: 'page-generation',
        runId: 'run',
        jobId: 'job',
        request: {},
      } as unknown as ReachDeckPageGenerationJobPayload;
      const audit = vi.fn(async () => undefined);
      const resolver = createReachDeckGenerationMediaResolvers(
        payload,
        async () => undefined,
        deps,
        audit,
      );
      const entries = [0, 1, 2].map((index) => ({
        input: {
          pageId: 'p',
          assetId: `a${index}`,
          plan: { kind: 'diagram', representation: 'chart' },
          width: 800,
          height: 450,
        },
        produce: async () => {
          if (!index) throw sourceFailure;
          return '<svg/>';
        },
      })) as unknown as ReachDeckDiagramAssetEntry[];
      const results = await resolver.resolveDiagramAssetsSettled!(entries);
      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        renderFails ? 'rejected' : 'fulfilled',
        'fulfilled',
      ]);
      expect(results[0]).toMatchObject({ reason: sourceFailure });
      if (renderFails) expect(results[1]).toMatchObject({ reason: renderFailure });
      expect(render).toHaveBeenCalledOnce();
      expect(render.mock.calls[0]?.[0]).toHaveLength(2);
      expect(store).toHaveBeenCalledTimes(renderFails ? 1 : 2);
      expect(audit).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'reach_deck.render_diagram',
          outcome: renderFails ? 'failed' : 'succeeded',
          ...(renderFails ? { errorCode: 'REACH_DECK_MEDIA_PROVIDER_FAILED' } : {}),
        }),
      );
    },
  );
});
