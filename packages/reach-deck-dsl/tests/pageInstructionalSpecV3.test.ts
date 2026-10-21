import { describe, it, expect } from 'vitest';
import {
  getPageInstructionalSpec,
  applyPageInstructionalSpec,
  parsePageOutlineValue,
  normalizeTeacherPagedDeckOutlineValue,
  REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3 as V3,
} from '../src/index.js';
const page: any = { id: 'p', order: 1, sceneType: 'quiz', title: 'Page' };
describe('v3 scene specification migration', () => {
  it('preserves raw HTML, whitespace, JSON and brief text through parse/adopt and repeat reads', () => {
    const raw = '<p>老师  原文</p>\n{ "x":  1 }\n';
    const spec = getPageInstructionalSpec({
      ...page,
      instructionalSpec: {
        pageJob: raw,
        keyPoints: [raw],
        learningObjective: raw,
        visualDirection: raw,
      },
      interactionBrief: { learnerAction: raw, experienceGoal: raw, approachHints: [raw] },
    });
    const saved = parsePageOutlineValue(applyPageInstructionalSpec(page, spec));
    expect(saved.instructionalSpec?.keyPoints).toContain(raw);
    expect(saved.instructionalSpec?.learningObjective).toBe(raw);
    expect(saved.interactionBrief?.learnerAction).toBe(raw);
    expect(getPageInstructionalSpec(saved)).toEqual(spec);
    const adopted = normalizeTeacherPagedDeckOutlineValue({
      id: 'o',
      title: 'Deck',
      pages: [saved],
    });
    expect(adopted.pages[0]).toEqual(saved);
  });
  it('preserves mixed scopes and reveal precedence with supplemental exact labels', () => {
    const spec = getPageInstructionalSpec({
      ...page,
      pageRole: 'develop',
      knowledgePointId: 'new-a',
      summarizesKnowledgePointIds: ['old-c', 'old-b'],
      pageFunctions: ['transfer'],
      microCycleStages: ['attempt_predict', 'explain_reveal'],
    });
    expect(spec.pageRole).toBe('reveal');
    expect(spec.knowledgePointIds).toEqual(['new-a', 'old-c', 'old-b']);
    expect(spec.keyPoints.join('\n')).toContain('[microCycleStages]');
    expect(spec.keyPoints.join('\n')).toContain('[knowledgePointId]');
    expect(spec.keyPoints.join('\n')).toContain('[summarizesKnowledgePointIds]');
  });
  it('does not refill explicitly cleared v2 role or v3 canonical fields from stale aliases', () => {
    expect(
      getPageInstructionalSpec({
        ...page,
        pageRole: 'transfer',
        instructionalSpec: {
          schemaVersion: 'reach-deck-instructional-spec/v2',
          pageRole: null,
          pageJob: '',
        },
      }).pageRole,
    ).toBeUndefined();
    const saved = applyPageInstructionalSpec(
      {
        ...page,
        pageRole: 'transfer',
        pageJob: 'stale',
        interactionBrief: { learnerAction: 'old', experienceGoal: 'old' },
      },
      getPageInstructionalSpec({
        ...page,
        instructionalSpec: { schemaVersion: V3, keyPoints: [], pageJob: '', knowledgePointIds: [] },
      }),
    );
    expect(saved.pageRole).toBeUndefined();
    expect(saved.pageJob).toBe('');
    expect(saved.interactionBrief).toBeUndefined();
    expect(saved.instructionalSpec.keyPoints).toEqual([]);
  });
  it('keeps unknown v3 extension and malformed legacy teaching prose editable', () => {
    const spec = getPageInstructionalSpec({
      ...page,
      instructionalSpec: { schemaVersion: V3, customInstruction: 'KEEP  <b>exact</b>' },
    });
    expect(spec.keyPoints).toEqual(['[customInstruction]\nKEEP  <b>exact</b>']);
    const adopted = normalizeTeacherPagedDeckOutlineValue({
      id: 'o',
      title: 'Deck',
      pages: [
        {
          ...page,
          instructionalSpec: { schemaVersion: V3, customInstruction: 'KEEP', keyPoints: [] },
        },
      ],
    });
    expect(adopted.pages[0].instructionalSpec?.keyPoints).toEqual(['[customInstruction]\nKEEP']);
    const old = getPageInstructionalSpec({
      ...page,
      instructionalSpec: { teachingMove: '先让学生实验', focusStatement: 123 },
    });
    expect(old.keyPoints).toContain('[teachingMove]\n先让学生实验');
    expect(old.keyPoints).toContain('[focusStatement]\n123');
  });
  it('keeps retired visual intents as editable reference text, never as a media plan', () => {
    const spec = getPageInstructionalSpec({
      ...page,
      instructionalSpec: { visualIntents: ['画 y=x；4:3'] },
    });
    expect(spec.visualAssets).toEqual([]);
    expect(spec).not.toHaveProperty('visualIntents');
    expect(spec.keyPoints).toContain('[visualIntents]\n[\n  "画 y=x；4:3"\n]');
  });
  it.each(['slide', 'quiz', 'interactive'])(
    'adopts sparse %s without unrelated requirements',
    (sceneType) => {
      const result = normalizeTeacherPagedDeckOutlineValue({
        id: 'o',
        title: 'Deck',
        pages: [{ ...page, sceneType, instructionalSpec: { schemaVersion: V3 } }],
      });
      expect(result.pages[0].sceneType).toBe(sceneType);
      expect(result.pages[0].instructionalSpec?.schemaVersion).toBe(V3);
    },
  );
});
