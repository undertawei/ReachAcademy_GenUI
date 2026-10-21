import {
  buildReachDeckMediaResourceForObjectKey,
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../lib/reach-deck/contracts.js';
import { createDecksmithMediaTools } from '../../lib/reach-deck/decksmith/media-tools.js';
import { DecksmithDocumentSession } from '../../lib/reach-deck/decksmith/session.js';

const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555';

function createSession() {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: DOCUMENT_ID, title: '细胞结构' }),
  );
  const page = normalized.pages[0]!;
  const document = parseReachDeckDocument({
    ...normalized,
    pages: normalized.pages,
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${DOCUMENT_ID}:native-1`,
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ],
  });
  return new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
}

function dependencies() {
  return {
    generateImage: vi.fn(async () => ({
      objectKey: 'uploads/reach-deck/image-1',
      contentType: 'image/png',
      sizeBytes: 123,
      checksumSha256: 'a'.repeat(64),
    })),
    editImage: vi.fn(async () => ({
      objectKey: 'uploads/reach-deck/edited-1.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 456,
      checksumSha256: 'b'.repeat(64),
    })),
  };
}

const ORIGINAL = {
  id: 'media-original',
  objectKey: 'uploads/reach-deck/original.png',
  contentType: 'image/png',
  digest: `sha256:${'c'.repeat(64)}`,
};

function sessionWithImage() {
  const session = createSession();
  const pageId = session.listPages()[0]!.pageId;
  session.bindImage({
    pageId,
    elementId: 'image-1',
    resource: ORIGINAL,
    transform: { x: 120, y: 80, width: 640, height: 400, rotation: 5 },
    zIndex: 7,
    fit: 'contain',
    alt: '电热水壶、风扇和电池的能量转化示意图',
  });
  return { session, pageId };
}

function editTool(session: DecksmithDocumentSession, media: ReturnType<typeof dependencies>) {
  return createDecksmithMediaTools(session, media).find(
    (candidate) => candidate.name === 'edit_native_image',
  )!;
}

describe('Decksmith v2 managed media tools', () => {
  it('registers a media resource and binds a native image without writing provider URLs', async () => {
    const session = createSession();
    const media = dependencies();
    const tool = createDecksmithMediaTools(session, media).find(
      (candidate) => candidate.name === 'generate_native_image',
    )!;
    const pageId = session.listPages()[0]!.pageId;
    const expectedResourceId = buildReachDeckMediaResourceForObjectKey(
      'uploads/reach-deck/image-1',
    ).id;
    expect(JSON.stringify(tool.parameters)).not.toContain('resourceId');

    await tool.execute('image-call-1', {
      pageId,
      elementId: 'image-1',
      prompt: 'A clean labeled cell diagram',
      alt: '细胞结构示意图',
      transform: { x: 900, y: 180, width: 560, height: 520 },
      fit: 'contain',
    });

    expect(session.document.resources.media).toContainEqual({
      id: expectedResourceId,
      objectKey: 'uploads/reach-deck/image-1',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
    });
    expect(session.readNativeSlide(pageId).elements).toContainEqual(
      expect.objectContaining({ type: 'image', resourceId: expectedResourceId }),
    );
    expect(JSON.stringify(session.document)).not.toContain('http');
  });

  it('rejects a same-id resource collision instead of rebinding existing document consumers', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const first = {
      id: 'media-conflict',
      objectKey: 'uploads/reach-deck/original.png',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    session.bindImage({
      pageId,
      elementId: 'image-1',
      resource: first,
      transform: { x: 100, y: 100, width: 400, height: 300 },
      alt: 'Original',
    });

    expect(() =>
      session.bindImage({
        pageId,
        elementId: 'image-1',
        resource: { ...first, objectKey: 'uploads/reach-deck/replacement.png' },
      }),
    ).toThrow(/already exists with different authoritative metadata/);
    expect(session.document.resources.media).toContainEqual(first);
    expect(session.readNativeSlide(pageId).elements).toContainEqual(
      expect.objectContaining({ id: 'image-1', resourceId: 'media-conflict' }),
    );
  });

  it('edits from the element current resource and rebinds a new resource with the same geometry', async () => {
    const { session, pageId } = sessionWithImage();
    const media = dependencies();
    const before = session.readNativeSlide(pageId).elements.find((e) => e.id === 'image-1')!;

    const result = await editTool(session, media).execute('edit-call-1', {
      pageId,
      elementId: 'image-1',
      instruction: '把左下角的电池换成正在充电的充电电池，其余保持不变',
    });

    expect(media.editImage).toHaveBeenCalledWith({
      toolCallId: 'edit-call-1',
      pageId,
      targetId: 'image-1',
      instruction: '把左下角的电池换成正在充电的充电电池，其余保持不变',
      source: {
        resourceId: ORIGINAL.id,
        objectKey: ORIGINAL.objectKey,
        contentType: 'image/png',
      },
    });
    const newResourceId = buildReachDeckMediaResourceForObjectKey(
      'uploads/reach-deck/edited-1.jpg',
    ).id;
    const after = session.readNativeSlide(pageId).elements.find((e) => e.id === 'image-1')!;
    expect(after).toEqual({ ...before, resourceId: newResourceId });
    expect(session.document.resources.media).toContainEqual(ORIGINAL);
    expect(session.document.resources.media).toContainEqual({
      id: newResourceId,
      objectKey: 'uploads/reach-deck/edited-1.jpg',
      contentType: 'image/jpeg',
      digest: `sha256:${'b'.repeat(64)}`,
    });
    const receipt = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({
      kind: 'image-edit',
      previousResourceId: ORIGINAL.id,
      resourceId: newResourceId,
      geometryPreserved: true,
    });
  });

  it('edits an image generated earlier in the same run and updates alt only when given', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const media = dependencies();
    await createDecksmithMediaTools(session, media)
      .find((candidate) => candidate.name === 'generate_native_image')!
      .execute('gen-1', {
        pageId,
        elementId: 'image-1',
        prompt: 'A battery',
        alt: '电池',
        transform: { x: 10, y: 10, width: 300, height: 200 },
      });

    await editTool(session, media).execute('edit-2', {
      pageId,
      elementId: 'image-1',
      instruction: 'Add a charging cable',
      alt: '正在充电的电池',
    });

    expect(media.editImage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          objectKey: 'uploads/reach-deck/image-1',
        }),
      }),
    );
    expect(session.readNativeSlide(pageId).elements).toContainEqual(
      expect.objectContaining({ id: 'image-1', alt: '正在充电的电池' }),
    );
  });

  it('never forwards the document digest as an expected checksum', async () => {
    // PPTX 导入记录的是源部件 digest，转码后与存储字节不同；若上送会让取图授权误报 409。
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    for (const [index, digest] of [
      `sha256:${'d'.repeat(64)}`,
      'objectkey:uploads/reach-deck/imported.png',
    ].entries()) {
      const imported = {
        ...buildReachDeckMediaResourceForObjectKey(`uploads/reach-deck/imported-${index}.png`),
        digest,
      };
      session.bindImage({
        pageId,
        elementId: `image-${index}`,
        resource: imported,
        transform: { x: 0, y: 0, width: 100, height: 100 },
        alt: 'Imported',
      });
      const media = dependencies();

      await editTool(session, media).execute(`edit-${index}`, {
        pageId,
        elementId: `image-${index}`,
        instruction: 'Replace the battery with a rechargeable one',
      });

      const [call] = media.editImage.mock.calls[0] as unknown as [
        { source: Record<string, unknown> },
      ];
      expect(call.source).toEqual({
        resourceId: imported.id,
        objectKey: imported.objectKey,
        contentType: imported.contentType,
      });
    }
  });

  it('rejects missing elements and non-image elements without calling the edit service', async () => {
    const { session, pageId } = sessionWithImage();
    session.upsertNativeShape({
      pageId,
      elementId: 'shape-1',
      preset: 'rect',
      transform: { x: 0, y: 0, width: 100, height: 100 },
    });
    const media = dependencies();
    const tool = editTool(session, media);

    await expect(
      tool.execute('edit-4', { pageId, elementId: 'missing', instruction: 'change' }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      tool.execute('edit-5', { pageId, elementId: 'shape-1', instruction: 'change' }),
    ).rejects.toThrow(/not an image/);
    await expect(
      tool.execute('edit-6', { pageId, elementId: 'image-1', instruction: '  ' }),
    ).rejects.toThrow(/instruction is required/);
    expect(media.editImage).not.toHaveBeenCalled();
  });

  it('edits an image nested inside a group and rebinds it in place', async () => {
    const { session: flat, pageId } = sessionWithImage();
    const image = flat.readNativeSlide(pageId).elements.find((e) => e.id === 'image-1')!;
    const binding = flat.document.nativeSlides.find((entry) => entry.pageId === pageId)!;
    const grouped = parseReachDeckDocument({
      ...flat.document,
      nativeSlides: [
        {
          ...binding,
          slide: {
            ...binding.slide,
            elements: [
              {
                id: 'group-1',
                type: 'group',
                transform: { x: 100, y: 60, width: 700, height: 460 },
                zIndex: 3,
                children: [image],
              },
            ],
          },
        },
      ],
    });
    const session = new DecksmithDocumentSession(grouped, REACH_DECK_DECKSMITH_CAPABILITY);
    const media = dependencies();

    await editTool(session, media).execute('edit-group', {
      pageId,
      elementId: 'image-1',
      instruction: '把电池换成充电电池',
    });

    expect(media.editImage).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'image-1',
        source: expect.objectContaining({ resourceId: ORIGINAL.id }),
      }),
    );
    const newResourceId = buildReachDeckMediaResourceForObjectKey(
      'uploads/reach-deck/edited-1.jpg',
    ).id;
    const elements = session.readNativeSlide(pageId).elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      id: 'group-1',
      type: 'group',
      children: [{ ...image, resourceId: newResourceId }],
    });
  });

  it('refuses to move a grouped image through a rebinding transform', () => {
    const { session: flat, pageId } = sessionWithImage();
    const image = flat.readNativeSlide(pageId).elements.find((e) => e.id === 'image-1')!;
    const binding = flat.document.nativeSlides.find((entry) => entry.pageId === pageId)!;
    const session = new DecksmithDocumentSession(
      parseReachDeckDocument({
        ...flat.document,
        nativeSlides: [
          {
            ...binding,
            slide: {
              ...binding.slide,
              elements: [
                {
                  id: 'group-1',
                  type: 'group',
                  transform: { x: 100, y: 60, width: 700, height: 460 },
                  zIndex: 3,
                  children: [image],
                },
              ],
            },
          },
        ],
      }),
      REACH_DECK_DECKSMITH_CAPABILITY,
    );

    expect(() =>
      session.bindImage({
        pageId,
        elementId: 'image-1',
        resource: { ...ORIGINAL, id: 'media-next', objectKey: 'uploads/reach-deck/next.png' },
        transform: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).toThrow(/inside a group/);
  });

  it('never rebinds the edited element to the original object key', async () => {
    const { session, pageId } = sessionWithImage();
    const media = dependencies();
    media.editImage.mockResolvedValueOnce({
      objectKey: ORIGINAL.objectKey,
      contentType: 'image/png',
      sizeBytes: 1,
      checksumSha256: 'c'.repeat(64),
    });

    await expect(
      editTool(session, media).execute('edit-7', {
        pageId,
        elementId: 'image-1',
        instruction: 'change',
      }),
    ).rejects.toThrow(/new media resource/);
    expect(session.readNativeSlide(pageId).elements).toContainEqual(
      expect.objectContaining({ id: 'image-1', resourceId: ORIGINAL.id }),
    );
  });
});
