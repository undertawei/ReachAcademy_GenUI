import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  agentLoop: vi.fn(),
  createToken: vi.fn(async () => 'service-token'),
  resolveReference: vi.fn(),
  loadReference: vi.fn(),
}));

vi.mock('@mariozechner/pi-agent-core', () => ({ agentLoop: dependencies.agentLoop }));
vi.mock('../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  createModelServiceToken: dependencies.createToken,
  resolveModelServiceOpenAiBaseUrl: vi.fn(() => 'http://model.test/v1'),
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckDecksmithImageReference: dependencies.resolveReference,
}));
vi.mock('../../lib/reach-deck/authorized-image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/authorized-image.js')>()),
  loadAuthorizedReferenceImage: dependencies.loadReference,
}));

import {
  DecksmithCapacityBlockedError,
  buildDecksmithInitialProviderInput,
  measureDecksmithModelInput,
  measureDecksmithProviderPayload,
  runDecksmith,
  type DecksmithRunInput,
} from '../../lib/reach-deck/decksmith/agent.js';
import { estimateDeterministicCapacity } from '../../lib/reach-deck/decksmith/capacity.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../lib/reach-deck/contracts.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import { authorizeDecksmithVisualInputs } from '../../lib/reach-deck/decksmith/visual-input.js';
import {
  authorizedReference,
  documentWithImages,
  imageContextRef,
  imageObjectKey,
} from './fixtures/decksmith-visual.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const CONTEXT = {
  actorId: 'teacher-1',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  sessionId: 'decksmith-vision-job',
  jobId: 'decksmith-vision-job',
  runId: 'decksmith-vision-run',
};

interface Captured {
  messages: Array<{ role: string; content: unknown }>;
  context: {
    systemPrompt: string;
    tools: Array<{ name: string; description: string; parameters: unknown }>;
  };
  config: {
    model: { input: string[] } & Parameters<typeof streamOpenAICompletions>[0];
    convertToLlm: (messages: unknown[]) => unknown[];
    onPayload: (payload: unknown) => unknown;
  };
}

let captured: Captured | undefined;

async function thumbnail() {
  const bytes = await sharp({
    create: { width: 96, height: 64, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return {
    bytes,
    contentType: 'image/jpeg' as const,
    width: 96,
    height: 64,
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  };
}

async function visualInput(selected: readonly string[]) {
  const { document, pageId } = documentWithImages(2);
  const visualInputs = await authorizeDecksmithVisualInputs({
    document,
    pageId,
    contextRefs: selected.map((id) => imageContextRef(document, pageId, id)),
    resolve: async ({ objectKey }) => authorizedReference(objectKey),
  });
  return {
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: '把图里的箭头反过来',
    document,
    pageId,
    selectedElementIds: selected,
    ...(visualInputs === undefined ? {} : { visualInputs }),
  } satisfies DecksmithRunInput;
}

async function run(input: DecksmithRunInput) {
  const events = [];
  for await (const event of runDecksmith(input, CONTEXT)) events.push(event);
  return events;
}

/** 用 pi 的真实 OpenAI 序列化得到派发 payload（在网络发送前截停）。 */
async function dispatchedPayload(): Promise<Record<string, unknown>> {
  const { messages, context, config } = captured!;
  let dispatched: unknown;
  const stream = streamOpenAICompletions(
    config.model,
    {
      systemPrompt: context.systemPrompt,
      messages: config.convertToLlm(messages) as never,
      tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })) as never,
    },
    {
      apiKey: 'test-not-a-secret',
      onPayload: (payload) => {
        dispatched = payload;
        throw new Error('Stop before network dispatch');
      },
    },
  );
  await stream.result();
  return dispatched as Record<string, unknown>;
}

function imageParts(payload: Record<string, unknown>) {
  return (payload.messages as Array<{ content: unknown }>).flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<{ type: string; image_url?: { url: string } }>).filter(
          (part) => part.type === 'image_url',
        )
      : [],
  );
}

