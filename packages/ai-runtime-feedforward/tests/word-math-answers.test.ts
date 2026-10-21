import { describe, expect, it } from 'vitest';
import {
  fastWordReferences,
  isWordStructuralLabel,
  parseWordFast,
  type WordSourceBlock,
} from '../src/word-import/index.js';

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const image = (id: string, sourceMediaId = id): WordSourceBlock => ({
  id,
  content: [{ type: 'image', attrs: { sourceMediaId } }],
});
const table = (id: string): WordSourceBlock => ({
  id,
  content: [
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
            },
            { type: 'tableCell', content: [{ type: 'paragraph' }] },
          ],
        },
      ],
    },
  ],
});
const precedingQuestion = () => [
  block('old-question', '1．Explain the old question.'),
  block('old-answer', '【答案】Old answer'),
  block('old-analysis', '【点睛】Old explanation.'),
];

describe('Word mathematics source answer preservation', () => {
  it.each(['计算题 （直接写出得数）。', '作图题 (每题5分):', '判断题：', '排序题。'])(
    'accepts bounded heading annotations and terminal punctuation: %s',
    (title) => {
      const result = parseWordFast(
        [
          block('fill-section', '填空题'),
          block('section', title),
          block('q', '1．Original task.'),
          block('a', '【答案】Original answer'),
        ],
        'bounded-math-section',
      );
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].question_type).toBe('short_answer');
      expect(JSON.stringify(result.questions)).not.toContain(title);
      expect(isWordStructuralLabel(title)).toBe(true);
      expect(
        result.diagnostics.some((diagnostic) => diagnostic.code === 'word-import.unassigned-block'),
      ).toBe(false);
    },
  );

  it('keeps generic choice inference after a punctuated heading', () => {
    const result = parseWordFast(
      [
        block('section', '选择题 （请选择正确选项）：'),
        block('q', '1．Which?'),
        block('o', 'A．First B．Second C．Third'),
        block('a', '【答案】AB'),
      ],
      'punctuated-choice-section',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      question_type: 'multiple_choice',
      answer: ['A', 'B'],
    });
  });

  it('preserves parentheses in explicitly short mathematical tasks without scoring blanks', () => {
    const result = parseWordFast(
      [
        block('section', '解答题'),
        block('q', '1．说明角度 (    )° 和时间 (    )。'),
        block('a', '【答案】Original explanation'),
      ],
      'explicit-short-parentheses',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(result.questions[0].blanks).toBeUndefined();
    expect(JSON.stringify(result.questions[0].question)).toContain('(    )°');
    expect(JSON.stringify(result.questions[0].question)).not.toContain('quizBlank');
    expect(result.diagnostics.some((d) => d.code === 'word-import.unexpected-blanks')).toBe(false);
  });

  it('keeps a review diagnostic for a small underlined number in an explicitly short task', () => {
    const result = parseWordFast(
      [
        block('section', '解答题'),
        {
          id: 'q',
          content: [
            { type: 'text', text: '1．已知 ' },
            { type: 'text', text: '123', marks: [{ type: 'underline' }] },
            { type: 'text', text: '，说明关系。' },
          ],
        },
        block('a', '【答案】Original explanation'),
      ],
      'explicit-short-numeric-review',
    );
    expect(JSON.stringify(result.questions[0].question)).toContain('123');
    expect(JSON.stringify(result.questions[0].question)).not.toContain('quizBlank');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.check-question-boundary', blockId: 'q' }),
    );
  });

  it('recognizes a complete native-numbered root option pool', () => {
    const refs = fastWordReferences([
      { ...block('q', 'A．First    B．Second'), numbering: { level: 0, label: '1.' } },
      block('a', '【答案】B'),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].questionType).toBe('single_choice');
    expect(refs[0].options?.map((option) => option.sourceLabel)).toEqual(['A', 'B']);
  });

  it('retains the original native option-only root in the resolved preview', () => {
    const result = parseWordFast(
      [
        { ...block('q', 'A．First    B．Second'), numbering: { level: 0, label: '1.' } },
        block('a', '【答案】B'),
      ],
      'native-pool-source-question',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      question_type: 'single_choice',
      answer: ['B'],
      has_answer: true,
    });
    expect(result.questions[0].options?.map((option) => option.value)).toEqual(['A', 'B']);
    expect(JSON.stringify(result.questions[0].question)).toContain('A．First    B．Second');
    expect(result.unresolvedItems?.some((item) => item.kind === 'question')).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(false);
  });

  it('attaches a native-numbered option-only row to the active unanswered root', () => {
    const result = parseWordFast(
      [
        block('q', '1．Which?'),
        { ...block('o', 'A. One B. Two'), numbering: { level: 0, label: '2．' } },
        block('a', '【答案】A'),
      ],
      'native-option-continuation',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      question_type: 'single_choice',
      answer: ['A'],
      has_answer: true,
    });
    expect(result.questions[0].options).toHaveLength(2);
    expect(JSON.stringify(result.questions[0].question)).toContain('Which?');
    expect(JSON.stringify(result.questions[0].question)).not.toContain('One');
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(false);
  });

  it('creates a new native root for substantive prose after an unanswered root', () => {
    const refs = fastWordReferences([
      block('q1', '1．First question?'),
      {
        ...block('q2', 'A、B、C是三个点，说明它们的位置。'),
        numbering: { level: 0, label: '2．' },
      },
      block('a2', '【答案】Original explanation'),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0].options).toBeUndefined();
    expect(refs[0].answer).toEqual([]);
    expect(refs[1].question).toContainEqual(expect.objectContaining({ blockId: 'q2' }));
    expect(refs[1].answer).toContainEqual(expect.objectContaining({ blockId: 'a2' }));
  });

  it('keeps a native option pool separate from an already solved root', () => {
    const refs = fastWordReferences([
      block('q1', '1．Original question.'),
      block('a1', '【答案】Original answer'),
      { ...block('q2', 'A. One B. Two'), numbering: { level: 0, label: '2．' } },
      block('a2', '【答案】A'),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0].options).toBeUndefined();
    expect(refs[0].answer).toContainEqual(expect.objectContaining({ blockId: 'a1' }));
    expect(refs[1].options).toHaveLength(2);
    expect(refs[1].answer).toContainEqual(expect.objectContaining({ blockId: 'a2' }));
  });

  it('keeps substantive mathematical heading-like prose nonstructural', () => {
    expect(isWordStructuralLabel('计算题需要合理步骤。')).toBe(false);
    expect(isWordStructuralLabel('作图题 （请说明理由）继续分析。')).toBe(false);
  });

  it('preserves native-numbered variable-list prose as a stem', () => {
    const refs = fastWordReferences([
      { ...block('q', 'A、B、C是三个点，说明它们的位置。'), numbering: { level: 0, label: '1.' } },
      block('a', '【答案】Original explanation'),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].options).toBeUndefined();
    expect(refs[0].question).toContainEqual(expect.objectContaining({ blockId: 'q' }));
  });

  it('uses a later number-reading cue while preserving the original underlined digits visibly', () => {
    const result = parseWordFast(
      [
        {
          id: 'q',
          content: [
            { type: 'text', text: '1．已知 ' },
            { type: 'text', text: '123', marks: [{ type: 'underline' }] },
            { type: 'text', text: '。' },
          ],
        },
        block('cue', '读出横线上的数：____。'),
        block('a', '【答案】一百二十三'),
      ],
      'late-number-reading-cue',
    );
    expect(result.questions[0].blanks).toHaveLength(1);
    expect(JSON.stringify(result.questions[0].question)).toContain('123');
    expect(result.questions[0].has_answer).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'word-import.blank-outside-question')).toBe(
      false,
    );
  });

  it('joins a split ancestor number-rounding cue without converting source digits into a blank', () => {
    const result = parseWordFast(
      [
        block('root', '1．省略'),
        {
          id: 'child',
          content: [
            { type: 'text', text: '（1）尾数，已知 ' },
            { type: 'text', text: '123', marks: [{ type: 'underline' }] },
            { type: 'text', text: '，说明取值。' },
          ],
        },
        block('a', '【答案】（1）Original explanation'),
      ],
      'split-ancestor-numeric-cue',
    );
    const child = result.questions[0].sub_problems[0];
    expect(child).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(child.blanks).toBeUndefined();
    expect(JSON.stringify(child.question)).toContain('123');
    expect(JSON.stringify(child.question)).not.toContain('quizBlank');
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'word-import.blank-outside-question',
      ),
    ).toBe(false);
  });

  it('normalizes a zero-slot fill parent while preserving its material and child answers', () => {
    const result = parseWordFast(
      [
        block('section', '填空题'),
        block('root', '1．根据下面材料完成小题。'),
        image('material-image'),
        block('child1', '（1）First (    ).'),
        block('child2', '（2）Second (    ).'),
        block('a', '【答案】First     Second'),
      ],
      'zero-slot-composite-parent',
    );
    expect(result.questions[0].question_type).toBe('short_answer');
    expect(JSON.stringify(result.questions[0].question)).toContain('material-image');
    expect(result.questions[0].sub_problems.every((child) => child.has_answer)).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'word-import.missing-blanks')).toBe(false);
  });

  it('preserves an undistributed source answer on a zero-slot fill parent', () => {
    const result = parseWordFast(
      [
        block('section', '填空题'),
        block('root', '1．根据材料完成小题。'),
        block('child1', '（1）First (    ).'),
        block('child2', '（2）Second (    ).'),
        block('a', '【答案】Original shared narrative'),
      ],
      'zero-slot-parent-own-answer',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(JSON.stringify(result.questions[0].answer)).toContain('Original shared narrative');
  });

  it('retains a fill parent that owns an actual source blank', () => {
    const refs = fastWordReferences([
      block('section', '填空题'),
      block('root', '1．Overall result (    ).'),
      block('child1', '（1）First (    ).'),
      block('child2', '（2）Second (    ).'),
    ]);
    expect(refs[0].questionType).toBe('fill_in_the_blank');
    expect(refs[0].blanks).toHaveLength(1);
    expect(refs[0].children).toHaveLength(2);
  });

  it.each([
    block('sorting', '排序题'),
    block('sorting', '三、排序题'),
    { ...block('sorting', '排序题'), numbering: { level: 0, label: '三、' } },
  ])('recognizes complete sorting headings without creating phantom tasks', (section) => {
    const result = parseWordFast(
      [
        block('fill-section', '填空题'),
        section,
        block('question', '1．Sort the given values.'),
        block('answer', '【答案】1 < 2 < 3'),
      ],
      'sorting-section',
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(JSON.stringify(result.questions)).not.toContain('排序题');
  });

  it('groups unnumbered image material only with its complete global answer key', () => {
    const result = parseWordFast(
      [
        block('section', '解答题'),
        ...precedingQuestion(),
        block('material', '某单位统计了三个项目的数据，如下图。'),
        image('chart'),
        block('q5', '5．比例是多少？'),
        block('q6', '6．根据图中的数据，应选择哪幅图（    ）？'),
        {
          id: 'options',
          content: [
            { type: 'text', text: 'A．' },
            { type: 'image', attrs: { sourceMediaId: 'option-a' } },
            { type: 'text', text: '    B．' },
            { type: 'image', attrs: { sourceMediaId: 'option-b' } },
          ],
        },
        block('q7', '7．建议选 (    )，理由是 ____。'),
        block('answers', '【答案】5．80%    6．B    7．First item     Original suggestion'),
        block('analysis1', '【分析】（1）Compare the first measurement.'),
        block('analysis2', '（2）Compare the second measurement.'),
        block('analysis3', '（3）Explain the proposed suggestion.'),
        block('details5', '【详解】5．Explicit explanation for task five.'),
      ],
      'shared-chart',
    );
    expect(result.questions).toHaveLength(2);
    const parent = result.questions[1];
    expect(JSON.stringify(parent.question)).toContain('sourceMediaId');
    expect(JSON.stringify(result.questions[0].analysis)).not.toContain('某单位');
    expect(parent.sub_problems).toHaveLength(3);
    expect(parent.sub_problems.every((child) => child.has_answer)).toBe(true);
    expect(parent.sub_problems[1]).toMatchObject({
      question_type: 'single_choice',
      answer: ['B'],
    });
    expect(JSON.stringify(parent.sub_problems[0].answer)).toContain('80%');
    expect(parent.sub_problems[2].question_type).toBe('fill_in_the_blank');
    expect(JSON.stringify(parent.sub_problems[2].blanks?.[1].answer)).toContain(
      'Original suggestion',
    );
    expect(JSON.stringify(parent.analysis)).toContain('Compare the first measurement');
    expect(JSON.stringify(parent.analysis)).toContain('Explain the proposed suggestion');
    expect(JSON.stringify(parent.sub_problems[1].analysis)).not.toContain('Compare the');
    expect(JSON.stringify(parent.sub_problems[0].analysis)).toContain('Explicit explanation');
    expect(result.sources[parent.sub_problems[0].id].sourceLabel).toBe('5');
  });

  it('recognizes a native table as shared material with a verified numbered key', () => {
    const refs = fastWordReferences([
      ...precedingQuestion(),
      block('material', 'The following table describes the measurements.'),
      table('shared-table'),
      block('q2', '2．Explain the first measurement.'),
      block('q3', '3．Explain the second measurement.'),
      block('answers', '【答案】2．First answer    3．Second answer'),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[1].question.map((ref) => ref.blockId)).toEqual(['material', 'shared-table']);
    expect(refs[1].children.map((child) => child.sourceLabel)).toEqual(['2', '3']);
    expect(refs[1].children.every((child) => child.answer.length > 0)).toBe(true);
  });

  it.each([
    '【答案】2．First answer',
    '【答案】2．First answer    4．Different task',
    '【答案】2．First answer    3．Second answer    4．Extra answer',
  ])('does not guess a diagram group from an incomplete or conflicting answer key: %s', (key) => {
    const refs = fastWordReferences([
      ...precedingQuestion(),
      block('material', 'The following chart describes the measurements.'),
      image('chart'),
      block('q2', '2．Explain the first measurement.'),
      block('q3', '3．Explain the second measurement.'),
      block('answers', key),
    ]);
    expect(refs.filter((ref) => ref.children.length > 0)).toEqual([]);
  });

  it('does not scan a diagram group through another solution heading', () => {
    const refs = fastWordReferences([
      ...precedingQuestion(),
      block('material', 'The following chart describes the measurements.'),
      image('chart'),
      block('unrelated-analysis', '【分析】Another explanation.'),
      block('q2', '2．Explain the first measurement.'),
      block('q3', '3．Explain the second measurement.'),
      block('answers', '【答案】2．First answer    3．Second answer'),
    ]);
    expect(refs.filter((ref) => ref.children.length > 0)).toEqual([]);
  });

  it('assigns verified fill answers across separate source paragraphs', () => {
    const result = parseWordFast(
      [
        block('question', '1．Compare (    ), (    ), and (    ).'),
        block('answer-heading', '【答案】     '),
        block('answer1', '＜     '),
        block('answer2', '＜     '),
        block('answer3', '＞'),
        block('analysis', '【分析】Compare the values.'),
      ],
      'paragraph-answers',
    );
    expect(result.questions[0].question_type).toBe('fill_in_the_blank');
    expect(result.questions[0].has_answer).toBe(true);
    expect(result.questions[0].blanks?.map((blank) => JSON.stringify(blank.answer))).toEqual([
      expect.stringContaining('＜'),
      expect.stringContaining('＜'),
      expect.stringContaining('＞'),
    ]);
  });

  it('combines compact decimal values and paragraph answers only with a matching slot count', () => {
    const result = parseWordFast(
      [
        block('question', '1．Complete (    ), (    ), and (    ).'),
        block('answer12', '【答案】12.56     50.24'),
        block('answer3', '75.36'),
      ],
      'compact-paragraphs',
    );
    expect(result.questions[0].question_type).toBe('fill_in_the_blank');
    expect(result.questions[0].blanks?.map((blank) => JSON.stringify(blank.answer))).toEqual([
      expect.stringContaining('12.56'),
      expect.stringContaining('50.24'),
      expect.stringContaining('75.36'),
    ]);
  });

  it('preserves an incompatible source answer as short answer with an explicit review diagnostic', () => {
    const result = parseWordFast(
      [
        block('section', '填空题'),
        block('question', '1．Direction (    ), angle (    ), time (    ), distance (    ).'),
        block('answer', '【答案】East (or South); South (or East); 30 (or 60); 4; 40'),
      ],
      'source-mismatch',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(result.questions[0].blanks).toBeUndefined();
    expect(JSON.stringify(result.questions[0].question)).toContain('angle (    )');
    expect(JSON.stringify(result.questions[0].answer)).toContain(
      'East (or South); South (or East); 30 (or 60); 4; 40',
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.uncertain-block', blockId: 'question' }),
    );
    expect(result.unresolvedItems).toContainEqual(
      expect.objectContaining({ code: 'word-import.uncertain-block' }),
    );
  });

  it('retains a drawing answer image when a fill section has no addressable slots', () => {
    const result = parseWordFast(
      [
        block('section', '填空题'),
        block('question', '1．Draw the requested region.'),
        {
          id: 'answer',
          content: [
            { type: 'text', text: '【答案】' },
            { type: 'image', attrs: { sourceMediaId: 'drawing-answer' } },
          ],
        },
      ],
      'drawing-preservation',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(JSON.stringify(result.questions[0].answer)).toContain('drawing-answer');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.uncertain-block', blockId: 'question' }),
    );
  });

  it('flags an incompatible drawing-section answer while preserving its existing short-answer type', () => {
    const result = parseWordFast(
      [
        block('section', '四、作图题'),
        block('question', '1．A点偏 (    ) (    )°，即 (    ) 点钟，距离 (    ) 千米。'),
        block('answer', '【答案】东（或南）；南（或东）；30（或60）；4；40'),
      ],
      'drawing-source-mismatch',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(JSON.stringify(result.questions[0].answer)).toContain(
      '东（或南）；南（或东）；30（或60）；4；40',
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.uncertain-block', blockId: 'question' }),
    );
  });

  it('retains the full native table and answer when table cells have no addressable slots', () => {
    const result = parseWordFast(
      [
        block('section', '填空题'),
        block('question', '1．Complete the table.'),
        table('question-table'),
        block('answer', '【答案】5；2；9；5'),
      ],
      'table-preservation',
    );
    expect(result.questions[0]).toMatchObject({ question_type: 'short_answer', has_answer: true });
    expect(JSON.stringify(result.questions[0].question)).toContain('tableCell');
    expect(JSON.stringify(result.questions[0].answer)).toContain('5；2；9；5');
  });

  it('keeps existing labeled fill answers without a preservation fallback', () => {
    const result = parseWordFast(
      [
        block('question', '1．Complete (    ) and (    ).'),
        block('answer', '【答案】（1）First;（2）Second'),
      ],
      'labeled-fill',
    );
    expect(result.questions[0]).toMatchObject({
      question_type: 'fill_in_the_blank',
      has_answer: true,
    });
    expect(result.questions[0].blanks?.map((blank) => JSON.stringify(blank.answer))).toEqual([
      expect.stringContaining('First'),
      expect.stringContaining('Second'),
    ]);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === 'word-import.uncertain-block'),
    ).toBe(false);
  });

  it('preserves the existing English shared-pool cloze contract', () => {
    const result = parseWordFast(
      [
        block('section', '选词填空'),
        block('question', '1．The ___ is ___.'),
        block('options', 'A. sky B. blue C. green'),
        block('answer', '【答案】1. A 2. B'),
      ],
      'english-regression',
    );
    expect(result.questions[0]).toMatchObject({
      question_type: 'fill_with_candidates',
      has_answer: true,
    });
    expect(result.questions[0].blanks?.map((blank) => blank.answer)).toEqual([['A'], ['B']]);
  });

  it.each(['见详解', '见解析', '见解答'])(
    'shares a complete unnumbered reference answer after unanswered child stems: %s',
    (answer) => {
      const result = parseWordFast(
        [
          block('root', '1．Complete the following tasks.'),
          block('child1', '（1）First task.'),
          block('child2', '（2）Second task.'),
          block('child3', '（3）Third task.'),
          block('answer', `【答案】${answer}`),
          block(
            'analysis',
            '【详解】（1）First explanation.    （2）Second explanation.    （3）Third explanation.',
          ),
        ],
        'shared-reference-answer',
      );
      expect(result.questions[0].sub_problems).toHaveLength(3);
      expect(result.questions[0].sub_problems.every((child) => child.has_answer)).toBe(true);
      for (const child of result.questions[0].sub_problems)
        expect(JSON.stringify(child.answer)).toContain(answer);
    },
  );

  it('keeps a reference answer on its last child when an earlier child already has a solution', () => {
    const result = parseWordFast(
      [
        block('root', '1．Complete the following tasks.'),
        block('child1', '（1）First task.'),
        block('answer1', '【答案】Original first answer'),
        block('child2', '（2）Second task.'),
        block('answer2', '【答案】见详解'),
      ],
      'last-child-reference-answer',
    );
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).toContain(
      'Original first answer',
    );
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).not.toContain('见详解');
    expect(JSON.stringify(result.questions[0].sub_problems[1].answer)).toContain('见详解');
  });

  it('shares joint drawing answers when the named children own the drawing commands', () => {
    const result = parseWordFast(
      [
        block('root', '1．描述各点的信息。'),
        block('child1', '（1）A点位于哪里？'),
        block('child2', '（2）请标出B点的位置。'),
        block('child3', '（3）请在图中画出覆盖的区域。'),
        block('answer1', '【答案】（1）Original description'),
        block('joint-answer', '（2）（3）见解答'),
        image('joint-image'),
      ],
      'named-drawing-commands',
    );
    for (const child of result.questions[0].sub_problems.slice(1)) {
      expect(child.has_answer).toBe(true);
      expect(JSON.stringify(child.answer)).toContain('见解答');
      expect(JSON.stringify(child.answer)).toContain('joint-image');
    }
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).not.toContain('joint-image');
  });

  it('shares a joint answer explicitly declaring drawing output after an earlier numbered answer', () => {
    const result = parseWordFast(
      [
        block('root', '1．某学校的调查统计结果如下。'),
        block('child1', '（1）每格代表多少人？'),
        block('child2', '（2）将统计图补充完整。'),
        block('answer1', '【答案】（1）50'),
        block('joint-answer', '（1）（2）作图如下：'),
        image('joint-image'),
      ],
      'declared-joint-drawing',
    );
    expect(result.questions[0].sub_problems.every((child) => child.has_answer)).toBe(true);
    expect(JSON.stringify(result.questions[0].sub_problems[0].answer)).toContain('50');
    for (const child of result.questions[0].sub_problems)
      expect(JSON.stringify(child.answer)).toContain('joint-image');
  });

  it('recognizes a named line-drawing command with an explicitly joint figure answer', () => {
    const result = parseWordFast(
      [
        block('root', '1．按要求操作。'),
        block('child1', '（1）说明选取的位置。'),
        block('child2', '（2）画一条线与AB平行。'),
        block('joint-answer', '【答案】（1）（2）如下图：'),
        image('joint-image'),
      ],
      'line-drawing-command',
    );
    for (const child of result.questions[0].sub_problems) {
      expect(child.has_answer).toBe(true);
      expect(JSON.stringify(child.answer)).toContain('joint-image');
    }
  });
});
