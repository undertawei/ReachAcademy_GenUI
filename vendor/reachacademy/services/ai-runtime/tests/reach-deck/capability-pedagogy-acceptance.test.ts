import {
  parseLessonPlanValue,
  richTextFromPlainText,
  REFERENCE_MANIFEST_VERSION,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  type DeckSlide,
  type GenerationSceneType,
  type PageGenerationRequest,
  type PageRole,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
} from '@reachany/reach-deck-dsl/reference-library';
import { describe, expect, it, vi } from 'vitest';

import {
  buildCompactOutlineSchema,
  parseCompactOutline,
} from '../../lib/reach-deck/compact-outline.js';
import {
  composeHtmlProductionPrompt,
  HTML_PRODUCTION_PROMPT_VERSION,
} from '../../lib/reach-deck/prompts/html-production.js';
import { REFERENCE_OUTLINE_PROMPT } from '../../lib/reach-deck/prompts/reference-design.js';
import {
  generatePageArtifactWithModelService,
  generatePagedDeckOutlineWithModelService,
  prepareNarrationForSlide,
} from '../../lib/reach-deck/generation-pipeline.js';
import { buildReachDeckSlideContentDigest } from '../../lib/reach-deck/job-identity.js';
import type { ReachDeckFinalizedModelPayload } from '../../lib/reach-deck/model-service-client.js';
import * as localPrompts from '../../lib/reach-deck/prompts/corpus/local-stages.js';
import { PAGE_RESPONSIBILITY_PRIORITY } from '../../lib/reach-deck/prompts/corpus/page-responsibility.js';
import {
  KNOWLEDGE_MICRO_CYCLE_PEDAGOGY_SNIPPET,
  PREPARATION_DESIGN_GUIDE,
} from '../../lib/reach-deck/prompts/corpus/local-snippets.js';
import {
  NARRATION_PROMPT,
  INTERACTIVE_PROMPT_SECTIONS,
  PROMPT_CORPUS_DIGEST,
  PROMPT_CORPUS_VERSION,
} from '../../lib/reach-deck/prompts/index.js';

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
  jobId: 'job-pedagogy-acceptance',
  runId: 'run-pedagogy-acceptance',
};
const MODEL_ENV = { REACHANY_SERVICE_JWT_SECRET: 'offline-fixture-secret' };
const FACTS = ['相同时间内，路程越长，平均速度越大。', '总路程除以总时间得到平均速度。'];
const DESIGN_CONTEXT = {
  schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
  libraryVersion: REFERENCE_LIBRARY_VERSION,
  librarySha256: REFERENCE_LIBRARY_SHA256,
  paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
  originalDesign: false,
  typographyProfile: 'general' as const,
  imageStyleReferenceIds: [],
  visualIntent: 'Clear motion evidence',
  resolvedColors: {
    background: '#ffffff',
    surface: '#eeeeee',
    ink: '#111111',
    muted: '#444444',
    accent: '#005599',
    success: '#006633',
    warning: '#885500',
  },
};

