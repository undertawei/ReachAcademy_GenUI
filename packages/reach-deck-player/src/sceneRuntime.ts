import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import type { ReachDeckRuntimeByPageId, ReachDeckSceneRuntimeState } from './types.js';

export const isRuntimeStateForPage = (
  state: ReachDeckSceneRuntimeState,
  page: ReachDeckPublishedPage,
): boolean =>
  page.sceneType !== 'slide' &&
  state.kind === page.sceneType &&
  state.sceneId === page.scene.id &&
  state.sourceRevision === page.revision;

export const reconcileReachDeckRuntime = (
  runtime: ReachDeckRuntimeByPageId,
  document: ReachDeckDocument,
  options: { migrateInteractiveRevision?: boolean } = {},
): ReachDeckRuntimeByPageId => {
  const pagesById = new Map(document.pages.map((page) => [page.pageId, page]));
  let changed = false;
  const entries = Object.entries(runtime).flatMap(([pageId, state]) => {
    const page = pagesById.get(pageId);
    if (page !== undefined && isRuntimeStateForPage(state, page)) return [[pageId, state] as const];
    if (
      options.migrateInteractiveRevision === true &&
      page?.sceneType === 'interactive' &&
      state.kind === 'interactive' &&
      state.sceneId === page.scene.id
    ) {
      changed = true;
      return [[pageId, { ...state, sourceRevision: page.revision }] as const];
    }
    changed = true;
    return [];
  });
  return changed ? Object.fromEntries(entries) : runtime;
};
