import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  agentLoop: vi.fn(),
  createToken: vi.fn(async () => 'service-token'),
  findMedia: vi.fn(),
  storeMedia: vi.fn(),
  resolveReference: vi.fn(),
  loadReference: vi.fn(),
  editImage: vi.fn(),
}));

vi.mock('@mariozechner/pi-agent-core', () => ({ agentLoop: dependencies.agentLoop }));
vi.mock('../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  createModelServiceToken: dependencies.createToken,
  resolveModelServiceOpenAiBaseUrl: vi.fn(() => 'http://model.test/v1'),
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  findReachDeckGeneratedMedia: dependencies.findMedia,
  storeReachDeckGeneratedMedia: dependencies.storeMedia,
  resolveReachDeckDecksmithImageReference: dependencies.resolveReference,
}));
vi.mock('../../lib/reach-deck/authorized-image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/authorized-image.js')>()),
  loadAuthorizedReferenceImage: dependencies.loadReference,
}));
vi.mock('../../lib/reach-deck/model-service-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-tools.js')>()),
  editReachDeckImage: dependencies.editImage,
}));

import {
  buildDecksmithImageEditIdempotencyKey,
  buildDecksmithInitialProviderInput,
  runDecksmith,
  type DecksmithStreamEvent,
} from '../../lib/reach-deck/decksmith/agent.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../lib/reach-deck/contracts.js';
import { ReachDeckModelToolError } from '../../lib/reach-deck/model-service-tools.js';
import { AuthorizedImageError } from '../../lib/reach-deck/authorized-image.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const ORIGINAL_KEY = `uploads/${TEST_REACH_DECK_RESOURCE_SCOPE.organizationId}/reach-deck/original.png`;
const EDITED_KEY = `uploads/${TEST_REACH_DECK_RESOURCE_SCOPE.organizationId}/reach-deck/edited.jpg`;
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');
const CONTEXT = {
  actorId: 'teacher-1',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  sessionId: 'decksmith-edit-job',
  jobId: 'decksmith-edit-job',
  runId: 'decksmith-edit-run',
};

