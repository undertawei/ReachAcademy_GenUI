import { describe, expect, it } from 'vitest';
import {
  createBlankReachDeckDocument,
  parseReachDeckDocument,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { rebaseReachDeckSave } from './reach-deck-save-rebase.js';

function document(): ReachDeckDocument {
  const first = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
  const second = createBlankReachDeckDocument({ id: 'other', title: 'Second' });
  return {
    ...first,
    pages: [...first.pages, { ...second.pages[0]!, order: 2 }],
    nativeSlides: [...first.nativeSlides, ...second.nativeSlides],
  };
}

function editPage(base: ReachDeckDocument, index: number, title: string): ReachDeckDocument {
  return {
    ...base,
    pages: base.pages.map((page, i) =>
      i === index ? { ...page, title, revision: page.revision + 1 } : page,
    ),
    nativeSlides: base.nativeSlides.map((binding, i) =>
      i === index ? { ...binding, slide: { ...binding.slide, title } } : binding,
    ),
  };
}

describe('rebaseReachDeckSave', () => {
  it('preserves a remote page update alongside local title and ordering changes', () => {
    const base = document();
    const local = {
      ...base,
      title: 'Local title',
      pages: base.pages.map((page, index) => ({ ...page, order: 2 - index })),
    };
    const remote = editPage(base, 1, 'Remote page');
    const merged = rebaseReachDeckSave(base, local, remote)!;
    expect(merged.title).toBe('Local title');
    expect(merged.pages.map((page) => page.pageId)).toEqual(
      [...base.pages].reverse().map((page) => page.pageId),
    );
    expect(merged.nativeSlides[1]!.slide.title).toBe('Remote page');
    expect(merged.pages[0]!.revision).toBe(remote.pages[1]!.revision);
  });

  it('merges independent pages but refuses concurrent edits to the same page', () => {
    const base = document();
    expect(
      rebaseReachDeckSave(base, editPage(base, 0, 'Local'), editPage(base, 1, 'Remote'))?.pages.map(
        (page) => page.title,
      ),
    ).toEqual(['Local', 'Remote']);
    expect(
      rebaseReachDeckSave(base, editPage(base, 0, 'Local'), editPage(base, 0, 'Remote')),
    ).toBeUndefined();
  });

  it('uses the remote revision when only its stamp changed', () => {
    const base = document();
    const remote = {
      ...base,
      pages: base.pages.map((page) => ({ ...page, revision: page.revision + 3 })),
    };
    const merged = rebaseReachDeckSave(base, editPage(base, 0, 'Local'), remote)!;
    expect(merged.pages[0]!.title).toBe('Local');
    expect(merged.pages[0]!.revision).toBe(remote.pages[0]!.revision);
  });

  it('adopts the remote document when the attempted candidate has no local changes', () => {
    const base = document();
    const remote = editPage(base, 0, 'Remote');
    expect(rebaseReachDeckSave(base, structuredClone(base), remote)).toEqual(remote);
  });

  it('accepts deletion of an untouched page but refuses deletion of an edited page', () => {
    const base = document();
    const remote = { ...base, pages: [base.pages[0]!], nativeSlides: [base.nativeSlides[0]!] };
    expect(
      rebaseReachDeckSave(base, { ...base, title: 'Local title' }, remote)?.pages,
    ).toHaveLength(1);
    expect(rebaseReachDeckSave(base, editPage(base, 1, 'Local edit'), remote)).toBeUndefined();
  });

  it('unions additive media resources while retaining remote narration resource references', () => {
    const base = document();
    const localMedia = {
      id: 'local-media',
      objectKey: 'images/local.png',
      contentType: 'image/png',
      digest: 'local',
    };
    const remoteMedia = {
      id: 'remote-audio',
      objectKey: 'audio/remote.mp3',
      contentType: 'audio/mpeg',
      digest: 'remote',
    };
    const local = {
      ...base,
      title: 'Local',
      resources: { ...base.resources, media: [localMedia] },
    };
    const remote = {
      ...base,
      resources: { ...base.resources, media: [remoteMedia] },
      nativeSlides: base.nativeSlides.map((binding, index) =>
        index === 1
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                narration: {
                  markdown: 'Remote narration',
                  audioResourceId: remoteMedia.id,
                  segments: [{ text: 'Remote narration', start: 0, end: 1 }],
                },
              },
            }
          : binding,
      ),
    };
    parseReachDeckDocument(remote);
    const merged = rebaseReachDeckSave(base, local, remote)!;
    expect(merged.resources.media.map((media) => media.id)).toEqual([
      'remote-audio',
      'local-media',
    ]);
    expect(merged.nativeSlides[1]!.slide.narration?.audioResourceId).toBe('remote-audio');
  });

  it('refuses conflicting resource ids and resource changes affecting concurrent edits', () => {
    const base = document();
    const media = {
      id: 'shared',
      objectKey: 'images/old.png',
      contentType: 'image/png',
      digest: 'old',
    };
    const withMedia = { ...base, resources: { ...base.resources, media: [media] } };
    const replaced = {
      ...withMedia,
      resources: { ...withMedia.resources, media: [{ ...media, objectKey: 'images/new.png' }] },
    };
    expect(
      rebaseReachDeckSave(withMedia, editPage(withMedia, 0, 'Local'), replaced),
    ).toBeUndefined();
    expect(rebaseReachDeckSave(base, withMedia, replaced)).toBeUndefined();
  });

  it('refuses incompatible structural edits and same-field metadata edits', () => {
    const base = document();
    const local = {
      ...base,
      pages: [...base.pages].reverse().map((page, order) => ({ ...page, order })),
    };
    const remote = { ...base, pages: [base.pages[0]!], nativeSlides: [base.nativeSlides[0]!] };
    expect(rebaseReachDeckSave(base, local, remote)).toBeUndefined();
    expect(
      rebaseReachDeckSave(base, { ...base, title: 'Local' }, { ...base, title: 'Remote' }),
    ).toBeUndefined();
  });
});
