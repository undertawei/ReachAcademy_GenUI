import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  type PageGenerationRequest,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY,
  REFERENCE_REGISTRY,
} from '@reachany/reach-deck-dsl/reference-library';
import { generatePageArtifactWithModelService } from '../../lib/reach-deck/generation-pipeline.js';
import { HtmlLayoutValidationError } from '../../lib/reach-deck/html-layout/types.js';
import { isRetryableReachDeckGenerationFailure } from '../../lib/reach-deck/workspace-failure.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const mocks = vi.hoisted(() => ({ compile: vi.fn(), generate: vi.fn() }));
vi.mock('../../lib/reach-deck/html-layout/index.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/html-layout/index.js')>()),
  compileHtmlLayout: mocks.compile,
}));
vi.mock('../../lib/reach-deck/model-service-client.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  generateTextWithModelService: mocks.generate,
}));

const page: PageGenerationRequest['page'] = {
  id: 'page-2',
  order: 1,
  sceneType: 'slide',
  title: 'Systems',
  instructionalSpec: {
    learningObjective: 'Explain one idea',
    teachingMove: 'explain',
    keyPoints: ['Connected parts', 'Changes propagate', 'Feedback keeps balance'],
    visualDirection: 'The relationship',
    density: 'low',
    visualAssets: [],
  },
  slideClassification: {
    primaryType: 'single_focus',
    density: 'low',
    visualFocus: 'statement',
    mediaType: 'none',
  },
  designIntent: {
    pageRole: 'content',
    focus: 'Systems',
    informationRelationship: 'single_focus',
    layoutReferenceIds: [],
    componentReferenceIds: [],
    imageStyleReferenceIds: [],
  },
};
const request: PageGenerationRequest = {
  runId: 'run-1',
  pageId: page.id,
  requestedRevision: 3,
  attempt: 2,
  attemptReason: 'regenerate',
  source: 'Source facts',
  lessonPlan: {
    id: 'plan-1',
    title: 'Systems',
    audience: 'Grade 8',
    durationMinutes: 45,
    learningObjectives: ['Explain one idea'],
    teachingStrategy: 'Explain',
    keyTerms: ['system'],
    narrative: 'Teach systems.',
  },
  pagedOutline: {
    id: 'outline-1',
    title: 'Systems',
    pages: [page],
    manifestVersion: REFERENCE_MANIFEST_VERSION,
    referenceCoverage: REFERENCE_REGISTRY,
    designContext: {
      schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
      libraryVersion: REFERENCE_LIBRARY_VERSION,
      librarySha256: REFERENCE_LIBRARY_SHA256,
      paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
      imageStyleReferenceIds: [],
      visualIntent: 'Clear relationships',
      resolvedColors: {
        background: '#ffffff',
        surface: '#eeeeee',
        ink: '#111111',
        muted: '#444444',
        accent: '#005599',
        success: '#006633',
        warning: '#885500',
      },
    },
  },
  page,
  previousSlides: [],
  nearbyLayoutReferenceIds: [],
  prompt: 'Teacher direction',
};
const options = { context: { ...TEST_REACH_DECK_SCOPE, jobId: 'job-1', runId: 'run-1' } };
const compiled = () => ({
  slide: {
    schemaVersion: 'reach-deck-slide/v2',
    id: page.id,
    title: page.title,
    elements: [],
    animations: [],
  },
  resources: [],
  themes: [],
  pendingMedia: [],
  assetBindings: [],
  diagnostics: [],
  elementIdMap: {},
});

describe('HTML layout failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generate.mockReset().mockResolvedValue('<!doctype html><html></html>');
    mocks.compile.mockReset().mockResolvedValue(compiled());
  });

  it('terminates a structural violation without another model call', async () => {
    mocks.compile.mockRejectedValueOnce(new HtmlLayoutValidationError('Missing slide root'));
    await expect(generatePageArtifactWithModelService(request, options)).rejects.toThrow(
      'Missing slide root',
    );
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0]![0].payload).not.toHaveProperty('outputCorrection');
  });

  it('captures original HTML before a terminal structural compilation error', async () => {
    mocks.compile.mockRejectedValue(new HtmlLayoutValidationError('Missing slide root'));
    const capture = vi.fn();
    const error = await generatePageArtifactWithModelService(request, {
      ...options,
      onHtmlLayoutEvidence: capture,
    }).catch((error) => error);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<!doctype html><html></html>' }),
    );
    expect(error).toMatchObject({ retryable: false });
  });

  it.each(['Chrome executable missing', 'Target closed', 'HTML layout timed out'])(
    'propagates infrastructure failure without model correction: %s',
    async (message) => {
      const failure = new Error(message);
      mocks.compile.mockRejectedValue(failure);
      await expect(generatePageArtifactWithModelService(request, options)).rejects.toBe(failure);
      expect(mocks.generate).toHaveBeenCalledTimes(1);
      expect(isRetryableReachDeckGenerationFailure(failure)).toBe(true);
    },
  );

  it('does not correct a cancelled compile', async () => {
    const controller = new AbortController();
    mocks.compile.mockImplementationOnce(() => {
      controller.abort(new Error('cancelled fixture'));
      throw new HtmlLayoutValidationError('Interrupted validation');
    });
    await expect(
      generatePageArtifactWithModelService(request, { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('publishes successful diagnostics with page context and removes URLs and HTML', async () => {
    mocks.compile.mockResolvedValue({
      ...compiled(),
      diagnostics: ['[RASTERIZED] figure-1', 'https://asset.test/img?signature=secret <section>'],
    });
    const diagnostic = vi.fn();
    await generatePageArtifactWithModelService(request, {
      ...options,
      onOutputDiagnostic: diagnostic,
    });
    expect(diagnostic).toHaveBeenCalledWith({
      type: 'content-normalization',
      stage: 'slide',
      pageId: page.id,
      message: expect.stringContaining('[RASTERIZED] figure-1'),
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('signature=secret');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('<section>');
  });
});
