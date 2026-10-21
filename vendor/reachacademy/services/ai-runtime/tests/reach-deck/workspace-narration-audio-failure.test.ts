import { createBlankReachDeckDocument, type GenerationWorkspace } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import type { ReachDeckNarrationGenerationJobResult } from '@/lib/reach-deck/contracts';
import { workspaceNarrationAudioFailure } from '@/lib/reach-deck/workspace-recovery';

// 首轮工作区通道「讲稿保留、音频失败」的恢复投影：只有当前内容仍是这份讲稿且仍无音频时，
// 才向教师端报告音频失败；教师改了讲稿或补好音频后不再报告。
const generatedAt = '2026-10-19T00:00:00.000Z';
const blank = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt });
const slide = blank.nativeSlides[0]!.slide;
const pageId = blank.pages[0]!.pageId;
const markdown = '保留下来的讲稿。';
const artifact = {
  schemaVersion: 'reach-deck-slide-artifact/v2' as const,
  runId: 'run',
  pageId,
  requestedRevision: 2,
  attempt: 3,
  generatedAt,
  sceneType: 'slide' as const,
  status: 'ready' as const,
  nativeSlide: { ...slide, narration: { markdown } },
  resources: blank.resources,
};
const result = {
  kind: 'narration-generation',
  runId: 'run',
  generatedFromDraftRevision: 4,
  narrationContentDigest: 'a'.repeat(64),
  artifact,
  audioFailureCode: 'tts-timestamps-text-mismatch',
} as unknown as ReachDeckNarrationGenerationJobResult;

function workspaceWith(current: object | undefined): GenerationWorkspace {
  return {
    runId: 'run',
    sceneArtifacts: current === undefined ? {} : { [pageId]: current },
  } as unknown as GenerationWorkspace;
}

function documentWith(narration: object | undefined) {
  return {
    ...blank,
    nativeSlides: blank.nativeSlides.map((binding) => ({
      ...binding,
      slide: { ...binding.slide, ...(narration === undefined ? {} : { narration }) },
    })),
  };
}

const expected = {
  pageId,
  requestedRevision: 2,
  markdown,
  audioFailureCode: 'tts-timestamps-text-mismatch',
};

describe('workspaceNarrationAudioFailure', () => {
  it('reports the failure before materialization while the workspace keeps the script', () => {
    expect(workspaceNarrationAudioFailure(result, undefined, workspaceWith(artifact))).toEqual(
      expected,
    );
  });

  it('reports the failure after materialization while the document keeps the script', () => {
    expect(
      workspaceNarrationAudioFailure(result, documentWith({ markdown }), workspaceWith(undefined)),
    ).toEqual(expected);
  });

  it('stops reporting once audio was generated for the page', () => {
    expect(
      workspaceNarrationAudioFailure(
        result,
        documentWith({
          markdown,
          audioResourceId: 'media-audio',
          segments: [{ text: markdown, start: 0, end: 2 }],
        }),
        workspaceWith(artifact),
      ),
    ).toBeUndefined();
  });

  it('stops reporting once the teacher replaced the script', () => {
    expect(
      workspaceNarrationAudioFailure(
        result,
        documentWith({ markdown: '教师改过的讲稿。' }),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      workspaceNarrationAudioFailure(
        result,
        undefined,
        workspaceWith({
          ...artifact,
          nativeSlide: { ...slide, narration: { markdown: '新讲稿。' } },
        }),
      ),
    ).toBeUndefined();
  });

  it('ignores a newer page attempt in the workspace', () => {
    expect(
      workspaceNarrationAudioFailure(result, undefined, workspaceWith({ ...artifact, attempt: 4 })),
    ).toBeUndefined();
  });

  it('ignores results that carry audio', () => {
    const { audioFailureCode: _code, ...succeeded } = result;
    expect(
      workspaceNarrationAudioFailure(
        succeeded as ReachDeckNarrationGenerationJobResult,
        undefined,
        workspaceWith(artifact),
      ),
    ).toBeUndefined();
  });
});