function lessonFixture() {
  return {
    id: 'lesson-motion',
    title: '比较运动与平均速度',
    audience: 'Grade 8',
    durationMinutes: 30,
    learningObjectives: ['根据同一时间内的路程比较运动', '解释平均速度的计算'],
    teachingStrategy: 'Observe, predict, explain and apply each knowledge point.',
    keyTerms: ['路程', '时间', '平均速度'],
    narrative: '先比较，再用平均速度处理不同时间的运动。',
    assessmentPlan: '分别提交比较理由和平均速度计算过程。',
    objectives: FACTS.map((statement, index) => ({
      id: `objective-${index + 1}`,
      statement,
      evidence: `提交知识点 ${index + 1} 的判断与理由。`,
    })),
    story: {
      schemaVersion: 'reach-deck-story/v1',
      coreQuestion: '怎样公平比较两段运动？',
      learnerPromise: '能比较运动并说明自己的判断依据。',
      advanceOrganizer: {
        priorKnowledge: ['认识路程与时间'],
        coreQuestion: '怎样公平比较两段运动？',
        learningRoute: ['相同时间的比较', '不同时间的比较'],
        successEvidence: ['提交比较理由', '解释比值的含义'],
      },
      opening: '呈现两段运动记录。',
      development: '逐项完成比较和计算的学习循环。',
      closing: {
        synthesis: '比较运动需要同时考虑路程与时间。',
        returnToOpening: '用比较依据回应开头的问题。',
        transfer: '用新的路程和时间数据比较运动。',
      },
      sections: FACTS.map((_, index) => ({
        id: `section-${index + 1}`,
        title: `运动比较 ${index + 1}`,
        question: `如何验证判断 ${index + 1}？`,
        objectiveIds: [`objective-${index + 1}`],
        entryCondition: '认识路程与时间。',
        exitOutcome: `解释知识点 ${index + 1} 并完成应用。`,
      })),
    },
    knowledgePlan: {
      schemaVersion: 'reach-deck-knowledge-plan/v1',
      points: FACTS.map((fact, index) => ({
        id: `knowledge-${index + 1}`,
        sectionId: `section-${index + 1}`,
        title: `运动知识点 ${index + 1}`,
        kind: 'standard',
        items: [{ id: `atom-${index + 1}`, content: fact }],
        objectiveIds: [`objective-${index + 1}`],
        prerequisite: '认识路程与时间。',
        targetUnderstanding: fact,
        masteryEvidence: `提交知识点 ${index + 1} 的判断与理由。`,
        curiositySeed: '只看路程能公平比较吗？',
        learnerAttempt: '先预测再提交比较依据。',
        reveal: fact,
      })),
    },
    presentationPreferences: { includeTitlePage: false },
  };
}

type PageFixtureOptions = {
  point?: number;
  sceneType?: GenerationSceneType;
  pageRole?: PageRole;
  fact?: string;
};

function pageFixture({
  point = 1,
  sceneType = 'slide',
  pageRole = 'develop',
  fact = FACTS[point - 1]!,
}: PageFixtureOptions = {}) {
  return {
    sceneType,
    designIntent: {
      pageRole: 'content' as const,
      focus: fact,
      informationRelationship: 'single_focus',
      layoutReferenceIds: [REFERENCE_LIBRARY.layouts[0]!.id],
      componentReferenceIds: [],
      imageStyleReferenceIds: [],
    },
    title: `运动知识点 ${point}`,
    estimatedDurationMinutes: 2,
    instructionalSpec: {
      schemaVersion: 'reach-deck-instructional-spec/v3',
      learningObjective: fact,
      pageRole,
      pageJob: fact,
      keyPoints: [fact, '比较前先确认路程和时间使用一致的单位。'],
      knowledgePointIds: [`knowledge-${point}`],
      assessmentEvidence: sceneType === 'quiz' ? '提交判断及计算依据，保留部分正确的推理。' : null,
      visualDirection: sceneType === 'slide' ? 'Present the motion records clearly.' : null,
      visualAssets: [],
      ...(sceneType === 'slide' ? { density: 'medium', visibleTitleMode: 'topic' } : {}),
    } as Record<string, unknown>,
    slideClassification:
      sceneType === 'slide'
        ? { primaryType: 'single_focus', visualFocus: 'statement', mediaType: 'none' }
        : null,
    interactionBrief:
      sceneType === 'interactive'
        ? {
            learnerAction: '自由比较运动记录',
            experienceGoal: '观察路程与时间如何共同决定快慢',
            approachHints: null,
          }
        : null,
    materialReferenceOrdinals: null,
  };
}

function outlineFixture(pages: ReturnType<typeof pageFixture>[]) {
  return { title: '比较运动与平均速度', designContext: DESIGN_CONTEXT, pages };
}

function messageText(payload: ReachDeckFinalizedModelPayload) {
  const messages = payload.modelInput.messages as Array<{ role: string; content: string }>;
  return messages.map(({ content }) => content).join('\n\n');
}

