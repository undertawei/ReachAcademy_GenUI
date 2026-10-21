import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getMaterializedDocument: vi.fn(),
  discoverCapacity: vi.fn(),
}));

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
}));
vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: dependencies.discoverCapacity,
}));

import { AuthorizedImageError } from '../../lib/reach-deck/authorized-image.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import {
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  type ReachDeckDecksmithV2JobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  DecksmithCapacityBlockedError,
  buildDecksmithInitialProviderInput,
  convertDecksmithMessagesForProvider,
  measureDecksmithModelInput,
  measureDecksmithProviderPayload,
} from '../../lib/reach-deck/decksmith/agent.js';
import {
  buildDecksmithV2RequestIdentity,
  prepareDecksmithTurn,
  rehydrateDecksmithV2Input,
} from '../../lib/reach-deck/decksmith/execution-context.js';
import { parseDecksmithFrozenRunInput } from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  DECKSMITH_VISION_IMAGE_CAPACITY_UNITS,
  DECKSMITH_VISION_NORMALIZATION_VERSION,
  parseDecksmithFrozenVisualInputs,
  type DecksmithFrozenVisualImage,
  type DecksmithFrozenVisualInputs,
} from '../../lib/reach-deck/decksmith/visual-input-contract.js';
import {
  DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER,
  authorizeDecksmithVisualInputs,
  loadDecksmithVisualInputs,
} from '../../lib/reach-deck/decksmith/visual-input.js';
import {
  buildDecksmithDocumentHash,
  buildStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import {
  authorizedReference,
  checksumFor,
  documentWithImages,
  imageContextRef,
  imageObjectKey,
} from './fixtures/decksmith-visual.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const ROLE_GRANT = '99999999-9999-4999-8999-999999999999';

async function jpeg(width = 64, height = 48) {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  return {
    bytes,
    contentType: 'image/jpeg' as const,
    width,
    height,
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  };
}

async function frozenFor(count: number, selected: readonly string[]) {
  const { document, pageId } = documentWithImages(count);
  const visualInputs = await authorizeDecksmithVisualInputs({
    document,
    pageId,
    contextRefs: selected.map((id) => imageContextRef(document, pageId, id)),
    resolve: async ({ objectKey }) => authorizedReference(objectKey),
  });
  return { document, pageId, visualInputs: visualInputs! };
}

describe('Decksmith selected-image authorization (frozen contract)', () => {
  it('resolves selected origin-page images to stable identifiers and authoritative checksums only', async () => {
    const resolve = vi.fn(async ({ objectKey }: { objectKey: string }) =>
      authorizedReference(objectKey),
    );
    const { document, pageId } = documentWithImages(2);
    const visualInputs = await authorizeDecksmithVisualInputs({
      document,
      pageId,
      contextRefs: [
        imageContextRef(document, pageId, 'image-2'),
        imageContextRef(document, pageId, 'image-1'),
      ],
      resolve,
    });
    expect(resolve).toHaveBeenNthCalledWith(
      1,
      { objectKey: imageObjectKey(2) },
      expect.any(AbortSignal),
    );
    expect(visualInputs).toEqual({
      schemaVersion: 'reach-deck-decksmith-visual-inputs/v1',
      normalization: DECKSMITH_VISION_NORMALIZATION_VERSION,
      pageId,
      pageRevision: document.pages[0]!.revision,
      images: [
        {
          elementId: 'image-2',
          status: 'attached',
          resourceId: 'media-2',
          objectKey: imageObjectKey(2),
          contentType: 'image/png',
          sizeBytes: 2048,
          checksumSha256: checksumFor(imageObjectKey(2)),
        },
        expect.objectContaining({ elementId: 'image-1', status: 'attached' }),
      ],
    });
    // 只冻结稳定标识：签名地址、过期时间与像素都不进入冻结合同。
    expect(JSON.stringify(visualInputs)).not.toMatch(/https?:|signed|Expires|base64/);
  });

  it('records count-limit, missing resources and authorization failures explicitly', async () => {
    const { document: parsed, pageId } = documentWithImages(6);
    const contextRefs = ['image-6', 'image-1', 'image-2', 'image-3', 'image-4', 'image-5'].map(
      (id) => imageContextRef(parsed, pageId, id),
    );
    // 文档解析不允许悬空资源；直接移除资源模拟“元素没有可用媒体资源”。
    const document = structuredClone(parsed);
    document.resources.media = document.resources.media.filter(
      (resource) => resource.id !== 'media-6',
    );
    const visualInputs = await authorizeDecksmithVisualInputs({
      document,
      pageId,
      contextRefs,
      resolve: async ({ objectKey }) => {
        if (objectKey === imageObjectKey(2)) {
          throw new ContentServiceClientError('forbidden', 403);
        }
        if (objectKey === imageObjectKey(3)) {
          throw new ContentServiceClientError('upstream down', 503, true);
        }
        return authorizedReference(objectKey);
      },
    });
    expect(
      visualInputs!.images.map((entry) => [
        entry.elementId,
        entry.status,
        'reason' in entry ? entry.reason : undefined,
      ]),
    ).toEqual([
      ['image-6', 'omitted', 'no-media-resource'],
      ['image-1', 'attached', undefined],
      ['image-2', 'omitted', 'not-authorized'],
      ['image-3', 'omitted', 'reference-unavailable'],
      ['image-4', 'attached', undefined],
      ['image-5', 'attached', undefined],
    ]);
    const fourth = await frozenFor(4, ['image-1', 'image-2', 'image-3', 'image-4']);
    expect(fourth.visualInputs.images.at(-1)).toEqual({
      elementId: 'image-4',
      status: 'omitted',
      reason: 'count-limit',
    });
  });

  it('authorizes one wave concurrently and turns a hung authorization into an explicit note', async () => {
    const { document, pageId } = documentWithImages(4);
    let inFlight = 0;
    let maxInFlight = 0;
    const resolve = vi.fn(async ({ objectKey }: { objectKey: string }, signal: AbortSignal) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (objectKey === imageObjectKey(2)) {
          // 模拟 content-service 挂起：只有截止信号能结束本次调用。
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        }
        await new Promise((settle) => setTimeout(settle, 5));
        return authorizedReference(objectKey);
      } finally {
        inFlight -= 1;
      }
    });
    const visualInputs = await authorizeDecksmithVisualInputs({
      document,
      pageId,
      contextRefs: ['image-1', 'image-2', 'image-3', 'image-4'].map((id) =>
        imageContextRef(document, pageId, id),
      ),
      resolve,
      authorizationTimeoutMs: 30,
    });
    expect(maxInFlight).toBe(3);
    // 与逐张串行一致：超时的第 2 张记为显式省略，由第 4 张补位。
    expect(
      visualInputs!.images.map((entry) => ('reason' in entry ? entry.reason : entry.status)),
    ).toEqual(['attached', 'reference-unavailable', 'attached', 'attached']);
  });

  it('ignores non-image and other-page refs and returns nothing without selected pictures', async () => {
    const { document, pageId } = documentWithImages(1);
    await expect(
      authorizeDecksmithVisualInputs({
        document,
        pageId,
        contextRefs: [],
        resolve: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeDecksmithVisualInputs({
        document,
        pageId,
        contextRefs: [{ forged: true }],
        resolve: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });

  it('parses strictly: rejects URLs, extra fields and refs outside the selection', async () => {
    const { visualInputs } = await frozenFor(1, ['image-1']);
    const attached = visualInputs.images[0]!;
    expect(() =>
      parseDecksmithFrozenVisualInputs({
        ...visualInputs,
        images: [{ ...attached, downloadUrl: 'https://oss.example/signed' }],
      }),
    ).toThrow();
    expect(() =>
      parseDecksmithFrozenVisualInputs({
        ...visualInputs,
        images: [{ ...attached, objectKey: 'https://oss.example/picture.png' }],
      }),
    ).toThrow(/URL/);
    expect(() =>
      parseDecksmithFrozenVisualInputs({
        ...visualInputs,
        images: [{ elementId: 'image-1', status: 'omitted', reason: 'byte-budget' }],
      }),
    ).toThrow(/reason/);
  });
});

describe('Decksmith selected-image runtime loading', () => {
  it('re-authorizes with the frozen checksum and attaches a normalized JPEG', async () => {
    const { document, visualInputs } = await frozenFor(1, ['image-1']);
    const image = await jpeg();
    const resolve = vi.fn(async ({ objectKey }: { objectKey: string }) =>
      authorizedReference(objectKey),
    );
    const load = vi.fn(async () => image);
    const entries = await loadDecksmithVisualInputs({ visualInputs, document, resolve, load });
    expect(resolve).toHaveBeenCalledWith(
      {
        objectKey: imageObjectKey(1),
        expectedChecksumSha256: checksumFor(imageObjectKey(1)),
      },
      expect.any(AbortSignal),
    );
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: expect.stringContaining('https://oss.example/') }),
      expect.objectContaining({ maxEdge: 1024, jpegOnly: true }),
      expect.anything(),
    );
    expect(entries).toEqual([
      {
        elementId: 'image-1',
        state: 'attached',
        image: { base64: image.bytes.toString('base64'), mimeType: 'image/jpeg' },
      },
    ]);
  });

  it('turns checksum changes, integrity failures, rebinding and load failures into explicit notes', async () => {
    const { document, visualInputs } = await frozenFor(3, ['image-1', 'image-2', 'image-3']);
    const image = await jpeg();
    const rebound = structuredClone(document);
    const slide = rebound.nativeSlides[0]!.slide;
    (slide.elements[2] as { resourceId: string }).resourceId = 'media-1';
    const entries = await loadDecksmithVisualInputs({
      visualInputs,
      document: rebound,
      resolve: async ({ objectKey }) => {
        if (objectKey === imageObjectKey(1)) {
          throw new ContentServiceClientError('checksum changed', 409);
        }
        return authorizedReference(objectKey);
      },
      load: async () => {
        throw new AuthorizedImageError('bytes differ', 'integrity');
      },
    });
    expect(entries).toEqual([
      { elementId: 'image-1', state: 'omitted', reason: 'checksum-mismatch' },
      { elementId: 'image-2', state: 'omitted', reason: 'checksum-mismatch' },
      { elementId: 'image-3', state: 'omitted', reason: 'picture-changed' },
    ]);
    const decodeFailure = await loadDecksmithVisualInputs({
      visualInputs,
      document,
      resolve: async ({ objectKey }) =>
        objectKey === imageObjectKey(2)
          ? { ...authorizedReference(objectKey), checksumSha256: 'f'.repeat(64) }
          : authorizedReference(objectKey),
      load: async (source) => {
        if (source.objectKey === imageObjectKey(3)) {
          throw new AuthorizedImageError('bad', 'decode');
        }
        return image;
      },
    });
    expect(decodeFailure.map((entry) => ('reason' in entry ? entry.reason : entry.state))).toEqual([
      'attached',
      'checksum-mismatch',
      'load-failed',
    ]);
  });

  it('retries one transient download after re-authorization and enforces the encoded byte budget', async () => {
    const { document, visualInputs } = await frozenFor(3, ['image-1', 'image-2', 'image-3']);
    const image = await jpeg();
    let calls = 0;
    const big = { ...image, bytes: Buffer.alloc(600 * 1024, 1) };
    const resolve = vi.fn(async ({ objectKey }: { objectKey: string }) =>
      authorizedReference(objectKey),
    );
    const entries = await loadDecksmithVisualInputs({
      visualInputs,
      document,
      resolve,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new AuthorizedImageError('reset', 'network');
        return big;
      },
    });
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(entries.map((entry) => ('reason' in entry ? entry.reason : entry.state))).toEqual([
      'attached',
      'attached',
      'byte-budget',
    ]);
  });

  it('bounds execution-time re-authorization by a deadline', async () => {
    const { document, visualInputs } = await frozenFor(1, ['image-1']);
    const load = vi.fn();
    const entries = await loadDecksmithVisualInputs({
      visualInputs,
      document,
      // 解析器忽略信号也不会拖住模型调用。
      resolve: () => new Promise(() => undefined),
      load,
      signal: new AbortController().signal,
      authorizationTimeoutMs: 20,
    });
    expect(entries).toEqual([
      { elementId: 'image-1', state: 'omitted', reason: 'reference-unavailable' },
    ]);
    expect(load).not.toHaveBeenCalled();
  });

  it('propagates cancellation instead of degrading it into a note', async () => {
    const { document, visualInputs } = await frozenFor(1, ['image-1']);
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    await expect(
      loadDecksmithVisualInputs({
        visualInputs,
        document,
        signal: controller.signal,
        resolve: async () => {
          controller.abort(cancelled);
          throw new Error('aborted fetch');
        },
        load: vi.fn(),
      }),
    ).rejects.toBe(cancelled);
  });
});

