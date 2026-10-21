import { describe, expect, it } from 'vitest';
import { richTextFromPlainText } from '@reachany/reach-deck-dsl';
import {
  parseReachDeckElementsClipboard,
  serializeReachDeckElementsClipboard,
} from '../src/elementClipboard';
import { isReachDeckElementsClipboardSelfContained } from '../src/elementClipboardSafety';
import { copyReachDeckNativeElements, pasteReachDeckNativeElements } from '../src/operations';
import { createEditorDocument } from './fixture';

describe('Reach Deck element clipboard cross-Deck safety', () => {
  it('rejects ESA bearer signatures embedded in clipboard text', () => {
    const source = createEditorDocument();
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['title-1'])!;
    const serialized = serializeReachDeckElementsClipboard(fragment, source)!;
    expect(parseReachDeckElementsClipboard(serialized, source)).toBeDefined();
    const payload = JSON.parse(serialized);
    payload.elements[0].text.doc = richTextFromPlainText(
      'https://media-test.reachacademy.cn/image.png',
    );
    expect(parseReachDeckElementsClipboard(JSON.stringify(payload), source)).toBeDefined();
    payload.elements[0].text.doc = richTextFromPlainText(
      'https://media-test.reachacademy.cn/image.png?auth_key=1791840000-0-0-private',
    );
    expect(parseReachDeckElementsClipboard(JSON.stringify(payload), source)).toBeUndefined();
  });

  it('resolves source theme colors into portable literal colors', () => {
    const source = createEditorDocument();
    source.nativeSlides[0]!.slide.elements.push({
      id: 'theme-shape',
      type: 'shape',
      transform: { x: 0, y: 0, width: 100, height: 50 },
      zIndex: 2,
      geometry: { kind: 'preset', preset: 'rect' },
      style: { fill: { kind: 'solid', color: { kind: 'theme', token: 'accent' } } },
    });
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['theme-shape'])!;
    const serialized = serializeReachDeckElementsClipboard(fragment, source)!;
    const target = { ...createEditorDocument(), id: 'target-deck' };

    expect(parseReachDeckElementsClipboard(serialized, source)?.elements[0]).toMatchObject({
      style: { fill: { color: { kind: 'theme', token: 'accent' } } },
    });
    expect(parseReachDeckElementsClipboard(serialized, target)?.elements[0]).toMatchObject({
      style: { fill: { color: { kind: 'srgb', value: '#2563eb' } } },
    });
    expect(fragment.elements[0]).toMatchObject({
      style: { fill: { color: { kind: 'theme', token: 'accent' } } },
    });
  });

  it('keeps theme modifiers and unknown tokens in the source Deck but rejects foreign dependencies', () => {
    const source = createEditorDocument();
    source.nativeSlides[0]!.slide.elements.push({
      id: 'modified-theme-shape',
      type: 'shape',
      transform: { x: 0, y: 0, width: 100, height: 50 },
      zIndex: 2,
      geometry: { kind: 'preset', preset: 'rect' },
      style: {
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent', tint: 0.25 } },
        stroke: { width: 2, fill: { kind: 'theme', token: 'custom-color' } },
      },
    });
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['modified-theme-shape'])!;
    const serialized = serializeReachDeckElementsClipboard(fragment, source)!;
    const target = { ...createEditorDocument(), id: 'target-deck' };

    expect(parseReachDeckElementsClipboard(serialized, source)?.elements[0]).toMatchObject({
      style: {
        fill: { color: { kind: 'theme', token: 'accent', tint: 0.25 } },
        stroke: { fill: { kind: 'theme', token: 'custom-color' } },
      },
    });
    expect(parseReachDeckElementsClipboard(serialized, target)).toBeUndefined();
  });

  it('accepts an older v2 literal fragment without a portable copy', () => {
    const source = createEditorDocument();
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['title-1'])!;
    const serialized = JSON.stringify(fragment);

    expect(
      parseReachDeckElementsClipboard(serialized, {
        ...createEditorDocument(),
        id: 'target-deck',
      })?.elements,
    ).toHaveLength(1);
  });

  it('accepts and remaps self-contained text, shape, and group fragments from another Deck', () => {
    const source = createEditorDocument();
    const text = structuredClone(source.nativeSlides[0]!.slide.elements[0]!);
    const shape = {
      id: 'shape-1',
      type: 'shape' as const,
      transform: { x: 200, y: 240, width: 180, height: 100 },
      zIndex: 2,
      geometry: { kind: 'preset' as const, preset: 'rect' },
      style: {
        fill: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#1d4ed8' } },
      },
    };
    const group = {
      id: 'group-1',
      type: 'group' as const,
      transform: { x: 420, y: 240, width: 180, height: 100 },
      zIndex: 3,
      children: [{ ...shape, id: 'shape-in-group' }],
    };
    source.nativeSlides[0]!.slide.elements.push(shape, group);
    const fragment = copyReachDeckNativeElements(source, 'page-1', [text.id, shape.id, group.id])!;
    const serialized = serializeReachDeckElementsClipboard(fragment, source)!;
    const target = { ...createEditorDocument(), id: 'target-deck' };

    const parsed = parseReachDeckElementsClipboard(serialized, target);
    expect(parsed?.elements.map((element) => element.type)).toEqual([
      'textFrame',
      'shape',
      'group',
    ]);
    let sequence = 0;
    const result = pasteReachDeckNativeElements(target, 'page-1', parsed!, (prefix) => {
      sequence += 1;
      return `target-${prefix}-${sequence}`;
    });
    expect(result.elementIds).toHaveLength(3);
    expect(result.document.nativeSlides[0]!.slide.elements.map((element) => element.id)).toEqual(
      expect.arrayContaining(['target-element-1', 'target-element-2', 'target-element-3']),
    );
  });

  it('rejects foreign media even when the target has an identically named resource', () => {
    const source = createEditorDocument();
    const target = { ...createEditorDocument(), id: 'target-deck' };
    const media = {
      id: 'shared-media',
      objectKey: 'uploads/shared.png',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    source.resources.media.push(media);
    target.resources.media.push(structuredClone(media));
    source.nativeSlides[0]!.slide.elements.push({
      id: 'foreign-image',
      type: 'image',
      transform: { x: 0, y: 0, width: 120, height: 80 },
      zIndex: 2,
      resourceId: media.id,
      fit: 'contain',
      alt: 'Shared ID must not authorize copying',
    });
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['foreign-image'])!;

    expect(
      parseReachDeckElementsClipboard(
        serializeReachDeckElementsClipboard(fragment, source)!,
        target,
      ),
    ).toBeUndefined();
    expect(pasteReachDeckNativeElements(target, 'page-1', fragment, () => 'element')).toEqual({
      document: target,
      elementIds: [],
    });
  });

  it('rejects nested resource, theme, provenance, and scientific dependencies', () => {
    const base = {
      id: 'safe',
      type: 'shape' as const,
      transform: { x: 0, y: 0, width: 100, height: 50 },
      zIndex: 1,
      geometry: { kind: 'preset' as const, preset: 'rect' },
    };
    expect(
      isReachDeckElementsClipboardSelfContained([
        { ...base, style: { fill: { kind: 'image', resourceId: 'picture', mode: 'cover' } } },
        {
          ...base,
          id: 'video-group',
          type: 'group',
          children: [
            {
              id: 'video',
              type: 'video',
              transform: base.transform,
              zIndex: 1,
              resourceId: 'video',
              posterResourceId: 'poster',
              playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
              title: 'Video',
            },
          ],
        },
        { ...base, style: { fill: { kind: 'solid', color: { kind: 'theme', token: 'accent' } } } },
        { ...base, source: { partPath: 'ppt/slides/slide1.xml' } },
        {
          ...base,
          id: 'scientific',
          type: 'scientificVisual',
          ariaLabel: 'Unsafe visual',
          documentHtml: '<div></div>',
          manifest: {},
        },
      ] as never),
    ).toBe(false);
    expect(
      isReachDeckElementsClipboardSelfContained([
        base,
        {
          ...base,
          id: 'table',
          type: 'table',
          columnWidths: [100],
          rowHeights: [50],
          rows: [],
        },
        {
          ...base,
          id: 'diagram',
          type: 'diagram',
          diagramType: 'cycle',
          nodes: [],
          edges: [],
        },
      ] as never),
    ).toBe(true);
  });

  it('keeps the bounded sensitive-field guard in front of cross-Deck validation', () => {
    const source = createEditorDocument();
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['title-1'])!;
    const payload = JSON.parse(serializeReachDeckElementsClipboard(fragment, source)!) as Record<
      string,
      unknown
    >;
    payload.documentId = 'target-deck';
    (payload.elements as Array<Record<string, unknown>>)[0]!.objectKey = 'leak';

    expect(
      parseReachDeckElementsClipboard(JSON.stringify(payload), {
        ...createEditorDocument(),
        id: 'target-deck',
      }),
    ).toBeUndefined();
  });
});
