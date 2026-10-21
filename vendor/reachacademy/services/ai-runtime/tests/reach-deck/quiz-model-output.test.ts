import { describe, expect, it } from 'vitest';
import {
  parseQuizSceneContentValue,
  parseQuizSceneValue,
  richTextToPlainText,
} from '@reachany/reach-deck-dsl';

import {
  GENERATION_SAFE_QUIZ_QUESTION_TYPES,
  normalizeDecksmithQuizSceneReplacement,
  normalizeQuizModelOutput,
} from '../../lib/reach-deck/quiz-model-output.js';
import { QUIZ_SCENE_SCHEMA } from '../../lib/reach-deck/model-service-schemas.js';
import { GeneratedMarkdownFormulaError } from '../../lib/reach-deck/model-markdown.js';

describe('Reach Deck quiz model output', () => {
  it('enforces the generated one-question contract without narrowing durable quiz scenes', () => {
    expect(() =>
      normalizeQuizModelOutput({
        content: {
          questions: [
            { question: 'First', sub_problems: [] },
            { question: 'Second', sub_problems: [] },
          ],
        },
      }),
    ).toThrow('exactly one top-level question');

    expect(() =>
      normalizeQuizModelOutput({
        content: {
          questions: [
            {
              question: 'Composite',
              sub_problems: [{ question: 'Nested', sub_problems: [] }],
            },
          ],
        },
      }),
    ).toThrow('must not contain sub-problems');
  });

  it('converts supported formula delimiters in learner-visible fields to rich-text math nodes', () => {
    const normalized = normalizeQuizModelOutput({
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: '若 \\(x=2\\)，求：\n\n\\[\nx^2\n\\]',
            analysis: '代入得到 \\(2^2=4\\)。',
            cognitive_schema: '使用公式 \\(y=x^2\\)。',
            options: [
              { value: 'A', label: '\\(4\\)' },
              { value: 'B', label: '\\(2\\)' },
              { value: 'C', label: '\\(0\\)' },
            ],
            has_answer: true,
            answer: 'A',
            sub_problems: [],
          },
        ],
      },
    });

    const question = (normalized.scene as any).content.questions[0];
    expect(JSON.stringify(question.question)).toContain('inlineMath');
    expect(JSON.stringify(question.question)).toContain('blockMath');
    expect(JSON.stringify(question.options[0].label)).toContain('inlineMath');
    expect(JSON.stringify(question.analysis)).toContain('inlineMath');
    expect(JSON.stringify(question.cognitive_schema)).toContain('inlineMath');
    expect(question.answer).toBe('A');
    expect(normalized.diagnostics).toEqual([]);
  });

  it('canonicalizes the page-3 paired doubled delimiters before quiz adaptation', () => {
    const normalized = normalizeQuizModelOutput({
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: String.raw`化简 \\(\sqrt[4]{(3-\pi)^4}\\) 的结果是：`,
            analysis: String.raw`因为 \\(3-\pi<0\\)，所以结果为 \\(\pi-3\\)。`,
            cognitive_schema: String.raw`使用 \\(|a|\\)=\\(\sqrt{a^2}\\)。`,
            options: [
              { value: 'A', label: String.raw`\\(3-\pi\\)` },
              { value: 'B', label: String.raw`\\(\pi-3\\)` },
              { value: 'C', label: String.raw`\\(|3-\pi|\\)` },
            ],
            has_answer: true,
            answer: 'B',
            sub_problems: [],
          },
        ],
      },
    });

    const question = (normalized.scene as any).content.questions[0];
    expect(question.question.content[0].content).toEqual([
      { type: 'text', text: '化简 ' },
      { type: 'inlineMath', attrs: { latex: String.raw`\sqrt[4]{(3-\pi)^4}` } },
      { type: 'text', text: ' 的结果是：' },
    ]);
    expect(question.options[1].label.content[0].content).toEqual([
      { type: 'inlineMath', attrs: { latex: String.raw`\pi-3` } },
    ]);
    expect(JSON.stringify(question)).not.toContain(String.raw`"text":"\\"`);
    expect(JSON.stringify(question)).not.toContain(String.raw`"latex":"\pi-3\\"`);
  });

  it('preserves LaTeX row spacing in a generated quiz display formula', () => {
    const normalized = normalizeQuizModelOutput({
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: String.raw`\[
\begin{aligned}
a &= b \\[2ex]
c &= d
\end{aligned}
\]`,
            options: [
              { value: 'A', label: '甲' },
              { value: 'B', label: '乙' },
              { value: 'C', label: '丙' },
            ],
            has_answer: true,
            answer: 'A',
            sub_problems: [],
          },
        ],
      },
    });

    const question = (normalized.scene as any).content.questions[0];
    expect(JSON.stringify(question.question)).toContain(String.raw`\\[2ex]`);
  });

  it.each([
    ['decoded control', `线段 \u00028AB=DE`],
    ['literal control escape', String.raw`线段 \u00028AB=DE`],
    ['broken delimiter', String.raw`线段 \u0008(x+1)`],
    ['unclosed formula', String.raw`线段 \(AB=DE`],
  ])('rejects fresh quiz text containing %s', (_label, question) => {
    expect(() =>
      normalizeQuizModelOutput({
        content: {
          questions: [
            {
              question_type: 'single_choice',
              question,
              options: [
                { value: 'A', label: '甲' },
                { value: 'B', label: '乙' },
                { value: 'C', label: '丙' },
              ],
              has_answer: true,
              answer: 'A',
              sub_problems: [],
            },
          ],
        },
      }),
    ).toThrow(GeneratedMarkdownFormulaError);
  });

  it('keeps legal dollar currency, ordinary backslashes, and Unicode quiz text', () => {
    const normalized = normalizeQuizModelOutput({
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: String.raw`预算为 $9，路径 C:\notes\第一章，字符 π🙂，求 \(1+2\)。`,
            options: [
              { value: 'A', label: '3' },
              { value: 'B', label: '4' },
              { value: 'C', label: '5' },
            ],
            has_answer: true,
            answer: 'A',
            sub_problems: [],
          },
        ],
      },
    });
    const question = (normalized.scene as any).content.questions[0].question;
    expect(richTextToPlainText(question)).toBe(
      String.raw`预算为 $9，路径 C:\notes\第一章，字符 π🙂，求 \(1+2\)。`,
    );
  });

  it('normalizes a short-answer reference answer without changing selection answer values', () => {
    const normalized = normalizeQuizModelOutput({
      content: {
        questions: [
          {
            question_type: 'short_answer',
            question: '写出 \\(a^2+b^2\\)。',
            answer: '\\(c^2\\)',
            has_answer: true,
            sub_problems: [],
          },
        ],
      },
    });

    const question = (normalized.scene as any).content.questions[0];
    expect(JSON.stringify(question.answer)).toContain('inlineMath');
  });

  it('preserves ordinary dollar text instead of treating it as a Quiz formula', () => {
    const normalized = normalizeQuizModelOutput({
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: '预算从 $9 增加到 $12，变化量是 \\(12-9\\)。',
            options: [
              { value: 'A', label: '3' },
              { value: 'B', label: '4' },
              { value: 'C', label: '5' },
            ],
            has_answer: true,
            answer: 'A',
            sub_problems: [],
          },
        ],
      },
    });

    const question = (normalized.scene as any).content.questions[0].question;
    expect(JSON.stringify(question)).toContain('inlineMath');
    expect(JSON.stringify(question)).toContain('$9');
    expect(JSON.stringify(question)).toContain('$12');
  });

  it('rejects dangling answers, duplicate keys, and empty student-visible labels', () => {
    const candidate = {
      schemaVersion: 'reach-quiz-scene/v1',
      id: 'quiz-1',
      title: 'Quiz',
      sceneType: 'quiz',
      content: {
        questions: [
          {
            id: 'q1',
            question_type: 'single_choice',
            question_index: 1,
            question: 'Choose one.',
            points: 10,
            analysis: '',
            cognitive_schema: null,
            sub_problems: [],
            options: [
              { value: 'A', label: 'A' },
              { value: 'B', label: 'B' },
              { value: 'C', label: 'C' },
            ],
            has_answer: true,
            answer: 'missing',
          },
        ],
        display_mode: 'single_question',
        navigation: 'horizontal',
        show_progress: false,
        show_question_index: true,
        answer_reveal: 'after_submit',
        allow_previous: false,
        allow_skip: false,
      },
    };
    expect(() => normalizeQuizModelOutput(candidate)).toThrow(/reference exactly one option/i);
    const question = candidate.content.questions[0] as Record<string, any>;
    expect(() =>
      normalizeQuizModelOutput({
        ...candidate,
        content: {
          ...candidate.content,
          questions: [
            {
              ...question,
              answer: 'A',
              options: [
                { value: 'A', label: 'First' },
                { value: 'A', label: 'Second' },
                { value: 'D', label: 'Third' },
              ],
            },
          ],
        },
      }),
    ).toThrow(/unique non-empty keys/i);
    expect(() =>
      normalizeQuizModelOutput({
        ...candidate,
        content: {
          ...candidate.content,
          questions: [
            {
              ...question,
              answer: 'A',
              options: [
                { value: 'A', label: 'First' },
                { value: 'B', label: '   ' },
                { value: 'C', label: 'Third' },
              ],
            },
          ],
        },
      }),
    ).toThrow(/student-visible content/i);
  });

  it.each([
    ['yes', 'no'],
    ['A', 'C', 'F'],
    ['A', 'B', 'C', 'D', 'E', 'F'],
    ['A', 'Bити'],
  ])('accepts supported option counts and custom keys %j through durable parsing', (...keys) => {
    const answer = keys.at(-1)!;
    const normalized = normalizeQuizModelOutput({
      id: 'quiz-1',
      title: 'Quiz',
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: 'Choose one.',
            options: keys.map((value) => ({ value, label: `Option ${value}` })),
            has_answer: true,
            answer,
          },
        ],
      },
    });
    expect((normalized.scene as any).content.questions[0].answer).toBe(answer);
    const scene = parseQuizSceneValue(normalized.scene);
    const question = scene.content.questions[0];
    expect(question.question_type).toBe('single_choice');
    if (question.question_type !== 'single_choice') throw new Error('Expected choice');
    expect(question.options).toHaveLength(keys.length);
    // The durable parser canonicalizes keys and remaps the answer to the same option.
    expect(question.answer).toEqual([question.options!.at(-1)!.value]);
  });

  it('preserves multiple-choice answer references with custom keys and rejects unusable references', () => {
    const candidate = singleChoice('A');
    const question = candidate.content.questions[0];
    const withAnswer = (answer: string[]) => ({
      ...candidate,
      content: {
        ...candidate.content,
        questions: [
          {
            ...question,
            question_type: 'multiple_choice',
            options: [
              { value: 'first', label: 'First' },
              { value: 'last', label: 'Last' },
            ],
            answer,
          },
        ],
      },
    });
    const parsed = parseQuizSceneValue(
      normalizeQuizModelOutput(withAnswer(['first', 'last'])).scene,
    );
    expect(parsed.content.questions[0].answer).toEqual(['A', 'B']);
    for (const answer of [[], ['first', 'first'], ['missing']]) {
      expect(() => normalizeQuizModelOutput(withAnswer(answer))).toThrow(
        /unique emitted option values/,
      );
    }
    const blankKey = withAnswer(['first']);
    blankKey.content.questions[0].options[1].value = ' ';
    expect(() => normalizeQuizModelOutput(blankKey)).toThrow(/unique non-empty keys/);
  });

  // Frozen from the 2026-09-26 acceptance run (sine lesson, page 6): the key was `"Bити"`.
  it.each([
    ['Bити', 'B'],
    ['B。', 'B'],
    [' C ', 'C'],
  ])('keeps a single-choice key %j with non-alphanumeric trailing noise as %s', (answer, key) => {
    const normalized = normalizeQuizModelOutput(singleChoice(answer));
    const question = (normalized.scene as any).content.questions[0];
    expect(question.answer).toBe(key);
    expect(normalized.diagnostics.join('\n')).toContain(`规范为 ${key}`);
  });

  it.each(['BC', 'B2', 'b', 'D', 'answer B'])(
    'still rejects an ambiguous or unknown single-choice key %j',
    (answer) => {
      expect(() => normalizeQuizModelOutput(singleChoice(answer))).toThrow(
        /reference exactly one option/i,
      );
    },
  );

  it('补齐机械可推导的字段，而不是把缺字段退回给模型重试', () => {
    // 只给语义必需的内容：省略 sub_problems、整组 content 展示位与场景外壳标识。
    const normalized = normalizeQuizModelOutput({
      title: '测验',
      content: {
        questions: [
          {
            question_type: 'single_choice',
            question: '粉笔的主要成分是什么？',
            analysis: '碳酸钙。',
            cognitive_schema: '物质组成。',
            options: [
              { value: 'A', label: '碳酸钙' },
              { value: 'B', label: '氯化钠' },
              { value: 'C', label: '蔗糖' },
            ],
            has_answer: true,
            answer: 'A',
          },
        ],
      },
    });

    const scene = normalized.scene as Record<string, any>;
    expect(scene.schemaVersion).toBe('reach-quiz-scene/v1');
    expect(scene.sceneType).toBe('quiz');
    expect(scene.content).toMatchObject({
      display_mode: 'single_question',
      navigation: 'horizontal',
      answer_reveal: 'after_submit',
      show_progress: true,
      show_question_index: true,
      allow_previous: true,
      allow_skip: false,
    });
    expect(scene.content.questions[0].sub_problems).toEqual([]);
    // 协议层补字段不占用面向教师的内容归一化诊断通道。
    expect(normalized.diagnostics).toEqual([]);

    // 补全后的场景能直接通过持久化解析器，无需模型再跑一轮。
    expect(() => parseQuizSceneValue({ ...scene, id: 'page-1' })).not.toThrow();
  });

  it('只在 Decksmith 放开无参考答案的开放简答题，且能通过持久化解析器', () => {
    const openEnded = () => ({
      title: '春草图',
      content: {
        questions: [
          {
            question_type: 'short_answer',
            question: '读第 4 段，你会给这幅画取什么名字？说说依据。',
            analysis: '可以从草的颜色、姿态和人的活动中找依据。',
            has_answer: false,
            answer: '',
          },
        ],
      },
    });
    // 课件生成仍必须带参考答案。
    expect(() => normalizeQuizModelOutput(openEnded())).toThrow(
      'Generated quiz question must provide a reference answer.',
    );

    const normalized = normalizeQuizModelOutput(openEnded(), { allowOpenEndedShortAnswer: true });
    const parsed = parseQuizSceneValue({ ...(normalized.scene as object), id: 'page-1' });
    expect(parsed.content.questions[0]).toMatchObject({
      question_type: 'short_answer',
      has_answer: false,
    });

    // 选择题没有"无标答"形态：放开开关后仍拒绝，并告诉模型只有简答题可以这样做。
    expect(() =>
      normalizeQuizModelOutput(
        {
          content: {
            questions: [
              {
                question_type: 'single_choice',
                question: '你更喜欢哪幅画？',
                options: [
                  { value: 'A', label: '春草图' },
                  { value: 'B', label: '春花图' },
                  { value: 'C', label: '春风图' },
                ],
                has_answer: false,
              },
            ],
          },
        },
        { allowOpenEndedShortAnswer: true },
      ),
    ).toThrow('only short_answer may set has_answer false');
  });

  it('无标答简答题不残留伪参考答案与评分点（WP3 / 评审 M2）', () => {
    const normalized = normalizeQuizModelOutput(
      {
        title: '开放题',
        content: {
          questions: [
            {
              question_type: 'short_answer',
              question: '你会怎样向同桌解释电功？',
              analysis: '可以从电压、电流和时间三个量入手。',
              has_answer: false,
              answer: '参考答案：电功等于电压乘电流乘时间。',
              scoring_points: [
                {
                  id: 'p1',
                  target_ids: ['t1'],
                  criterion: '提到 W=UIt',
                  acceptable_answers: ['W=UIt'],
                  points: 5,
                },
              ],
              answer_components: [
                { id: 'c1', target_ids: ['t1'], answer: 'W=UIt', required: true },
              ],
              acceptable_variants: null,
              typical_wrong_answers: [],
            },
          ],
        },
      },
      { allowOpenEndedShortAnswer: true },
    );
    const question = (normalized.scene as any).content.questions[0];
    expect(richTextToPlainText(question.answer)).toBe('');
    for (const field of [
      'scoring_points',
      'answer_components',
      'acceptable_variants',
      'partial_credit_examples',
      'typical_wrong_answers',
    ]) {
      expect(question).not.toHaveProperty(field);
    }
    // 只列出真正带了内容的字段；null / 缺省的字段静默删除。
    expect(normalized.diagnostics).toContain(
      '题目 1：无标答题不保留参考答案或评分点，已移除 answer, scoring_points, answer_components, typical_wrong_answers',
    );
    const parsed = parseQuizSceneValue({ ...(normalized.scene as object), id: 'page-1' });
    expect(parsed.content.questions[0]).toMatchObject({
      question_type: 'short_answer',
      has_answer: false,
    });
    expect(richTextToPlainText(parsed.content.questions[0]!.answer as never)).toBe('');

    // 已经干净的开放题不产生 diagnostics；有标答的简答题原样保留参考答案。
    expect(
      normalizeQuizModelOutput(
        {
          content: {
            questions: [
              { question_type: 'short_answer', question: '开放', has_answer: false, answer: '' },
            ],
          },
        },
        { allowOpenEndedShortAnswer: true },
      ).diagnostics,
    ).toEqual([]);
    const answered = normalizeQuizModelOutput(
      {
        content: {
          questions: [
            {
              question_type: 'short_answer',
              question: '电功公式？',
              has_answer: true,
              answer: 'W=UIt',
            },
          ],
        },
      },
      { allowOpenEndedShortAnswer: true },
    );
    expect(richTextToPlainText((answered.scene as any).content.questions[0].answer)).toBe('W=UIt');
  });

  it('题型校验与生成侧允许题型同源：先报题型，再报参考答案', () => {
    // 严格 schema 的每个变体之外，normalizer 只放行 GENERATION_SAFE_QUIZ_QUESTION_TYPES。
    const schemaTypes = (
      (QUIZ_SCENE_SCHEMA.schema as any).$defs.question.anyOf as { properties: any }[]
    ).map((variant) => variant.properties.question_type.const);
    for (const type of GENERATION_SAFE_QUIZ_QUESTION_TYPES) expect(schemaTypes).toContain(type);
    for (const type of schemaTypes.filter(
      (candidate: string) =>
        !(GENERATION_SAFE_QUIZ_QUESTION_TYPES as readonly string[]).includes(candidate),
    )) {
      for (const hasAnswer of [true, false]) {
        expect(() =>
          normalizeQuizModelOutput(
            {
              content: {
                questions: [{ question_type: type, question: '填空', has_answer: hasAnswer }],
              },
            },
            { allowOpenEndedShortAnswer: true },
          ),
        ).toThrow(`Generated quiz question type "${type}" is not supported`);
      }
    }
  });

  it('展示位取值非法时回落到默认值', () => {
    const normalized = normalizeQuizModelOutput({
      schemaVersion: 'reach-quiz-scene/v1',
      title: '测验',
      sceneType: 'quiz',
      content: {
        questions: [
          {
            question_type: 'short_answer',
            question: '简述粉笔书写的原理。',
            has_answer: true,
            answer: '摩擦使碳酸钙脱落附着在黑板上。',
            sub_problems: [],
          },
        ],
        display_mode: 'single_question',
        navigation: 'horizontal',
        answer_reveal: 'immediately',
        show_progress: 'yes',
        show_question_index: true,
        allow_previous: true,
        allow_skip: false,
      },
    });

    const content = (normalized.scene as Record<string, any>).content;
    expect(content.answer_reveal).toBe('after_submit');
    expect(content.show_progress).toBe(true);
  });

  it('仍然拒绝真正带子题的生成结果', () => {
    expect(() =>
      normalizeQuizModelOutput({
        content: {
          questions: [{ question: 'Composite', sub_problems: [{ question: 'Nested' }] }],
        },
      }),
    ).toThrow(/must not contain sub-problems/i);
  });

  it('场景与 content 的校验失败会指明具体字段', () => {
    expect(() => parseQuizSceneValue({ schemaVersion: 'reach-quiz-scene/v2' })).toThrow(
      /schemaVersion must be "reach-quiz-scene\/v1"/,
    );
    expect(() =>
      parseQuizSceneValue({
        schemaVersion: 'reach-quiz-scene/v1',
        id: 'page-1',
        sceneType: 'quiz',
      }),
    ).toThrow(/title must be a non-empty string/);
    expect(() => parseQuizSceneContentValue({ questions: [] })).toThrow(
      /questions must be a non-empty array/,
    );
  });

  it('不受支持的题型报错要点名实际取值和允许集合', () => {
    const withType = (questionType: unknown) => ({
      content: {
        questions: [
          {
            question: '判断题',
            question_type: questionType,
            has_answer: true,
            sub_problems: [],
          },
        ],
      },
    });

    expect(() => normalizeQuizModelOutput(withType('true_false'))).toThrow(
      'Generated quiz question type "true_false" is not supported; use exactly one of single_choice, multiple_choice, short_answer.',
    );
    expect(() => normalizeQuizModelOutput(withType('fill_in_the_blank'))).toThrow(
      /"fill_in_the_blank" is not supported/,
    );
    expect(() => normalizeQuizModelOutput(withType(undefined))).toThrow(
      /type nothing is not supported; use exactly one of single_choice, multiple_choice, short_answer/,
    );
  });
});