describe('Decksmith selected-image capacity contract', () => {
  it('counts each planned picture as a fixed-size placeholder and keeps text-only input unchanged', async () => {
    const { document, pageId, visualInputs } = await frozenFor(2, ['image-1', 'image-2']);
    const base = {
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: '把图里的箭头反过来',
      document,
      pageId,
    };
    const textOnly = buildDecksmithInitialProviderInput(base);
    expect(typeof textOnly.messages[1].content).toBe('string');
    const withImages = buildDecksmithInitialProviderInput({ ...base, visualInputs });
    const content = withImages.messages[1].content as Array<{ type: string; text?: string }>;
    expect(content.map((part) => part.type)).toEqual(['text', 'image_url', 'image_url']);
    expect(content[0]!.text).toContain('Attached picture 1: element image-1, alt "示意图 1"');
    expect(content[0]!.text).toContain('"x":40');
    expect(DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER).toHaveLength(
      DECKSMITH_VISION_IMAGE_CAPACITY_UNITS,
    );
    const textMeasure = measureDecksmithModelInput(base);
    const imageMeasure = measureDecksmithModelInput({ ...base, visualInputs });
    expect(
      imageMeasure.serializedInputUtf8Bytes - textMeasure.serializedInputUtf8Bytes,
    ).toBeGreaterThan(2 * DECKSMITH_VISION_IMAGE_CAPACITY_UNITS);
    // A real data URL projects to exactly the planned measure.
    const image = await jpeg();
    const dispatched = {
      ...withImages,
      messages: [
        withImages.messages[0],
        {
          role: 'user',
          content: content.map((part) =>
            part.type === 'text' ? part : { type: 'image_url', image_url: { url: image.dataUrl } },
          ),
        },
      ],
    };
    expect(measureDecksmithProviderPayload(dispatched)).toEqual(imageMeasure);
  });

  it('blocks dispatch for oversized, non-JPEG or too many images', async () => {
    const payload = (urls: string[]) => ({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      tools: [],
    });
    const small = (await jpeg()).dataUrl;
    expect(() => measureDecksmithProviderPayload(payload([small]))).not.toThrow();
    expect(() => measureDecksmithProviderPayload(payload([small, small, small, small]))).toThrow(
      DecksmithCapacityBlockedError,
    );
    expect(() =>
      measureDecksmithProviderPayload(payload(['data:image/png;base64,iVBORw0KGgo='])),
    ).toThrow(DecksmithCapacityBlockedError);
    expect(() =>
      measureDecksmithProviderPayload(
        payload([`data:image/jpeg;base64,${'A'.repeat(900 * 1024)}`]),
      ),
    ).toThrow(DecksmithCapacityBlockedError);
    expect(() =>
      measureDecksmithProviderPayload(payload(['https://oss.example/picture.jpg'])),
    ).toThrow(DecksmithCapacityBlockedError);
  });

  it('keeps image blocks while compacting only the text of the initial user message', () => {
    const converted = convertDecksmithMessagesForProvider([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        ],
        timestamp: 1,
      },
    ] as never);
    expect(converted[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      ],
    });
  });
});

