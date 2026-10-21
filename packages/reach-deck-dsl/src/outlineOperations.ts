import type { PageOutline, PagedDeckOutline } from './generationTypes.js';

export type OutlineChange =
  | { kind: 'add'; pageId: string; afterPageId?: string }
  | { kind: 'delete'; pageId: string }
  | { kind: 'duplicate'; pageId: string; sourcePageId: string }
  | { kind: 'reorder'; pageId: string; beforePageId?: string }
  | { kind: 'semantic'; pageId: string }
  | { kind: 'root' };

export interface OutlineOperationResult {
  outline: PagedDeckOutline;
  change: OutlineChange;
}

export type IdFactory = (prefix: string) => string;

export const normalizePageOrder = (pages: PageOutline[]): PageOutline[] =>
  pages.map((page, index) => (page.order === index + 1 ? page : { ...page, order: index + 1 }));

const cloneJson = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneJson(nested)]),
    ) as T;
  }
  return value;
};

const uniqueAllocator = (outline: PagedDeckOutline, createId: IdFactory): IdFactory => {
  const ids = new Set(outline.pages.map((page) => page.id));
  return (prefix) => {
    const id = createId(prefix);
    if (id.trim().length === 0) throw new Error('Generated ID must not be empty.');
    if (ids.has(id)) throw new Error(`ID allocation conflict: ${id}`);
    ids.add(id);
    return id;
  };
};

const ordered = (outline: PagedDeckOutline): PageOutline[] =>
  outline.pages.slice().sort((left, right) => left.order - right.order);

export const editOutlineRoot = (
  outline: PagedDeckOutline,
  update: (value: Pick<PagedDeckOutline, 'id' | 'title'>) => Pick<PagedDeckOutline, 'id' | 'title'>,
): OutlineOperationResult => {
  const next = update({ id: outline.id, title: outline.title });
  return {
    outline: { ...outline, id: next.id, title: next.title },
    change: { kind: 'root' },
  };
};

export const addOutlinePage = (
  outline: PagedDeckOutline,
  afterPageId: string | undefined,
  createId: IdFactory,
): OutlineOperationResult => {
  const pages = ordered(outline);
  if (afterPageId !== undefined && !pages.some((page) => page.id === afterPageId)) {
    throw new Error('Cannot find the page after which to add a page.');
  }
  const id = uniqueAllocator(outline, createId)('page');
  const page: PageOutline = {
    id,
    order: 1,
    sceneType: 'slide',
    title: 'New page',
  };
  const index = afterPageId
    ? pages.findIndex((candidate) => candidate.id === afterPageId) + 1
    : pages.length;
  pages.splice(index, 0, page);
  return {
    outline: { ...outline, pages: normalizePageOrder(pages) },
    change: { kind: 'add', pageId: id, ...(afterPageId ? { afterPageId } : {}) },
  };
};

export const deleteOutlinePage = (
  outline: PagedDeckOutline,
  pageId: string,
): OutlineOperationResult => {
  if (!outline.pages.some((page) => page.id === pageId)) {
    throw new Error('Cannot find the page to delete.');
  }
  if (outline.pages.length === 1) {
    throw new Error('A paged outline must retain at least one page.');
  }
  return {
    outline: {
      ...outline,
      pages: normalizePageOrder(ordered(outline).filter((page) => page.id !== pageId)),
    },
    change: { kind: 'delete', pageId },
  };
};

export const duplicateOutlinePage = (
  outline: PagedDeckOutline,
  sourcePageId: string,
  createId: IdFactory,
): OutlineOperationResult => {
  const pages = ordered(outline);
  const sourceIndex = pages.findIndex((page) => page.id === sourcePageId);
  if (sourceIndex < 0) throw new Error('Cannot find the page to duplicate.');
  const id = uniqueAllocator(outline, createId)('page');
  const copy: PageOutline = {
    ...cloneJson(pages[sourceIndex]),
    id,
    title: `${pages[sourceIndex].title} copy`,
  };
  pages.splice(sourceIndex + 1, 0, copy);
  return {
    outline: { ...outline, pages: normalizePageOrder(pages) },
    change: { kind: 'duplicate', pageId: id, sourcePageId },
  };
};

export const moveOutlinePage = (
  outline: PagedDeckOutline,
  pageId: string,
  beforePageId: string | undefined,
): OutlineOperationResult => {
  const pages = ordered(outline);
  const sourceIndex = pages.findIndex((page) => page.id === pageId);
  if (sourceIndex < 0) throw new Error('Cannot find the page to move.');
  if (beforePageId !== undefined && !pages.some((page) => page.id === beforePageId)) {
    throw new Error('Cannot find the move target page.');
  }
  if (beforePageId !== pageId) {
    const [page] = pages.splice(sourceIndex, 1);
    const targetIndex =
      beforePageId === undefined
        ? pages.length
        : pages.findIndex((candidate) => candidate.id === beforePageId);
    pages.splice(targetIndex, 0, page);
  }
  return {
    outline: { ...outline, pages: normalizePageOrder(pages) },
    change: { kind: 'reorder', pageId, ...(beforePageId ? { beforePageId } : {}) },
  };
};

export const editOutlinePage = (
  outline: PagedDeckOutline,
  pageId: string,
  update: (page: PageOutline) => PageOutline,
): OutlineOperationResult => {
  if (!outline.pages.some((page) => page.id === pageId)) {
    throw new Error('Cannot find the page to edit.');
  }
  return {
    outline: {
      ...outline,
      pages: normalizePageOrder(
        ordered(outline).map((page) => {
          if (page.id !== pageId) return page;
          const { courseBackground: _dropped, ...updated } = update(cloneJson(page));
          // The background group is host-owned and fixed at adoption; edits never move it.
          return {
            ...updated,
            id: page.id,
            order: page.order,
            ...(page.courseBackground === undefined
              ? {}
              : { courseBackground: page.courseBackground }),
          };
        }),
      ),
    },
    change: { kind: 'semantic', pageId },
  };
};