async function generateFixedOutline(pages: ReturnType<typeof pageFixture>[], prompt?: string) {
  const modelPayloads: ReachDeckFinalizedModelPayload[] = [];
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const actualBody = JSON.parse(init!.body as string);
    expect(actualBody.messages).toEqual(modelPayloads.at(-1)!.modelInput.messages);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(outlineFixture(pages)) } }],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const lessonPlan = parseLessonPlanValue(lessonFixture());
  const result = await generatePagedDeckOutlineWithModelService(
    { source: FACTS.join('\n'), lessonPlan, prompt, manifestVersion: REFERENCE_MANIFEST_VERSION },
    {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onModelPayload: (payload) => {
        modelPayloads.push(payload);
      },
    },
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(modelPayloads).toHaveLength(1);
  expect(messageText(modelPayloads[0]!)).toContain(REFERENCE_OUTLINE_PROMPT.text);
  expect(messageText(modelPayloads[0]!)).toContain(PAGE_RESPONSIBILITY_PRIORITY);
  return { result, lessonPlan, payload: modelPayloads[0]! };
}

// Fixed provider outputs prove transport, prompt wiring and adapter preservation. They do not
// demonstrate that a live model will choose these pedagogical decisions from a conflicting brief.
describe('capability pedagogy acceptance with fixed provider outputs', () => {
  it('preserves two complete knowledge cycles, knowledge scope and Quiz evidence', async () => {
    const sequence: PageFixtureOptions[] = [
      { sceneType: 'interactive', pageRole: 'exploration' },
      { sceneType: 'quiz', pageRole: 'attempt' },
      { sceneType: 'slide', pageRole: 'reveal' },
      { sceneType: 'quiz', pageRole: 'practice' },
    ];
    const pages = [1, 2].flatMap((point) =>
      sequence.map((part) => pageFixture({ ...part, point })),
    );
    const { result, lessonPlan, payload } = await generateFixedOutline(pages);
    const text = messageText(payload);
    for (const corpus of [PREPARATION_DESIGN_GUIDE, KNOWLEDGE_MICRO_CYCLE_PEDAGOGY_SNIPPET])
      expect(text).toContain(corpus);
    expect(text).toContain(JSON.stringify(lessonPlan));
    expect(text).toContain(PROMPT_CORPUS_VERSION);
    expect(text).toContain(PROMPT_CORPUS_DIGEST);
    expect(payload.promptVersion).toBe(REFERENCE_OUTLINE_PROMPT.version);
    expect(result.pages).toHaveLength(8);
    expect(result.pages.map((page) => page.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const point of [1, 2]) {
      const cycle = result.pages.filter((page) =>
        page.instructionalSpec?.knowledgePointIds?.includes(`knowledge-${point}`),
      );
      expect(cycle.map((page) => page.pageRole)).toEqual(sequence.map(({ pageRole }) => pageRole));
      expect(cycle.map((page) => page.sceneType)).toEqual(['interactive', 'quiz', 'slide', 'quiz']);
      for (const page of cycle) {
        expect(page.pageJob).toBe(FACTS[point - 1]);
        expect(page.instructionalSpec!.keyPoints).toContain(FACTS[point - 1]);
        if (page.sceneType === 'quiz') {
          expect(page.instructionalSpec).toMatchObject({
            assessmentEvidence: '提交判断及计算依据，保留部分正确的推理。',
          });
        }
      }
    }
    // Step 2 is advisory: the outline no longer copies its story or roadmap.
    expect(result.roadmap).toBeUndefined();
  });

  const conflicts: Array<{
    name: string;
    prompt: string;
    fact: string;
    options: PageFixtureOptions;
    narrationMode?: string;
  }> = [
    {
      name: 'explanation takes priority over question-only wording',
      prompt: '本页只提问，不给解释。材料：小车在 2 秒内行驶 6 米。',
      fact: '小车在 2 秒内行驶 6 米。',
      options: { pageRole: 'develop' },
      narrationMode: 'explain_current_idea',
    },
    {
      name: 'Quiz responsibility takes priority over collecting answers on Slide',
      prompt: '改成 Slide 收集答案。材料：甲车 2 秒行驶 6 米，乙车 2 秒行驶 4 米。',
      fact: '甲车 2 秒行驶 6 米，乙车 2 秒行驶 4 米。',
      options: { sceneType: 'quiz', pageRole: 'checkpoint' },
    },
    {
      name: 'reveal takes priority over prolonging suspense',
      prompt: '继续保留悬念，不揭示比值。材料：6 米除以 2 秒得到每秒 3 米。',
      fact: '6 米除以 2 秒得到每秒 3 米。',
      options: { pageRole: 'reveal' },
      narrationMode: 'resolve_prior_question',
    },
    {
      name: 'closure takes priority over introducing a new topic',
      prompt: '收束页增加加速度新知识。保留材料：今天用路程与时间比较了运动。',
      fact: '今天用路程与时间比较了运动。',
      options: { pageRole: 'close' },
      narrationMode: 'close_briefly',
    },
    {
      name: 'transfer takes priority over repeating the entire definition',
      prompt: '重新完整讲一遍定义。材料：公交车 10 分钟行驶 4 千米。',
      fact: '公交车 10 分钟行驶 4 千米。',
      options: { pageRole: 'transfer' },
      narrationMode: 'transfer_learning',
    },
    {
      name: 'free Interactive responsibility takes priority over fixed controls and steps',
      prompt: '必须用两个下拉框和四个固定步骤。材料：两辆小车都运行 5 秒。',
      fact: '两辆小车都运行 5 秒。',
      options: { sceneType: 'interactive', pageRole: 'exploration' },
    },
  ];

  it.each(conflicts)('$name', async ({ prompt, fact, options, narrationMode }) => {
    const fixedPage = pageFixture({ ...options, fact });
    const { result, lessonPlan, payload } = await generateFixedOutline([fixedPage], prompt);
    expect(messageText(payload)).toContain(prompt);
    const page = result.pages[0]!;
    expect(page).toMatchObject({
      sceneType: fixedPage.sceneType,
      pageRole: fixedPage.instructionalSpec.pageRole,
      pageJob: fact,
    });
    expect(page.instructionalSpec!.keyPoints).toContain(fact);
    const request: PageGenerationRequest = {
      runId: MODEL_CONTEXT.runId,
      pageId: page.id,
      requestedRevision: 1,
      attempt: 1,
      attemptReason: 'initial',
      source: fact,
      lessonPlan,
      pagedOutline: result,
      page,
      previousPageSummaries: [],
      nearbyLayoutReferenceIds: [],
      prompt,
    };
    const dispatchBoundary = new Error('offline acceptance: captured actual model payload');
    const pagePayloads: ReachDeckFinalizedModelPayload[] = [];
    const fetchMock = vi.fn();
    await expect(
      generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        onModelPayload: (modelPayload) => {
          pagePayloads.push(modelPayload);
          throw dispatchBoundary;
        },
      }),
    ).rejects.toBe(dispatchBoundary);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pagePayloads).toHaveLength(1);
    expect(pagePayloads[0]!.stage).toBe(page.sceneType);
    const pagePrompt = {
      slide: {
        version: HTML_PRODUCTION_PROMPT_VERSION,
        text: composeHtmlProductionPrompt(DESIGN_CONTEXT.resolvedColors),
      },
      quiz: localPrompts.QUIZ_PROMPT,
      // The immutable corpus contains retired technical blocks; generation uses the composed preamble.
      interactive: { text: INTERACTIVE_PROMPT_SECTIONS.PREAMBLE },
    }[page.sceneType];
    const forwarded = messageText(pagePayloads[0]!);
    expect(forwarded).toContain(pagePrompt.text);
    expect(forwarded).toContain(PAGE_RESPONSIBILITY_PRIORITY);
    expect(forwarded).toContain(prompt);
    expect(forwarded).toContain(fact);
    expect(forwarded).toContain(`"pageRole":"${page.pageRole}"`);
    expect(forwarded).toContain(`"pageJob":"${fact}"`);

    if (page.sceneType === 'slide') {
      const slide: DeckSlide = {
        id: page.id,
        title: page.title,
        layout: 'freeform',
        duration: 8,
        background: 'background',
        elements: [
          {
            id: 'body',
            type: 'text',
            frame: { x: 80, y: 80, width: 1200, height: 500 },
            layer: 1,
            variant: 'body',
            doc: richTextFromPlainText(fact),
          },
        ],
        animations: [],
        voiceTimeline: [],
      };
      const narrationPayloads: ReachDeckFinalizedModelPayload[] = [];
      await expect(
        prepareNarrationForSlide(
          {
            ...request,
            slideContentDigest: buildReachDeckSlideContentDigest(slide),
            lessonContext: {
              courseTitle: result.title,
              pageIndex: 1,
              totalPages: 2,
              currentPage: page,
            },
          },
          slide,
          {
            context: MODEL_CONTEXT,
            env: MODEL_ENV,
            fetch: fetchMock,
            onModelPayload: (modelPayload) => {
              narrationPayloads.push(modelPayload);
              throw dispatchBoundary;
            },
          },
        ),
      ).rejects.toBe(dispatchBoundary);
      expect(narrationPayloads).toHaveLength(1);
      const narration = messageText(narrationPayloads[0]!);
      expect(narration).toContain(NARRATION_PROMPT.text);
      expect(narration).toContain(localPrompts.NARRATION_PROMPT.text);
      expect(narration).toContain(PAGE_RESPONSIBILITY_PRIORITY);
      expect(narration).toContain(prompt);
      expect(narration).toContain(fact);
      expect(narration).toContain('"pagePosition":"last"');
      expect(narration).toContain(`"deliveryPolicy":{"mode":"${narrationMode}"}`);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  const invalidLessons: Array<[string, (plan: ReturnType<typeof lessonFixture>) => void, RegExp]> =
    [
      [
        'duplicate objective ID',
        (plan) => {
          plan.objectives[1]!.id = plan.objectives[0]!.id;
        },
        /unique/,
      ],
      [
        'duplicate section ID',
        (plan) => {
          plan.story.sections[1]!.id = plan.story.sections[0]!.id;
        },
        /unique/,
      ],
      [
        'duplicate knowledge point ID',
        (plan) => {
          plan.knowledgePlan.points[1]!.id = plan.knowledgePlan.points[0]!.id;
        },
        /unique/,
      ],
      [
        'duplicate atom ID across points',
        (plan) => {
          plan.knowledgePlan.points[1]!.items[0]!.id = plan.knowledgePlan.points[0]!.items[0]!.id;
        },
        /unique/,
      ],
      [
        'unknown section',
        (plan) => {
          plan.knowledgePlan.points[0]!.sectionId = 'missing-section';
        },
        /unknown deck section/,
      ],
      [
        'unknown objective',
        (plan) => {
          plan.knowledgePlan.points[0]!.objectiveIds = ['missing-objective'];
        },
        /unknown lesson objective/,
      ],
      [
        'cross-section objective',
        (plan) => {
          plan.knowledgePlan.points[0]!.objectiveIds = ['objective-2'];
        },
        /outside its section/,
      ],
      [
        'missing mastery evidence',
        (plan) => {
          plan.knowledgePlan.points[0]!.masteryEvidence = '';
        },
        /valid/,
      ],
    ];

  it.each(invalidLessons)('rejects lesson %s', (_label, mutate, error) => {
    const plan = lessonFixture();
    mutate(plan);
    expect(() => parseLessonPlanValue(plan)).toThrow(error);
  });

  // Step 2 references are advisory in v3; the model boundary checks scene ownership instead.
  const invalidPages: Array<[string, (page: ReturnType<typeof pageFixture>) => void, RegExp]> = [
    [
      'learner attempt on a Slide',
      (page) => {
        page.sceneType = 'slide';
        page.instructionalSpec = {
          ...page.instructionalSpec,
          pageRole: 'attempt',
          assessmentEvidence: null,
          visualDirection: 'Show the records',
          density: 'medium',
          visibleTitleMode: 'topic',
        };
        page.slideClassification = {
          primaryType: 'single_focus',
          visualFocus: 'statement',
          mediaType: 'none',
        };
      },
      /pageRole: Invalid enum/,
    ],
    [
      'Interactive without a brief',
      (page) => {
        page.sceneType = 'interactive';
        page.interactionBrief = null;
      },
      /interactionBrief|no allowed shape/,
    ],
    [
      'Quiz with a Slide classification',
      (page) => {
        page.slideClassification = {
          primaryType: 'single_focus',
          visualFocus: 'statement',
          mediaType: 'none',
        };
      },
      /slideClassification|expected null/,
    ],
  ];

  it.each(invalidPages)('rejects outline %s', (_label, mutate, error) => {
    const page = pageFixture({ sceneType: 'quiz', pageRole: 'checkpoint' });
    mutate(page);
    expect(() =>
      parseCompactOutline(
        outlineFixture([page]),
        parseLessonPlanValue(lessonFixture()),
        buildCompactOutlineSchema(['slide', 'quiz', 'interactive'], { referenceDesign: true }),
      ),
    ).toThrow(error);
  });
});
