import { describe, expect, it } from 'vitest';

import {
  applyHarnessPromptVersionSuffix,
  applyReachDeckPromptSnippetOverrides,
  HARNESS_PROMPT_VERSION_SUFFIX,
  LESSON_PLAN_PROMPT,
  parseReachDeckPromptSnippetOverrides,
  REACH_DECK_PROMPT_SNIPPETS,
  REACH_DECK_PROMPT_SNIPPET_OVERRIDE_MAX_CHARACTERS,
  ReachDeckPromptOverrideError,
} from '@/lib/reach-deck/prompts/index';
import { createGenerationWorkspace } from '@reachany/reach-deck-dsl';

import { buildReachDeckLessonPlanJobPayload } from '@/lib/reach-deck/workspace-jobs';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope';
import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '@/lib/reach-deck/voice-selection';
import {
  isReachDeckHarnessModeEnabled,
  ReachDeckHarnessModeDisabledError,
  requireReachDeckHarnessMode,
} from '@/lib/reach-deck/harness-mode';

describe('reach deck prompt snippet overrides', () => {
  it('replaces a snippet inside an already composed stage prompt', () => {
    const overrides = parseReachDeckPromptSnippetOverrides({
      'source-and-language': 'ALWAYS ANSWER IN KLINGON',
    });
    const composed = applyReachDeckPromptSnippetOverrides(
      LESSON_PLAN_PROMPT.text,
      overrides,
      'lesson-plan',
    );

    expect(composed).toContain('ALWAYS ANSWER IN KLINGON');
    expect(composed).not.toContain(REACH_DECK_PROMPT_SNIPPETS['source-and-language']);
    // 未被覆盖的 snippet 必须原样保留。
    expect(composed).toContain(REACH_DECK_PROMPT_SNIPPETS['json-output-rules']);
  });

  it('rejects a snippet that the stage prompt does not contain', () => {
    const overrides = parseReachDeckPromptSnippetOverrides({
      'slide-authoring-quality': 'never mind the layout',
    });

    expect(() =>
      applyReachDeckPromptSnippetOverrides(LESSON_PLAN_PROMPT.text, overrides, 'lesson-plan'),
    ).toThrow(ReachDeckPromptOverrideError);
  });

  it('skips an inherited snippet the stage does not contain instead of failing the chain', () => {
    // 页面生成成功后会自动推进讲稿 lane，讲稿模板不含 slide 专用 snippet。继承来的
    // 覆盖在这里报错，等于让一条版面调用已经计费的链在中途失败。
    const overrides = parseReachDeckPromptSnippetOverrides({
      'slide-authoring-quality': 'never mind the layout',
      'json-output-rules': 'ONLY JSON',
    });

    const composed = applyReachDeckPromptSnippetOverrides(
      LESSON_PLAN_PROMPT.text,
      overrides,
      'lesson-plan',
      'inherited',
    );

    expect(composed).toContain('ONLY JSON');
    expect(composed).not.toContain('never mind the layout');
    expect(() =>
      applyReachDeckPromptSnippetOverrides(
        LESSON_PLAN_PROMPT.text,
        overrides,
        'lesson-plan',
        'requested',
      ),
    ).toThrow(ReachDeckPromptOverrideError);
  });

  it('leaves the prompt untouched when no override is supplied', () => {
    expect(
      applyReachDeckPromptSnippetOverrides(LESSON_PLAN_PROMPT.text, undefined, 'lesson-plan'),
    ).toBe(LESSON_PLAN_PROMPT.text);
  });

  it('rejects unknown ids, blank text, and oversized text', () => {
    expect(() => parseReachDeckPromptSnippetOverrides({ 'no-such-snippet': 'x' })).toThrow(
      'Unknown prompt snippet id',
    );
    expect(() => parseReachDeckPromptSnippetOverrides({ 'json-output-rules': '  ' })).toThrow(
      'non-empty string',
    );
    expect(() =>
      parseReachDeckPromptSnippetOverrides({
        'json-output-rules': 'x'.repeat(REACH_DECK_PROMPT_SNIPPET_OVERRIDE_MAX_CHARACTERS + 1),
      }),
    ).toThrow('exceeds');
    expect(() => parseReachDeckPromptSnippetOverrides(['json-output-rules'])).toThrow(
      'must be an object',
    );
  });

  it('drops an override that merely restates the default snippet', () => {
    expect(
      parseReachDeckPromptSnippetOverrides({
        'json-output-rules': REACH_DECK_PROMPT_SNIPPETS['json-output-rules'],
      }),
    ).toBeUndefined();
  });

  it('serializes override keys in a stable order so the request hash is reproducible', () => {
    const first = parseReachDeckPromptSnippetOverrides({
      'source-and-language': 'b',
      'json-output-rules': 'a',
    });
    const second = parseReachDeckPromptSnippetOverrides({
      'json-output-rules': 'a',
      'source-and-language': 'b',
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('marks the prompt version so overridden runs stay separable in observability', () => {
    const overrides = parseReachDeckPromptSnippetOverrides({ 'json-output-rules': 'a' });

    expect(applyHarnessPromptVersionSuffix('lesson-plan/v7', overrides)).toBe(
      'lesson-plan/v7' + HARNESS_PROMPT_VERSION_SUFFIX,
    );
    expect(applyHarnessPromptVersionSuffix('lesson-plan/v7', undefined)).toBe('lesson-plan/v7');
  });
});

describe('reach deck harness mode gate', () => {
  it('is disabled unless the environment opts in with the exact value', () => {
    expect(isReachDeckHarnessModeEnabled({})).toBe(false);
    expect(isReachDeckHarnessModeEnabled({ REACH_DECK_HARNESS_MODE: 'true' })).toBe(false);
    expect(isReachDeckHarnessModeEnabled({ REACH_DECK_HARNESS_MODE: '1' })).toBe(false);
    expect(isReachDeckHarnessModeEnabled({ REACH_DECK_HARNESS_MODE: 'on' })).toBe(true);
  });

  it('refuses the debug capability instead of silently ignoring it', () => {
    expect(() => requireReachDeckHarnessMode('promptSnippetOverrides', {})).toThrow(
      ReachDeckHarnessModeDisabledError,
    );
    expect(() =>
      requireReachDeckHarnessMode('promptSnippetOverrides', { REACH_DECK_HARNESS_MODE: 'on' }),
    ).not.toThrow();
  });
});

describe('reach deck staged job identity under prompt overrides', () => {
  const scope = TEST_REACH_DECK_SCOPE;
  const resource = {
    ...scope.resourceScope,
    draftRevision: 3,
    workspace: createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      createdAt: '2026-07-18T08:00:00.000Z',
    }),
    createdAt: '2026-07-18T08:00:00.000Z',
    updatedAt: '2026-07-18T08:00:00.000Z',
  };

  const payloadFor = (overrides: Record<string, string> | undefined) =>
    buildReachDeckLessonPlanJobPayload(
      resource,
      { ...scope, ...(overrides === undefined ? {} : { promptSnippetOverrides: overrides }) },
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );

  it('gives an overridden run a different identity than the default run', () => {
    // 覆盖必须进入身份哈希：否则审计门会把改完覆盖的重跑判成同一个已完成任务，
    // 幂等跳过后页面上看起来就是"改了没反应"。
    const baseline = payloadFor(undefined);
    const overridden = payloadFor({ 'source-and-language': 'ALWAYS ANSWER IN KLINGON' });

    expect(overridden.requestHash).not.toBe(baseline.requestHash);
    expect(overridden.jobId).not.toBe(baseline.jobId);
    expect(overridden.promptSnippetOverrides).toEqual({
      'source-and-language': 'ALWAYS ANSWER IN KLINGON',
    });
  });

  it('gives two different overrides two different identities', () => {
    const first = payloadFor({ 'source-and-language': 'first' });
    const second = payloadFor({ 'source-and-language': 'second' });

    expect(first.requestHash).not.toBe(second.requestHash);
  });

  it('carries the inherited marker without changing the job identity', () => {
    // 标记只决定不适用条目的处置方式，不属于请求身份：把它算进哈希会让同一组覆盖
    // 在链上换一跳就变成另一个任务。
    const requested = payloadFor({ 'source-and-language': 'ALWAYS ANSWER IN KLINGON' });
    const inherited = buildReachDeckLessonPlanJobPayload(
      resource,
      {
        ...scope,
        promptSnippetOverrides: { 'source-and-language': 'ALWAYS ANSWER IN KLINGON' },
        promptSnippetOverridesInherited: true,
      },
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );

    expect(requested.promptSnippetOverridesInherited).toBeUndefined();
    expect(Object.hasOwn(requested, 'promptSnippetOverridesInherited')).toBe(false);
    expect(inherited.promptSnippetOverridesInherited).toBe(true);
    expect(inherited.requestHash).toBe(requested.requestHash);
  });

  it('keeps the default run byte-identical to the pre-override behaviour', () => {
    const baseline = payloadFor(undefined);

    expect(baseline.promptSnippetOverrides).toBeUndefined();
    expect(Object.hasOwn(baseline, 'promptSnippetOverrides')).toBe(false);
  });
});
