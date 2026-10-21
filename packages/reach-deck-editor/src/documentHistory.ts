import { reachDeckValuesEqual, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { reconcilePageSelection, type PageSelection } from './pageSelection.js';
import {
  mergeReachDeckNativeSlideAnimations,
  mergeReachDeckNativeSlideDuration,
} from './narrationAnimationMerge.js';

export const REACH_DECK_DOCUMENT_HISTORY_LIMIT = 50;

export interface ReachDeckDocumentSnapshot {
  document: ReachDeckDocument;
  activePageId?: string;
  selectedElementId?: string;
  selectedElementIds: string[];
  selectedAnimationId?: string;
  pageSelection?: PageSelection;
}

export interface ReachDeckDocumentHistory {
  past: ReachDeckDocumentSnapshot[];
  future: ReachDeckDocumentSnapshot[];
  openGroup?: string;
}

export const createReachDeckDocumentHistory = (): ReachDeckDocumentHistory => ({
  past: [],
  future: [],
});

export function recordReachDeckDocumentEdit(
  history: ReachDeckDocumentHistory,
  current: ReachDeckDocumentSnapshot,
  group?: string,
): ReachDeckDocumentHistory {
  if (group !== undefined && history.openGroup === group) {
    return { ...history, future: [] };
  }
  return {
    past: [...history.past, current].slice(-REACH_DECK_DOCUMENT_HISTORY_LIMIT),
    future: [],
    ...(group === undefined ? {} : { openGroup: group }),
  };
}

export function closeReachDeckDocumentHistoryGroup(
  history: ReachDeckDocumentHistory,
): ReachDeckDocumentHistory {
  if (history.openGroup === undefined) return history;
  const { openGroup: _openGroup, ...closed } = history;
  return closed;
}

export function undoReachDeckDocumentEdit(
  history: ReachDeckDocumentHistory,
  current: ReachDeckDocumentSnapshot,
): { history: ReachDeckDocumentHistory; snapshot?: ReachDeckDocumentSnapshot } {
  const snapshot = history.past.at(-1);
  if (snapshot === undefined) return { history };
  return {
    snapshot,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, REACH_DECK_DOCUMENT_HISTORY_LIMIT),
    },
  };
}

export function redoReachDeckDocumentEdit(
  history: ReachDeckDocumentHistory,
  current: ReachDeckDocumentSnapshot,
): { history: ReachDeckDocumentHistory; snapshot?: ReachDeckDocumentSnapshot } {
  const snapshot = history.future[0];
  if (snapshot === undefined) return { history };
  return {
    snapshot,
    history: {
      past: [...history.past, current].slice(-REACH_DECK_DOCUMENT_HISTORY_LIMIT),
      future: history.future.slice(1),
    },
  };
}

export function rebaseReachDeckDocumentHistory(
  history: ReachDeckDocumentHistory,
  previousServer: ReachDeckDocument,
  nextServer: ReachDeckDocument,
  currentDraft: ReachDeckDocument,
): { history: ReachDeckDocumentHistory; invalidated: boolean } {
  const nextStructure = documentStructureFingerprint(nextServer);
  if (
    documentStructureFingerprint(previousServer) !== nextStructure &&
    documentStructureFingerprint(currentDraft) !== nextStructure
  ) {
    return { history: createReachDeckDocumentHistory(), invalidated: true };
  }
  return {
    invalidated: false,
    history: {
      ...history,
      past: history.past.map((snapshot) =>
        rebaseSnapshot(snapshot, previousServer, nextServer, currentDraft),
      ),
      future: history.future.map((snapshot) =>
        rebaseSnapshot(snapshot, previousServer, nextServer, currentDraft),
      ),
    },
  };
}

export function rebaseReachDeckDocumentDraft(
  draft: ReachDeckDocument,
  previousServer: ReachDeckDocument,
  nextServer: ReachDeckDocument,
): { document: ReachDeckDocument; invalidated: boolean } {
  const nextStructure = documentStructureFingerprint(nextServer);
  if (
    documentStructureFingerprint(previousServer) !== nextStructure &&
    documentStructureFingerprint(draft) !== nextStructure
  ) {
    return { document: nextServer, invalidated: true };
  }
  return { document: rebaseDocument(draft, previousServer, nextServer), invalidated: false };
}

