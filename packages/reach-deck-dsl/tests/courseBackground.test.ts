import { describe, expect, it } from 'vitest';
import {
  addOutlinePage,
  assignReachDeckCourseBackgrounds,
  deleteOutlinePage,
  editOutlinePage,
  parsePagedDeckOutlineValue,
  reachDeckCourseBackgroundVeilOpacity,
  resolveReachDeckCourseBackgroundGroup,
  type PageOutline,
  type PagedDeckOutline,
} from '../src/index.js';

const designContext = {} as NonNullable<PagedDeckOutline['designContext']>;

function page(
  index: number,
  role: string = 'content',
  sceneType: PageOutline['sceneType'] = 'slide',
): PageOutline {
  return {
    id: `p${index}`,
    order: index,
    sceneType,
    title: `Page ${index}`,
    designIntent: { pageRole: role } as PageOutline['designIntent'],
  };
}

function outline(pages: PageOutline[]): PagedDeckOutline {
  return { id: 'o', title: 'Deck', pages, designContext };
}

const groups = (value: PagedDeckOutline) =>
  value.pages.map((entry) => resolveReachDeckCourseBackgroundGroup(value, entry)?.id ?? '-');

describe('course background groups', () => {
  it('registers cover, agenda and closing groups and splits body slides contiguously', () => {
    const pages = [
      page(1, 'cover'),
      page(2, 'agenda'),
      ...Array.from({ length: 10 }, (_, index) => page(index + 3)),
      page(13, 'content', 'quiz'),
      page(14, 'closing'),
    ];
    const planned = assignReachDeckCourseBackgrounds(outline(pages), { initial: true });
    expect(planned.backgroundGroups).toEqual([
      { id: 'background-cover', slot: 'cover' },
      { id: 'background-agenda', slot: 'agenda' },
      { id: 'background-closing', slot: 'closing' },
      { id: 'background-body-1', slot: 'body' },
      { id: 'background-body-2', slot: 'body' },
      { id: 'background-body-3', slot: 'body' },
    ]);
    expect(groups(planned)).toEqual([
      'background-cover',
      'background-agenda',
      ...Array(4).fill('background-body-1'),
      ...Array(3).fill('background-body-2'),
      ...Array(3).fill('background-body-3'),
      '-',
      'background-closing',
    ]);
  });

  it.each([
    [3, 1],
    [4, 2],
    [10, 3],
  ])('uses a pool sized for %i body slides', (count, pool) => {
    const result = assignReachDeckCourseBackgrounds(
      outline(Array.from({ length: count }, (_, index) => page(index + 1))),
      { initial: true },
    );
    expect(result.backgroundGroups).toHaveLength(pool);
  });

  it('never plans legacy outlines, and page edits never move a registered group', () => {
    const legacy = { ...outline([page(1)]), designContext: undefined };
    expect(assignReachDeckCourseBackgrounds(legacy, { initial: true })).toBe(legacy);
    const unplanned = outline([page(1), page(2)]);
    expect(assignReachDeckCourseBackgrounds(unplanned, { initial: false })).toBe(unplanned);

    const planned = assignReachDeckCourseBackgrounds(
      outline(Array.from({ length: 6 }, (_, index) => page(index + 1))),
      { initial: true },
    );
    // Deleting pages from body-1 keeps the registry and the remaining members.
    let changed = deleteOutlinePage(planned, 'p1').outline;
    changed = deleteOutlinePage(changed, 'p2').outline;
    changed = addOutlinePage(changed, 'p4', () => 'new').outline;
    changed = assignReachDeckCourseBackgrounds(changed, { initial: false });
    expect(changed.backgroundGroups).toEqual(planned.backgroundGroups);
    expect(groups(changed)).toEqual([
      'background-body-1',
      'background-body-2',
      'background-body-2',
      'background-body-2',
      'background-body-2',
    ]);
    const edited = editOutlinePage(changed, 'p3', ({ courseBackground: _group, ...rest }) => ({
      ...rest,
      title: 'Edited',
    })).outline;
    expect(edited.pages[0]!.courseBackground).toEqual({ groupId: 'background-body-1' });
  });

  it('registers a body group only when an incremental slide has no body group to join', () => {
    const planned = assignReachDeckCourseBackgrounds(outline([page(1, 'cover')]), {
      initial: true,
    });
    const added = assignReachDeckCourseBackgrounds(
      addOutlinePage(planned, 'p1', () => 'p2').outline,
      { initial: false },
    );
    expect(added.backgroundGroups).toEqual([
      { id: 'background-cover', slot: 'cover' },
      { id: 'background-body-1', slot: 'body' },
    ]);
    expect(groups(added)).toEqual(['background-cover', 'background-body-1']);
  });

  it('validates the stored registry and every page reference', () => {
    const stored = {
      id: 'o',
      title: 'Deck',
      backgroundGroups: [{ id: 'background-body-1', slot: 'body' }],
      pages: [
        {
          id: 'p1',
          order: 1,
          sceneType: 'slide',
          title: 'A',
          courseBackground: { groupId: 'background-body-1' },
        },
      ],
    };
    expect(parsePagedDeckOutlineValue(stored).pages[0]!.courseBackground).toEqual({
      groupId: 'background-body-1',
    });
    for (const invalid of [
      { ...stored, backgroundGroups: [] },
      { ...stored, backgroundGroups: [{ id: 'background-body-1', slot: 'hero' }] },
      {
        ...stored,
        backgroundGroups: [...stored.backgroundGroups, ...stored.backgroundGroups],
      },
    ])
      expect(() => parsePagedDeckOutlineValue(invalid)).toThrow();
  });

  it('veils body pages more than the cover', () => {
    expect(reachDeckCourseBackgroundVeilOpacity('cover')).toBe(0.2);
    expect(reachDeckCourseBackgroundVeilOpacity('agenda')).toBe(0.78);
    expect(reachDeckCourseBackgroundVeilOpacity('closing')).toBe(0.68);
    expect(reachDeckCourseBackgroundVeilOpacity('body')).toBe(0.84);
  });
});

import { resolveDeckDesignTheme, parseStoredReachDeckDesignContextValue } from '../src/index.js';
import {
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '../src/reference-library/index.js';

describe('subject typography', () => {
  const context = (typographyProfile?: string) => ({
    schemaVersion: 'reach-deck-design-context/v1',
    libraryVersion: REFERENCE_LIBRARY_VERSION,
    librarySha256: REFERENCE_LIBRARY_SHA256,
    paletteReferenceId: '',
    originalDesign: true,
    ...(typographyProfile === undefined ? {} : { typographyProfile }),
    imageStyleReferenceIds: [],
    visualIntent: 'Calm',
    resolvedColors: {
      background: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#111111',
      muted: '#555555',
      accent: '#006699',
      success: '#006600',
      warning: '#663300',
    },
  });

  it('pairs serif titles with kai body text for humanities and keeps sans otherwise', () => {
    const humanities = parseStoredReachDeckDesignContextValue(context('humanities'));
    expect(resolveDeckDesignTheme(undefined, humanities)).toMatchObject({
      fontDisplay: 'Source Han Serif SC',
      fontBody: 'LXGW WenKai',
    });
    for (const profile of ['general', undefined])
      expect(
        resolveDeckDesignTheme(undefined, parseStoredReachDeckDesignContextValue(context(profile))),
      ).toMatchObject({ fontDisplay: 'Source Han Sans VF', fontBody: 'Source Han Sans VF' });
    expect(() => parseStoredReachDeckDesignContextValue(context('fancy'))).toThrow();
  });
});
