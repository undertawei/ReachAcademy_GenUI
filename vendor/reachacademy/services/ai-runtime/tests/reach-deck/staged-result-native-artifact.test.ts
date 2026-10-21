import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';
import { parseCompletedStagedResult } from '@/lib/reach-deck/staged-result';

const generatedAt = '2026-09-20T00:00:00.000Z';
const document = createBlankReachDeckDocument({ id: 'test', title: 'Native page', generatedAt });
const artifact = {
  schemaVersion: 'reach-deck-slide-artifact/v2',
  runId: 'run',
  pageId: 'page',
  requestedRevision: 1,
  attempt: 1,
  generatedAt,
  sceneType: 'slide',
  status: 'ready',
  nativeSlide: document.nativeSlides[0]!.slide,
  resources: document.resources,
  generationMetadata: {
    blueprint: {
      pageId: 'page',
      learningGoal: 'Explain one idea',
      keyMessage: 'One idea',
      audienceAssumption: 'New learner',
      narrativeRole: 'explain',
      contentUnits: [{ id: 'claim', role: 'claim', text: 'One idea', priority: 'primary' }],
      desiredStudentAttention: 'The relationship',
      mediaIntent: { kind: 'none' },
    },
    classification: {
      primaryType: 'single_focus',
      itemCount: 1,
      density: 'low',
      visualFocus: 'statement',
      mediaType: 'none',
      confidence: 0.9,
      rationale: 'One main claim.',
    },
    layoutReferences: [{ id: 'single_focus-statement-v1', version: 1, score: 165 }],
    promptVersion: 'html-v1',
  },
};

describe('Native staged artifacts', () => {
  it('retains media slot recovery metadata through the durable result parser', () => {
    const slot = {
      assetId: 'planned-image',
      plannedIndex: 0,
      plannedAsset: {
        kind: 'image',
        purpose: 'Explain one idea',
        prompt: 'A source image',
        alt: 'Idea',
        aspectRatio: '16:9',
        placement: 'primary',
      },
      planDigest: 'a'.repeat(64),
      elementId: 'image',
      binding: 'image-element',
      resourceId: 'placeholder',
      status: 'failed',
      failure: { reason: 'timeout', retryable: true, at: generatedAt },
      attempt: 1,
    };
    const withSlot = {
      ...artifact,
      nativeSlide: {
        ...artifact.nativeSlide,
        elements: [
          {
            id: 'image',
            type: 'image',
            zIndex: 1,
            transform: { x: 0, y: 0, width: 400, height: 225 },
            resourceId: 'placeholder',
            fit: 'contain',
            alt: 'Idea',
          },
        ],
      },
      resources: {
        ...artifact.resources,
        media: [
          {
            id: 'placeholder',
            objectKey: 'placeholder.png',
            contentType: 'image/png',
            digest: 'a'.repeat(64),
          },
        ],
      },
      generationMetadata: { ...artifact.generationMetadata, mediaSlots: [slot] },
    };
    const provenance = {
      kind: 'page-generation' as const,
      runId: 'run',
      createdFromDraftRevision: 1,
      pageId: 'page',
      requestedRevision: 1,
      attempt: 1,
      sceneType: 'slide' as const,
    };
    const result = {
      kind: 'page-generation',
      runId: 'run',
      generatedFromDraftRevision: 1,
      artifact: withSlot,
    };
    expect(parseCompletedStagedResult(result, provenance)).toHaveProperty(
      'artifact.generationMetadata.mediaSlots',
      [slot],
    );
    expect(() =>
      parseCompletedStagedResult(
        {
          ...result,
          artifact: {
            ...withSlot,
            generationMetadata: {
              ...withSlot.generationMetadata,
              mediaSlots: [{ ...slot, failure: { ...slot.failure, reason: 'raw-provider-error' } }],
            },
          },
        },
        provenance,
      ),
    ).toThrow();
  });

  it.each(['page-generation', 'narration-generation'] as const)(
    'round-trips %s without a legacy scene',
    (kind) => {
      const provenance = {
        kind,
        runId: 'run',
        createdFromDraftRevision: 1,
        pageId: 'page',
        requestedRevision: 1,
        attempt: 1,
        sceneType: 'slide' as const,
      };
      const result = {
        kind,
        runId: 'run',
        generatedFromDraftRevision: 1,
        artifact,
        ...(kind === 'narration-generation' ? { narrationContentDigest: 'a'.repeat(64) } : {}),
      };
      const parsed = parseCompletedStagedResult(result, provenance);
      expect(parsed).toHaveProperty('artifact.nativeSlide', artifact.nativeSlide);
      expect(parsed).not.toHaveProperty('artifact.scene');
      expect(() =>
        parseCompletedStagedResult({ ...result, artifact: { ...artifact, scene: {} } }, provenance),
      ).toThrow();
      expect(() =>
        parseCompletedStagedResult(
          { ...result, artifact: { ...artifact, attempt: 2 } },
          provenance,
        ),
      ).toThrow(/identity/);
    },
  );
});

