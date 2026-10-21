// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LessonPlan } from '@reachany/reach-deck-dsl';
import {
  editableLessonObjectives,
  editableSavedLessonPlan,
} from './ReachDeckLessonStructureEditor';

const plan: LessonPlan = {
  id: 'lesson-1',
  title: 'Test',
  audience: 'Grade 5',
  durationMinutes: 10,
  learningObjectives: ['teacher modified the old list', 'Original goal'],
  objectives: [
    { id: 'objective-1', statement: 'Original goal', evidence: 'independent handwritten evidence' },
  ],
  narrative: 'Original narrative',
  teachingStrategy: 'Inquiry',
  keyTerms: ['radius'],
};

describe('Step 2 editable source adapters', () => {
  it('preserves diverged legacy teacher text without attaching evidence by list position', () => {
    const result = editableLessonObjectives(plan);
    expect(result).toEqual([
      {
        id: 'objective-1',
        statement: 'Original goal',
        evidence: 'independent handwritten evidence',
      },
      { id: 'objective-editor-2', statement: 'teacher modified the old list', evidence: '' },
    ]);
    expect(
      editableLessonObjectives({
        ...plan,
        objectives: result,
        learningObjectives: result.map(({ statement }) => statement),
      }),
    ).toEqual(result);
    expect(plan.objectives).toHaveLength(1);
  });

  it('does not trim or infer equivalence between independently authored objectives', () => {
    const result = editableLessonObjectives({
      ...plan,
      learningObjectives: ['  Original goal  ', 'Original goal\nSecond line'],
    });
    expect(result.map(({ statement }) => statement)).toEqual([
      'Original goal',
      '  Original goal  ',
      'Original goal\nSecond line',
    ]);
  });

  it('restores empty advisory teaching fields instead of resurrecting a previous valid plan', () => {
    const restored = editableSavedLessonPlan(plan, {
      id: plan.id,
      objectives: [],
      learningObjectives: [],
      narrative: '',
      teachingStrategy: '',
      keyTerms: [],
    });
    expect(restored).toMatchObject({
      objectives: [],
      learningObjectives: [],
      narrative: '',
      teachingStrategy: '',
      keyTerms: [],
    });
    expect(editableLessonObjectives(restored!)).toEqual([]);
    expect(editableSavedLessonPlan(plan, undefined)).toBe(plan);
  });

  it.each([undefined, null])(
    'fills missing editor shapes with empties, never prior content (%s)',
    (empty) => {
      const restored = editableSavedLessonPlan(plan, {
        story: {
          sections: [{ id: 'section-old', title: 'Exact original title', objectiveIds: empty }],
          advanceOrganizer: empty,
          closing: empty,
        },
        objectives: empty,
        learningObjectives: empty,
        knowledgePlan: {
          points: [{ id: 'point-old', title: 'Exact point', items: empty, objectiveIds: empty }],
        },
      })!;
      expect(restored.objectives).toEqual([]);
      expect(restored.learningObjectives).toEqual([]);
      expect(restored.story!.advanceOrganizer).toEqual({
        coreQuestion: '',
        priorKnowledge: [],
        learningRoute: [],
        successEvidence: [],
      });
      expect(restored.story!.closing).toEqual({ synthesis: '', returnToOpening: '', transfer: '' });
      expect(restored.story!.sections[0]).toMatchObject({
        id: 'section-old',
        title: 'Exact original title',
        objectiveIds: [],
      });
      expect(restored.knowledgePlan!.points[0]).toMatchObject({
        id: 'point-old',
        title: 'Exact point',
        items: [],
        objectiveIds: [],
        learnerAttempt: '',
      });
    },
  );
});