describe('Decksmith edit_native_image wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.findMedia.mockResolvedValue(undefined);
    dependencies.resolveReference.mockResolvedValue({
      objectKey: ORIGINAL_KEY,
      downloadUrl: 'https://oss.example/signed',
      expiresInSeconds: 120,
      contentType: 'image/png',
      sizeBytes: 100,
      checksumSha256: 'c'.repeat(64),
      source: 'document',
    });
    dependencies.loadReference.mockResolvedValue({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      contentType: 'image/png',
      width: 1536,
      height: 1024,
      bytes: Buffer.from([]),
    });
    dependencies.editImage.mockResolvedValue({
      base64: JPEG_BASE64,
      usage: { promptTokens: 1168, completionTokens: 1398, totalTokens: 2566 },
    });
    dependencies.storeMedia.mockResolvedValue({
      objectKey: EDITED_KEY,
      downloadUrl: 'https://oss.example/edited',
      contentType: 'image/jpeg',
      sizeBytes: 6,
      checksumSha256: 'b'.repeat(64),
    });
    dependencies.agentLoop.mockImplementation(invokeEditTool);
  });

  it('authorizes, normalizes, edits, stores under an idempotency key and bills the usage to the run', async () => {
    const { document, pageId } = documentWithImage();
    const events = await drain(document, pageId);

    expect(dependencies.resolveReference).toHaveBeenCalledWith(
      { objectKey: ORIGINAL_KEY },
      expect.objectContaining({ resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE }),
    );
    expect(dependencies.loadReference).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'https://oss.example/signed' }),
      expect.objectContaining({ maxEdge: 2048 }),
      expect.anything(),
    );
    expect(dependencies.editImage).toHaveBeenCalledWith(
      '把电池换成充电电池',
      'data:image/png;base64,iVBORw0KGgo=',
      expect.objectContaining({
        pageId,
        context: expect.objectContaining({ jobId: CONTEXT.jobId, runId: CONTEXT.runId }),
      }),
    );
    const idempotencyKey = buildDecksmithImageEditIdempotencyKey(CONTEXT, {
      pageId,
      targetId: 'image-1',
      instruction: '把电池换成充电电池',
      sourceObjectKey: ORIGINAL_KEY,
    });
    expect(dependencies.storeMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', pageId, idempotencyKey, contentType: 'image/jpeg' }),
      expect.anything(),
    );
    expect(events).toContainEqual({
      type: 'usage',
      model: 'decksmith-image-edit',
      promptTokens: 1168,
      completionTokens: 1398,
      totalTokens: 2566,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-start',
        tool: 'edit_native_image',
        label: '参考原图编辑图片',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-end', tool: 'edit_native_image', isError: false }),
    );
    const result = events.at(-1) as Extract<DecksmithStreamEvent, { type: 'result' }>;
    expect(result.changed).toBe(true);
    const slide = result.document!.nativeSlides.find((binding) => binding.pageId === pageId)!.slide;
    const image = slide.elements.find((element) => element.id === 'image-1')!;
    expect(image).toMatchObject({
      type: 'image',
      transform: { x: 120, y: 80, width: 640, height: 400 },
      zIndex: 3,
      fit: 'contain',
    });
    const resource = result.document!.resources.media.find(
      (candidate) => candidate.id === (image as { resourceId: string }).resourceId,
    );
    expect(resource).toMatchObject({ objectKey: EDITED_KEY, digest: `sha256:${'b'.repeat(64)}` });
  });

  it('reuses an image already stored for the same idempotency key without reading or editing', async () => {
    dependencies.findMedia.mockResolvedValue({
      objectKey: EDITED_KEY,
      downloadUrl: 'https://oss.example/edited',
      contentType: 'image/jpeg',
      sizeBytes: 6,
      checksumSha256: 'b'.repeat(64),
    });
    const { document, pageId } = documentWithImage();
    const events = await drain(document, pageId);

    expect(dependencies.resolveReference).not.toHaveBeenCalled();
    expect(dependencies.editImage).not.toHaveBeenCalled();
    expect(dependencies.storeMedia).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect((events.at(-1) as { changed: boolean }).changed).toBe(true);
  });

  it('retries one transient image-service failure inside the tool', async () => {
    dependencies.editImage
      .mockRejectedValueOnce(new ReachDeckModelToolError('upstream unavailable', 503, true))
      .mockResolvedValueOnce({ base64: JPEG_BASE64 });
    const { document, pageId } = documentWithImage();
    const events = await drain(document, pageId);

    expect(dependencies.editImage).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-end', tool: 'edit_native_image', isError: false }),
    );
  }, 10_000);

  it('re-authorizes and retries once when the reference download hits a transient failure', async () => {
    dependencies.loadReference.mockRejectedValueOnce(
      new AuthorizedImageError('Authorized image download timed out', 'timeout'),
    );
    const { document, pageId } = documentWithImage();
    const events = await drain(document, pageId);

    expect(dependencies.resolveReference).toHaveBeenCalledTimes(2);
    expect(dependencies.loadReference).toHaveBeenCalledTimes(2);
    expect(dependencies.editImage).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-end', tool: 'edit_native_image', isError: false }),
    );
  });

  it('does not retry an integrity failure of the reference image', async () => {
    dependencies.loadReference.mockRejectedValueOnce(
      new AuthorizedImageError('Authorized image integrity check failed', 'integrity'),
    );
    const { document, pageId } = documentWithImage();
    const events = await drain(document, pageId);

    expect(dependencies.resolveReference).toHaveBeenCalledTimes(1);
    expect(dependencies.editImage).not.toHaveBeenCalled();
    expect(dependencies.storeMedia).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-end', tool: 'edit_native_image', isError: true }),
    );
  });

  it('describes edit_native_image honestly in the system prompt and exposes the tool', () => {
    const { document, pageId } = documentWithImage();
    const input = buildDecksmithInitialProviderInput({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: '把电池换成充电电池',
      pageId,
      document,
    });
    const system = input.messages[0]!.content;
    expect(system).toContain('call edit_native_image on that image element');
    expect(system).toContain('not pixel-identical');
    expect(system).toContain('Use generate_native_image only for a brand-new picture');
    expect(system).toContain(
      'the service was temporarily unavailable and that nothing was replaced',
    );
    expect(system).toContain('ask the teacher to name one');
    expect(system).not.toContain('do not regenerate yet');
    // 实测 gemini-nano-banana-2.1 能正确反转箭头，几何类修改也走参考图编辑，但必须请教师核对，且不得用叠加形状冒充修复。
    expect(system).toContain('Geometric changes inside a picture');
    expect(system).toContain('ask the teacher to check that detail');
    expect(system).toContain('Never overlay native shapes to fake such a fix');
    expect(system).toContain('draft_layout_with_html');
    expect(input.tools.map((tool) => tool.function.name)).toContain('edit_native_image');
  });
});

async function* invokeEditTool(
  _messages: unknown,
  context: { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> },
) {
  const tool = context.tools.find((candidate) => candidate.name === 'edit_native_image')!;
  const args = { pageId: currentPageId, elementId: 'image-1', instruction: '把电池换成充电电池' };
  yield { type: 'tool_execution_start', toolCallId: 'edit-call', toolName: tool.name, args };
  let result: unknown;
  let isError = false;
  try {
    result = await tool.execute('edit-call', args);
  } catch (error) {
    isError = true;
    result = { content: [{ type: 'text', text: String(error) }] };
  }
  yield {
    type: 'tool_execution_end',
    toolCallId: 'edit-call',
    toolName: tool.name,
    result,
    isError,
  };
}

let currentPageId = '';

async function drain(document: unknown, pageId: string) {
  currentPageId = pageId;
  const events: DecksmithStreamEvent[] = [];
  for await (const event of runDecksmith(
    {
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: '把电池换成充电电池',
      pageId,
      selectedElementIds: ['image-1'],
      document,
    },
    CONTEXT,
  )) {
    events.push(event);
  }
  return events;
}

function documentWithImage() {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title: '能量转化',
      generatedAt: '2026-10-08T00:00:00.000Z',
    }),
  );
  const page = normalized.pages[0]!;
  const document = parseReachDeckDocument({
    ...normalized,
    resources: {
      ...normalized.resources,
      media: [
        {
          id: 'media-original',
          objectKey: ORIGINAL_KEY,
          contentType: 'image/png',
          digest: `sha256:${'c'.repeat(64)}`,
        },
      ],
    },
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${page.pageId}:native`,
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'image-1',
              type: 'image',
              transform: { x: 120, y: 80, width: 640, height: 400 },
              zIndex: 3,
              resourceId: 'media-original',
              alt: '能量转化示意图',
              fit: 'contain',
            },
          ],
          animations: [],
        },
      },
    ],
  });
  return { document, pageId: page.pageId };
}
