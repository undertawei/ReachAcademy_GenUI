import { describe, expect, it } from 'vitest';
import {
  REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
  applyPageInstructionalSpec,
  getLegacyPageInstructionalSpec as getPageInstructionalSpec,
  parseGeneratedPageOutlineValue,
  parsePageOutlineValue,
  parsePagedDeckOutlineValue,
  normalizeTeacherPagedDeckOutlineValue,
  type PageInstructionalSpec,
  type PageOutline,
} from '../src/index.js';

const legacy: PageOutline = {
  id: 'page-1',
  order: 1,
  sceneType: 'slide',
  title: '原有页面',
  pageRole: 'worked_example',
  pageFunctions: ['develop'],
  pageJob: '完整示范如何用证据判断。',
  sectionId: 'section-1',
  objectiveIds: ['objective-1'],
  knowledgePointId: 'point-1',
  microCycleStages: ['explain_reveal'],
  summarizesKnowledgePointIds: [],
  visibleTitleMode: 'topic',
  continuity: {
    fromPrevious: '承接观察。',
    learningAdvance: '完成证据解释。',
    toNext: '进入迁移。',
  },
  instructionalSpec: {
    learningObjective: '学生能解释判断依据。',
    teachingMove: 'demonstrate',
    focusStatement: '比较两种独立的证据。',
    supportingDetails: ['先排除无关条件。'],
    keyPoints: ['比较两种独立的证据。', '先排除无关条件。', '保留反例及条件边界。'],
    visualDirection: '并列呈现证据。',
    density: 'low',
    assessmentEvidence: '解释支持结论的条件。',
    visualAssets: [
      {
        kind: 'image',
        purpose: '场景',
        prompt: '教室场景',
        alt: '教室',
        aspectRatio: '16:9',
        placement: 'hero',
      },
    ],
  },
  slideClassification: {
    primaryType: 'single_focus',
    density: 'high',
    visualFocus: 'example',
    mediaType: 'none',
  },
};

