import { describe, expect, it } from 'vitest';

import {
  createReachDeckDocumentHistory,
  rebaseReachDeckDocumentDraft,
  rebaseReachDeckDocumentHistory,
  recordReachDeckDocumentEdit,
  redoReachDeckDocumentEdit,
  undoReachDeckDocumentEdit,
  type ReachDeckDocumentSnapshot,
} from '../src/documentHistory.js';
import {
  addReachDeckPage,
  deleteReachDeckPage,
  duplicateReachDeckPage,
} from '../src/operations.js';
import { clearReachDeckDocumentMedia } from '../src/deckMediaClear.js';
import { createEditorDocument } from './fixture.js';

const narratedDocument = () => {
  const document = createEditorDocument();
  document.nativeSlides[0]!.slide.animations = [
    {
      id: 'narration-entrance:title-1',
      targetId: 'title-1',
      trigger: 'on-enter',
      effect: 'fade',
      start: 1,
      duration: 0.4,
    },
  ];
  return document;
};

const snapshot = (title: string): ReachDeckDocumentSnapshot => ({
  document: { ...createEditorDocument(), title },
  activePageId: 'page-1',
  selectedElementId: 'title-1',
  selectedElementIds: ['title-1'],
});

describe('Reach Deck document history', () => {
  it('retains an authored hold when refreshing a page without server duration', () => {
    const previous = createEditorDocument();
    delete previous.nativeSlides[0]!.slide.duration;
    const draft = structuredClone(previous);
    draft.nativeSlides[0]!.slide.animations = narratedDocument().nativeSlides[0]!.slide.animations;
    draft.nativeSlides[0]!.slide.duration = 12;
    const server = structuredClone(previous);
    expect(
      rebaseReachDeckDocumentDraft(draft, previous, server).document.nativeSlides[0]!.slide
        .duration,
    ).toBe(12);
    const history = {
      past: [{ ...snapshot('hold'), document: draft }],
      future: [{ ...snapshot('redo-hold'), document: draft }],
    };
    const rebased = rebaseReachDeckDocumentHistory(history, previous, server, draft);
    expect(rebased.history.past[0]!.document.nativeSlides[0]!.slide.duration).toBe(12);
    expect(rebased.history.future[0]!.document.nativeSlides[0]!.slide.duration).toBe(12);
  });

  it('derives restored animation duration after audio deletion and retains it across server echoes', () => {
    const previous = narratedDocument();
    const slide = previous.nativeSlides[0]!.slide;
    slide.narration = {
      markdown: 'Keep narration',
      audioResourceId: 'audio-old',
      segments: [{ text: 'Keep narration', start: 0, end: 20 }],
    };
    slide.duration = 20;
    slide.animations[0] = { ...slide.animations[0]!, start: 10, duration: 2, delay: 1 };
    slide.animations.push({
      ...slide.animations[0]!,
      id: 'orphan',
      targetId: 'missing',
      start: 100,
    });
    const saved = clearReachDeckDocumentMedia(previous, { audio: true, animation: true }).document;
    const current = { ...snapshot('saved'), document: saved };
    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), {
      ...current,
      document: previous,
    });
    const rebased = rebaseReachDeckDocumentHistory(history, previous, saved, saved);
    const undone = undoReachDeckDocumentEdit(rebased.history, current);
    expect(undone.snapshot!.document.nativeSlides[0]!.slide.duration).toBe(13);
    expect(
      undone.snapshot!.document.nativeSlides[0]!.slide.narration?.audioResourceId,
    ).toBeUndefined();
    const echoed = rebaseReachDeckDocumentDraft(
      undone.snapshot!.document,
      saved,
      structuredClone(saved),
    );
    expect(echoed.document.nativeSlides[0]!.slide.duration).toBe(13);
    const echoHistory = rebaseReachDeckDocumentHistory(
      undone.history,
      saved,
      structuredClone(saved),
      echoed.document,
    );
    const redone = redoReachDeckDocumentEdit(echoHistory.history, {
      ...undone.snapshot!,
      document: echoed.document,
    });
    expect(redone.snapshot!.document.nativeSlides[0]!.slide.duration).toBeUndefined();
    expect(
      redone.snapshot!.document.nativeSlides[0]!.slide.narration?.audioResourceId,
    ).toBeUndefined();
  });

  it.each(['slide', 'interactive'] as const)(
    'keeps audio-only deletion irreversible in existing %s undo and redo states',
    (kind) => {
      let baseline = createEditorDocument();
      baseline.resources.media.push({
        id: 'audio-1',
        objectKey: 'deck/audio.mp3',
        contentType: 'audio/mpeg',
        digest: 'sha256:audio',
      });
      if (kind === 'slide') {
        baseline.nativeSlides[0]!.slide.narration = {
          markdown: 'Keep this narration',
          audioResourceId: 'audio-1',
          segments: [{ text: 'Keep this narration', start: 0, end: 8 }],
        };
      } else {
        baseline = addReachDeckPage(baseline, {
          sceneType: 'interactive',
          afterPageId: 'page-1',
          idFactory: (prefix) => `${prefix}-interactive`,
        });
        const page = baseline.pages.find((page) => page.sceneType === 'interactive')!;
        if (page.sceneType !== 'interactive') throw new Error('Expected interactive page');
        page.scene.narration = {
          schemaVersion: 'reach-interactive-narration/v1',
          text: 'Keep this narration',
          audioResourceId: 'audio-1',
        };
      }
      const current = { ...snapshot('current'), document: baseline };
      const history = {
        past: [{ ...current, document: { ...baseline, title: 'past' } }],
        future: [{ ...current, document: { ...baseline, title: 'future' } }],
      };
      const saved = clearReachDeckDocumentMedia(baseline, {
        audio: true,
        animation: false,
      }).document;
      const rebased = rebaseReachDeckDocumentHistory(history, baseline, saved, baseline);
      const audioIds = (document: typeof baseline) => [
        ...document.nativeSlides.map((binding) => binding.slide.narration?.audioResourceId),
        ...document.pages.map((page) =>
          page.sceneType === 'interactive' ? page.scene.narration?.audioResourceId : undefined,
        ),
      ];
      expect(rebased.invalidated).toBe(false);
      expect(
        audioIds(rebaseReachDeckDocumentDraft(baseline, baseline, saved).document),
      ).not.toContain('audio-1');
      const undone = undoReachDeckDocumentEdit(rebased.history, { ...current, document: saved });
      expect(undone.snapshot!.document.title).toBe('past');
      expect(audioIds(undone.snapshot!.document)).not.toContain('audio-1');
      const future = redoReachDeckDocumentEdit(rebased.history, { ...current, document: saved });
      expect(future.snapshot!.document.title).toBe('future');
      expect(audioIds(future.snapshot!.document)).not.toContain('audio-1');
      if (kind === 'slide')
        expect(undone.snapshot!.document.nativeSlides[0]!.slide.duration).toBeUndefined();
      else {
        const page = undone.snapshot!.document.pages.find(
          (page) => page.sceneType === 'interactive',
        )!;
        expect(page.sceneType === 'interactive' && page.scene.narration?.text).toBe(
          'Keep this narration',
        );
      }
    },
  );

  it('caps past transactions at 50 and clears redo after a new edit', () => {
    let history = createReachDeckDocumentHistory();
    for (let index = 0; index < 55; index += 1) {
      history = recordReachDeckDocumentEdit(history, snapshot(`version-${index}`));
    }
    expect(history.past).toHaveLength(50);
    const undone = undoReachDeckDocumentEdit(history, snapshot('current'));
    expect(undone.snapshot?.document.title).toBe('version-54');
    expect(undone.history.future).toHaveLength(1);
    const edited = recordReachDeckDocumentEdit(undone.history, snapshot('after-undo'));
    expect(edited.future).toEqual([]);
  });

  it('groups continuous edits into one transaction and supports deterministic redo', () => {
    let history = createReachDeckDocumentHistory();
    history = recordReachDeckDocumentEdit(history, snapshot('before'), 'transform:title-1');
    history = recordReachDeckDocumentEdit(history, snapshot('during'), 'transform:title-1');
    expect(history.past.map((entry) => entry.document.title)).toEqual(['before']);
    const undone = undoReachDeckDocumentEdit(history, snapshot('after'));
    expect(undone.snapshot?.document.title).toBe('before');
    const redone = redoReachDeckDocumentEdit(undone.history, undone.snapshot!);
    expect(redone.snapshot?.document.title).toBe('after');
  });

  it('keeps a page-deletion undo point after many grouped quiz rich-text updates', () => {
    let history = createReachDeckDocumentHistory();
    history = recordReachDeckDocumentEdit(history, snapshot('before-delete'));
    for (let index = 0; index < 75; index += 1) {
      history = recordReachDeckDocumentEdit(
        history,
        snapshot(`quiz-edit-${index}`),
        'quiz-rich-text:page-1:question-1:prompt',
      );
    }

    expect(history.past.map((entry) => entry.document.title)).toEqual([
      'before-delete',
      'quiz-edit-0',
    ]);
    const undoQuiz = undoReachDeckDocumentEdit(history, snapshot('after-quiz-edit'));
    expect(undoQuiz.snapshot?.document.title).toBe('quiz-edit-0');
    const undoDelete = undoReachDeckDocumentEdit(undoQuiz.history, undoQuiz.snapshot!);
    expect(undoDelete.snapshot?.document.title).toBe('before-delete');
  });

  it('rebases late narration, audio media, revisions, and derived animations into every snapshot', () => {
    const baseline = createEditorDocument();
    const draft = createEditorDocument();
    draft.nativeSlides[0]!.slide.elements[0]!.transform.x = 320;
    const server = createEditorDocument();
    server.pages[0]!.revision = 9;
    server.resources.media.push({
      id: 'audio-1',
      objectKey: 'deck/audio.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:audio',
    });
    server.nativeSlides[0]!.slide.narration = {
      markdown: 'Late narration',
      audioResourceId: 'audio-1',
      segments: [{ text: 'Late narration', start: 0, end: 2 }],
    };
    server.nativeSlides[0]!.slide.duration = 3;
    server.nativeSlides[0]!.slide.animations.push({
      id: 'narration-entrance:title-1:0',
      targetId: 'title-1',
      trigger: 'on-enter',
      effect: 'appear',
      start: 0,
      duration: 0,
    });

    const rebased = rebaseReachDeckDocumentDraft(draft, baseline, server);
    expect(rebased.invalidated).toBe(false);
    expect(rebased.document.nativeSlides[0]!.slide.elements[0]!.transform.x).toBe(320);
    expect(rebased.document.nativeSlides[0]!.slide.narration?.audioResourceId).toBe('audio-1');
    expect(rebased.document.resources.media).toContainEqual(server.resources.media[0]);
    expect(rebased.document.pages[0]!.revision).toBe(9);

    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), snapshot('old'));
    const rebasedHistory = rebaseReachDeckDocumentHistory(history, baseline, server, draft);
    expect(
      rebasedHistory.history.past[0]!.document.nativeSlides[0]!.slide.narration?.audioResourceId,
    ).toBe('audio-1');
  });

  it('does not revive server narration animations for elements the draft deleted', () => {
    const withBody = () => {
      const document = createEditorDocument();
      const slide = document.nativeSlides[0]!.slide;
      slide.elements.push({ ...slide.elements[0]!, id: 'body-1', zIndex: 2 });
      return document;
    };
    const narrationEntrance = (targetId: string) => ({
      id: `narration-entrance:${targetId}`,
      targetId,
      trigger: 'on-enter' as const,
      effect: 'fade' as const,
      start: 1,
      duration: 0.4,
    });
    const baseline = withBody();
    const draft = createEditorDocument();
    const server = withBody();
    server.nativeSlides[0]!.slide.animations.push(
      narrationEntrance('title-1'),
      narrationEntrance('body-1'),
    );

    const rebased = rebaseReachDeckDocumentDraft(draft, baseline, server);
    expect(rebased.invalidated).toBe(false);
    expect(rebased.document.nativeSlides[0]!.slide.elements.map((element) => element.id)).toEqual([
      'title-1',
    ]);
    expect(
      rebased.document.nativeSlides[0]!.slide.animations.map((animation) => animation.id),
    ).toEqual(['narration-entrance:title-1']);
    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), {
      ...snapshot('old'),
      document: draft,
    });
    expect(
      rebaseReachDeckDocumentHistory(
        history,
        baseline,
        server,
        draft,
      ).history.past[0]!.document.nativeSlides[0]!.slide.animations.map(
        (animation) => animation.targetId,
      ),
    ).toEqual(['title-1']);
  });

  it('preserves a deleted generated track across refresh, save echo, undo and redo', () => {
    const baseline = narratedDocument();
    const deleted = structuredClone(baseline);
    deleted.nativeSlides[0]!.slide.animations = [];
    const before: ReachDeckDocumentSnapshot = { ...snapshot('before'), document: baseline };
    const after: ReachDeckDocumentSnapshot = { ...snapshot('after'), document: deleted };
    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), before);

    const refreshed = rebaseReachDeckDocumentDraft(deleted, baseline, structuredClone(baseline));
    expect(refreshed.document.nativeSlides[0]!.slide.animations).toEqual([]);
    const saved = structuredClone(deleted);
    saved.pages[0]!.revision += 1;
    const acknowledged = rebaseReachDeckDocumentHistory(history, baseline, saved, deleted);
    const undone = undoReachDeckDocumentEdit(acknowledged.history, after);
    expect(undone.snapshot!.document.nativeSlides[0]!.slide.animations).toEqual(
      baseline.nativeSlides[0]!.slide.animations,
    );

    // Saving the restored track must not overwrite the redo entry that deletes it again.
    const restored = structuredClone(undone.snapshot!.document);
    restored.pages[0]!.revision += 1;
    const undoAcknowledged = rebaseReachDeckDocumentHistory(
      undone.history,
      saved,
      restored,
      undone.snapshot!.document,
    );
    const redone = redoReachDeckDocumentEdit(undoAcknowledged.history, undone.snapshot!);
    expect(redone.snapshot!.document.nativeSlides[0]!.slide.animations).toEqual([]);
  });

  it('preserves modified generated animation fields across refresh and history rebases', () => {
    const baseline = narratedDocument();
    const draft = structuredClone(baseline);
    draft.nativeSlides[0]!.slide.animations[0]!.duration = 0.9;
    const server = structuredClone(baseline);
    server.nativeSlides[0]!.slide.animations[0]!.start = 3;

    const refreshed = rebaseReachDeckDocumentDraft(draft, baseline, server);
    expect(refreshed.document.nativeSlides[0]!.slide.animations[0]).toMatchObject({
      start: 3,
      duration: 0.9,
    });
    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), {
      ...snapshot('edited'),
      document: draft,
    });
    const rebased = rebaseReachDeckDocumentHistory(history, baseline, server, draft);
    expect(rebased.history.past[0]!.document.nativeSlides[0]!.slide.animations[0]).toMatchObject({
      start: 3,
      duration: 0.9,
    });
  });

  it('adopts unedited server removals while preserving explicit local deletion during new generation', () => {
    const baseline = narratedDocument();
    const server = structuredClone(baseline);
    server.nativeSlides[0]!.slide.animations = [];
    expect(
      rebaseReachDeckDocumentDraft(baseline, baseline, server).document.nativeSlides[0]!.slide
        .animations,
    ).toEqual([]);

    const deleted = structuredClone(baseline);
    deleted.nativeSlides[0]!.slide.animations = [];
    const retimed = structuredClone(baseline);
    retimed.nativeSlides[0]!.slide.animations[0]!.start = 5;
    expect(
      rebaseReachDeckDocumentDraft(deleted, baseline, retimed).document.nativeSlides[0]!.slide
        .animations,
    ).toEqual([]);
  });

  it('invalidates history on a structural server conflict', () => {
    const baseline = createEditorDocument();
    const server = createEditorDocument();
    server.pages[0] = { ...server.pages[0]!, pageId: 'remote-page' };
    server.nativeSlides[0] = { ...server.nativeSlides[0]!, pageId: 'remote-page' };
    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), snapshot('old'));
    const result = rebaseReachDeckDocumentHistory(history, baseline, server, baseline);
    expect(result.invalidated).toBe(true);
    expect(result.history).toEqual({ past: [], future: [] });
  });

  it('preserves pre-delete undo history when the server echoes the local structure', () => {
    let sequence = 0;
    const baseline = duplicateReachDeckPage(
      createEditorDocument(),
      'page-1',
      (prefix) => `${prefix}-${++sequence}`,
    );
    const deleted = deleteReachDeckPage(baseline, 'page-1');
    const beforeDelete: ReachDeckDocumentSnapshot = {
      ...snapshot('before'),
      document: baseline,
    };
    const history = recordReachDeckDocumentEdit(createReachDeckDocumentHistory(), beforeDelete);
    const result = rebaseReachDeckDocumentHistory(history, baseline, deleted, deleted);
    expect(result.invalidated).toBe(false);
    expect(result.history.past).toHaveLength(1);
    expect(result.history.past[0]!.document.pages).toHaveLength(2);
    expect(result.history.past[0]!.document.nativeSlides).toHaveLength(2);
  });
});