describe('Decksmith selected-image freeze and rehydration', () => {
  beforeEach(() => {
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    dependencies.getMaterializedDocument.mockReset();
    dependencies.discoverCapacity.mockReset().mockImplementation(async ({ measure }) => {
      const estimatedInput = measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16;
      return {
        schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
        capacityProfileVersion: 'test-profile-1m',
        estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
        capacityUnit: 'model-token-upper-bound',
        guaranteedInputCapacity: 1_000_000,
        reservedOutputCapacity: 16_384,
        estimatedInput,
        thresholds: { approaching: 650_000, needsCompaction: 800_000, blocked: 900_000 },
        state: 'ordinary',
        messageKey: 'reachDeck.decksmith.capacity.ordinary',
        provenance: { kind: 'model-service' },
        inputMeasure: measure,
      };
    });
  });

  it('freezes identifiers only and measures prepare and rehydrate identically with images', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const { document, pageId, visualInputs } = await frozenFor(2, ['image-1', 'image-2']);
    const contextRefs = ['image-1', 'image-2'].map((id) => imageContextRef(document, pageId, id));
    const prepared = await prepareDecksmithTurn({
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: '把图里的箭头反过来',
      idempotencyKey: 'visual-key',
      roleGrantId: ROLE_GRANT,
      baselineContentDigest: 'sha256:authoritative',
      document,
      contextRefs,
      visualInputs,
    });
    expect(prepared.frozenInput.visualInputs).toEqual(visualInputs);
    const serialized = JSON.stringify(prepared.run.input);
    expect(serialized).not.toMatch(/data:image|base64,|https:\/\/oss/);

    const payload: ReachDeckDecksmithV2JobPayload = {
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: 'decksmith-v2-visual',
      runId: 'decksmith-run-v2-visual',
      runtimeRunId: prepared.run.id,
      threadId: prepared.threadId,
      requestHash: buildDecksmithV2RequestIdentity({
        idempotencyKey: 'visual-key',
        billingGroupId: null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        frozenInput: prepared.frozenInput,
      }),
      baseDocumentHash: buildDecksmithDocumentHash(document),
      contextDigest: buildStagedGenerationRequestHash(prepared.frozenInput),
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId: ROLE_GRANT,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: 'sha256:authoritative',
      learnerDocument: document,
    });
    await store.acquireDecksmithDeckLease({
      threadId: prepared.threadId,
      scope: { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId },
      ownerRunId: prepared.run.id,
      ownerRequestKey: 'visual-lease',
    });
    const rehydrated = await rehydrateDecksmithV2Input(payload, store);
    expect(rehydrated.visualInputs).toEqual(visualInputs);
    expect(rehydrated.selectedElementIds).toEqual(['image-1', 'image-2']);
    expect(prepared.frozenInput.capacity?.inputMeasure).toEqual(
      measureDecksmithModelInput(rehydrated),
    );
    // The planned measure includes both fixed-size image placeholders.
    const withoutImages = measureDecksmithModelInput({ ...rehydrated, visualInputs: undefined });
    expect(
      prepared.frozenInput.capacity!.inputMeasure.serializedInputUtf8Bytes -
        withoutImages.serializedInputUtf8Bytes,
    ).toBeGreaterThan(2 * DECKSMITH_VISION_IMAGE_CAPACITY_UNITS);
  });

  it('rejects visual inputs that no longer match the authoritative binding', async () => {
    const { document, pageId, visualInputs } = await frozenFor(1, ['image-1']);
    const forged: DecksmithFrozenVisualInputs = {
      ...visualInputs,
      images: [
        { ...(visualInputs.images[0] as DecksmithFrozenVisualImage), resourceId: 'media-other' },
      ],
    };
    await expect(
      prepareDecksmithTurn({
        store: new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' }),
        actor: {
          subject: '11111111-1111-4111-8111-111111111111',
          orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
          roles: ['teacher'],
        },
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt: 'x',
        idempotencyKey: 'forged-visual',
        roleGrantId: ROLE_GRANT,
        baselineContentDigest: 'sha256:authoritative',
        document,
        contextRefs: [imageContextRef(document, pageId, 'image-1')],
        visualInputs: forged,
      }),
    ).rejects.toMatchObject({ code: 'DECKSMITH_COMPONENT_REF_STALE' });
  });

  it('parses legacy frozen inputs without visualInputs and rejects images outside the selection', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const { document, pageId, visualInputs } = await frozenFor(2, ['image-1']);
    const prepared = await prepareDecksmithTurn({
      store,
      actor: {
        subject: '11111111-1111-4111-8111-111111111111',
        orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
        roles: ['teacher'],
      },
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'x',
      idempotencyKey: 'legacy-shape',
      roleGrantId: ROLE_GRANT,
      baselineContentDigest: 'sha256:authoritative',
      document,
      contextRefs: [imageContextRef(document, pageId, 'image-1')],
      visualInputs,
    });
    const { visualInputs: _removed, ...legacy } = prepared.frozenInput;
    expect(parseDecksmithFrozenRunInput(legacy).visualInputs).toBeUndefined();
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...prepared.frozenInput,
        visualInputs: {
          ...visualInputs,
          images: [
            { ...(visualInputs.images[0] as DecksmithFrozenVisualImage), elementId: 'image-2' },
          ],
        },
      }),
    ).toThrow(/selected origin-page images/);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...prepared.frozenInput,
        visualInputs: { ...visualInputs, pageRevision: visualInputs.pageRevision + 1 },
      }),
    ).toThrow(/origin page baseline/);
  });
});
