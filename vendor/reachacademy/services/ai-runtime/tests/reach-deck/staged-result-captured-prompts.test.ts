import { describe, expect, it } from 'vitest';

import { parseCompletedStagedResult } from '@/lib/reach-deck/staged-result';

/**
 * 调试工作台捕获的完整提示词要随耐久结果一起存下来。
 *
 * 这条路径只有在 harness 模式真实跑完一个阶段时才会走到：结果的键集合是严格校验的，
 * 漏掉这个可选键会让阶段在模型已经调用成功之后才失败，白白烧掉一次生成。
 */
const provenance = {
  kind: 'lesson-plan' as const,
  runId: 'run-1',
  createdFromDraftRevision: 3,
};

const lessonPlan = {
  id: 'plan-1',
  title: 'Systems lesson',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain a system'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
};

const baseResult = {
  kind: 'lesson-plan' as const,
  runId: 'run-1',
  generatedFromDraftRevision: 3,
  candidate: lessonPlan,
};

describe('completed staged result with captured prompts', () => {
  it('keeps the captured prompts on the durable result', () => {
    const parsed = parseCompletedStagedResult(
      {
        ...baseResult,
        capturedModelPrompts: [
          {
            stage: 'lesson-plan',
            promptVersion: 'lesson-plan/v7+harness-snippet-override',
            serializedModelInput: '{"messages":[]}',
          },
        ],
      },
      provenance,
    );

    expect(parsed.capturedModelPrompts).toEqual([
      {
        stage: 'lesson-plan',
        promptVersion: 'lesson-plan/v7+harness-snippet-override',
        serializedModelInput: '{"messages":[]}',
      },
    ]);
  });

  it('still accepts a result without them, which is the production shape', () => {
    const parsed = parseCompletedStagedResult(baseResult, provenance);

    expect(parsed.capturedModelPrompts).toBeUndefined();
    expect(Object.hasOwn(parsed, 'capturedModelPrompts')).toBe(false);
  });

  it('rejects a captured prompt whose payload is not a string', () => {
    expect(() =>
      parseCompletedStagedResult(
        {
          ...baseResult,
          capturedModelPrompts: [{ stage: 'lesson-plan', serializedModelInput: 42 }],
        },
        provenance,
      ),
    ).toThrow('captured model prompt contains invalid values');
  });

  it('still rejects a genuinely unknown key', () => {
    expect(() =>
      parseCompletedStagedResult({ ...baseResult, somethingElse: 1 }, provenance),
    ).toThrow('contains missing or unsupported keys');
  });
});
