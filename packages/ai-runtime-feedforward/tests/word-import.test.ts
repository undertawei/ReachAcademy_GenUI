import { describe, expect, it } from 'vitest';
import {
  fastWordReferences,
  parseWordFast,
  parseWordSmartResponse,
  partitionWordSmartSource,
  wordSmartInput,
  resolveWordQuestions,
  sliceSource,
  type WordQuestionReference,
  type WordSourceBlock,
} from '../src/word-import/index.js';

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const ref = (blockId: string) => ({ blockId });
const question = (blockId: string): WordQuestionReference => ({
  questionType: 'short_answer',
  question: [ref(blockId)],
  answer: [],
  analysis: [],
  children: [],
});

describe('Word mathematics boundaries', () => {
  const textOf = (sources: WordSourceBlock[], ranges: WordQuestionReference['question']) =>
    ranges
      .map((range) => {
        const source = sources.find((item) => item.id === range.blockId)!;
        return sliceSource(source.content, range.start ?? 0, range.end ?? source.content.length)
          .map((node) => node.text ?? '')
          .join('');
      })
      .join('');

  it.each(['选择题', '一、选择题', '选择题（每题只有一个正确答案）'])(
    'recognizes a complete generic choice section and allows multiple-answer inference: %s',
    (heading) => {
      const result = parseWordFast(
        [
          block('h', heading),
          block('q', '1．Select matching diagrams.'),
          block('o', 'A．First B．Second C．Third'),
          block('a', '【答案】A、C'),
        ],
        'math-choice-section',
      );
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0]).toMatchObject({
        question_type: 'multiple_choice',
        answer: ['A', 'C'],
      });
    },
  );

  it.each(['作图题', '三、作图题', '计算题', '判断题'])(
    'resets fill mode at a complete mathematical section: %s',
    (heading) => {
      const refs = fastWordReferences([
        block('h1', '填空题'),
        block('q1', '1．Fill ____.'),
        block('a1', '【答案】First'),
        block('h2', heading),
        block('q2', '2．Draw a line.'),
        block('a2', '【答案】Original drawing'),
      ]);
      expect(refs).toHaveLength(2);
      expect(refs[1]).toMatchObject({ sourceLabel: '2', questionType: 'short_answer' });
      expect(refs[1].blanks).toBeUndefined();
    },
  );

  it('recognizes native math headings but preserves substantive numbered tasks', () => {
    const sources = [
      { ...block('h', 'III. 作图题'), numbering: { level: 0, label: 'III.' } },
      block('q', '1．计算题中哪些算式相等？'),
      block('a', '【答案】Original answer'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(textOf(sources, refs[0].question)).toBe('计算题中哪些算式相等？');
  });

  it.each(['273.5米/分≈270米/分', '2.625×80＝210', '0.3x＝18'])(
    'retains a decimal calculation on the current analysis instead of opening a main task: %s',
    (calculation) => {
      const sources = [
        block('q', '4．Explain.'),
        block('a', '【答案】Answer'),
        block('analysis', '【详解】Calculation follows.'),
        block('decimal', calculation),
        block('next', '5．Next task.'),
        block('nextanswer', '【答案】Next answer'),
      ];
      const refs = fastWordReferences(sources);
      expect(refs.map((item) => item.sourceLabel)).toEqual(['4', '5']);
      expect(textOf(sources, refs[0].analysis)).toContain(calculation);
    },
  );

  it('preserves an ambiguous decimal after the expected task number and requests review', () => {
    const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
    const sources = [
      block('q', '2．Explain.'),
      block('a', '【答案】Answer'),
      block('analysis', '【详解】Calculation'),
      block('decimal', '3.75×4＝15'),
    ];
    const refs = fastWordReferences(sources, diagnostics);
    expect(refs).toHaveLength(1);
    expect(textOf(sources, refs[0].analysis)).toContain('3.75×4＝15');
    expect(diagnostics).toContainEqual({
      code: 'word-import.check-question-boundary',
      severity: 'warning',
      blockId: 'decimal',
    });
  });

  it('keeps a spaced ASCII main label while refusing a decimal lookahead as a reading task', () => {
    const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
    fastWordReferences(
      [
        block('p', '阅读下面材料，完成下面小题。'),
        block('material', 'Material'),
        block('child', '（1）What is X?'),
        block('decimal', '1.5×4＝6'),
        block('a', '【答案】Original answer'),
      ],
      diagnostics,
    );
    expect(diagnostics).toContainEqual({
      code: 'word-import.unresolved-child-level',
      severity: 'warning',
      blockId: 'child',
    });
    expect(fastWordReferences([block('spaced', '3. 5×2 equals what?')])[0].sourceLabel).toBe('3');
  });

  it('uses ancestor number-reading cues when an underlined value appears only in a child', () => {
    const sources: WordSourceBlock[] = [
      block('q', '4．写出下列横线上的数。'),
      {
        id: 'child',
        content: [
          { type: 'text', text: '（1）' },
          { type: 'text', text: '527', marks: [{ type: 'underline' }] },
        ],
      },
      block('a', '【答案】（1）五百二十七'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children[0].blanks).toBeUndefined();
    expect(textOf(sources, refs[0].children[0].question)).toBe('527');
  });

  it('retains a bare small underlined Chinese numeric label with a source review diagnostic', () => {
    const sources: WordSourceBlock[] = [
      {
        id: 'q',
        content: [
          { type: 'text', text: '1．观察图中的' },
          { type: 'text', text: '12', marks: [{ type: 'underline' }] },
          { type: 'text', text: '并说明。' },
        ],
      },
      block('a', '【答案】Original explanation'),
    ];
    const result = parseWordFast(sources, 'ambiguous-small-numeric-label');
    expect(result.fieldDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'word-import.check-question-boundary',
        sourceRanges: [expect.objectContaining({ blockId: 'q' })],
      }),
    );
    expect(JSON.stringify(result.sourceExcerpts)).toContain('12');
  });

  it('retains decimal answer prefixes and decimal values in layout-separated blanks', () => {
    const sources = [
      block('q', '1．Name a value.'),
      block('a', '【答案】1.75'),
      block('next', '2．Complete ____ and ____.'),
      block('nextanswer', '【答案】1.75     2.25'),
    ];
    const refs = fastWordReferences(sources);
    expect(textOf(sources, refs[0].answer)).toBe('1.75');
    expect(refs[1].blanks?.map((blank) => textOf(sources, blank.answer).trim())).toEqual([
      '1.75',
      '2.25',
    ]);
  });

  it('requires a matching root for dotted children and a real child before routing decimal solutions', () => {
    const sources = [
      block('q', '1．Material'),
      block('child', '1.1 Explain.'),
      block('a', '【答案】1.1 Child answer'),
      block('analysis', '【解析】Original explanation'),
      block('decimal', '1.5 units remain.'),
      block('next', '2．Next material'),
      block('data', '7.1 units remain.'),
      block('nextanswer', '【答案】Answer'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs.map((item) => item.sourceLabel)).toEqual(['1', '2']);
    expect(refs[0].children).toHaveLength(1);
    expect(textOf(sources, refs[0].children[0].analysis)).toContain('1.5 units remain.');
    expect(refs[1].children).toEqual([]);
    expect(textOf(sources, refs[1].question)).toContain('7.1 units remain.');
  });

  it('retains an unresolved decimal appendix continuation on its current answer', () => {
    const sources = [
      block('q', '1．Material'),
      block('child', '1.1 Explain.'),
      block('h', '参考答案'),
      block('a', '1.1 Child answer'),
      block('decimal', '1.75 units'),
    ];
    const refs = fastWordReferences(sources);
    expect(textOf(sources, refs[0].children[0].answer)).toContain('1.75 units');
  });

  it('opens a real numbered task containing a variable list after a solved choice', () => {
    const result = parseWordFast(
      [
        block('q', '5．Select a value.'),
        block('o', 'A．One B．Two'),
        block('a', '【答案】A'),
        block('analysis', '【解析】Reason'),
        block('next', '6．a、b、c、d是四条直线，正确的说法有几项？'),
        block('nextoptions', 'A．One B．Two C．Three D．Four'),
        block('nextanswer', '【答案】D'),
      ],
      'variable-list',
    );
    expect(result.questions).toHaveLength(2);
    expect(result.questions.map((item) => item.answer)).toEqual([['A'], ['D']]);
    expect(JSON.stringify(result.questions[1].question)).toContain('a、b、c、d');
  });

  it('keeps contiguous choice statements as one task with its own complete pool and letter answer', () => {
    const result = parseWordFast(
      [
        block('q', '2．正确的说法有（ ）句。'),
        block('s1', '（1）First statement.'),
        block('s2', '（2）Second statement.'),
        block('s3', '（3）Third statement.'),
        block('o', 'A．One B．Two C．Three'),
        block('a', '【答案】B'),
      ],
      'choice-statements',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      question_type: 'single_choice',
      answer: ['B'],
      sub_problems: [],
    });
    expect(JSON.stringify(result.questions[0].question)).toContain('Third statement');
  });

  it('preserves actual children that each own options and answers', () => {
    const result = parseWordFast(
      [
        block('q', '1．Material'),
        block('c1', '（1）First choice.'),
        block('o1', 'A．First B．Second'),
        block('a1', '【答案】A'),
        block('c2', '（2）Second choice.'),
        block('o2', 'A．First B．Second'),
        block('a2', '【答案】B'),
      ],
      'child-choices',
    );
    expect(result.questions[0].sub_problems.map((item) => item.answer)).toEqual([['A'], ['B']]);
  });

  it('infers a choice from an option pool even with two placeholder blanks', () => {
    const result = parseWordFast(
      [
        block('q', '1．图①表示（ ），图②表示（ ）。'),
        block('o', 'A．First pair B．Second pair C．Third pair'),
        block('a', '【答案】A'),
      ],
      'two-blank-choice',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'single_choice', answer: ['A'] });
    expect(result.questions[0].blanks).toBeUndefined();
  });

  it('splits consecutive inline mathematical subtasks with exact source ranges and child points', () => {
    const sources = [
      block('q', '7．用竖式计算。'),
      block('row', '（1）312×24＝（2分）    （2）864÷36＝（3分）    （3）※905÷24＝（4分）'),
      block('a', '【答案】（1）7488；（2）24；（3）37余17'),
      block('analysis', '【分析】（1）First method.'),
      block('shared', '（2）（3）Shared division method.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children.map((item) => item.sourceLabel)).toEqual(['1', '2', '3']);
    expect(refs[0].children.map((item) => item.points)).toEqual([2, 3, 4]);
    expect(textOf(sources, refs[0].children[0].question)).not.toContain('864');
    expect(textOf(sources, refs[0].children[1].answer)).toContain('24');
    expect(textOf(sources, refs[0].children[2].analysis)).toContain('Shared division method');
  });

  it('splits a first inline child after the root number when later child labels confirm its structure', () => {
    const sources = [
      block('q', '8．（1）Measure ____ degrees.'),
      block('c2', '（2）Draw a parallel line.'),
      block('c3', '（3）Draw a shortest path.'),
      block('a', '【答案】（1）72'),
      block('a2', '（2）Original second answer'),
      block('a3', '（3）Original third answer'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children.map((item) => item.sourceLabel)).toEqual(['1', '2', '3']);
    expect(refs[0].answer).toEqual([]);
    expect(textOf(sources, refs[0].children[0].answer)).toBe('72');
  });

  it('shares explicitly joint drawing-answer source ranges across all named children', () => {
    const sources: WordSourceBlock[] = [
      block('q', '3．Draw both lines.'),
      block('c1', '（1）Draw the first line.'),
      block('c2', '（2）Draw the second line.'),
      block('a', '【答案】（1）（2）如下图：'),
      { id: 'image', content: [{ type: 'image', attrs: { sourceMediaId: 'drawing' } }] },
      block('analysis', '【分析】（1）（2）Use the ruler.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children).toHaveLength(2);
    expect(refs[0].children.every((item) => item.answer.some((r) => r.blockId === 'image'))).toBe(
      true,
    );
    expect(refs[0].children[0].answer).toEqual(refs[0].children[1].answer);
  });

  it('keeps an image after the first inline task on that task before the next numbered child', () => {
    const sources: WordSourceBlock[] = [
      block('q', '8．（1）Measure the angle.'),
      { id: 'image', content: [{ type: 'image', attrs: { sourceMediaId: 'angle-diagram' } }] },
      block('c2', '（2）Draw a line.'),
      block('a', '【答案】（1）72°    （2）Original drawing'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children).toHaveLength(2);
    expect(refs[0].children[0].question.some((ref) => ref.blockId === 'image')).toBe(true);
    expect(refs[0].question.some((ref) => ref.blockId === 'image')).toBe(false);
  });

  it('keeps inline-started numbered analysis lists on their original owner', () => {
    const sources = [
      block('q', '2．Explain.'),
      block('a', '【答案】Original answer'),
      block('analysis', '【详解】1．First step.'),
      block('s2', '2．Second step.'),
      block('s3', '3．Third step.'),
      block('next', '3．Next real question.'),
      block('nextanswer', '【答案】Next answer'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs.map((item) => item.sourceLabel)).toEqual(['2', '3']);
    expect(textOf(sources, refs[0].analysis)).toContain('Third step.');
  });
});

describe('Word native reference contract', () => {
  it.each([
    'ABD',
    'A、B、D',
    'A,B,D',
    'A，B，D',
    'A B D',
    'A;B;D',
    'a；b；d',
    '(A)(B)(D)',
    'A．B．D',
  ])('infers multiple choice using the same answer separators as resolution: %s', (answer) => {
    const result = parseWordFast(
      [
        block('q', '1．Which artists?'),
        block('o', 'A. One B. Two C. Three D. Four'),
        block('a', `【答案】${answer}`),
      ],
      'separators',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      question_type: 'multiple_choice',
      answer: ['A', 'B', 'D'],
      has_answer: true,
    });
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('keeps an explicitly single-choice question with conflicting answers for correction', () => {
    const result = parseWordFast(
      [
        block('h', '单选题'),
        block('q', '1．Which?'),
        block('o', 'A. One B. Two'),
        block('a', '【答案】A、B'),
        block('analysis', '【解析】Original explanation'),
      ],
      'explicit-single',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      question_type: 'single_choice',
      answer: [],
      has_answer: false,
    });
    expect(JSON.stringify(result.questions[0].analysis)).toContain('Original explanation');
    expect(result.diagnostics).toContainEqual({
      code: 'word-import.single-answer-count',
      severity: 'error',
      questionId: result.questions[0].id,
      sourceAnswer: 'A、B',
    });
    expect(JSON.stringify(result.questions)).not.toContain('sourceAnswer');
  });

  it('does not infer multiple choice from repeated copies of one answer', () => {
    const result = parseWordFast(
      [block('q', '1．Which?'), block('o', 'A. One B. Two'), block('a', '【答案】A、A')],
      'duplicate',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'single_choice', answer: ['A'] });
  });
  it('preserves the first numbered shared-pool answer when its number equals the root number', () => {
    const result = parseWordFast(
      [
        block('section', '选词填空'),
        block('prompt', '1. The ___ is ___.'),
        block('options', 'A. sky B. blue C. green'),
        block('answer', '【答案】1. A 2. B'),
      ],
      'shared-pool',
    );
    expect(result.questions[0].question_type).toBe('fill_with_candidates');
    expect(result.questions[0].blanks?.map((blank) => blank.answer)).toEqual([['A'], ['B']]);
    expect(result.questions[0].has_answer).toBe(true);
  });
  it('keeps absent points and answers visible rather than inventing defaults', () => {
    const result = resolveWordQuestions([block('p1', 'A question')], [question('p1')], 'run');
    expect(result.questions[0]).not.toHaveProperty('points');
    expect(result.questions[0].has_answer).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'word-import.missing-points',
      'word-import.missing-answer',
    ]);
    expect(JSON.stringify(result.questions)).not.toMatch(/sourceLabel|blockIds|parserVersion/);
  });

  it('keeps parent media/material once and stable object-safe recursive identities', () => {
    const parent = question('p1');
    parent.children = [question('p2')];
    const blocks = [block('p1', 'Material'), block('p2', 'Child')];
    blocks[0].content.push({ type: 'image', attrs: { sourceMediaId: 'asset' } });
    const result = resolveWordQuestions(blocks, [parent], 'run');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].sub_problems).toHaveLength(1);
    expect(JSON.stringify(result.questions).match(/sourceMediaId/g)).toHaveLength(1);
    expect(result.questions[0].id).toMatch(/^wi-[a-f0-9]{64}$/);
    expect(result).toEqual(resolveWordQuestions(blocks, [parent], 'run'));
    parent.children[0].question = [ref('p1')];
    expect(() => resolveWordQuestions(blocks, [parent], 'run')).toThrow('duplicated-material');
  });

  it('preserves marks and atomic math/image positions when slicing', () => {
    const content = [
      { type: 'text', text: '1. Bold', marks: [{ type: 'bold' }] },
      { type: 'inlineMath', attrs: { latex: 'x^{100}' } },
      { type: 'image', attrs: { sourceMediaId: 'm' } },
      { type: 'text', text: ' tail' },
    ];
    expect(sliceSource(content, 3, 9)).toEqual([
      { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
      content[1],
      content[2],
    ]);
  });

  it('rejects invented references, unknown types and invalid points', () => {
    const blocks = [block('p1', 'Question')];
    expect(() => resolveWordQuestions(blocks, [question('missing')], 'run')).toThrow(
      'unknown-block',
    );
    const candidate = question('p1');
    candidate.question = [{ blockId: 'p1', end: 900 }];
    expect(() => resolveWordQuestions(blocks, [candidate], 'run')).toThrow('invalid-range');
    candidate.question = [ref('p1')];
    candidate.points = -1;
    expect(() => resolveWordQuestions(blocks, [candidate], 'run')).toThrow('invalid-points');
  });

  it.each(['cloze', 'fill_with_candidates', 'fill_in_the_blank'] as const)(
    'resolves native %s blank identity and source label 11',
    (questionType) => {
      const candidate = question('p1');
      candidate.questionType = questionType;
      candidate.candidatePoolRepeatable = false;
      const options = [
        { sourceLabel: 'A', label: [ref('o1')] },
        { sourceLabel: 'B', label: [ref('o2')] },
      ];
      if (questionType === 'fill_with_candidates') candidate.options = options;
      candidate.blanks = [
        {
          marker: { blockId: 'p1', start: 5, end: 7 },
          sourceLabel: '11',
          answer: [ref('a1')],
          ...(questionType === 'cloze' ? { candidates: options } : {}),
        },
      ];
      const result = resolveWordQuestions(
        [block('p1', 'Text 11 end'), block('o1', 'One'), block('o2', 'Two'), block('a1', 'B')],
        [candidate],
        'run',
      );
      const q = result.questions[0];
      expect(q.blanks?.[0].blank_index).toBe(1);
      expect(q.question.content?.[0].content?.[1]).toEqual({
        type: 'quizBlank',
        attrs: { blankId: q.blanks?.[0].id, blankIndex: 1 },
      });
      expect(q.has_answer).toBe(true);
      if (questionType === 'cloze') expect(q).not.toHaveProperty('options');
      if (questionType === 'fill_with_candidates')
        expect(q.blanks?.[0]).not.toHaveProperty('candidates');
    },
  );

  it('normalizes option values and rejects answers outside the source pool', () => {
    const candidate = question('p1');
    candidate.questionType = 'multiple_choice';
    candidate.options = [
      { sourceLabel: 'C', label: [ref('o1')] },
      { sourceLabel: 'D', label: [ref('o2')] },
    ];
    candidate.answer = [ref('a1')];
    const blocks = [
      block('p1', 'Question'),
      block('o1', 'One'),
      block('o2', 'Two'),
      block('a1', 'CD'),
    ];
    expect(resolveWordQuestions(blocks, [candidate], 'run').questions[0].answer).toEqual([
      'A',
      'B',
    ]);
    blocks[3] = block('a1', 'X');
    expect(() => resolveWordQuestions(blocks, [candidate], 'run')).toThrow(
      'invalid-answer-reference',
    );
    candidate.options = [
      { sourceLabel: 'a', label: [ref('o1')] },
      { sourceLabel: 'A', label: [ref('o2')] },
    ];
    expect(() => resolveWordQuestions(blocks, [candidate], 'run')).toThrow('invalid-options');
  });
});

describe('Word fast rules', () => {
  it('keeps parenthesized children after a numbered reading task as actual children', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面材料，完成下面小题。'),
        block('material', 'Shared material.'),
        block('task', '5．Explain both details.'),
        block('child', '（1）First detail?'),
        block('a', '【答案】5．（1）Original child answer'),
      ],
      'reading-task-child',
    );
    expect(result.questions[0].sub_problems).toHaveLength(1);
    expect(result.questions[0].sub_problems[0].sub_problems).toHaveLength(1);
    expect(result.questions[0].sub_problems[0].sub_problems[0].has_answer).toBe(true);
  });

  it('does not treat ordinary circled answer prose as an ordinal place key', () => {
    const refs = fastWordReferences([
      block('q', '8．Complete ____，____。'),
      block('a', '【答案】①Consider the context. ②Consider the wording.'),
    ]);
    expect(refs[0].blanks?.every((blank) => blank.answer.length === 0)).toBe(true);
    expect(refs[0].answer).toEqual([expect.objectContaining({ blockId: 'a' })]);
  });

  it('preserves ordinary inferred choices with requested reasons and real bare explanation markers', () => {
    const result = parseWordFast(
      [
        block('q', '1．选出正确的一项并说明理由。'),
        block('o', 'A．First B．Second'),
        block('a', '【答案】B 解析：Original explanation'),
        block('analysis', '分析：Further explanation'),
      ],
      'ordinary-choice-analysis',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'single_choice', answer: ['B'] });
    expect(JSON.stringify(result.questions[0].analysis)).toContain('Original explanation');
    expect(JSON.stringify(result.questions[0].analysis)).toContain('Further explanation');
  });

  it('keeps parenthesized passage headings before the first reading task on shared material', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面材料，完成下面小题。'),
        block('material', 'The proposal follows.'),
        block('heading1', '（1）去酸方案'),
        block('body1', 'First proposal details.'),
        block('heading2', '（2）修复方案'),
        block('body2', 'Second proposal details.'),
        block('q', '5．Explain.'),
        block('a', '【答案】5．Original answer'),
      ],
      'material-subsection',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].sub_problems).toHaveLength(1);
    expect(JSON.stringify(result.questions[0].question)).toContain('（1）去酸方案');
    expect(JSON.stringify(result.questions[0].question)).toContain('（2）修复方案');
    expect(result.unresolvedItems).toEqual([]);
  });

  it.each([
    { following: [] },
    { following: [block('next', '3．Next task.'), block('nextanswer', '【答案】Next answer.')] },
  ])(
    'retains review diagnostics for parenthesized reading tasks without a subsequent numeric task before their answer: %j',
    ({ following }) => {
      const result = parseWordFast(
        [
          block('p', '阅读下面材料，完成下面小题。'),
          block('material', 'Shared material.'),
          block('q1', '（1）What is X?'),
          block('q2', '（2）Why?'),
          block('a', '【答案】（1）Answer one    （2）Answer two'),
          ...following,
        ],
        'ambiguous-parenthesized-reading',
      );
      expect(result.fieldDiagnostics).toContainEqual(
        expect.objectContaining({
          code: 'word-import.unresolved-child-level',
          sourceRanges: [expect.objectContaining({ blockId: 'q1' })],
        }),
      );
      expect(result.fieldDiagnostics).toContainEqual(
        expect.objectContaining({
          code: 'word-import.unresolved-child-level',
          sourceRanges: [expect.objectContaining({ blockId: 'q2' })],
        }),
      );
    },
  );

  it('assigns explicit circled place answer keys across separate paragraphs to the corresponding blanks', () => {
    const result = parseWordFast(
      [
        block('q', '8．Complete ____，____，____。'),
        block('a', '【答案】'),
        block('a1', '①处：First answer.'),
        block('a2', '②处：Second answer.'),
        block('a3', '③处：Third answer.'),
      ],
      'circled-place-key',
    );
    expect(result.questions[0].has_answer).toBe(true);
    expect(result.questions[0].blanks?.map((blank) => JSON.stringify(blank.answer))).toEqual([
      expect.stringContaining('First answer.'),
      expect.stringContaining('Second answer.'),
      expect.stringContaining('Third answer.'),
    ]);
  });

  it.each(['。', '，', '.', ',', ';', '；', '    '])(
    'assigns inline circled place keys separated by %j without swallowing subsequent answers',
    (separator) => {
      const sources = [
        block('q', '8．Complete ____，____，____。'),
        block('a', `【答案】①处：甲${separator}②处：乙${separator}③处：丙`),
      ];
      expect(
        fastWordReferences(sources)[0].blanks?.map((blank) =>
          blank.answer.map((ref) =>
            sliceSource(sources[1].content, ref.start!, ref.end!)
              .map((node) => node.text)
              .join('')
              .trim(),
          ),
        ),
      ).toEqual([['甲'], ['乙'], ['丙']]);
      expect(parseWordFast(sources, 'inline-circled-place-key').questions[0].has_answer).toBe(true);
    },
  );

  it('preserves numbered answer subheadings without changing explicit analysis markers', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面材料，完成下面小题。'),
        block('material', 'Passage'),
        block('q16', '16．Explain.'),
        block('q17', '17．Analyse its effect.'),
        block('a', '【答案】16．First answer    17．分析：'),
        block('body', 'Substantive analysis as the requested answer.'),
        block('effect', '效果：More requested answer.'),
        block('explanation', '【解析】17．Separate explanation'),
      ],
      'answer-analysis-heading',
    );
    const q = result.questions[0].sub_problems[1];
    expect(q.has_answer).toBe(true);
    expect(JSON.stringify(q.answer)).toContain('分析：');
    expect(JSON.stringify(q.answer)).toContain('Substantive analysis as the requested answer.');
    expect(JSON.stringify(q.answer)).toContain('效果：More requested answer.');
    expect(JSON.stringify(q.analysis)).toContain('Separate explanation');
  });

  it('retains explanation-plus-selection tasks as open responses with their option text', () => {
    const result = parseWordFast(
      [
        block('q', '26．下列选项各有特点，请分别加以说明，并选出差别最大的一项。'),
        block('options', 'A．First B．Second C．Third'),
        block('a', '【答案】A. First meaning.'),
        block('b', 'B. Second meaning.'),
        block('c', 'C. Third meaning. Select A.'),
      ],
      'explain-and-select',
    );
    const q = result.questions[0];
    expect(q.question_type).toBe('short_answer');
    expect(q.has_answer).toBe(true);
    expect(JSON.stringify(q.question)).toContain('A．First B．Second C．Third');
    expect(JSON.stringify(q.answer)).toContain('Third meaning. Select A.');
  });

  it('preserves an explicitly declared choice for explanation-plus-selection wording', () => {
    const result = parseWordFast(
      [
        block('section', '单选题'),
        block('q', '1．请分别加以说明，并选出一项。'),
        block('o', 'A．First B．Second'),
        block('a', '【答案】B'),
      ],
      'explicit-explain-select',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'single_choice', answer: ['B'] });
  });

  it.each(['名篇名句默写', '古代诗歌阅读', '语言文字运用'])(
    'resets the active reading group at the complete section heading: %s',
    (title) => {
      const result = parseWordFast(
        [
          block('reading', '阅读下面文章，完成下面小题。'),
          block('passage', 'Shared passage'),
          block('task', '19．Explain.'),
          block('taskanswer', '【答案】19．Original answer'),
          block('section', `二、${title}`),
          block('root', '20．Complete.'),
          block('child1', '（1）____，____。'),
          block('child2', '（2）____，____。'),
          block('answer', '【答案】One     Two     Three     Four'),
        ],
        'section-reset',
      );
      expect(result.questions).toHaveLength(2);
      expect(result.questions[0].sub_problems).toHaveLength(1);
      expect(result.questions[1].sub_problems).toHaveLength(2);
      expect(result.questions[1].sub_problems.every((child) => child.has_answer)).toBe(true);
      expect(JSON.stringify(result.questions)).not.toContain(`二、${title}`);
      expect(
        result.unresolvedItems?.some((item) =>
          item.sourceRanges.some((source) => source.blockId === 'section'),
        ),
      ).toBe(false);
    },
  );

  it('filters a leading poetry section heading without filtering substantive prose', () => {
    const result = parseWordFast(
      [
        block('section', '一、古代诗歌阅读'),
        block('q', '1．Explain.'),
        block('prose', '二、名篇名句默写需要联系语境。'),
        block('a', '【答案】Original answer'),
      ],
      'poetry-heading',
    );
    expect(result.questions).toHaveLength(1);
    expect(JSON.stringify(result.questions[0].question)).toContain(
      '二、名篇名句默写需要联系语境。',
    );
    expect(JSON.stringify(result.questions[0].question)).not.toContain('一、古代诗歌阅读');
  });

  it.each([
    '根据公式（1）、（2）可知结论。',
    '（1）根据公式（1）、（2）可知结论。    （2）证明内容。',
  ])('preserves paired formula citations in solution prose: %s', (answer) => {
    const result = parseWordFast(
      [
        block('p', '1．Parent'),
        block('c1', '（1）求值'),
        block('c2', '（2）证明'),
        block('a', `【答案】${answer}`),
      ],
      'paired-citations',
    );
    expect(JSON.stringify(result.questions)).toContain('根据公式（1）、（2）可知结论。');
  });

  it('keeps preassigned child blank answers atomic rather than splitting their punctuation again', () => {
    const result = parseWordFast(
      [
        block('q', '1．Fill.'),
        block('c1', '（1）____，____。'),
        block('c2', '（2）____，____。'),
        block('a', '【答案】One     Two     夫学须静也，才须学也     非学无以广才，非志无以成学'),
      ],
      'atomic-child-answers',
    );
    const answers = result.questions[0].sub_problems[1].blanks!;
    expect(JSON.stringify(answers[0].answer)).toContain('夫学须静也，才须学也');
    expect(JSON.stringify(answers[0].answer)).not.toContain('非学无以广才');
    expect(JSON.stringify(answers[1].answer)).toContain('非学无以广才，非志无以成学');
    expect(JSON.stringify(answers[1].answer)).not.toContain('夫学须静也');
    const refs = fastWordReferences([
      block('q', '1．Fill.'),
      block('c1', '（1）____，____。'),
      block('c2', '（2）____，____。'),
      block('a', '【答案】One     Two     夫学须静也，才须学也     非学无以广才，非志无以成学'),
    ]);
    expect(refs[0].children[1].blanks?.map((blank) => blank.answer.length)).toEqual([1, 1]);
  });

  it('keeps reading material blanks as prose when its tasks own the answers', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面文章，完成下面小题。'),
        block('material', 'A story with ______.'),
        block('q', '1．请在横线处补充恰当的词语。'),
        block('a', '【答案】1．Source answer'),
        block('nextp', '2．下面是一段评论，请你帮他修改。'),
        block('material2', 'It is not old, ______ new.'),
        block('child', '（1）请在横线处补充恰当的词语。'),
        block('childanswer', '【答案】（1）but'),
      ],
      'material-blanks',
    );
    expect(result.questions[0].question_type).toBe('short_answer');
    expect(result.questions[0].blanks).toBeUndefined();
    expect(JSON.stringify(result.questions[0].question)).toContain('______');
    const numbered = result.questions[0].sub_problems[1];
    expect(numbered.question_type).toBe('short_answer');
    expect(numbered.blanks).toBeUndefined();
    expect(JSON.stringify(numbered.question)).toContain('______');
  });

  it('retains parenthesized references inside a previously numbered answer', () => {
    const result = parseWordFast(
      [
        block('p', '1．Parent'),
        block('c1', '（1）求值'),
        block('c2', '（2）证明'),
        block('a', '【答案】（1）利用（2）的结论计算。    （2）实际证明内容。'),
      ],
      'embedded-owner-reference',
    );
    const tasks = result.questions[0].sub_problems;
    expect(JSON.stringify(tasks[0].answer)).toContain('利用（2）的结论计算。');
    expect(JSON.stringify(tasks[1].answer)).toContain('实际证明内容。');
    expect(JSON.stringify(tasks[1].answer)).not.toContain('的结论计算');
  });

  it('keeps numbered solution enumerations below the active reading task labels', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面文章，完成下面小题。'),
        block('material', 'Passage'),
        block('q38', '38．Explain.'),
        block('q39', '39．Explain two.'),
        block('a', '【答案】38．First    39．Second'),
        block('analysis', '【解析】Explanation.'),
        block('point1', '1．First explanation point.'),
        block('point2', '2．Second explanation point.'),
      ],
      'reading-solution-enumeration',
    );
    expect(result.questions[0].sub_problems).toHaveLength(2);
    expect(JSON.stringify(result.questions[0])).toContain('First explanation point.');
    expect(JSON.stringify(result.questions[0])).toContain('Second explanation point.');
    expect(JSON.stringify(result.questions[0].sub_problems[1].question)).not.toContain(
      'explanation point',
    );
  });

  it('keeps decimals and numeric lists inside grouped answer content', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面材料，完成下列问题。'),
        block('material', 'Material'),
        block('q1', '1．Find the value.'),
        block('q2', '2．Explain.'),
        block('a', '【答案】1．数值为 2.5 千米，编号为 2、3    2．第二题答案'),
      ],
      'decimals',
    );
    const tasks = result.questions[0].sub_problems;
    expect(JSON.stringify(tasks[0].answer)).toContain('数值为 2.5 千米，编号为 2、3');
    expect(JSON.stringify(tasks[1].answer)).toContain('第二题答案');
  });

  it('keeps reading siblings with their per-question inline answers', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面文章，完成下面小题。'),
        block('material', 'Passage'),
        block('q1', '38．First task.'),
        block('a1', '【答案】First answer'),
        block('q2', '39．Second task.'),
        block('a2', '【答案】Second answer'),
      ],
      'inline-reading-solutions',
    );
    expect(result.questions).toHaveLength(1);
    const tasks = result.questions[0].sub_problems;
    expect(tasks).toHaveLength(2);
    expect(JSON.stringify(tasks[0].answer)).toContain('First answer');
    expect(JSON.stringify(tasks[1].answer)).toContain('Second answer');
  });

  it('preserves per-child inline fill answers', () => {
    const result = parseWordFast(
      [
        block('p', '5．Fill'),
        block('c1', '（1）____，____'),
        block('a1', '【答案】x，y'),
        block('c2', '（2）____'),
        block('a2', '【答案】z'),
      ],
      'inline-fill-solutions',
    );
    expect(result.questions[0].sub_problems.every((child) => child.has_answer)).toBe(true);
    expect(JSON.stringify(result.questions[0].sub_problems[0].blanks?.[1].answer)).toContain('y');
    expect(JSON.stringify(result.questions[0].sub_problems[1].blanks?.[0].answer)).toContain('z');
  });

  it('does not turn an untyped multi-blank word bank into a choice question', () => {
    const result = parseWordFast(
      [
        block('p', '1．用所给词填空：I ____ to ____ every day.'),
        block('o', 'A．go B．school'),
        block('a', '【答案】A B'),
      ],
      'untyped-bank',
    );
    expect(result.questions[0].question_type).toBe('fill_in_the_blank');
    expect(result.questions[0].blanks).toHaveLength(2);
  });

  it('preserves concatenated Chinese right-parenthesis options', () => {
    const result = parseWordFast(
      [
        block('q', '1．Which city?'),
        block('o', 'A）北京B）上海C）广州D）深圳'),
        block('a', '【答案】B'),
      ],
      'chinese-options',
    );
    expect(result.questions[0].options).toHaveLength(4);
    expect(result.questions[0].answer).toEqual(['B']);
  });

  it('limits a reading group to its declared question range', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面的诗歌，完成14～15题。'),
        block('material', 'Poem'),
        block('q14', '14．First task'),
        block('q15', '15．Second task'),
        block('q16', '16．Independent task'),
      ],
      'reading-range',
    );
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].sub_problems).toHaveLength(2);
    expect(JSON.stringify(result.questions[1].question)).toContain('Independent task');
  });

  it('resets solution owners across roots and retains parenthesized prose mentions', () => {
    const result = parseWordFast(
      [
        block('root', '1．Parent'),
        block('child1', '（1）Explain'),
        block('child2', '（2）Explain two'),
        block('a', '【答案】（1）First （2）Second'),
        block('next', '2．New question'),
        block('nextanswer', '【答案】New answer refers to （1）and continues'),
      ],
      'reset-solution',
    );
    expect(result.questions).toHaveLength(2);
    expect(JSON.stringify(result.questions[1].answer)).toContain(
      'New answer refers to （1）and continues',
    );
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).not.toContain('continues');
    const mentions = parseWordFast(
      [
        block('root', '1．Parent'),
        block('child1', '（1）Explain'),
        block('child2', '（2）Explain two'),
        block('a', '【答案】See example （1） and example （2） below.'),
      ],
      'prose-references',
    );
    expect(JSON.stringify(mentions.questions)).toContain(
      'See example （1） and example （2） below.',
    );
  });

  it('keeps explicit choices that request a reason', () => {
    const result = parseWordFast(
      [
        block('section', '单选题'),
        block('q', '1．下列哪种方法能说明理由？'),
        block('o', 'A．方法一 B．方法二'),
        block('a', '【答案】B'),
      ],
      'explicit-reason',
    );
    expect(result.questions[0].options).toHaveLength(2);
    expect(result.questions[0].answer).toEqual(['B']);
  });

  it('retains short explanation headings and circled lists after an ordinary solution', () => {
    const result = parseWordFast(
      [
        block('q', '1．Explain the passage.'),
        block('a', '【答案】Original answer.'),
        block('analysis', '【解析】Detailed explanation.'),
        block('heading', '中心思想'),
        block('point1', '①First explanation point.'),
        block('point2', '②Second explanation point.'),
        block('next', '2．Next question.'),
        block('nextanswer', '【答案】2．Next answer.'),
      ],
      'analysis-heading',
    );
    expect(result.questions).toHaveLength(2);
    expect(JSON.stringify(result.questions[0].analysis)).toContain('中心思想');
    expect(JSON.stringify(result.questions[0].analysis)).toContain('②Second explanation point.');
    expect(result.questions.every((q) => q.sub_problems.length === 0)).toBe(true);
  });

  it('recognizes a new bare reading title only with existing reading context and a sourced answer batch', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面文章，完成下面小题。'),
        block('text', '①First passage.'),
        block('q1', '1．Explain.'),
        block('a1', '【答案】1．First answer'),
        block('title', 'New passage'),
        block('text2', '①Second passage.'),
        block('q2', '2．Explain.'),
        block('a2', '【答案】2．Second answer'),
      ],
      'bare-reading-title',
    );
    expect(result.questions).toHaveLength(2);
    expect(result.questions[1].sub_problems).toHaveLength(1);
    expect(JSON.stringify(result.questions[1].question)).toContain('New passage');
    expect(JSON.stringify(result.questions[0].analysis)).not.toContain('Second passage');
  });

  it('distributes a complete layout answer key to nested blanks without duplicating parent answers', () => {
    const result = parseWordFast(
      [
        block('q', '1．Complete.'),
        block('c1', '（1）____，____。'),
        block('c2', '（2）____。'),
        block('a', '【答案】One     Two     Three   '),
        block('next', '2．Next question.'),
        block('nextanswer', '【答案】Next answer.'),
      ],
      'nested-layout',
    );
    expect(result.questions).toHaveLength(2);
    const parent = result.questions[0];
    expect(parent.sub_problems.every((child) => child.has_answer)).toBe(true);
    expect(JSON.stringify(parent.answer)).not.toContain('One');
    expect(JSON.stringify(parent.sub_problems[0].blanks?.[1].answer)).toContain('Two');
    expect(JSON.stringify(parent.sub_problems[1].blanks?.[0].answer)).toContain('Three');
  });

  it.each(
    ['    ', '     ', '\t', '\u00a0\u00a0\u00a0\u00a0', '\n'].flatMap((separator) =>
      [
        ['甲', '乙', '丙', '丁'],
        ['甲', 'New York', '乙方', 'Los Angeles'],
        ['甲', 'New York', '乙，丙', 'Los Angeles'],
      ].map((answers) => ({ separator, answers })),
    ),
  )(
    'distributes single-character and mixed layout answers to nested blanks: %j',
    ({ separator, answers }) => {
      const sources = [
        block('q', '20．补写空缺。'),
        block('c1', '（1）____，____。'),
        block('c2', '（2）____，____。'),
        block('a', `【答案】${answers.join(separator)}`),
      ];
      const parent = fastWordReferences(sources)[0];
      expect(parent.answer).toEqual([]);
      expect(
        parent.children.flatMap((child) =>
          child.blanks!.map((blank) =>
            blank.answer.map((ref) =>
              sliceSource(sources[3].content, ref.start!, ref.end!)
                .map((node) => node.text)
                .join(''),
            ),
          ),
        ),
      ).toEqual(answers.map((answer) => [answer]));
      expect(
        parseWordFast(sources, 'nested-single-character-layout').questions[0].sub_problems.every(
          (child) => child.has_answer,
        ),
      ).toBe(true);
    },
  );

  it('routes concatenated nested answer labels and retains a subsequent sibling with circled prose', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面文章，完成下面小题。'),
        block('text', 'Shared material'),
        block('q', '38．Translate.'),
        block('child1', '（1）First sentence.'),
        block('child2', '（2）Second sentence.'),
        block('q2', '39．Explain.'),
        block(
          'a',
          '【答案】38．（1）First answer。（2）Second answer。    39．①One point②Another point',
        ),
      ],
      'nested-group',
    );
    const tasks = result.questions[0].sub_problems;
    expect(tasks[0].sub_problems.every((child) => child.has_answer)).toBe(true);
    expect(JSON.stringify(tasks[1].answer)).toContain('①One point②Another point');
  });

  it('preserves punctuation inside blank answers separated by source layout', () => {
    const result = parseWordFast(
      [
        block('q', '1．____，____。'),
        block('a', '【答案】敦厚忠信，能攻吾过     克己修身，痛加检点   '),
      ],
      'punctuated-layout',
    );
    expect(result.questions[0].has_answer).toBe(true);
    expect(JSON.stringify(result.questions[0].blanks?.[0].answer)).toContain('敦厚忠信，能攻吾过');
  });

  it('keeps blank-only letter rows as source fill tasks and preserves open responses with a category menu', () => {
    const result = parseWordFast(
      [
        block('q', '1．Fill the diagram.'),
        block('a', 'A．________'),
        block('b', 'B．________'),
        block('answer', '【答案】One     Two'),
        block('q2', '2．将本文编入最合适的专栏，并简述理由。'),
        block('menu', 'A．Nature B．History'),
        block('a2', '【答案】Nature, because of its setting.'),
      ],
      'open-menu',
    );
    expect(result.questions[0]).toMatchObject({
      question_type: 'fill_in_the_blank',
      has_answer: true,
    });
    expect(result.questions[1]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(JSON.stringify(result.questions[1].question)).toContain('Nature');
  });

  it('keeps pinyin endings and parenthesized letters inside source options', () => {
    const result = parseWordFast(
      [
        block('q', '4．Which pronunciation?'),
        block('a', 'A．甲（huàn） B．乙（yùn） C．公式（B） D．正确'),
        block('answer', '【答案】D'),
      ],
      'pinyin',
    );
    expect(result.questions[0].options).toHaveLength(4);
    expect(result.questions[0].answer).toEqual(['D']);
    expect(JSON.stringify(result.questions[0].options)).toContain('huàn');
    expect(JSON.stringify(result.questions[0].options)).toContain('（B）');
  });

  it.each(['A) One B) Two', 'a）One b）Two', 'C．OneD．Two'])(
    'preserves supported option separators and non-A pools: %s',
    (options) => {
      const result = parseWordFast(
        [
          block('q', '1．Which?'),
          block('o', options),
          block('a', `【答案】${options.startsWith('C') ? 'D' : 'B'}`),
        ],
        'option-patterns',
      );
      expect(result.questions[0].options).toHaveLength(2);
      expect(result.questions[0].answer).toEqual(['B']);
    },
  );

  it('uses option values consistently when partial recovery retains duplicate source labels', () => {
    const result = parseWordFast(
      [
        block('q', '1．Which?'),
        block('o', 'A．One A．Duplicate B．Two C．Three'),
        block('a', '【答案】C'),
      ],
      'duplicate-pool',
    );
    expect(result.questions[0].options?.map((option) => option.value)).toEqual([
      'A',
      'A',
      'B',
      'C',
    ]);
    expect(result.questions[0].answer).toEqual(['C']);
  });

  it('keeps date titles and complete section headings out of questions', () => {
    const result = parseWordFast(
      [
        block('title', '\uFFFC2026年10月2日初中语文作业'),
        block('header', '学校：____姓名：____班级：____'),
        block('section', '一、积累运用'),
        block('q', '1．Explain'),
        block('a', '【答案】Source answer'),
      ],
      'headers',
    );
    expect(result.questions).toHaveLength(1);
    expect(JSON.stringify(result.questions)).not.toContain('积累运用');
    expect(JSON.stringify(result.questions)).not.toContain('2026年');
    expect(result.questions[0]).not.toHaveProperty('points');
  });

  it('keeps numbered reading prose once on its parent and routes grouped solutions by source labels', () => {
    const result = parseWordFast(
      [
        block('p', '阅读下面文章，完成下面小题。'),
        block('title', 'Reading title'),
        block('prose1', '①The first passage paragraph.'),
        block('prose2', '②The second passage paragraph.'),
        block('q38', '38．Explain the first detail.'),
        block('q39', '39．Explain the second detail.'),
        block('answers', '【答案】38．First answer    39．Second answer'),
        block('continuation', 'Second answer continuation'),
        block('overview', '【导语】Shared analysis'),
        block('a38', '【详解】38．First analysis'),
        block('a39', '39．Second analysis'),
      ],
      'reading-group',
    );
    expect(result.questions).toHaveLength(1);
    const parent = result.questions[0];
    expect(parent.sub_problems).toHaveLength(2);
    expect(JSON.stringify(parent.question)).toContain('①The first passage');
    expect(JSON.stringify(parent.analysis)).toContain('Shared analysis');
    expect(JSON.stringify(parent.sub_problems[0].answer)).toContain('First answer');
    expect(JSON.stringify(parent.sub_problems[0].answer)).not.toContain('Second answer');
    expect(JSON.stringify(parent.sub_problems[1].answer)).toContain('Second answer continuation');
    expect(JSON.stringify(parent.sub_problems[0].analysis)).toContain('First analysis');
    expect(JSON.stringify(parent.sub_problems[1].analysis)).toContain('Second analysis');
    expect(result.sources[parent.sub_problems[0].id].fields).toContainEqual(
      expect.objectContaining({
        field: { kind: 'answer' },
        sourceRanges: [expect.objectContaining({ blockId: 'answers', start: 7 })],
      }),
    );
  });

  it('infers choice over fill markers when the following source supplies options', () => {
    const result = parseWordFast(
      [
        block('q', '1．The _____ answer is which?'),
        block('o', 'A．One B．Two'),
        block('a', '【答案】B'),
      ],
      'choice-with-underline',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'single_choice', answer: ['B'] });
    expect(result.questions[0].blanks).toBeUndefined();
  });

  it('filters quiz headers, normalizes lowercase options and extracts unused knowledge points', () => {
    const header: WordSourceBlock = {
      id: 'header',
      content: [
        { type: 'text', text: '学校：____' },
        { type: 'hardBreak' },
        { type: 'text', text: '姓名：____' },
        { type: 'hardBreak' },
        { type: 'text', text: '班级：____' },
      ],
    };
    const options: WordSourceBlock = {
      id: 'o',
      content: [
        { type: 'text', text: 'a．One' },
        { type: 'hardBreak' },
        { type: 'text', text: 'b．Two c．Three' },
      ],
    };
    const metadata: WordSourceBlock = {
      id: 'metadata',
      content: [
        { type: 'text', text: '【知识点】函数' },
        { type: 'hardBreak' },
        { type: 'text', text: '图像【答案】b' },
      ],
    };
    const result = parseWordFast(
      [header, block('q', '1．Which?'), options, metadata],
      'compatibility',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].question_type).toBe('single_choice');
    expect(result.questions[0].options).toHaveLength(3);
    expect(result.questions[0].answer).toEqual(['B']);
    expect(JSON.stringify(result.questions[0].question)).not.toMatch(/知识点|函数|图像/);
    expect(result.questions[0].cognitive_schema).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    expect(result.diagnostics.some((item) => item.blockId === 'header')).toBe(false);
    expect(result.diagnostics.some((item) => item.blockId === 'metadata')).toBe(false);
  });

  it('recognizes lowercase cloze choices and inline answer letters', () => {
    const inline = parseWordFast(
      [block('q', '1．Which? (b)'), block('o', 'a．One b．Two')],
      'inline-lowercase',
    );
    expect(inline.questions[0].answer).toEqual(['B']);
    const passage: WordSourceBlock = {
      id: 'passage',
      content: [
        { type: 'text', text: 'Pick ' },
        { type: 'text', text: '11', marks: [{ type: 'underline' }] },
      ],
    };
    const cloze = parseWordFast(
      [block('section', '完形填空'), passage, block('options', '11．a．one b．two')],
      'cloze-lowercase',
    );
    expect(cloze.questions[0].blanks?.[0].candidates).toHaveLength(2);
  });

  it('keeps inferred lowercase multiple choice independent from later explicit sections', () => {
    const result = parseWordFast(
      [
        block('q1', '1. First?'),
        block('o1', 'a. One b. Two'),
        block('a1', '【答案】ab'),
        block('section', '单选题'),
        block('q2', '2. Second?'),
        block('o2', 'a. One b. Two'),
        block('a2', '【答案】a'),
      ],
      'section-scope',
    );
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].question_type).toBe('multiple_choice');
    expect(result.questions[0].answer).toEqual(['A', 'B']);
    expect(result.questions[1].question_type).toBe('single_choice');
  });

  it('recognizes native Roman section and root labels', () => {
    const result = parseWordFast(
      [
        { ...block('section', 'I. 多选题'), numbering: { level: 0, label: 'I.' } },
        { ...block('q', 'II. Which?'), numbering: { level: 0, label: 'II.' } },
        block('options', 'a. One b. Two'),
        block('answer', '【答案】ab'),
      ],
      'roman-section',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].question_type).toBe('multiple_choice');
    expect(result.questions[0].answer).toEqual(['A', 'B']);
    expect(result.sources[result.questions[0].id]?.sourceLabel).toBe('II');
  });

  it.each([
    [0, '.'],
    [1, '.'],
    [0, ')'],
    [1, ')'],
  ])('keeps native lowercase level %i list items with %s as options', (level, delimiter) => {
    const result = parseWordFast(
      [
        block('q', '1. Which?'),
        {
          ...block('a', `a${delimiter} One`),
          numbering: { level, label: `a${delimiter}`, format: 'lowerLetter' },
        },
        {
          ...block('b', `b${delimiter} Two`),
          numbering: { level, label: `b${delimiter}`, format: 'lowerLetter' },
        },
        block('answer', '【答案】b'),
      ],
      `native-options-${level}`,
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].question_type).toBe('single_choice');
    expect(result.questions[0].options).toHaveLength(2);
    expect(result.questions[0].answer).toEqual(['B']);
  });

  it('uses the current letter from compound native option labels', () => {
    const result = parseWordFast(
      [
        block('q', '1. Which?'),
        {
          ...block('a', '1.a) One'),
          numbering: { level: 1, label: '1.a)', format: 'lowerLetter' },
        },
        {
          ...block('b', '1.b) Two'),
          numbering: { level: 1, label: '1.b)', format: 'lowerLetter' },
        },
        block('answer', '【答案】b'),
      ],
      'compound-native-options',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].options).toHaveLength(2);
    expect(result.questions[0].answer).toEqual(['B']);
    expect(JSON.stringify(result.questions[0].options)).not.toContain('1.a)');
  });

  it('keeps native letter children under an explicitly typed short-answer root', () => {
    const result = parseWordFast(
      [
        block('section', '简答题'),
        block('root', '1. Shared material'),
        {
          ...block('a', 'a. Explain'),
          numbering: { level: 1, label: 'a.', format: 'lowerLetter' },
        },
        {
          ...block('b', 'b. Calculate'),
          numbering: { level: 1, label: 'b.', format: 'lowerLetter' },
        },
      ],
      'native-letter-children',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].sub_problems).toHaveLength(2);
    expect(result.questions[0]).not.toHaveProperty('options');
  });

  it('assigns native Roman appendix answers to their roots', () => {
    const result = parseWordFast(
      [
        { ...block('q1', 'I. First?'), numbering: { level: 0, label: 'I.' } },
        { ...block('q2', 'II. Second?'), numbering: { level: 0, label: 'II.' } },
        block('heading', '参考答案'),
        { ...block('a1', 'I. First answer'), numbering: { level: 0, label: 'I.' } },
        { ...block('a2', 'II. Second answer'), numbering: { level: 0, label: 'II.' } },
      ],
      'roman-appendix',
    );
    expect(result.questions).toHaveLength(2);
    expect(JSON.stringify(result.questions[0].answer)).toContain('First answer');
    expect(JSON.stringify(result.questions[1].answer)).toContain('Second answer');
    expect(JSON.stringify(result.questions[0].answer)).not.toContain('I.');
    expect(JSON.stringify(result.questions[1].answer)).not.toContain('II.');
  });

  it('keeps sequential children after inline solutions separate and flags the inferred boundary', () => {
    const result = parseWordFast(
      [
        block('p', '1. Shared passage'),
        block('c1', '(1) First task'),
        block('a1', '【答案】First answer'),
        block('c2', '(2) Second task'),
        block('a2', '【答案】Second answer'),
      ],
      'run',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].sub_problems).toHaveLength(2);
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).toContain('First answer');
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).not.toContain('Second task');
    expect(JSON.stringify(result.questions[0].sub_problems[1].answer)).toContain('Second answer');
    expect(result.diagnostics).toContainEqual({
      code: 'word-import.check-question-boundary',
      severity: 'warning',
      blockId: 'c2',
    });
  });
  it('keeps deep dotted/circled hierarchy and auto-numbered children on the parent', () => {
    const roots = fastWordReferences([
      block('root', '1．Material'),
      block('child', '1.1 Explain'),
      block('grandchild', '① Detail'),
      { ...block('sibling', 'Next child'), numbering: { level: 1, label: '2' } },
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(2);
    expect(roots[0].children[0].children).toHaveLength(1);
    expect(roots[0].children[0].children[0].sourceLabel).toBe('①');
  });

  it('does not attach unmatched appendix continuations to the preceding answer', () => {
    const result = parseWordFast(
      [
        block('q', '1．Explain'),
        block('h', '参考答案'),
        block('a', '1．Correct'),
        block('missing', '9．Unknown'),
        block('tail', 'Unknown explanation'),
      ],
      'appendix',
    );
    expect(result.questions).toHaveLength(1);
    expect(JSON.stringify(result.questions[0].answer)).not.toContain('Unknown');
    expect(
      result.diagnostics
        .filter((item) => item.code === 'word-import.unassigned-block')
        .map((item) => item.blockId),
    ).toEqual(expect.arrayContaining(['missing', 'tail']));
  });

  it('binds appendix child answers to their root path despite repeated child labels', () => {
    const result = parseWordFast(
      [
        block('q1', '1．Material one'),
        block('c1', '(1) First child'),
        block('q2', '2．Material two'),
        block('c2', '(1) Second child'),
        block('h', '参考答案'),
        block('a1', '1.1 First solution'),
        block('a2', '2.1 Second solution'),
      ],
      'paths',
    );
    expect(result.questions).toHaveLength(2);
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).toContain('First solution');
    expect(JSON.stringify(result.questions[1].sub_problems[0].answer)).toContain('Second solution');
    expect(result.questions.every((root) => !root.has_answer)).toBe(true);
  });

  it('retains an invalid-answer root and a later valid root without losing source content', () => {
    const result = parseWordFast(
      [
        block('q1', '1．Broken choice'),
        block('o', 'A．OneB．Two'),
        block('a', '【答案】Z'),
        block('q2', '2．Valid choice'),
        block('o2', 'A．OneB．Two'),
        block('a2', '【答案】B'),
      ],
      'partial',
    );
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toMatchObject({ answer: [], has_answer: false });
    expect(JSON.stringify(result.questions[0].question)).toContain('Broken choice');
    expect(result.questions[0].options).toHaveLength(2);
    expect(result.questions[1].answer).toEqual(['B']);
    expect(result.diagnostics).toContainEqual({
      code: 'word-import.invalid-answer-reference',
      severity: 'error',
      questionId: result.questions[0].id,
      sourceAnswer: 'Z',
    });
    expect(Object.keys(result.sources)).toHaveLength(2);
    expect(result.diagnostics.some((item) => item.code === 'word-import.unassigned-block')).toBe(
      false,
    );
  });
  it('parses concatenated choices and standalone answer/analysis markers', () => {
    const result = parseWordFast(
      [
        block('p1', '1．Which?'),
        block('p2', 'A．OneB．TwoC．ThreeD．Four'),
        block('p3', '【答案】'),
        block('p4', 'B'),
        block('p5', '【解析】'),
        block('p6', '1．A numbered explanation'),
      ],
      'run',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].question_type).toBe('single_choice');
    expect(result.questions[0].answer).toEqual(['B']);
    expect(result.questions[0].options).toHaveLength(4);
    expect(JSON.stringify(result.questions[0].analysis)).toContain('numbered explanation');
  });
  it('keeps a multi-line answer key with the question it enumerates', () => {
    const result = parseWordFast(
      [
        block('p1', '25．Fill both blanks.'),
        block('p2', '【答案】'),
        block('p3', '1. minus four'),
        block('p4', '2. ten'),
        block('p5', '31．Next question.'),
        block('p6', '【答案】seven'),
      ],
      'run',
    );
    expect(result.questions).toHaveLength(2);
    const answers = JSON.stringify(result.questions[0].answer);
    expect(answers).toContain('minus four');
    expect(answers).toContain('ten');
    expect(JSON.stringify(result.questions[1].question)).toContain('Next question');
  });

  it.each(['    ', '     ', '\t', '\u00a0\u00a0\u00a0\u00a0', '\n'])(
    'maps layout-separated blank answers without losing math: %j',
    (separator) => {
      const result = parseWordFast(
        [
          block('q', '25. Fill ____ and ____.'),
          {
            id: 'a',
            content: [
              { type: 'text', text: `【答案】${separator}` },
              { type: 'inlineMath', attrs: { latex: '-4' } },
              { type: 'text', text: `${separator}10${separator}` },
            ],
          },
        ],
        'layout-answers',
      );
      expect(result.questions[0].has_answer).toBe(true);
      expect(result.questions[0].blanks?.map((blank) => blank.answer)).toEqual([
        {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: '-4' } }] },
          ],
        },
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '10' }] }] },
      ]);
    },
  );

  it('preserves single spaces inside layout-separated prose answers', () => {
    const sources = [
      block('q', '25. Fill ____ and ____.'),
      block('a', '【答案】New York     Los Angeles'),
    ];
    const refs = fastWordReferences(sources);
    expect(
      refs[0].blanks?.map((blank) =>
        blank.answer.map((r) =>
          sliceSource(sources[1].content, r.start!, r.end!)
            .map((node) => node.text)
            .join(''),
        ),
      ),
    ).toEqual([['New York'], ['Los Angeles']]);
  });

  it.each(
    ['    ', '     ', '\t', '\u00a0\u00a0\u00a0\u00a0', '\n'].flatMap((separator) =>
      [
        ['甲', '乙', '丙', '丁'],
        ['甲', 'New York', '乙方', 'Los Angeles'],
        ['甲', 'New York', '乙，丙', 'Los Angeles'],
      ].map((answers) => ({ separator, answers })),
    ),
  )(
    'assigns single-character and mixed layout answers to standalone blanks: %j',
    ({ separator, answers }) => {
      const sources = [
        block('q', '20．补写____，____，____，____。'),
        block('a', `【答案】${answers.join(separator)}`),
      ];
      expect(
        fastWordReferences(sources)[0].blanks!.map((blank) =>
          blank.answer.map((ref) =>
            sliceSource(sources[1].content, ref.start!, ref.end!)
              .map((node) => node.text)
              .join(''),
          ),
        ),
      ).toEqual(answers.map((answer) => [answer]));
      expect(
        parseWordFast(sources, 'standalone-single-character-layout').questions[0].has_answer,
      ).toBe(true);
    },
  );

  it.each(['New York', 'New  York', 'New   York', 'one     two     three'])(
    'leaves ambiguous layout answers unassigned: %s',
    (answer) => {
      const refs = fastWordReferences([
        block('q', '25. Fill ____ and ____.'),
        block('a', `【答案】${answer}`),
      ]);
      expect(refs[0].blanks?.map((blank) => blank.answer)).toEqual([[], []]);
    },
  );

  it('retains parent and child references instead of flattening', () => {
    const result = fastWordReferences([
      block('p1', '1．Read material'),
      block('p2', '(1) Explain'),
      block('p3', '(2) Calculate'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(2);
    expect(result[0].question).toEqual([{ blockId: 'p1', start: 2, end: 15 }]);
  });

  it('maps underlined cloze labels 11 and 12 to contiguous native blanks', () => {
    const passage: WordSourceBlock = {
      id: 'p1',
      content: [
        { type: 'text', text: 'Pick ' },
        { type: 'text', text: '11', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' then ' },
        { type: 'text', text: '12', marks: [{ type: 'underline' }] },
      ],
    };
    const result = parseWordFast(
      [
        block('h', '完形填空'),
        passage,
        block('o1', '11．A．oneB．two'),
        block('o2', '12．A．threeB．four'),
        block('a', '【答案】11．A 12．B'),
      ],
      'run',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].blanks?.map((blank) => blank.answer)).toEqual([['A'], ['B']]);
    expect(result.questions[0].blanks?.map((blank) => blank.blank_index)).toEqual([1, 2]);
  });
});

