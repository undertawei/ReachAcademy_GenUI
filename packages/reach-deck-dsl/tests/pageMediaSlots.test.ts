import { describe, expect, it } from 'vitest';
import {
  createBlankReachDeckDocument,
  getReachDeckRegenerationPageCapabilities,
  parseReachDeckPageMediaSlot,
  parseSlideGenerationMetadataValue,
  type ReachDeckPageMediaSlot,
} from '../src/index.js';
import { NOW, slideMetadata } from './generationFixtures.js';

const slot: ReachDeckPageMediaSlot = {
  assetId: 'image-1',
  plannedIndex: 0,
  plannedAsset: {
    kind: 'image',
    purpose: 'Explain the solar system',
    prompt: 'The solar system',
    alt: 'The solar system',
    aspectRatio: '16:9',
    placement: 'primary',
  },
  planDigest: 'a'.repeat(64),
  elementId: 'image-element-1',
  binding: 'image-element',
  resourceId: 'image-resource-1',
  status: 'ready',
  attempt: 1,
};
const failed: ReachDeckPageMediaSlot = {
  ...slot,
  status: 'failed',
  failure: { reason: 'timeout', retryable: true, at: NOW },
};

describe('authoring image slot metadata', () => {
  it('roundtrips a native scientific binding and rejects mixed bitmap identities', () => {
    const { resourceId: _resourceId, ...common } = slot;
    const native = {
      ...common,
      binding: 'scientific-visual',
      contentDigest: 'b'.repeat(64),
      plannedAsset: {
        kind: 'scientific-visual',
        purpose: 'Explain motion',
        prompt: 'Two balls move',
        alt: 'Motion',
        aspectRatio: '16:9',
        placement: 'primary',
      },
    };
    expect(parseReachDeckPageMediaSlot(native)).toEqual(native);
    for (const changes of [
      { resourceId: 'unexpected' },
      { contentDigest: 'invalid' },
      { status: 'failed', failure: failed.failure },
      { plannedAsset: slot.plannedAsset },
    ])
      expect(() => parseReachDeckPageMediaSlot({ ...native, ...changes })).toThrow();
    expect(() => parseReachDeckPageMediaSlot({ ...slot, contentDigest: 'b'.repeat(64) })).toThrow();
  });
  it('roundtrips successful and failed bindings and keeps legacy metadata valid', () => {
    for (const binding of ['image-element', 'shape-fill'] as const) {
      for (const value of [slot, failed]) {
        const input = { ...value, binding };
        expect(parseReachDeckPageMediaSlot(input)).toEqual(input);
        const metadata = { ...slideMetadata('p'), mediaSlots: [input] };
        expect(parseSlideGenerationMetadataValue(metadata)).toEqual(metadata);
      }
    }
    expect(parseSlideGenerationMetadataValue(slideMetadata('p'))).not.toHaveProperty('mediaSlots');
  });

  it('preserves explicit teacher replacement provenance and rejects nonliteral marker values', () => {
    expect(parseReachDeckPageMediaSlot({ ...slot, teacherReplaced: true })).toEqual({
      ...slot,
      teacherReplaced: true,
    });
    for (const teacherReplaced of [false, 'true', null, 1])
      expect(() => parseReachDeckPageMediaSlot({ ...slot, teacherReplaced })).toThrow();
  });

  it.each([
    { extra: true },
    { plannedIndex: -1 },
    { plannedIndex: 0.5 },
    { planDigest: 'not-a-sha256' },
    { elementId: '' },
    { resourceId: '' },
    { binding: 'background' },
    { attempt: 0 },
    { attempt: 1.5 },
    { status: 'pending' },
    { status: 'failed' },
    { plannedAsset: { ...slot.plannedAsset, extra: true } },
    { failure: failed.failure },
  ])('rejects invalid slot fields %j', (changes) => {
    expect(() => parseReachDeckPageMediaSlot({ ...slot, ...changes })).toThrow();
  });

  it.each([
    { reason: 'unknown' },
    { retryable: 'true' },
    { at: 'not-a-date' },
    { at: '2026-10-17' },
    { extra: true },
  ])('rejects invalid failures %j', (changes) => {
    expect(() =>
      parseReachDeckPageMediaSlot({
        ...failed,
        failure: { ...failed.failure, ...changes },
      }),
    ).toThrow();
  });

  it('rejects duplicate image bindings rather than making retry target resolution ambiguous', () => {
    for (const second of [
      { ...slot, plannedIndex: 1, elementId: 'other' },
      { ...slot, assetId: 'other', elementId: 'other' },
      { ...slot, assetId: 'other', plannedIndex: 1 },
    ])
      expect(() =>
        parseSlideGenerationMetadataValue({
          ...slideMetadata('p'),
          mediaSlots: [slot, second],
        }),
      ).toThrow(/duplicate/);
    expect(() =>
      parseSlideGenerationMetadataValue({ ...slideMetadata('p'), mediaSlots: {} }),
    ).toThrow();
  });

  it('enables image regeneration only for native pages with persisted slots', () => {
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt: NOW });
    const pageId = document.pages[0]!.pageId;
    expect(getReachDeckRegenerationPageCapabilities(document, pageId).channels.image).toBe(false);
    expect(getReachDeckRegenerationPageCapabilities(document, pageId, []).channels.image).toBe(
      false,
    );
    expect(getReachDeckRegenerationPageCapabilities(document, pageId, [slot]).channels.image).toBe(
      true,
    );
    expect(
      getReachDeckRegenerationPageCapabilities(document, 'missing', [slot]).channels.image,
    ).toBe(false);
  });
});
