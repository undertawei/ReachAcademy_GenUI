import { describe, expect, it } from 'vitest';
import {
  fastWordReferences,
  isWordStructuralLabel,
  parseWordFast,
  sourceText,
  type WordSourceBlock,
  type WordSourceRange,
} from '../src/word-import/index.js';

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const math = (id: string, latex: string, before = '', after = ''): WordSourceBlock => ({
  id,
  content: [
    ...(before ? [{ type: 'text' as const, text: before }] : []),
    { type: 'inlineMath', attrs: { latex } },
    ...(after ? [{ type: 'text' as const, text: after }] : []),
  ],
});
const projected = (blocks: WordSourceBlock[], refs: WordSourceRange[]) =>
  refs
    .map((ref) =>
      sourceText(blocks.find((item) => item.id === ref.blockId)!.content).slice(ref.start, ref.end),
    )
    .join('\n');
const nestedTasks = () => [
  block('section', '解答题'),
  block('root', '1．Material.'),
  block('task1', '(1) First task.'),
  block('task2', '(2) Second group.'),
  block('inner1', '① First inner task.'),
  block('inner2', '② Second inner task.'),
];
const plainTasks = () => [
  block('section', '解答题'),
  block('root', '1．Material.'),
  block('task1', '(1) First task.'),
  block('task2', '(2) Second task.'),
];