describe('unified editable page instructional specification', () => {
  it.each(['slide', 'quiz', 'interactive'] as const)(
    'adopts sparse %s teaching drafts without Slide requirements',
    (sceneType) => {
      const result = normalizeTeacherPagedDeckOutlineValue({
        id: 'outline',
        title: 'Course',
        pages: [
          {
            id: 'page-1',
            order: 1,
            sceneType,
            title: '',
            estimatedDurationMinutes: 0,
            instructionalSpec: {
              schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
              learningObjective: '',
              pageJob: '',
              visualDirection: '',
              supportingDetails: [],
              objectiveIds: ['', 'removed', 'removed'],
              summarizesKnowledgePointIds: ['', 'old'],
              sectionId: 'deleted-section',
            },
          },
        ],
      });
      expect(result.pages[0]).toMatchObject({
        sceneType,
        title: '',
        estimatedDurationMinutes: 0,
        instructionalSpec: {
          learningObjective: '',
          pageJob: '',
          knowledgePointIds: ['', 'old'],
        },
      });
      expect(parsePagedDeckOutlineValue(result)).toEqual(result);
    },
  );

  it('preserves incomplete legacy plans and advanced source as inert reference text', () => {
    const raw = '{"html":"<p>keep exact text</p>"';
    const result = normalizeTeacherPagedDeckOutlineValue({
      id: 'outline',
      title: 'Course',
      story: {},
      roadmap: null,
      pages: [
        {
          id: 'page-1',
          order: 1,
          sceneType: 'quiz',
          title: '',
          instructionalSpec: {
            keyPoints: ['Teacher fact'],
            visualDirection: '',
            interactionAssessmentPlan: { unfinished: raw },
            customInstruction: 'Keep my custom instruction',
            supportingDetails: [raw],
          },
          slideClassification: {},
        },
      ],
    });
    const spec = result.pages[0].instructionalSpec!;
    expect(spec.pageJob).toBe('Teacher fact');
    expect(spec.keyPoints).toContain(raw);
    expect(spec.keyPoints).toContain('[customInstruction]\nKeep my custom instruction');
    expect(spec.keyPoints?.some((text) => text.startsWith('[interactionAssessmentPlan]'))).toBe(
      true,
    );
    expect(spec.keyPoints).toContain('story: {}');
    expect(spec.keyPoints).toContain('roadmap: null');
    expect(spec.interactionAssessmentPlan).toBeUndefined();
    expect(result.pages[0].slideClassification).toBeUndefined();
    expect(parsePagedDeckOutlineValue(result)).toEqual(result);
    expect(normalizeTeacherPagedDeckOutlineValue(result)).toEqual(result);
  });

  it('retains out-of-scene historical planning as context after a teacher changes page type', () => {
    const promoted = applyPageInstructionalSpec(legacy, getPageInstructionalSpec(legacy));
    const result = normalizeTeacherPagedDeckOutlineValue({
      id: 'outline',
      title: 'Course',
      pages: [{ ...promoted, sceneType: 'quiz' }],
    });
    expect(result.pages[0].instructionalSpec?.visualAssets).toEqual(
      legacy.instructionalSpec!.visualAssets,
    );
  });

  it('preserves malformed legacy aliases without restoring cleared canonical fields', () => {
    const source = {
      id: 'outline',
      title: 'Course',
      pages: [
        {
          id: 'page-1',
          order: 1,
          sceneType: 'quiz',
          title: '',
          instructionalSpec: {
            keyPoints: '保留关键事实',
            teachingMove: '先让学生实验',
            focusStatement: 123,
          },
        },
      ],
    };
    const adopted = normalizeTeacherPagedDeckOutlineValue(source);
    expect(adopted.pages[0].instructionalSpec!.keyPoints).toEqual([
      '[teachingMove]\n先让学生实验',
      '[focusStatement]\n123',
      '[keyPoints]\n保留关键事实',
    ]);
    expect(normalizeTeacherPagedDeckOutlineValue(adopted)).toEqual(adopted);
    source.pages[0].instructionalSpec = {
      ...source.pages[0].instructionalSpec,
      schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
      pageJob: '',
      supportingDetails: [],
    } as (typeof source.pages)[0]['instructionalSpec'];
    expect(
      normalizeTeacherPagedDeckOutlineValue(source).pages[0].instructionalSpec!.pageJob,
    ).toEqual('');
  });

  it('still rejects unknown scene dispatch, duplicate identity and invalid page order', () => {
    const outline = {
      id: 'outline',
      title: 'Course',
      pages: [{ id: 'page-1', order: 1, sceneType: 'quiz', title: '' }],
    };
    expect(() =>
      normalizeTeacherPagedDeckOutlineValue({
        ...outline,
        pages: [{ ...outline.pages[0], sceneType: 'unknown' }],
      }),
    ).toThrow();
    expect(() =>
      normalizeTeacherPagedDeckOutlineValue({
        ...outline,
        pages: [outline.pages[0], { ...outline.pages[0], order: 2 }],
      }),
    ).toThrow();
    expect(() =>
      normalizeTeacherPagedDeckOutlineValue({
        ...outline,
        pages: [{ ...outline.pages[0], order: 0 }],
      }),
    ).toThrow();
  });

  it('promotes usable legacy task text past empty aliases without refilling a cleared v2 task', () => {
    const source = {
      ...legacy,
      pageJob: '',
      instructionalSpec: { ...legacy.instructionalSpec!, focusStatement: '  ' },
    };
    const spec = getPageInstructionalSpec(source);
    expect(spec.pageJob).toBe(source.instructionalSpec.keyPoints[0]);
    const cleared = applyPageInstructionalSpec(source, { ...spec, pageJob: '' });
    expect(getPageInstructionalSpec(cleared).pageJob).toBe('');
    expect(parsePageOutlineValue(cleared).pageJob).toBe('');
  });
  it('roundtrips merged legacy prose beyond former alias bounds and cleared associations', () => {
    const source = { ...legacy, continuesFrom: '原文'.repeat(240) };
    source.continuity = { ...legacy.continuity!, fromPrevious: '补充'.repeat(240) };
    const spec = {
      ...getPageInstructionalSpec(source),
      sectionId: '',
      knowledgePointId: '',
      pageJob: '教师详细职责'.repeat(120),
    };
    const result = parsePageOutlineValue(applyPageInstructionalSpec(source, spec));
    expect(result.continuesFrom).toBe(
      `${source.continuity.fromPrevious}\n\n${source.continuesFrom}`,
    );
    expect(result.pageJob).toBe(spec.pageJob);
    expect(result.sectionId).toBe('');
    expect(result.knowledgePointId).toBe('');
  });
  it('migrates all legacy responsibility and distinct content without duplicating equivalent fields', () => {
    const spec = getPageInstructionalSpec(legacy);
    expect(spec).toMatchObject({
      schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
      pageJob: legacy.pageJob,
      pageRole: 'worked_example',
      pageFunctions: ['develop'],
      learningObjective: legacy.instructionalSpec!.learningObjective,
      sectionId: 'section-1',
      objectiveIds: ['objective-1'],
      knowledgePointId: 'point-1',
      microCycleStages: ['explain_reveal'],
      summarizesKnowledgePointIds: [],
      visibleTitleMode: 'topic',
      continuity: legacy.continuity,
      visualAssets: legacy.instructionalSpec!.visualAssets,
      assessmentEvidence: legacy.instructionalSpec!.assessmentEvidence,
    });
    expect(spec.supportingDetails).toEqual([
      '先排除无关条件。',
      '比较两种独立的证据。',
      '保留反例及条件边界。',
    ]);
    expect(spec.keyPoints).toEqual([legacy.pageJob, ...spec.supportingDetails!]);
    expect(getPageInstructionalSpec(applyPageInstructionalSpec(legacy, spec))).toEqual(spec);
  });

  it('makes edited responsibility, details and density authoritative for old consumers', () => {
    const edited = applyPageInstructionalSpec(legacy, {
      ...getPageInstructionalSpec(legacy),
      pageRole: 'transfer',
      pageJob: '在新情境中应用已学方法。',
      supportingDetails: ['保留新情境中的给定事实。'],
      density: 'medium',
    });
    expect(edited.pageRole).toBe('transfer');
    expect(edited.pageJob).toBe('在新情境中应用已学方法。');
    expect(edited.instructionalSpec!.focusStatement).toBe(edited.pageJob);
    expect(edited.instructionalSpec!.teachingMove).toBe('transfer');
    expect(edited.instructionalSpec!.keyPoints).toEqual([
      edited.pageJob,
      '保留新情境中的给定事实。',
    ]);
    expect(edited.slideClassification!.density).toBe('medium');
    expect(legacy.pageJob).toBe('完整示范如何用证据判断。');
  });

  it('preserves independent continuity wording in a single editable field', () => {
    const spec = getPageInstructionalSpec({
      ...legacy,
      continuesFrom: '另一个必须保留的前页问题。',
      handsOffTo: legacy.continuity!.toNext,
    });
    expect(spec.continuity).toEqual({
      fromPrevious: '承接观察。\n\n另一个必须保留的前页问题。',
      learningAdvance: '完成证据解释。',
      toNext: '进入迁移。',
    });
  });

  it('preserves legacy exploration as an editable micro-cycle and derives its teaching move', () => {
    const spec = getPageInstructionalSpec({
      ...legacy,
      pageRole: undefined,
      microCycleStages: undefined,
      instructionalSpec: { ...legacy.instructionalSpec!, teachingMove: 'explore' },
    });
    expect(spec.pageRole).toBe('develop');
    expect(spec.microCycleStages).toEqual(['curiosity_explore']);
    expect(spec.teachingMove).toBe('explore');
    expect(
      applyPageInstructionalSpec(legacy, { ...spec, microCycleStages: ['attempt_predict'] })
        .instructionalSpec!.teachingMove,
    ).toBe('explore');
    expect(
      applyPageInstructionalSpec(legacy, { ...spec, pageRole: 'transfer' }).instructionalSpec!
        .teachingMove,
    ).toBe('transfer');
  });

  it('accepts partially cleared canonical continuity while deriving missing draft text', () => {
    const parsed = parsePageOutlineValue({
      ...legacy,
      instructionalSpec: {
        schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
        continuity: { fromPrevious: '只保留承接。' },
      },
    });
    expect(parsed.continuity).toEqual({ fromPrevious: '只保留承接。', learningAdvance: '' });
    expect(parsed.handsOffTo).toBeUndefined();
  });

  it('does not resurrect old fields after the teacher clears canonical fields', () => {
    const edited: PageInstructionalSpec = {
      ...getPageInstructionalSpec(legacy),
      pageRole: undefined,
      pageJob: '',
      sectionId: undefined,
      objectiveIds: [],
      knowledgePointId: undefined,
      pageFunctions: [],
      continuity: undefined,
      supportingDetails: [],
      interactionBrief: undefined,
    };
    const saved = parsePageOutlineValue(
      applyPageInstructionalSpec(
        {
          ...legacy,
          continuesFrom: '过时的承接',
          handsOffTo: '过时的下一页',
        },
        edited,
      ),
    );
    expect(saved.pageRole).toBeUndefined();
    expect(saved.sectionId).toBeUndefined();
    expect(saved.knowledgePointId).toBeUndefined();
    expect(saved.continuity).toBeUndefined();
    expect(saved.continuesFrom).toBeUndefined();
    expect(saved.handsOffTo).toBeUndefined();
    expect(saved.pageJob).toBe('');
    expect(saved.instructionalSpec!.keyPoints).toEqual([]);
    expect(getPageInstructionalSpec(saved).pageJob).toBe('');
  });

  it('accepts canonical-only model output and projects old runtime fields', () => {
    const parsed = parseGeneratedPageOutlineValue({
      sceneType: 'quiz',
      title: '教师修改的检测题',
      instructionalSpec: {
        schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
        pageRole: 'checkpoint',
        pageJob: '检测判断依据。',
        supportingDetails: ['两个独立条件。'],
        learningObjective: '能说明理由。',
        assessmentIntent: '选择并解释。',
        assessmentEvidence: '引用条件。',
        visualDirection: '',
        density: 'low',
        continuity: { learningAdvance: '确认迁移。' },
      },
    });
    expect(parsed.pageRole).toBe('checkpoint');
    expect(parsed.instructionalSpec!.teachingMove).toBe('evaluate');
    expect(parsed.instructionalSpec!.keyPoints).toEqual(['检测判断依据。', '两个独立条件。']);
    expect(parsed.continuity).toEqual({ learningAdvance: '确认迁移。' });
  });

  it('keeps legacy page wire shapes readable without silently migrating their output', () => {
    const page = { ...legacy, instructionalSpec: { ...legacy.instructionalSpec! } };
    expect(parsePageOutlineValue(page)).toEqual(page);
    expect(parsePageOutlineValue(page).instructionalSpec!.schemaVersion).toBeUndefined();
  });

  it('migrates legacy interaction context without discarding independent learner guidance', () => {
    const page: PageOutline = {
      id: 'interactive',
      order: 1,
      sceneType: 'interactive',
      title: '实验',
      interactionBrief: {
        learnerAction: '自由改变参数。',
        experienceGoal: '观察因果。',
        approachHints: ['允许自由路径。'],
      },
    };
    const spec = getPageInstructionalSpec(page);
    expect(spec.interactionBrief).toEqual(page.interactionBrief);
    const parsed = parsePageOutlineValue(applyPageInstructionalSpec(page, spec));
    expect(parsed.interactionBrief).toEqual(page.interactionBrief);
    const cleared = parsePageOutlineValue(
      applyPageInstructionalSpec(parsed, { ...spec, interactionBrief: undefined }),
    );
    expect(cleared.interactionBrief).toBeUndefined();
  });

  it.each([
    { pageRole: 'invented-role' },
    { pageFunctions: ['develop', 'invented-role'] },
    { microCycleStages: ['invented-stage'] },
    { density: 'invented-density' },
    { visibleTitleMode: 'invented-title' },
    { teachingMove: 'invented-move' },
    { unrecognized: 'text' },
  ])('rejects malformed canonical enum or unknown fields: %j', (invalid) => {
    expect(() =>
      parsePageOutlineValue({
        id: 'p',
        order: 1,
        sceneType: 'slide',
        title: '页面',
        instructionalSpec: {
          schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
          ...invalid,
        },
      }),
    ).toThrow();
  });

  it('keeps teacher-edited references even when Step 2 does not contain them', () => {
    const edited = applyPageInstructionalSpec(legacy, {
      ...getPageInstructionalSpec(legacy),
      sectionId: 'teacher-section',
      objectiveIds: ['teacher-objective'],
      knowledgePointId: 'teacher-point',
    });
    const outline = {
      id: 'outline',
      title: '课件',
      pages: [edited],
      story: {
        schemaVersion: 'reach-deck-story/v1',
        coreQuestion: '为什么？',
        learnerPromise: '能够解释。',
        advanceOrganizer: {
          priorKnowledge: ['观察'],
          coreQuestion: '为什么？',
          learningRoute: ['解释'],
          successEvidence: ['证据'],
        },
        opening: '观察',
        development: '解释',
        closing: { synthesis: '归纳', returnToOpening: '回答', transfer: '应用' },
        sections: [
          {
            id: 'section-1',
            title: '原有章节',
            question: '问题',
            objectiveIds: ['objective-1'],
            entryCondition: '观察',
            exitOutcome: '解释',
          },
        ],
      },
    };
    expect(parsePagedDeckOutlineValue(outline).pages[0]).toMatchObject({
      sectionId: 'teacher-section',
      objectiveIds: ['teacher-objective'],
      knowledgePointId: 'teacher-point',
    });
  });
});