function singleChoice(answer: string) {
  return {
    schemaVersion: 'reach-quiz-scene/v1',
    id: 'quiz-1',
    title: 'Quiz',
    sceneType: 'quiz',
    content: {
      questions: [
        {
          id: 'q1',
          question_type: 'single_choice',
          question_index: 1,
          question: 'Choose one.',
          points: 10,
          analysis: '',
          cognitive_schema: null,
          sub_problems: [],
          options: [
            { value: 'A', label: 'First' },
            { value: 'B', label: 'Second' },
            { value: 'C', label: 'Third' },
          ],
          has_answer: true,
          answer,
        },
      ],
      display_mode: 'single_question',
      navigation: 'horizontal',
      show_progress: false,
      show_question_index: true,
      answer_reveal: 'after_submit',
      allow_previous: false,
      allow_skip: false,
    },
  };
}

/**
 * Decksmith 手写 sceneJson 的字段写法改正（2026-10-09 第②层评测取参：4/4 个样本首次把题干写成 prompt，
 * learning_fence 写成字符串）。改正只作用于原本会被拒绝、意思明确的输入，并在 repairs 里告诉模型。
 */
describe('Decksmith quiz field-mistake repairs', () => {
  const DECKSMITH = { allowOpenEndedShortAnswer: true, repairFieldMistakes: true } as const;
  const openEnded = (question: Record<string, unknown>, scene: Record<string, unknown> = {}) => ({
    title: '电压与电功',
    ...scene,
    content: {
      questions: [
        {
          question_type: 'short_answer',
          has_answer: false,
          answer: '',
          analysis: '可从 \\(W=UIt\\) 中各量的关系说明预测。',
          ...question,
        },
      ],
    },
  });
  const firstQuestion = (scene: unknown) =>
    (scene as { content: { questions: Record<string, unknown>[] } }).content.questions[0];

  it('accepts a stem sent as prompt, says so, and passes the durable parser', () => {
    const normalized = normalizeQuizModelOutput(
      openEnded({ prompt: '只把电压 U 调大，电功 W 会怎样变化？' }),
      DECKSMITH,
    );
    const question = firstQuestion(normalized.scene);
    expect(question.prompt).toBeUndefined();
    expect(richTextToPlainText(question.question as never)).toBe(
      '只把电压 U 调大，电功 W 会怎样变化？',
    );
    expect(normalized.repairs).toEqual([
      'question 1: the stem was sent as "prompt"; it was accepted as "question". Name the stem field "question" in later quiz writes.',
    ]);
    expect(() =>
      parseQuizSceneValue({ ...(normalized.scene as object), id: 'page-1' }),
    ).not.toThrow();
  });

  it('turns a string learning_fence into the object and drops empty ones', () => {
    const fromString = normalizeQuizModelOutput(
      openEnded({ question: '题干', learning_fence: '  回到滑块操作再比较一次。 ' }),
      DECKSMITH,
    );
    expect(firstQuestion(fromString.scene).learning_fence).toEqual({
      enabled: true,
      prompt: '回到滑块操作再比较一次。',
    });
    expect(fromString.repairs).toHaveLength(1);
    const parsed = parseQuizSceneValue({ ...(fromString.scene as object), id: 'page-1' });
    expect(parsed.content.questions[0].learning_fence).toEqual({
      enabled: true,
      prompt: '回到滑块操作再比较一次。',
    });

    for (const empty of ['', false]) {
      const normalized = normalizeQuizModelOutput(
        openEnded({ question: '题干', learning_fence: empty }),
        DECKSMITH,
      );
      expect('learning_fence' in firstQuestion(normalized.scene)).toBe(false);
      expect(normalized.repairs).toEqual([
        'question 1: an empty learning_fence was dropped. Omit learning_fence when there is no repair hint.',
      ]);
    }

    // 只写了 prompt 的对象补 enabled: true，否则 DSL 会把它静默丢掉。
    const withoutEnabled = normalizeQuizModelOutput(
      openEnded({ question: '题干', learning_fence: { prompt: '再看一次读数。' } }),
      DECKSMITH,
    );
    expect(firstQuestion(withoutEnabled.scene).learning_fence).toEqual({
      enabled: true,
      prompt: '再看一次读数。',
    });
    expect(withoutEnabled.repairs).toEqual([
      expect.stringContaining('learning_fence had no "enabled"'),
    ]);
    // 超出 DSL 上限时保持原样（DSL 仍按原行为静默丢弃），不因改正而变成拒绝。
    const tooLong = normalizeQuizModelOutput(
      openEnded({ question: '题干', learning_fence: { prompt: '长'.repeat(4_001) } }),
      DECKSMITH,
    );
    expect(firstQuestion(tooLong.scene).learning_fence).toEqual({ prompt: '长'.repeat(4_001) });
    expect(tooLong.repairs).toEqual([]);
    expect(() => parseQuizSceneValue({ ...(tooLong.scene as object), id: 'page-1' })).not.toThrow();
  });

  it('derives a missing title from the stem without formula delimiters', () => {
    const normalized = normalizeQuizModelOutput(
      openEnded(
        { question: '保持 \\(I\\) 和 \\(t\\) 不变，只把电压调大，电功会怎样变化？说说你的理由。' },
        { title: undefined },
      ),
      DECKSMITH,
    );
    const scene = normalized.scene as { title: string };
    expect(scene.title).toBe('保持 I 和 t 不变，只把电压调大，电功会怎样…');
    expect(normalized.repairs).toEqual([
      'The scene had no title; "保持 I 和 t 不变，只把电压调大，电功会怎样…" was derived from the question. Give every quiz page a short "title" in later quiz writes.',
    ]);
    expect(() => parseQuizSceneValue({ ...scene, id: 'page-1' })).not.toThrow();
  });

  it('leaves ambiguous or already valid input alone', () => {
    // 两个别名同时出现：意思不明确，不猜，交给下游按缺题干报错。
    const ambiguous = normalizeQuizModelOutput(openEnded({ prompt: '甲', stem: '乙' }), DECKSMITH);
    expect(firstQuestion(ambiguous.scene).question).toBeUndefined();
    expect(ambiguous.repairs).toEqual([]);

    // 已写对的输入结果不变、不产生 repairs。
    const valid = openEnded({ question: '题干' });
    const repaired = normalizeQuizModelOutput(valid, DECKSMITH);
    expect(repaired.scene).toEqual(
      normalizeQuizModelOutput(valid, { allowOpenEndedShortAnswer: true }).scene,
    );
    expect(repaired.repairs).toEqual([]);
  });

  it('does not repair for deck generation, which uses the structured schema', () => {
    const normalized = normalizeQuizModelOutput(
      openEnded({ prompt: '题干' }, { title: undefined }),
      { allowOpenEndedShortAnswer: true },
    );
    expect(firstQuestion(normalized.scene).prompt).toBe('题干');
    expect('repairs' in normalized).toBe(false);
  });

  it('applies the same repairs to replace_quiz_scene but keeps the current page title', () => {
    const normalized = normalizeDecksmithQuizSceneReplacement(
      openEnded({ prompt: '只把电压 U 调大会怎样？', learning_fence: '再试一次。' }, { title: '' }),
      '第 3 课 电功测验',
    );
    const question = firstQuestion(normalized.scene);
    expect(richTextToPlainText(question.question as never)).toBe('只把电压 U 调大会怎样？');
    expect(question.learning_fence).toEqual({ enabled: true, prompt: '再试一次。' });
    // 改写已有页不从题干派生标题：沿用当前页标题，避免提案里静默改掉教师的页标题。
    expect((normalized.scene as { title: string }).title).toBe('第 3 课 电功测验');
    expect(normalized.repairs).toEqual([
      expect.stringContaining('the stem was sent as "prompt"'),
      expect.stringContaining('learning_fence was a string'),
      'The scene had no title; the current page title "第 3 课 电功测验" was kept. Include "title" when replacing a quiz scene.',
    ]);

    // 不知道当前标题时不派生，交给下游按缺标题报错。
    const withoutCurrent = normalizeDecksmithQuizSceneReplacement(
      openEnded({ question: '题干' }, { title: '' }),
    );
    expect((withoutCurrent.scene as { title: string }).title).toBe('');
    expect(withoutCurrent.repairs).toEqual([]);
  });
});
