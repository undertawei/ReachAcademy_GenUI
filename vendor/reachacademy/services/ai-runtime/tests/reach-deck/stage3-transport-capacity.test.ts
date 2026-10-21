import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as compactOutline from '../../lib/reach-deck/compact-outline.js';
import { generatePagedDeckOutlineWithModelService } from '../../lib/reach-deck/generation-pipeline.js';
import { ReachDeckProviderOutputError } from '../../lib/reach-deck/model-service-client.js';

const MODEL_CONTEXT = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
  jobId: 'job-stage3-transport',
  runId: 'run-stage3-transport',
};

const lessonPlan = {
  id: 'lesson-transport',
  title: 'Linear relationships',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain how slope compares change'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['slope'],
  narrative: 'Observe a relationship and explain it.',
  assessmentPlan: 'Explain a new example.',
};

function outlineFixture(pageCount: number) {
  return {
    title: 'Linear relationships',
    themeName: 'reach-classic',
    pages: Array.from({ length: pageCount }, (_, index) => ({
      sceneType: 'slide',
      title: `比较斜率 ${index + 1}`,
      estimatedDurationMinutes: 1,
      instructionalSpec: {
        schemaVersion: 'reach-deck-instructional-spec/v3',
        learningObjective: 'Explain slope',
        pageRole: 'develop',
        pageJob: '斜率表示纵向变化与横向变化的比值。',
        keyPoints: ['比较同一横向变化下的纵向变化。', '保留正负号，说明变化方向。'],
        knowledgePointIds: [],
        assessmentEvidence: null,
        visualDirection: 'Compare two relationships',
        density: 'medium',
        visibleTitleMode: 'topic',
        visualAssets: [],
      },
      slideClassification: {
        primaryType: 'single_focus',
        visualFocus: 'statement',
        mediaType: 'none',
      },
      interactionBrief: null,
      materialReferenceOrdinals: null,
    })),
  };
}

const providerUsage = { prompt_tokens: 12000, completion_tokens: 3000, total_tokens: 15000 };

function providerWire(content: string, transport: 'json' | 'sse') {
  if (transport === 'json') {
    return {
      frameCount: 1,
      text: JSON.stringify({
        model: 'offline-fixture',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: providerUsage,
      }),
    };
  }
  const frames = [];
  // Keep actual Chinese text in the frames; network chunks below split UTF-8 code points.
  for (let offset = 0; offset < content.length; offset += 97) {
    frames.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(offset, offset + 97) } }] })}\r\n\r\n`,
    );
  }
  frames.push(
    `data: ${JSON.stringify({ model: 'offline-fixture', choices: [{ delta: {}, finish_reason: 'stop' }], usage: providerUsage })}\r\n\r\n`,
    'data: [DONE]\r\n\r\n',
  );
  return { frameCount: frames.length, text: frames.join('') };
}

function providerResponse(text: string, transport: 'json' | 'sse') {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 113) {
          controller.enqueue(bytes.slice(offset, offset + 113));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': transport === 'sse' ? 'text/event-stream' : 'application/json' } },
  );
}

describe('Stage 3 transport and capacity acceptance', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const transport of ['json', 'sse'] as const) {
    it.each([6, 20, 40, 41])('%i pages through ' + transport, async (pageCount) => {
      const content = JSON.stringify(outlineFixture(pageCount));
      const wire = providerWire(content, transport);
      const fetchMock = vi.fn(async () => providerResponse(wire.text, transport));
      const checkpoint = vi.fn(async () => undefined);
      const onUsage = vi.fn();
      const onOutputDiagnostic = vi.fn();
      let requestBytes = 0;
      let contentParseCount = 0;
      let parseMilliseconds = 0;
      const nativeParse = JSON.parse;
      vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        if (text === content) contentParseCount += 1;
        return nativeParse(text, reviver);
      });
      const originalParseOutline = compactOutline.parseCompactOutline;
      const parseOutline = vi
        .spyOn(compactOutline, 'parseCompactOutline')
        .mockImplementation((...args) => {
          const start = performance.now();
          try {
            return originalParseOutline(...args);
          } finally {
            parseMilliseconds += performance.now() - start;
          }
        });
      const start = performance.now();
      const generation = generatePagedDeckOutlineWithModelService(
        { source: '比较变化方向与变化比例。', lessonPlan },
        {
          context: MODEL_CONTEXT,
          env: { REACHANY_SERVICE_JWT_SECRET: 'offline-fixture-secret' },
          fetch: fetchMock,
          checkpoint,
          onUsage,
          onOutputDiagnostic,
          onModelPayload: ({ serializedModelInput }) => {
            requestBytes += Buffer.byteLength(serializedModelInput);
          },
        },
      );
      if (pageCount <= 40) {
        const result = await generation;
        expect(result.pages).toHaveLength(pageCount);
        expect(result.pages.map((page) => page.title)).toEqual(
          outlineFixture(pageCount).pages.map((page) => page.title),
        );
        expect(new Set(result.pages.map((page) => page.id)).size).toBe(pageCount);
        expect(checkpoint.mock.calls).toEqual([
          ['before-outline', { stage: 'paged-outline' }],
          ['after-outline', { stage: 'paged-outline' }],
        ]);
        expect(onOutputDiagnostic.mock.calls.map(([diagnostic]) => diagnostic.type)).toEqual([
          'scientific-context',
        ]);
      } else {
        // Capacity remains explicit. The existing single correction is retained, not a new
        // long-course continuation, session state machine, or retry of receipt persistence.
        const error = await generation.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
        expect(error).toMatchObject({ retryable: false });
        expect((error as Error).cause).toMatchObject({
          code: 'structure-invalid',
          issues: [expect.objectContaining({ path: 'outline.pages', code: 'schema-array-size' })],
          truncated: true,
        });
        expect(checkpoint.mock.calls).toEqual([['before-outline', { stage: 'paged-outline' }]]);
        expect(onOutputDiagnostic.mock.calls.map(([diagnostic]) => diagnostic.type)).toEqual([
          'scientific-context',
          'output-correction',
          'output-rejected',
        ]);
      }
      const elapsedMilliseconds = performance.now() - start;
      const expectedCalls = pageCount <= 40 ? 1 : 2;
      expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
      expect(contentParseCount).toBe(expectedCalls);
      expect(parseOutline).toHaveBeenCalledTimes(expectedCalls);
      expect(onUsage).toHaveBeenCalledTimes(expectedCalls);
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'offline-fixture', totalTokens: 15000 }),
      );
      console.info(
        'stage3-transport-capacity',
        JSON.stringify({
          pages: pageCount,
          transport,
          requestBytes,
          responseBytesPerCall: Buffer.byteLength(wire.text),
          framesPerCall: wire.frameCount,
          providerCalls: fetchMock.mock.calls.length,
          contentParseCount,
          checkpoints: checkpoint.mock.calls.length,
          parseMilliseconds: Number(parseMilliseconds.toFixed(2)),
          elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(2)),
        }),
      );
    });
  }
});