describe('Decksmith selected-image vision in the provider payload', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    captured = undefined;
    dependencies.agentLoop.mockImplementation(async function* (
      messages: Captured['messages'],
      context: Captured['context'],
      config: Captured['config'],
    ) {
      captured = { messages, context, config };
    });
    dependencies.resolveReference.mockImplementation(async ({ objectKey }) =>
      authorizedReference(objectKey),
    );
    dependencies.loadReference.mockResolvedValue(await thumbnail());
  });

  it('sends real pixels as image_url only for runs that carry selected pictures, matching the frozen measure', async () => {
    const input = await visualInput(['image-1', 'image-2']);
    const events = await run(input);
    expect(events.at(-1)).toMatchObject({ type: 'result', changed: false });
    expect(captured!.config.model.input).toEqual(['text', 'image']);
    expect(dependencies.resolveReference).toHaveBeenCalledWith(
      {
        objectKey: imageObjectKey(1),
        expectedChecksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      expect.objectContaining({ resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE }),
    );
    const payload = await dispatchedPayload();
    const images = imageParts(payload);
    expect(images).toHaveLength(2);
    const thumb = await thumbnail();
    expect(images[0]!.image_url!.url).toBe(thumb.dataUrl);
    // Images sit in the initial user message, not in an extra tool-result message.
    const user = (payload.messages as Array<{ role: string; content: unknown }>).filter(
      (message) => message.role === 'user',
    );
    expect(user).toHaveLength(1);
    expect(JSON.stringify(user[0]!.content)).toContain('Attached picture 2: element image-2');

    const planned = measureDecksmithModelInput(input);
    expect(measureDecksmithProviderPayload(payload)).toEqual(planned);
    const exact = estimateDeterministicCapacity(planned);
    const frozen = (guaranteed: number) => ({
      capacityProfileVersion: 'test-profile',
      estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
      capacityUnit: 'model-token-upper-bound',
      guaranteedInputCapacity: guaranteed,
      reservedOutputCapacity: 16_384,
    });
    await run({ ...input, capacity: frozen(exact) });
    expect(() => captured!.config.onPayload(payload)).not.toThrow();
    await run({ ...input, capacity: frozen(exact - 1) });
    expect(() => captured!.config.onPayload(payload)).toThrow(DecksmithCapacityBlockedError);
  });

  it('keeps text-only runs free of image input and image_url parts', async () => {
    const input = await visualInput([]);
    expect(input).not.toHaveProperty('visualInputs');
    await run(input);
    expect(captured!.config.model.input).toEqual(['text']);
    const payload = await dispatchedPayload();
    expect(imageParts(payload)).toHaveLength(0);
    expect(measureDecksmithProviderPayload(payload)).toEqual(measureDecksmithModelInput(input));
    expect(dependencies.resolveReference).not.toHaveBeenCalled();
  });

  it('never drops a picture silently: a failed fetch becomes an explicit note and stays within the plan', async () => {
    const input = await visualInput(['image-1', 'image-2']);
    dependencies.resolveReference.mockImplementation(async ({ objectKey }) => {
      if (objectKey === imageObjectKey(2)) throw new ContentServiceClientError('changed', 409);
      return authorizedReference(objectKey);
    });
    await run(input);
    expect(captured!.config.model.input).toEqual(['text', 'image']);
    const payload = await dispatchedPayload();
    expect(imageParts(payload)).toHaveLength(1);
    const text = JSON.stringify(payload.messages);
    expect(text).toContain('Element image-2');
    expect(text).toContain('is NOT attached (checksum-mismatch)');
    // A missing picture only shrinks the dispatched payload below the frozen plan.
    expect(estimateDeterministicCapacity(measureDecksmithProviderPayload(payload))).toBeLessThan(
      estimateDeterministicCapacity(measureDecksmithModelInput(input)),
    );

    dependencies.resolveReference.mockRejectedValue(
      new ContentServiceClientError('down', 503, true),
    );
    await run(input);
    expect(captured!.config.model.input).toEqual(['text']);
    const textOnly = await dispatchedPayload();
    expect(imageParts(textOnly)).toHaveLength(0);
    expect(JSON.stringify(textOnly.messages)).toContain('is NOT attached (reference-unavailable)');
  });

  it('routes picture-loading failures through the normal run error path before any model call', async () => {
    const input = await visualInput(['image-1']);
    dependencies.loadReference.mockRejectedValue(new TypeError('unexpected loader bug'));
    const events = await run(input);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'unexpected loader bug' });
    expect(dependencies.agentLoop).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = new Error('teacher cancelled');
    dependencies.resolveReference.mockImplementation(async () => {
      controller.abort(cancelled);
      throw new Error('aborted fetch');
    });
    const stream = runDecksmith(input, CONTEXT, {
      signal: controller.signal,
      throwOnError: true,
    });
    await expect(
      (async () => {
        for await (const _event of stream) void _event;
      })(),
    ).rejects.toBe(cancelled);
    expect(dependencies.agentLoop).not.toHaveBeenCalled();
  });

  it('states in the system prompt that selected pictures are attached when present', () => {
    const { document, pageId } = documentWithImages(1);
    const system = buildDecksmithInitialProviderInput({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: 'x',
      document,
      pageId,
    }).messages[0].content;
    expect(system).toContain('their thumbnails (longest side at most 1024 px) are attached');
    expect(system).toContain('marked NOT attached');
    expect(system).not.toContain('You cannot see raster image pixels;');
  });
});