function rebaseSnapshot(
  snapshot: ReachDeckDocumentSnapshot,
  previousServer: ReachDeckDocument,
  server: ReachDeckDocument,
  currentDraft: ReachDeckDocument,
): ReachDeckDocumentSnapshot {
  const document = rebaseDocument(snapshot.document, previousServer, server, currentDraft);
  const activePageId = document.pages.some((page) => page.pageId === snapshot.activePageId)
    ? snapshot.activePageId
    : document.pages[0]?.pageId;
  return {
    ...snapshot,
    document,
    activePageId,
    pageSelection: snapshot.pageSelection
      ? reconcilePageSelection(
          snapshot.pageSelection,
          document.pages.map((page) => page.pageId),
        )
      : undefined,
  };
}

function rebaseDocument(
  draft: ReachDeckDocument,
  previousServer: ReachDeckDocument,
  server: ReachDeckDocument,
  currentDraft?: ReachDeckDocument,
): ReachDeckDocument {
  const serverPages = new Map(server.pages.map((page) => [page.pageId, page]));
  const media = new Map(draft.resources.media.map((resource) => [resource.id, resource]));
  for (const resource of server.resources.media) media.set(resource.id, resource);
  return {
    ...draft,
    metadata: server.metadata,
    revisions: server.revisions,
    importApplications: mergeImportApplications(draft, server),
    resources: { ...draft.resources, media: [...media.values()] },
    pages: draft.pages.map((page) => {
      const serverPage = serverPages.get(page.pageId);
      if (page.sceneType === 'interactive' && serverPage?.sceneType === 'interactive') {
        const { narration: _narration, ...scene } = page.scene;
        return {
          ...page,
          revision: serverPage.revision,
          scene: {
            ...scene,
            ...(serverPage.scene.narration === undefined
              ? {}
              : { narration: serverPage.scene.narration }),
          },
        };
      }
      return {
        ...page,
        revision: serverPage?.revision ?? page.revision,
      };
    }),
    nativeSlides: draft.nativeSlides.map((binding) => {
      const serverBinding = server.nativeSlides.find(
        (candidate) => candidate.pageId === binding.pageId,
      );
      if (serverBinding === undefined) return binding;
      const { narration: _narration, duration: _duration, ...draftSlide } = binding.slide;
      const previous = previousServer.nativeSlides.find(
        (candidate) => candidate.pageId === binding.pageId,
      )?.slide;
      const animations = mergeReachDeckNativeSlideAnimations({
        previous,
        server: serverBinding.slide,
        draft: binding.slide,
        acknowledgedDraft: currentDraft?.nativeSlides.find(
          (candidate) => candidate.pageId === binding.pageId,
        )?.slide,
      });
      const duration = mergeReachDeckNativeSlideDuration({
        previous,
        server: serverBinding.slide,
        draft: binding.slide,
        animations,
      });
      return {
        ...binding,
        slide: {
          ...draftSlide,
          // Media is server-owned, including absence after an irreversible audio deletion.
          ...(serverBinding.slide.narration === undefined
            ? {}
            : { narration: serverBinding.slide.narration }),
          ...(duration === undefined ? {} : { duration }),
          animations,
        },
      };
    }),
  };
}

function mergeImportApplications(draft: ReachDeckDocument, server: ReachDeckDocument) {
  if (draft.importApplications === undefined && server.importApplications === undefined) {
    return undefined;
  }
  const applications = new Map(
    (draft.importApplications ?? []).map((application) => [application.applicationId, application]),
  );
  for (const application of server.importApplications ?? []) {
    applications.set(application.applicationId, application);
  }
  return [...applications.values()];
}

function documentStructureFingerprint(document: ReachDeckDocument): string {
  return JSON.stringify({
    pages: [...document.pages]
      .sort((left, right) => left.order - right.order)
      .map((page) => [page.pageId, page.sceneType]),
    nativeSlides: document.nativeSlides
      .map((binding) => [binding.pageId, binding.slide.id])
      .sort(([left], [right]) => left!.localeCompare(right!)),
  });
}

export function reachDeckDocumentSnapshotsEqual(
  left: ReachDeckDocumentSnapshot,
  right: ReachDeckDocumentSnapshot,
): boolean {
  return (
    left.activePageId === right.activePageId &&
    left.selectedElementId === right.selectedElementId &&
    left.selectedAnimationId === right.selectedAnimationId &&
    reachDeckValuesEqual(left.pageSelection, right.pageSelection) &&
    reachDeckValuesEqual(left.selectedElementIds, right.selectedElementIds) &&
    reachDeckValuesEqual(left.document, right.document)
  );
}
