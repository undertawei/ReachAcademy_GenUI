import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ToolAuditEntry } from '../../lib/contracts.js';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import { mapWithConcurrency } from '../../lib/reach-deck/concurrency.js';
import {
  createReachDeckGenerationMediaResolvers,
  type ReachDeckGenerationMediaDependencies,
} from '../../lib/reach-deck/generation-media.js';
import { generateReachDeckImage } from '../../lib/reach-deck/model-service-tools.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const payload: ReachDeckPageGenerationJobPayload = {
  ...TEST_REACH_DECK_SCOPE,
  schemaVersion: 'reach-deck-generation-job/v5',
  kind: 'page-generation',
  jobId: 'four-image-job',
  runId: 'four-image-run',
  createdFromDraftRevision: 1,
  requestHash: 'a'.repeat(64),
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  request: {} as ReachDeckPageGenerationJobPayload['request'],
};
const inputs = Array.from({ length: 4 }, (_, i) => ({
  pageId: 'same-page',
  assetId: `asset-${i + 1}`,
  purpose: `Evidence ${i + 1}`,
  prompt: `Distinct evidence image ${i + 1}`,
  alt: `Evidence ${i + 1}`,
  aspectRatio: '4:3' as const,
  placement: 'supporting' as const,
}));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const env = {
  REACHANY_SERVICE_JWT_SECRET: 'test-secret',
  REACHANY_MODEL_BASE_URL: 'http://model.test/api/v1/',
};

function setup(
  options: { failFourth?: boolean; block?: Promise<void>; cacheCancel?: boolean } = {},
) {
  const controller = new AbortController();
  const audit: ToolAuditEntry[] = [];
  let active = 0;
  let peak = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('http://model.test/v1/images/generations');
    const body = JSON.parse(String(init?.body));
    const token = new Headers(init?.headers).get('authorization')!.slice('Bearer '.length);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(claims).toMatchObject({
      actor_id: payload.actorId,
      module_version_id: payload.resourceScope.moduleVersionId,
    });
    expect(body).toMatchObject({
      n: 1,
      response_format: 'b64_json',
      metadata: {
        reachany_application_llm_span: {
          job_id: payload.jobId,
          run_id: payload.runId,
          page_id: 'same-page',
          invocation: {
            scene_id: 'teacher.deck',
            orchestration: 'courseware.deck',
            stage: 'slide',
            tool: 'generate_image',
            channel: 'image-generation',
          },
        },
      },
    });
    expect(body).not.toHaveProperty('model');
    peak = Math.max(peak, ++active);
    await (options.block ?? new Promise((resolve) => setTimeout(resolve, 5)));
    active--;
    if (options.failFourth && body.prompt === inputs[3]!.prompt)
      return Response.json({ message: 'provider failed' }, { status: 503 });
    return Response.json({ data: [{ b64_json: png }], usage: { cost: 0.04 } });
  });
  const find = vi.fn<ReachDeckGenerationMediaDependencies['find']>(async () => {
    if (options.cacheCancel)
      controller.abort(new DOMException('Cancelled while finding cached image', 'AbortError'));
    return undefined;
  });
  const store = vi.fn<ReachDeckGenerationMediaDependencies['store']>(async (input) => ({
    objectKey: `generated/${input.idempotencyKey}.png`,
    contentType: 'image/png',
    sizeBytes: 68,
    checksumSha256: createHash('sha256').update(input.bytes).digest('hex'),
    downloadUrl: 'https://unused.test/image.png',
  }));
  const resolvers = createReachDeckGenerationMediaResolvers(
    payload,
    async () => controller.signal.throwIfAborted(),
    {
      find,
      store,
      generateImage: (prompt, toolOptions) =>
        generateReachDeckImage(prompt, { ...toolOptions, env, fetch: fetchMock }),
      renderFunctionPlot: vi.fn(),
      synthesizeSpeech: vi.fn(),
    },
    (entry) => {
      audit.push(entry);
    },
  );
  return { controller, audit, fetchMock, find, store, resolvers, peak: () => peak };
}

describe('four reference images through durable media and real tool HTTP boundary', () => {
  it('dispatches and audits the fourth distinct image with at most three concurrent calls', async () => {
    const run = setup();
    const results = await mapWithConcurrency(inputs, 3, (input) =>
      run.resolvers.resolveImageAsset!(input),
    );
    expect(run.peak()).toBe(3);
    expect(run.fetchMock).toHaveBeenCalledTimes(4);
    expect(run.store).toHaveBeenCalledTimes(4);
    expect(new Set(run.store.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(4);
    expect(new Set(results.map((result) => result.objectKey)).size).toBe(4);
    expect(run.audit.map((entry) => entry.inputSha256).sort()).toEqual(inputs.map(digest).sort());
    expect(
      run.audit.every(
        (entry) => entry.toolName === 'reach_deck.generate_image' && entry.outcome === 'succeeded',
      ),
    ).toBe(true);
    expect(JSON.parse(String(run.fetchMock.mock.calls[3]![1]!.body)).prompt).toBe(
      inputs[3]!.prompt,
    );
  });

  it('records the fourth provider failure without losing the other three completed calls', async () => {
    const run = setup({ failFourth: true });
    const results = await mapWithConcurrency(inputs, 3, async (input) => {
      try {
        return await run.resolvers.resolveImageAsset!(input);
      } catch {
        return undefined;
      }
    });
    expect(run.fetchMock).toHaveBeenCalledTimes(4);
    expect(run.peak()).toBe(3);
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(run.store).toHaveBeenCalledTimes(3);
    expect(run.audit).toHaveLength(4);
    expect(run.audit.find((entry) => entry.inputSha256 === digest(inputs[3]))).toMatchObject({
      outcome: 'failed',
      errorCode: 'REACH_DECK_MEDIA_PROVIDER_FAILED',
    });
    expect(run.audit.filter((entry) => entry.outcome === 'succeeded')).toHaveLength(3);
  });

  it('retains audits of three in-flight calls after cancellation and never starts the fourth', async () => {
    let release!: () => void;
    const run = setup({
      block: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const pending: Promise<unknown>[] = [];
    const work = mapWithConcurrency(inputs, 3, (input) => {
      const operation = run.resolvers.resolveImageAsset!(input);
      pending.push(operation);
      return operation;
    });
    const rejected = expect(work).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(run.fetchMock).toHaveBeenCalledTimes(3));
    run.controller.abort(new DOMException('cancelled', 'AbortError'));
    release();
    await rejected;
    await Promise.allSettled(pending);
    expect(run.fetchMock).toHaveBeenCalledTimes(3);
    expect(run.store).not.toHaveBeenCalled();
    expect(run.audit.map((entry) => entry.inputSha256).sort()).toEqual(
      inputs.slice(0, 3).map(digest).sort(),
    );
    expect(run.audit.every((entry) => entry.outcome === 'succeeded')).toBe(true);
  });

  it('does not dispatch a provider request if cancellation occurs during cache lookup', async () => {
    const run = setup({ cacheCancel: true });
    await expect(run.resolvers.resolveImageAsset!(inputs[0]!)).rejects.toThrow(
      'Cancelled while finding cached image',
    );
    expect(run.fetchMock.mock.calls.length).toBe(0);
    expect(run.audit).toEqual([]);
    expect(run.store).not.toHaveBeenCalled();
  });
});