describe('Grade seven mathematics conservative parser regressions', () => {
  it.each(['单选题', '一、单选题', '二、多选题'])(
    'covers a complete heading alias: %s',
    (title) => {
      expect(isWordStructuralLabel(title)).toBe(true);
      const result = parseWordFast(
        [
          block('section', title),
          block('q', '1．Which?'),
          block('o', 'A. First B. Second'),
          block('a', '【答案】B'),
        ],
        'heading-alias',
      );
      expect(result.diagnostics.some((item) => item.code === 'word-import.unassigned-block')).toBe(
        false,
      );
    },
  );

  it('covers consecutive pure solution labels while keeping substantive residual prose reviewable', () => {
    expect(isWordStructuralLabel('【详解】解析：')).toBe(false);
    const result = parseWordFast(
      [
        block('q', '1．Explain.'),
        block('a', '【答案】Result.'),
        block('analysis', '【详解】解析：Explanation.'),
      ],
      'consecutive-labels',
    );
    expect(
      result.unresolvedItems?.some((item) => item.code === 'word-import.unassigned-range'),
    ).toBe(false);
    expect(isWordStructuralLabel('【详解】解析：Unassigned explanation')).toBe(false);
    expect(isWordStructuralLabel('单选题的选项需要比较。')).toBe(false);
    expect(isWordStructuralLabel('多选题（理由）继续说明')).toBe(false);
  });

  it.each(['解答题', '填空题'])('uses strong local choice cues under inherited %s', (section) => {
    const sources = [
      block('section', section),
      block('root', '1．Material.'),
      block('q', section === '解答题' ? '(1) Which?（单选）' : '(1) 正确的选项是（ ）'),
      block('o', 'A. First B. Second C. Third D. Fourth'),
      block('a', '【答案】C'),
    ];
    const result = parseWordFast(sources, 'local-choice');
    expect(result.questions[0].sub_problems[0]).toMatchObject({
      question_type: 'single_choice',
      answer: ['C'],
      has_answer: true,
    });
    expect(result.questions[0].sub_problems[0].blanks).toBeUndefined();
  });

  it('decodes a pure math letter choice without changing source projection or latex', () => {
    const sources = [
      block('section', '填空题'),
      block('q', '1．正确的选项是（ ）'),
      block('o', 'A. First B. Second C. Third D. Fourth'),
      math('a', '{C}', '【答案】'),
    ];
    const before = JSON.stringify(sources);
    expect(sourceText(sources.at(-1)!.content)).toBe('【答案】\uFFFC');
    const result = parseWordFast(sources, 'math-choice-letter');
    expect(result.questions[0]).toMatchObject({ question_type: 'single_choice', answer: ['C'] });
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('uses an exact first-stem annotation despite later transition material', () => {
    const sources = [
      block('section', '解答题'),
      block('root', '1．Material.'),
      block('q', '(1) Which?（单选）'),
      block('o', 'A. First B. Second C. Third'),
      block('transition', 'Continue considering this material.'),
      math('a', '{C}', '【答案】'),
    ];
    const result = parseWordFast(sources, 'annotated-stem-transition');
    expect(result.questions[0].sub_problems[0]).toMatchObject({
      question_type: 'single_choice',
      answer: ['C'],
    });
  });

  it('keeps a conflicting multi-letter key under an explicit single-choice annotation reviewable', () => {
    const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
    const refs = fastWordReferences(
      [
        block('section', '解答题'),
        block('q', '1．Which?（单选）'),
        block('o', 'A. First B. Second C. Third'),
        block('a', '【答案】AB'),
      ],
      diagnostics,
    );
    expect(refs[0].questionType).toBe('short_answer');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.check-question-boundary' }),
    );
  });

  it.each([
    ['Explain each alternative.', 'C'],
    ['正确的选项是（ ）', 'C because it is smaller'],
    ['正确的选项是（ ）', 'E'],
  ])('keeps inherited short type without all local choice evidence: %s / %s', (stem, key) => {
    const refs = fastWordReferences([
      block('section', '解答题'),
      block('q', `1．${stem}`),
      block('o', 'A. First B. Second C. Third D. Fourth'),
      block('a', `【答案】${key}`),
    ]);
    expect(refs[0].questionType).toBe('short_answer');
  });

  it.each(['A. First C. Third', 'A. First A. Again', 'B. Second C. Third'])(
    'requires an ordered full choice pool: %s',
    (options) => {
      const refs = fastWordReferences([
        block('section', '填空题'),
        block('q', '1．正确的选项是（ ）'),
        block('o', options),
        block('a', '【答案】C'),
      ]);
      expect(refs[0].questionType).toBe('fill_in_the_blank');
    },
  );

  it.each(['C+x', '\\angle C', '{C}^{2}', '{x}', '{AB}', '{C}{'])(
    'does not decode non-label math as a choice: %s',
    (latex) => {
      const result = parseWordFast(
        [
          block('section', '单选题'),
          block('q', '1．Which?'),
          block('o', 'A. First B. Second C. Third'),
          math('a', latex, '【答案】'),
        ],
        'non-label-math',
      );
      expect(result.questions[0].has_answer).toBe(false);
    },
  );

  it('routes compact existing circled answer keys after a formula', () => {
    const sources = [
      ...nestedTasks(),
      block('a1', '【答案】(1) First result.'),
      math('a2', 'x^2', '(2)①', '②1000'),
    ];
    const refs = fastWordReferences(sources);
    const inner = refs[0].children[1].children;
    expect(projected(sources, inner[0].answer)).toBe('\uFFFC');
    expect(projected(sources, inner[1].answer)).toBe('1000');
    const result = parseWordFast(sources, 'compact-inner-key');
    expect(JSON.stringify(result.questions[0].sub_problems[1].sub_problems[0].answer)).toContain(
      'x^2',
    );
    expect(JSON.stringify(result.questions[0].sub_problems[1].sub_problems[1].answer)).toContain(
      '1000',
    );
  });

  it('keeps interior circled prose references within the established owner', () => {
    const sources = [...nestedTasks(), block('a', '【答案】(2)①Compare ② with the first case.')];
    const refs = fastWordReferences(sources);
    const inner = refs[0].children[1].children;
    expect(projected(sources, inner[0].answer)).toBe('Compare ② with the first case.');
    expect(inner[1].answer).toEqual([]);
  });

  it('routes a leading standalone math parenthesis label without dropping its atom', () => {
    const sources = [
      ...plainTasks(),
      block('a', '【答案】(1) First result. (2) Second result.'),
      block('analysis', '【详解】(1) First explanation.'),
      math('second', '\\left(2\\right)', '', ' Second explanation.'),
    ];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[0].analysis)).not.toContain('Second explanation');
    expect(projected(sources, refs[0].children[1].analysis)).toBe('\uFFFC Second explanation.');
    expect(refs[0].children[1].analysis).toContainEqual({ blockId: 'second', start: 0, end: 21 });
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('routes a leading circled math formula to an existing sibling and preserves its latex', () => {
    const sources = [
      ...nestedTasks(),
      block('a', '【答案】(2)① First result.  ② Second result.'),
      block('analysis', '【详解】(2)① First explanation.'),
      math('second', '②\\angle ABC=30', '', ' Second explanation.'),
    ];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources);
    const inner = refs[0].children[1].children;
    expect(projected(sources, inner[0].analysis)).not.toContain('Second explanation');
    expect(projected(sources, inner[1].analysis)).toBe('\uFFFC Second explanation.');
    const result = parseWordFast(sources, 'circled-math-owner');
    expect(JSON.stringify(result.questions[0].sub_problems[1].sub_problems[1].analysis)).toContain(
      '②\\\\angle ABC=30',
    );
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('routes the first math child label after a leading text parent label', () => {
    const sources = [
      ...nestedTasks(),
      block('a', '【答案】See explanation.'),
      math('analysis', '①', '【详解】(2)', ' First nested proof.'),
    ];
    const refs = fastWordReferences(sources);
    const parent = refs[0].children[1];
    expect(projected(sources, parent.children[0].analysis)).toBe('\uFFFC First nested proof.');
    expect(projected(sources, parent.analysis)).not.toContain('First nested proof');
  });

  it('routes a combined native parent and first nested label as one preserved atom', () => {
    const sources = [
      ...nestedTasks(),
      block('analysis', '【详解】(1) First proof.'),
      math('second', '\\left(2\\right)①\\because x=3', '', ' Nested proof.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].children[0].analysis)).toBe(
      '\uFFFC Nested proof.',
    );
    expect(projected(sources, refs[0].children[0].analysis)).not.toContain('Nested proof');
  });

  it.each(['(2)②x=3', '(7)①x=3', '(2)①+x', '(2)①\\times x'])(
    'keeps unverified composite native keys with their established owner: %s',
    (latex) => {
      const sources = [
        ...nestedTasks(),
        block('analysis', '【详解】(1) First proof.'),
        math('formula', latex, '', ' Continuing proof.'),
      ];
      const refs = fastWordReferences(sources);
      expect(projected(sources, refs[0].children[0].analysis)).toContain('Continuing proof');
      expect(refs[0].children[1].children[0].analysis).toEqual([]);
    },
  );

  it('keeps a composite label followed by a separate native operator with its established owner', () => {
    const sources = [
      ...nestedTasks(),
      block('analysis', '【详解】(1) First proof.'),
      {
        id: 'formula',
        content: [
          { type: 'inlineMath', attrs: { latex: '(2)①' } },
          { type: 'inlineMath', attrs: { latex: '+x' } },
        ],
      } satisfies WordSourceBlock,
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children[0].analysis.some((ref) => ref.blockId === 'formula')).toBe(true);
    expect(refs[0].children[1].children[0].analysis).toEqual([]);
  });

  it('keeps a verified nested owner across an inline analysis heading and interior backward reference', () => {
    const sources = [
      ...nestedTasks(),
      block('analysis1', '【详解】(2)① First proof.分析：More first proof.'),
      block('analysis2', '②Same as ①.分析：Second proof.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].children[1].analysis)).toContain('Second proof');
    expect(projected(sources, refs[0].children[1].children[0].analysis)).not.toContain(
      'Second proof',
    );
  });

  it('does not restart a known nested sequence for an inline prose analysis label', () => {
    const sources = [
      ...nestedTasks(),
      block('analysis1', '【详解】(2)① First proof.'),
      block('analysis2', '②Same as ①.分析：Second proof.'),
      math('reference', '①\\angle ABC=30', '', ' Backward reference.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].children[1].analysis)).toContain(
      'Backward reference',
    );
    expect(projected(sources, refs[0].children[1].children[0].analysis)).not.toContain(
      'Backward reference',
    );
  });

  it('routes an existing textual child key after a retained unavailable-math warning atom', () => {
    const sources = [
      ...plainTasks(),
      block('analysis', '【详解】(1) First proof.'),
      {
        id: 'second',
        content: [
          { type: 'docxUnavailable', attrs: { reason: 'docx.math.unsupported' } },
          { type: 'text', text: '(2) Second proof.' },
        ],
      } satisfies WordSourceBlock,
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].analysis)).toBe('\uFFFC\nSecond proof.');
    expect(projected(sources, refs[0].children[0].analysis)).not.toContain('Second proof');
  });

  it.each(['inlineMath', 'image'])(
    'keeps a substantive %s prefix before a numeric reference with its current owner',
    (type) => {
      const sources = [
        ...plainTasks(),
        block('analysis', '【详解】(1) First proof.'),
        {
          id: 'formula',
          content: [
            { type, attrs: type === 'image' ? { sourceMediaId: 'figure' } : { latex: 'x^2' } },
            { type: 'text', text: '(2) Continuing proof.' },
          ],
        } satisfies WordSourceBlock,
      ];
      const refs = fastWordReferences(sources);
      expect(projected(sources, refs[0].children[0].analysis)).toContain('Continuing proof');
      expect(refs[0].children[1].analysis).toEqual([]);
    },
  );

  it('keeps an inline consecutive circled formula task pool whole rather than creating only the first child', () => {
    const sources = [
      block('root', '1．Material.'),
      block('task', '(1) Explain these equations.'),
      {
        id: 'pool',
        content: [
          { type: 'text', text: '①' },
          { type: 'inlineMath', attrs: { latex: 'x=1' } },
          { type: 'text', text: '；②' },
          { type: 'inlineMath', attrs: { latex: 'x=2' } },
          { type: 'text', text: '；③' },
          { type: 'inlineMath', attrs: { latex: 'x=3' } },
        ],
      } satisfies WordSourceBlock,
      block('a', '【答案】(1)①First result；②Second result；③Third result'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children[0].children).toEqual([]);
    expect(projected(sources, refs[0].children[0].question)).toContain('①\uFFFC；②\uFFFC；③\uFFFC');
    expect(projected(sources, refs[0].children[0].answer)).toContain('①First result');
  });

  it('keeps established separate circled tasks when a following paragraph continues their sequence', () => {
    const sources = [
      ...plainTasks(),
      math('inner1', 'x^2', '①Evaluate this expression and compare with ②:'),
      block('inner2', '②Evaluate the second expression:'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children[1].children.map((child) => child.sourceLabel)).toEqual(['①', '②']);
    expect(projected(sources, refs[0].children[1].children[0].question)).toContain(
      'Evaluate this expression',
    );
    expect(projected(sources, refs[0].children[1].question)).not.toContain(
      'Evaluate this expression',
    );
  });

  it('starts a known first math solution after an analysis introduction without dropping either range', () => {
    const sources = [
      ...plainTasks(),
      block('a', '【答案】(1) First result.  (2) Second result.'),
      block('intro', '【分析】A common introduction.'),
      math('first', '(1)', '', ' First proof.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[0].analysis)).toContain('First proof');
    expect(projected(sources, refs[0].children[1].analysis)).toContain('A common introduction');
  });

  it.each(['①+②', '①2②=3', '①2③3', '①由②可得', '①2②+3'])(
    'keeps operators, prose and skipped compact circled references intact: %s',
    (key) => {
      const sources = [...nestedTasks(), block('a', `【答案】(2)${key}`)];
      const refs = fastWordReferences(sources);
      expect(refs[0].children[1].children[1].answer).toEqual([]);
    },
  );

  it('does not loosen compact circled ownership inside analysis prose', () => {
    const sources = [
      ...nestedTasks(),
      block('a', '【答案】(2)①First'),
      math('analysis', 'x^2', '【详解】(2)①', '②1000'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].children[0].analysis)).toContain('②1000');
    expect(refs[0].children[1].children[1].analysis).toEqual([]);
  });

  it.each(['式代入后继续。', '+x', '=3'])(
    'does not route a standalone parenthesis atom before an equation reference: %s',
    (tail) => {
      const sources = [
        ...plainTasks(),
        block('analysis', '【详解】(1) First proof.'),
        math('formula', '\\left(2\\right)', '', tail),
      ];
      const refs = fastWordReferences(sources);
      expect(projected(sources, refs[0].children[0].analysis)).toContain(tail);
      expect(refs[0].children[1].analysis).toEqual([]);
    },
  );

  it('keeps a backward math reference in the established second solution', () => {
    const sources = [
      ...plainTasks(),
      block('analysis', '【详解】(2) Second proof.'),
      math('formula', '(1)', '', ' Refer to the first equation.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].analysis)).toContain(
      'Refer to the first equation',
    );
    expect(refs[0].children[0].analysis).toEqual([]);
  });

  it('keeps a backward root-child math reference in its established nested answer owner', () => {
    const sources = [
      ...nestedTasks(),
      block('a', '【答案】(2)①First answer.'),
      math('reference', '(1)', '', ' Ordinary explanation.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].children[0].answer)).toContain(
      'Ordinary explanation',
    );
    expect(refs[0].children[0].answer).toEqual([]);
  });

  it.each(['+', '＋', '－', '−'])(
    'keeps a %s expression after a solution prefix whole in its established owner',
    (operator) => {
      const expression = `解：(1)${operator}(2) gives the new conclusion.`;
      const sources = [
        ...plainTasks(),
        block('analysis', '【详解】(2)Second proof.'),
        block('reference', expression),
      ];
      const refs = fastWordReferences(sources);
      expect(projected(sources, refs[0].children[1].analysis)).toContain(expression);
      expect(refs[0].children[0].analysis).toEqual([]);
    },
  );

  it('keeps a plain appendix answer on its verified root despite a later root with matching children', () => {
    const sources = [
      block('first', '1．Plain task.'),
      block('second', '2．Material.'),
      block('task1', '(1) First task.'),
      block('task2', '(2) Second task.'),
      block('appendix', '参考答案'),
      math('a', '(1)', '1．', ' Solved result.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].answer)).toBe('\uFFFC Solved result.');
    expect(refs[1].children[0].answer).toEqual([]);
  });

  it.each(['+x', '{=3}', '\\times x'])(
    'keeps arithmetic split over adjacent math atoms with the established owner: %s',
    (tail) => {
      const sources = [
        ...plainTasks(),
        block('analysis', '【详解】(1) First proof.'),
        {
          id: 'formula',
          content: [
            { type: 'inlineMath', attrs: { latex: '(2)' } },
            { type: 'inlineMath', attrs: { latex: tail } },
          ],
        } satisfies WordSourceBlock,
      ];
      const refs = fastWordReferences(sources);
      expect(refs[0].children[0].analysis.some((ref) => ref.blockId === 'formula')).toBe(true);
      expect(refs[0].children[1].analysis).toEqual([]);
    },
  );

  it('keeps a compact circled equation with a following native operator in its owner', () => {
    const sources = [...nestedTasks(), math('a', '=3', '【答案】(2)①2②')];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[1].children[0].answer)).toBe('2②\uFFFC');
    expect(refs[0].children[1].children[1].answer).toEqual([]);
  });

  it.each(['(2)+x', '\\left(2\\right)+x', '①+②', 'x+②\\angle ABC', '②\\times x', '②{+x}'])(
    'keeps leading arithmetic/interior formula references with the established owner: %s',
    (latex) => {
      const sources = [
        ...nestedTasks(),
        block('a', '【答案】(2)① First result.'),
        math('formula', latex, '', ' Continuing explanation.'),
      ];
      const refs = fastWordReferences(sources);
      const inner = refs[0].children[1].children;
      expect(projected(sources, inner[0].answer)).toContain('Continuing explanation');
      expect(inner[1].answer).toEqual([]);
    },
  );

  it.each(['解：（2）Second explanation.', '  （2）Second explanation.'])(
    'routes a bounded leading solution key: %s',
    (key) => {
      const sources = [
        ...plainTasks(),
        block('a', '【答案】(1) First result.  (2) Second result.'),
        block('analysis', '【详解】(1) First explanation.'),
        block('second', key),
      ];
      const refs = fastWordReferences(sources);
      expect(projected(sources, refs[0].children[0].analysis)).not.toContain('Second explanation');
      expect(projected(sources, refs[0].children[1].analysis)).toContain('Second explanation');
    },
  );
});