describe('Word smart source protocol', () => {
  const response = (questions: WordQuestionReference[], unassignedBlockIds: string[] = []) =>
    JSON.stringify({ complete: true, questions, unassignedBlockIds });

  it('keeps a parent and its invalid-answer child editable with exact source diagnostics', () => {
    const child = question('child');
    child.questionType = 'single_choice';
    child.options = [
      { sourceLabel: 'A', label: [ref('optionA')] },
      { sourceLabel: 'B', label: [ref('optionB')] },
    ];
    child.answer = [ref('answer')];
    const parent = question('parent');
    parent.children = [child];
    const result = parseWordSmartResponse(
      response([parent]),
      [
        block('parent', 'Shared material'),
        block('child', 'Which?'),
        block('optionA', 'One'),
        block('optionB', 'Two'),
        block('answer', 'Z'),
      ],
      'nested-answer',
    );
    expect(result.questions).toHaveLength(1);
    const retained = result.questions[0].sub_problems[0];
    expect(retained).toMatchObject({
      question_type: 'single_choice',
      answer: [],
      has_answer: false,
    });
    expect(result.diagnostics).toContainEqual({
      code: 'word-import.invalid-answer-reference',
      severity: 'error',
      questionId: retained.id,
      sourceAnswer: 'Z',
    });
    expect(result.diagnostics.some((item) => item.code === 'word-import.unassigned-block')).toBe(
      false,
    );
  });

  it('does not send known quiz identity headers to the model', () => {
    const input = JSON.parse(
      wordSmartInput([
        block('header', '学校：____ 姓名：____ 班级：____'),
        block('question', '1．Question'),
      ]),
    );
    expect(input.map((item: { blockId: string }) => item.blockId)).toEqual(['question']);
  });

  it('supplies exact UTF-16 run boundaries across surrogate pairs and source atoms', () => {
    const source: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '😀题（' },
        { type: 'text', text: 'B' },
        { type: 'text', text: '）' },
        { type: 'image', attrs: { sourceMediaId: 'private' } },
        { type: 'text', text: '    11    ', marks: [{ type: 'underline' }] },
      ],
    };
    const [input] = JSON.parse(wordSmartInput([source]));
    expect(input.length).toBe(17);
    expect(
      input.runs.map(({ start, end }: { start: number; end: number }) => [start, end]),
    ).toEqual([
      [0, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 17],
    ]);
    expect(input.text.slice(input.runs[4].start, input.runs[4].end)).toBe('    11    ');
    expect(input.runs[4].marks).toEqual(['underline']);
    expect(JSON.stringify(input)).not.toContain('private');
  });

  it('resolves the real inline single-choice letter without accepting option words as answers', () => {
    const sources = [
      block('block-1', '1.下列图像中，能表示“y随x的增大而增大”的是（B）'),
      block('block-2', 'A. 从左上到右下的直线 '),
      block('block-3', 'B. 从左下到右上的直线 '),
      block('block-4', 'C. 水平直线 '),
      block('block-5', 'D. 抛物线开口向上'),
    ];
    const candidate: WordQuestionReference = {
      questionType: 'single_choice',
      question: [
        { blockId: 'block-1', end: 25 },
        { blockId: 'block-1', start: 26 },
      ],
      answer: [{ blockId: 'block-1', start: 25, end: 26 }],
      analysis: [],
      children: [],
      options: ['A', 'B', 'C', 'D'].map((sourceLabel, index) => ({
        sourceLabel,
        label: [{ blockId: `block-${index + 2}`, start: 3 }],
      })),
    };
    const preview = parseWordSmartResponse(response([candidate]), sources, 'single-real');
    expect(preview.questions[0].answer).toEqual(['B']);
    expect(preview.questions[0].options).toHaveLength(4);
    expect(JSON.stringify(preview.questions[0].question)).not.toContain('B');
    expect(preview.questions[0].question.content).toHaveLength(1);
    expect(preview.questions[0].question.content?.[0]?.content).toEqual([
      { type: 'text', text: '1.下列图像中，能表示“y随x的增大而增大”的是（' },
      { type: 'text', text: '）' },
    ]);
    // This was the actual failing model output: the chosen option's words, not B.
    candidate.answer = [{ blockId: 'block-3', start: 3, end: 12 }];
    expect(() => resolveWordQuestions(sources, [candidate], 'strict')).toThrow(
      'invalid-answer-reference',
    );
  });

  it('uses exact long-passage blank hints and source answer-key letters from the real cloze', () => {
    const passage: WordSourceBlock = {
      id: 'block-2',
      content: [
        {
          type: 'text',
          text: 'For nearly 10 years, 78-year-old Charlie Hicks lived alone. He followed the same ',
        },
        { type: 'text', text: '    11    ', marks: [{ type: 'underline' }] },
        {
          type: 'text',
          text: ' to the same restaurant, twice a day-once for lunch and once for dinner-and ',
        },
        { type: 'text', text: '    12    ', marks: [{ type: 'underline' }] },
        {
          type: 'text',
          text: ' the same meal every time: a cup of gumbo, light on the rice, no cracker. The habit was so reliable that staff members didn’t need to ask what he ',
        },
        { type: 'text', text: '    13    ', marks: [{ type: 'underline' }] },
        { type: 'text', text: '.' },
      ],
    };
    const [input] = JSON.parse(wordSmartInput([passage]));
    expect(
      input.runs
        .filter((run: { marks?: string[] }) => run.marks?.includes('underline'))
        .map(({ start, end }: { start: number; end: number }) => [start, end]),
    ).toEqual([
      [81, 91],
      [167, 177],
      [323, 333],
    ]);
    const sources = [
      passage,
      block('key', '11．B 12．C 13．A'),
      block('options', 'A．rule B．route C．advice'),
    ];
    const candidate: WordQuestionReference = {
      questionType: 'cloze',
      question: [ref('block-2')],
      answer: [],
      analysis: [],
      children: [],
      blanks: [81, 167, 323].map((start, index) => ({
        sourceLabel: String(index + 11),
        marker: { blockId: 'block-2', start, end: start + 10 },
        answer: [{ blockId: 'key', start: 3 + index * 5, end: 4 + index * 5 }],
        candidates: [
          { sourceLabel: 'A', label: [{ blockId: 'options', start: 2, end: 6 }] },
          { sourceLabel: 'B', label: [{ blockId: 'options', start: 9, end: 14 }] },
          { sourceLabel: 'C', label: [{ blockId: 'options', start: 17 }] },
        ],
      })),
    };
    const preview = parseWordSmartResponse(response([candidate]), sources, 'cloze-real');
    expect(preview.questions).toHaveLength(1);
    expect(preview.questions[0].blanks?.map((blank) => blank.answer)).toEqual([
      ['B'],
      ['C'],
      ['A'],
    ]);
    expect(JSON.stringify(preview.questions[0].question).match(/quizBlank/g)).toHaveLength(3);
    const missing = parseWordSmartResponse(
      response([{ ...candidate, blanks: candidate.blanks!.slice(0, 2) }]),
      sources,
      'missing-blank',
    );
    expect(missing.questions).toEqual([]);
    expect(missing.diagnostics).toContainEqual({
      code: 'word-import.question-parse-failed',
      severity: 'error',
      blockId: 'block-2',
    });
    candidate.blanks![2].marker.end = 350;
    expect(() => parseWordSmartResponse(response([candidate]), sources, 'invalid')).toThrow(
      'invalid-range',
    );
  });

  it('accepts the real model singleton pointsSource array without losing sourced content', () => {
    const sources = [
      block('block-1', '1. Synthetic acceptance: what is 2 + 2? (2分)'),
      block('block-2', '【答案】4'),
      block('block-3', '【解析】Add the two values.'),
    ];
    const raw = {
      questionType: 'short_answer',
      sourceLabel: '1',
      question: [{ blockId: 'block-1', start: 0, end: 41 }],
      answer: [{ blockId: 'block-2', start: 4, end: 5 }],
      analysis: [{ blockId: 'block-3', start: 4, end: 21 }],
      children: [],
      points: 2,
      pointsSource: [{ blockId: 'block-1', start: 41, end: 42 }],
    };
    const result = parseWordSmartResponse(
      JSON.stringify({ complete: true, questions: [raw], unassignedBlockIds: [] }),
      sources,
      'real-regression',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].points).toBe(2);
    expect(JSON.stringify(result.questions[0].question)).toContain('(2分)');
    expect(JSON.stringify(result.questions[0].answer)).toContain('4');
    expect(JSON.stringify(result.questions[0].analysis)).toContain('Add the two values.');
    expect(result.diagnostics).toEqual([]);
  });

  it.each([undefined, { blockId: 'q', start: 0, end: 1 }])(
    'omits an unverified score but keeps source-backed question/answer (%j)',
    (pointsSource) => {
      const candidate = question('q');
      candidate.answer = [ref('a')];
      candidate.points = 8;
      candidate.pointsSource = pointsSource;
      const result = parseWordSmartResponse(
        response([candidate]),
        [block('q', 'Question (2分)'), block('a', 'Answer')],
        'score',
      );
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0]).not.toHaveProperty('points');
      expect(result.questions[0].has_answer).toBe(true);
      expect(result.diagnostics.map((item) => item.code)).toEqual([
        'word-import.unsourced-points',
        'word-import.missing-points',
      ]);
    },
  );

  it('supplies readable table/math context without source URLs or changed offsets', () => {
    const source: WordSourceBlock = {
      id: 'table',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Cell answer' },
                        { type: 'inlineMath', attrs: { latex: 'x^2' } },
                        {
                          type: 'image',
                          attrs: { src: 'https://private.example', sourceMediaId: 'private-id' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const input = JSON.parse(wordSmartInput([source]));
    expect(input[0].text).toBe('\uFFFC');
    expect(JSON.stringify(input)).toContain('Cell answer');
    expect(JSON.stringify(input)).toContain('x^2');
    expect(JSON.stringify(input)).not.toMatch(/private\.example|private-id/);
    const preview = parseWordSmartResponse(response([question('table')]), [source], 'table');
    expect(preview.questions[0].question.content?.[0].type).toBe('table');
  });

  it('partitions numbered roots with whole children and their own appendix answers', () => {
    const sources = [
      block('q1', `1．${'First '.repeat(2600)}`),
      block('c1', '(1) Child'),
      block('q2', `2．${'Second '.repeat(2200)}`),
      block('c2', '(1) Child'),
      block('h', '参考答案'),
      block('a1', '1．First answer'),
      block('a2', '2．Second answer'),
    ];
    const segments = partitionWordSmartSource(sources);
    expect(segments.map((segment) => segment.map((item) => item.id))).toEqual([
      ['q1', 'c1', 'h', 'a1'],
      ['q2', 'c2', 'h', 'a2'],
    ]);
    segments.forEach((segment) => expect(() => wordSmartInput(segment)).not.toThrow());
  });

  it('does not split a shared cloze passage at its numbered option rows', () => {
    const sources = [
      block('h', '完形填空'),
      block('q', 'Passage '.repeat(7000)),
      block('o1', '11．A．OneB．Two'),
      block('o2', '12．A．ThreeB．Four'),
    ];
    expect(() => partitionWordSmartSource(sources)).toThrow('segment-too-large');
  });

  it('fails before a paid call when a long document appendix cannot be associated', () => {
    const sources = [
      block('q1', `1．${'First '.repeat(2600)}`),
      block('q2', `2．${'Second '.repeat(2200)}`),
      block('h', '参考答案'),
      block('a', '9．Unknown'),
    ];
    expect(() => partitionWordSmartSource(sources)).toThrow('ambiguous-appendix');
  });

  it('keeps valid complete roots with diagnostics for a semantically invalid sibling', () => {
    const bad = question('bad');
    bad.questionType = 'unsupported' as never;
    const result = parseWordSmartResponse(
      response([bad, question('good')]),
      [block('bad', 'Bad score'), block('good', 'Valid')],
      'partial',
    );
    expect(result.questions).toHaveLength(1);
    expect(
      result.diagnostics.some((item) => item.code === 'word-import.question-parse-failed'),
    ).toBe(true);
    expect(result.diagnostics).toContainEqual({
      code: 'word-import.unassigned-block',
      severity: 'warning',
      blockId: 'bad',
    });
  });

  it('never downgrades invented ranges, truncation or unaccounted source into partial success', () => {
    const sources = [block('q', 'Source')];
    expect(() => parseWordSmartResponse(response([question('missing')]), sources, 'run')).toThrow(
      'unknown-block',
    );
    const bad = question('q');
    bad.question[0].end = 99;
    expect(() => parseWordSmartResponse(response([bad]), sources, 'run')).toThrow('invalid-range');
    expect(() =>
      parseWordSmartResponse(
        '{"complete":false,"questions":[],"unassignedBlockIds":[]}',
        sources,
        'run',
      ),
    ).toThrow('incomplete-response');
    expect(() => parseWordSmartResponse(response([]), sources, 'run')).toThrow(
      'unaccounted-source',
    );
  });
});
