import type { PageOutline, PagedDeckOutline } from './generationTypes.js';

/** Background artwork families. Cover, agenda and closing own one image; body pages share 1–3. */
export const REACH_DECK_COURSE_BACKGROUND_SLOTS = ['cover', 'agenda', 'closing', 'body'] as const;
export type ReachDeckCourseBackgroundSlot = (typeof REACH_DECK_COURSE_BACKGROUND_SLOTS)[number];

/**
 * One shared background, registered on the outline when it is adopted. Its id is allocated by the
 * host and never derived from a page, so deleting, moving or editing pages cannot change it.
 */
export interface ReachDeckCourseBackgroundGroup {
  id: string;
  slot: ReachDeckCourseBackgroundSlot;
}

/** A slide page's membership in one registered background group. */
export interface ReachDeckCourseBackgroundAssignment {
  groupId: string;
}

/** Opacity of the theme-colored veil painted over the artwork, below every authored element. */
export function reachDeckCourseBackgroundVeilOpacity(slot: ReachDeckCourseBackgroundSlot): number {
  if (slot === 'cover') return 0.2;
  if (slot === 'closing') return 0.68;
  if (slot === 'agenda') return 0.78;
  return 0.84;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isGroupId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export function parseReachDeckCourseBackgroundAssignment(
  value: unknown,
): ReachDeckCourseBackgroundAssignment {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'groupId') ||
    !isGroupId(value.groupId)
  )
    throw new Error('Invalid course background assignment.');
  return { groupId: value.groupId };
}

export function parseReachDeckCourseBackgroundGroups(
  value: unknown,
): ReachDeckCourseBackgroundGroup[] {
  if (!Array.isArray(value)) throw new Error('Invalid course background groups.');
  const groups = value.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => key !== 'id' && key !== 'slot') ||
      !isGroupId(entry.id) ||
      typeof entry.slot !== 'string' ||
      !(REACH_DECK_COURSE_BACKGROUND_SLOTS as readonly string[]).includes(entry.slot)
    )
      throw new Error('Invalid course background group.');
    return { id: entry.id, slot: entry.slot as ReachDeckCourseBackgroundSlot };
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length)
    throw new Error('Course background group ids must be unique.');
  return groups;
}

/** Every page membership must name a registered group. */
export function assertReachDeckCourseBackgroundIntegrity(outline: PagedDeckOutline): void {
  const ids = new Set((outline.backgroundGroups ?? []).map((group) => group.id));
  for (const page of outline.pages)
    if (page.courseBackground !== undefined && !ids.has(page.courseBackground.groupId))
      throw new Error(`Page ${page.id} references an unknown course background group.`);
}

export function resolveReachDeckCourseBackgroundGroup(
  outline: Pick<PagedDeckOutline, 'backgroundGroups'>,
  page: Pick<PageOutline, 'courseBackground' | 'sceneType'>,
): ReachDeckCourseBackgroundGroup | undefined {
  if (page.sceneType !== 'slide' || page.courseBackground === undefined) return undefined;
  return outline.backgroundGroups?.find((group) => group.id === page.courseBackground!.groupId);
}

const fixedSlot = (page: PageOutline): ReachDeckCourseBackgroundSlot | undefined => {
  const role = page.designIntent?.pageRole;
  return role === 'cover' || role === 'agenda' || role === 'closing' ? role : undefined;
};

const bodyPoolSize = (bodyPageCount: number): number =>
  bodyPageCount >= 10 ? 3 : bodyPageCount >= 4 ? 2 : 1;

/**
 * Fix background groups on slide pages of a reference-design outline.
 *
 * `initial` plans the whole deck when no group is registered yet: the first cover, agenda and
 * closing pages own their artwork and the remaining slides split into 1–3 contiguous body groups.
 * Otherwise registered groups and memberships never move; a slide without one joins the nearest
 * preceding body group (or the following one), so inserting or deleting pages cannot reshuffle
 * backgrounds. A new body group is registered only when no body group exists at all.
 */
export function assignReachDeckCourseBackgrounds(
  outline: PagedDeckOutline,
  options: { initial: boolean },
): PagedDeckOutline {
  if (outline.designContext === undefined) return outline;
  const slides = outline.pages
    .filter((page) => page.sceneType === 'slide')
    .sort((left, right) => left.order - right.order);
  const groups = [...(outline.backgroundGroups ?? [])];
  const slotOf = new Map(groups.map((group) => [group.id, group.slot] as const));
  const membership = new Map<string, string>();
  for (const page of slides)
    if (page.courseBackground !== undefined) membership.set(page.id, page.courseBackground.groupId);
  const register = (slot: ReachDeckCourseBackgroundSlot): string => {
    let id: string = slot === 'body' ? '' : `background-${slot}`;
    for (let index = 1; id === '' || slotOf.has(id); index += 1) id = `background-${slot}-${index}`;
    groups.push({ id, slot });
    slotOf.set(id, slot);
    return id;
  };

  if (groups.length === 0) {
    if (!options.initial) return outline;
    const body: PageOutline[] = [];
    const claimed = new Set<ReachDeckCourseBackgroundSlot>();
    for (const page of slides) {
      const slot = fixedSlot(page);
      if (slot !== undefined && !claimed.has(slot)) {
        claimed.add(slot);
        membership.set(page.id, register(slot));
      } else body.push(page);
    }
    const pool = bodyPoolSize(body.length);
    const bodyGroups = new Map<number, string>();
    body.forEach((page, index) => {
      const bucket = Math.floor((index * pool) / body.length);
      if (!bodyGroups.has(bucket)) bodyGroups.set(bucket, register('body'));
      membership.set(page.id, bodyGroups.get(bucket)!);
    });
  } else {
    const bodyAt = (index: number) => {
      const groupId = membership.get(slides[index]!.id);
      return groupId !== undefined && slotOf.get(groupId) === 'body' ? groupId : undefined;
    };
    slides.forEach((page, index) => {
      if (membership.has(page.id)) return;
      let groupId: string | undefined;
      for (let cursor = index - 1; cursor >= 0 && groupId === undefined; cursor -= 1)
        groupId = bodyAt(cursor);
      for (let cursor = index + 1; cursor < slides.length && groupId === undefined; cursor += 1)
        groupId = bodyAt(cursor);
      groupId ??= groups.find((group) => group.slot === 'body')?.id ?? register('body');
      membership.set(page.id, groupId);
    });
  }

  let changed = groups.length !== (outline.backgroundGroups?.length ?? 0);
  const pages = outline.pages.map((page) => {
    const groupId = membership.get(page.id);
    if (groupId === undefined || page.courseBackground !== undefined) return page;
    changed = true;
    return { ...page, courseBackground: { groupId } };
  });
  return changed ? { ...outline, backgroundGroups: groups, pages } : outline;
}