describe('Native text-only narration result', () => {
  const provenance = {
    kind: 'narration-generation' as const,
    runId: 'run',
    createdFromDraftRevision: 1,
    pageId: 'page',
    requestedRevision: 1,
    attempt: 1,
    sceneType: 'slide' as const,
  };
  const textOnly = {
    kind: 'narration-generation' as const,
    runId: 'run',
    generatedFromDraftRevision: 1,
    nativeNarration: {
      pageId: 'page',
      requestedRevision: 1,
      attempt: 1,
      generatedAt,
      nativeSlideContentDigest: 'a'.repeat(64),
      narrationContentDigest: 'b'.repeat(64),
      textOnly: true,
      markdown: '只重写的讲稿。',
      segments: [],
      duration: 0,
    },
  };

  it('accepts the audio-free text-only form', () => {
    expect(parseCompletedStagedResult(textOnly, provenance)).toEqual(textOnly);
  });

  it.each([
    ['audio object key', { audioObjectKey: 'narration/page.mp3' }],
    ['audio failure', { audioFailureCode: 'REACH_DECK_TTS_FAILED' }],
    ['positive duration', { duration: 4 }],
    ['timed segments', { segments: [{ text: '只重写的讲稿。', start: 0, end: 4 }] }],
    ['timed reveals', { reveals: [{ start: 0, revealElementIds: ['element-1'] }] }],
    ['animation mode', { animationMode: 'regenerate' }],
    ['non-literal flag', { textOnly: false }],
  ])('rejects a text-only result with %s', (_label, override) => {
    expect(() =>
      parseCompletedStagedResult(
        { ...textOnly, nativeNarration: { ...textOnly.nativeNarration, ...override } },
        provenance,
      ),
    ).toThrow();
  });
});

describe('Workspace narration audio failure result', () => {
  // 首轮工作区通道音频失败的耐久结果：工件只带讲稿，失败码与工件并列。
  const provenance = {
    kind: 'narration-generation' as const,
    runId: 'run',
    createdFromDraftRevision: 1,
    pageId: 'page',
    requestedRevision: 1,
    attempt: 1,
    sceneType: 'slide' as const,
  };
  const scriptOnly = {
    ...artifact,
    nativeSlide: { ...artifact.nativeSlide, narration: { markdown: '保留下来的讲稿。' } },
  };
  const result = {
    kind: 'narration-generation',
    runId: 'run',
    generatedFromDraftRevision: 1,
    narrationContentDigest: 'b'.repeat(64),
    artifact: scriptOnly,
    audioFailureCode: 'tts-timestamps-text-mismatch',
  };

  it('keeps the audio failure code beside a script-only native artifact', () => {
    expect(parseCompletedStagedResult(result, provenance)).toMatchObject({
      audioFailureCode: 'tts-timestamps-text-mismatch',
      artifact: { nativeSlide: { narration: { markdown: '保留下来的讲稿。' } } },
    });
  });

  it('still parses results written before the failure code existed', () => {
    const { audioFailureCode: _code, ...legacy } = result;
    expect(parseCompletedStagedResult(legacy, provenance)).not.toHaveProperty('audioFailureCode');
  });

  it.each([
    ['a blank code', { audioFailureCode: ' ' }],
    ['an overlong code', { audioFailureCode: 'x'.repeat(129) }],
    [
      'a recording',
      {
        artifact: {
          ...scriptOnly,
          nativeSlide: {
            ...scriptOnly.nativeSlide,
            narration: {
              markdown: '保留下来的讲稿。',
              audioResourceId: 'media-audio',
              segments: [{ text: '保留下来的讲稿。', start: 0, end: 2 }],
            },
          },
          resources: {
            ...scriptOnly.resources,
            media: [
              {
                id: 'media-audio',
                objectKey: 'audio.mp3',
                contentType: 'audio/mpeg',
                digest: 'c'.repeat(64),
              },
            ],
          },
        },
      },
    ],
    [
      'no script',
      { artifact: { ...artifact, nativeSlide: { ...artifact.nativeSlide, narration: undefined } } },
    ],
  ])('rejects an audio failure result with %s', (_label, override) => {
    expect(() => parseCompletedStagedResult({ ...result, ...override }, provenance)).toThrow();
  });
});
