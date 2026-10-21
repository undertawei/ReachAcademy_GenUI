import { describe, expect, it } from 'vitest';
import type { QuizQuestionAnswer, RichTextNode } from '@reachany/reach-deck-dsl';
import wordbankLegacy from './fixtures/word-xueke-whole-wordbank-legacy.json';
import {
  fastWordReferences,
  isWordStructuralLabel,
  parseWordFast,
  parseWordSmartResponse,
  resolveWordQuestions,
  sourceText,
  type WordQuestionReference,
  type WordSourceBlock,
  type WordSourceRange,
} from '../src/word-import/index.js';

const b = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const rich = (nodes: RichTextNode[] = []): string =>
  nodes.map((node) => (node.content ? rich(node.content) : sourceText([node]))).join('');
const answerText = (answer: QuizQuestionAnswer) =>
  Array.isArray(answer) ? answer.join('') : rich(answer.content);
const projected = (blocks: WordSourceBlock[], refs: WordSourceRange[]) =>
  refs
    .map((r) => sourceText(blocks.find((v) => v.id === r.blockId)!.content).slice(r.start, r.end))
    .join('');
const smart = (blocks: WordSourceBlock[], question: WordQuestionReference) =>
  parseWordSmartResponse(
    JSON.stringify({ complete: true, questions: [question], unassignedBlockIds: [] }),
    blocks,
    'whole-regression',
  );
const fill = (
  markers: WordSourceRange[],
  question: WordSourceRange[] = [{ blockId: 'q' }],
): WordQuestionReference => ({
  questionType: 'fill_in_the_blank',
  question,
  answer: [],
  analysis: [],
  children: [],
  blanks: markers.map((marker) => ({ marker, answer: [{ blockId: 'a' }] })),
});

describe('XW-03 shared mandatory blank references', () => {
  it.each([false, true])('accepts whole parenthetical markers (underline=%s)', (underlined) => {
    const blocks: WordSourceBlock[] = [
      {
        id: 'q',
        content: [
          { type: 'text', text: '2×（' },
          {
            type: 'text',
            text: '   ',
            ...(underlined ? { marks: [{ type: 'underline' as const }] } : {}),
          },
          { type: 'text', text: '）=6。' },
        ],
      },
      b('a', '3'),
    ];
    const result = smart(blocks, fill([{ blockId: 'q', start: 2, end: 7 }]));
    expect(result.unresolvedItems ?? []).toEqual([]);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].blanks).toHaveLength(1);
    expect(answerText(result.questions[0].blanks![0].answer)).toBe('3');
    expect(rich(result.questions[0].question.content)).toBe('2×\uFFFC=6。');
  });

  it('accepts nonempty interior parenthetical markers', () => {
    const result = smart(
      [b('q', '2×（   ）=6。'), b('a', '3')],
      fill([{ blockId: 'q', start: 3, end: 6 }]),
    );
    expect(result.unresolvedItems ?? []).toEqual([]);
    expect(rich(result.questions[0].question.content)).toBe('2×（\uFFFC）=6。');
  });

  it.each(['括号（ ）用于____。', '解释print()时，输出内容为____。'])(
    'keeps literal parentheses in a smart fill: %s',
    (stem) => {
      const at = stem.indexOf('____');
      const result = smart(
        [b('q', stem), b('a', '说明')],
        fill([{ blockId: 'q', start: at, end: at + 4 }]),
      );
      expect(result.unresolvedItems ?? []).toEqual([]);
      expect(result.questions[0].blanks).toHaveLength(1);
      expect(rich(result.questions[0].question.content)).toBe(stem.replace('____', '\uFFFC'));
    },
  );

  it.each(['underline', 'numeric'])('rejects omitted mandatory %s markers', (kind) => {
    const blocks: WordSourceBlock[] = [
      {
        id: 'q',
        content: [
          { type: 'text', text: '值为____，再填' },
          { type: 'text', text: kind === 'numeric' ? '11' : '   ', marks: [{ type: 'underline' }] },
          { type: 'text', text: '。' },
        ],
      },
      b('a', '3'),
    ];
    const result = smart(blocks, fill([{ blockId: 'q', start: 2, end: 6 }]));
    expect(result.questions).toEqual([]);
    expect(result.unresolvedItems).toContainEqual(
      expect.objectContaining({ code: 'word-import.missing-blank-reference' }),
    );
  });

  it('does not let a wide range satisfy two separate mandatory markers', () => {
    const blocks = [b('q', '____与____'), b('a', '3')];
    const result = smart(blocks, fill([{ blockId: 'q', start: 0, end: 9 }]));
    expect(result.questions).toEqual([]);
    expect(result.unresolvedItems).toContainEqual(
      expect.objectContaining({ code: 'word-import.missing-blank-reference' }),
    );
  });

  it.each(['overlap', 'zero', 'outside'])('retains strict %s marker failure', (kind) => {
    const blocks = [b('q', '（   ）'), b('a', '3')];
    const markers =
      kind === 'overlap'
        ? [
            { blockId: 'q', start: 1, end: 4 },
            { blockId: 'q', start: 0, end: 5 },
          ]
        : kind === 'zero'
          ? [{ blockId: 'q', start: 1, end: 1 }]
          : [{ blockId: 'q', start: 0, end: 5 }];
    const result = smart(
      blocks,
      fill(markers, kind === 'outside' ? [{ blockId: 'q', start: 1, end: 4 }] : undefined),
    );
    expect(result.questions).toEqual([]);
    expect(result.unresolvedItems).toHaveLength(1);
  });

  it('retains fatal out-of-range and unknown-block failures', () => {
    const blocks = [b('q', '（   ）'), b('a', '3')];
    expect(() => smart(blocks, fill([{ blockId: 'q', start: 0, end: 99 }]))).toThrow(
      'word-import.invalid-range',
    );
    expect(() => smart(blocks, fill([{ blockId: 'missing', start: 0, end: 1 }]))).toThrow(
      'word-import.unknown-block',
    );
  });

  it('keeps exact references required for underscore blanks inside parentheses', () => {
    const result = smart(
      [b('q', '（____）'), b('a', '3')],
      fill([{ blockId: 'q', start: 0, end: 6 }]),
    );
    expect(result.questions).toEqual([]);
    expect(result.unresolvedItems).toContainEqual(
      expect.objectContaining({ code: 'word-import.missing-blank-reference' }),
    );
  });
});

const options = (native: boolean): WordSourceBlock[] =>
  native
    ? ['甲', '乙'].map((text, index) => ({
        ...b(`o${index}`, text),
        numbering: {
          level: 1,
          label: `${String.fromCharCode(65 + index)}.`,
          format: 'upperLetter' as const,
        },
      }))
    : [b('o0', 'A．甲'), b('o1', 'B．乙')];

describe('XW-05 native option inference agrees with textual options', () => {
  it.each([false, true])('infers a choice and clears parentheses blanks (native=%s)', (native) => {
    const blocks = [b('q', '1．正确的是( )'), ...options(native), b('a', '【答案】B')];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('single_choice');
    expect(reference.blanks).toBeUndefined();
    expect(reference.options?.map((o) => projected(blocks, o.label))).toEqual(['甲', '乙']);
    expect(projected(blocks, reference.answer)).toBe('B');
    const candidate = parseWordFast(blocks, 'native-option').questions[0];
    expect(candidate.question_type).toBe('single_choice');
    expect(candidate.blanks ?? []).toEqual([]);
    expect(candidate.answer).toEqual(['B']);
    expect(rich(candidate.question.content)).toBe('正确的是( )');
  });

  it('produces the same complete resolved candidate for native and textual options', () => {
    const candidates = [false, true].map((native) => {
      const blocks = [b('q', '1．正确的是( )'), ...options(native), b('a', '【答案】B')];
      return parseWordFast(blocks, 'same-options').questions.map((q) => ({
        ...q,
        options: q.options?.map((option) =>
          Object.fromEntries(Object.entries(option).filter(([key]) => key !== 'wordImportItemId')),
        ),
      }));
    });
    expect(candidates[0]).toEqual(candidates[1]);
  });

  it('handles a level-zero numbered option pool continuation', () => {
    const blocks: WordSourceBlock[] = [
      b('q', '1．正确的是( )'),
      { ...b('o', 'A．甲　B．乙'), numbering: { level: 0, label: '2.', format: 'decimal' } },
      b('a', '【答案】B'),
    ];
    const [reference] = fastWordReferences(blocks);
    expect(fastWordReferences(blocks)).toHaveLength(1);
    expect(reference.questionType).toBe('single_choice');
    expect(reference.blanks).toBeUndefined();
    expect(reference.options).toHaveLength(2);
    expect(parseWordFast(blocks, 'level-zero').questions[0].answer).toEqual(['B']);
  });

  it.each([false, true])('protects an explicit shared word bank (native=%s)', (native) => {
    const blocks = [
      b('section', '一、选词填空'),
      b('q', '1．用所给词语填空：( )。'),
      ...options(native),
      b('a', '【答案】A'),
    ];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('fill_with_candidates');
    expect(reference.blanks).toHaveLength(1);
    expect(reference.options).toHaveLength(2);
    const candidate = parseWordFast(blocks, 'bank').questions[0];
    expect(candidate.question_type).toBe('fill_with_candidates');
    expect(candidate.blanks).toHaveLength(1);
    expect(candidate.blanks![0].answer).toEqual(['A']);
  });

  it.each([false, true])(
    'does not upgrade an inferred word bank to single choice (native=%s)',
    (native) => {
      const blocks = [b('q', '1．用所给词语填空：( )。'), ...options(native), b('a', '【答案】A')];
      const [reference] = fastWordReferences(blocks);
      expect(reference.questionType).toBe('fill_in_the_blank');
      expect(reference.blanks).toHaveLength(1);
    },
  );

  it.each([false, true])('protects explicit fill declarations (native=%s)', (native) => {
    const blocks = [
      b('section', '一、填空题'),
      b('q', '1．填写正确内容：( )。'),
      ...options(native),
      b('a', '【答案】甲'),
    ];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('fill_in_the_blank');
    expect(reference.blanks).toHaveLength(1);
  });
});

describe('XW-07 literal and judgment parentheses', () => {
  it.each([
    ['括号（ ）在文中起什么作用？', '补充说明。'],
    ['说说括号（）的用法。', '表示注释。'],
    ['解释 print() 函数的作用。', '输出文本。'],
    ['已知函数f()满足f(x)=2x，求f(1)。', '2'],
    ['调用 print() 后描述输出。', '输出文本。'],
    ['“（ ）”在文中起什么作用？', '补充说明。'],
    ['符号（ ）是什么意思？', '表示注释。'],
  ])('preserves a short answer containing literal parentheses: %s', (stem, answer) => {
    const blocks = [b('q', `1．${stem}`), b('a', `【答案】${answer}`)];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('short_answer');
    expect(reference.blanks).toBeUndefined();
    expect(projected(blocks, reference.question)).toBe(stem);
    const candidate = parseWordFast(blocks, 'literal').questions[0];
    expect(candidate.question_type).toBe('short_answer');
    expect(rich(candidate.question.content)).toBe(stem);
    expect(answerText(candidate.answer)).toBe(answer);
  });

  it.each(['( )', '（\u00a0\u00a0）', '()'])(
    'preserves a judgment answer and source parentheses: %s',
    (marker) => {
      const stem = `地球绕着太阳转。${marker}`;
      const blocks = [b('q', `1．${stem}`), b('a', '【答案】√')];
      const candidate = parseWordFast(blocks, 'judgment').questions[0];
      expect(candidate.question_type).toBe('short_answer');
      expect(candidate.blanks ?? []).toEqual([]);
      expect(rich(candidate.question.content)).toBe(stem);
      expect(answerText(candidate.answer)).toBe('√');
      expect(candidate.has_answer).toBe(true);
    },
  );

  it.each([
    '2×( )=6。',
    '地球绕（ ）旋转。',
    '填入参数：sin( )=0。',
    '填空：a( )=6。',
    '把数字填入“（ ）”。',
    '3（ ）5。',
  ])('preserves a genuine parenthetical fill: %s', (stem) => {
    const blocks = [b('q', `1．${stem}`), b('a', '【答案】3')];
    const candidate = parseWordFast(blocks, 'actual-fill').questions[0];
    expect(candidate.question_type).toBe('fill_in_the_blank');
    expect(candidate.blanks).toHaveLength(1);
  });

  it('keeps an explicitly declared parenthetical fill with a judgment-symbol answer', () => {
    const blocks = [
      b('section', '一、填空题'),
      b('q', '1．表示正确的符号是( )。'),
      b('a', '【答案】√'),
    ];
    expect(parseWordFast(blocks, 'explicit-fill').questions[0].question_type).toBe(
      'fill_in_the_blank',
    );
  });

  it('keeps a genuine underline alongside a judgment-symbol answer', () => {
    const blocks = [b('q', '1．符号____与( )各有什么含义？'), b('a', '【答案】√')];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('fill_in_the_blank');
    expect(reference.blanks).toHaveLength(2);
  });

  it('keeps a nonterminal parenthetical fill with a judgment-symbol answer', () => {
    const blocks = [b('q', '1．( )表示错误。'), b('a', '【答案】×')];
    expect(parseWordFast(blocks, 'nonterminal').questions[0].question_type).toBe(
      'fill_in_the_blank',
    );
  });

  it.each(['T', 'F'])('does not treat %s as a judgment override', (answer) => {
    const blocks = [b('q', '1．The letter is ( ).'), b('a', `【答案】${answer}`)];
    expect(parseWordFast(blocks, 'letter').questions[0].question_type).toBe('fill_in_the_blank');
  });

  it('keeps real underline filling in mixed literal-symbol questions', () => {
    const blocks = [b('q', '1．括号（ ）在文中起____作用。'), b('a', '【答案】补充说明')];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('fill_in_the_blank');
    expect(reference.blanks).toHaveLength(1);
    const candidate = resolveWordQuestions(blocks, [reference], 'mixed').questions[0];
    expect(rich(candidate.question.content)).toBe('括号（ ）在文中起\uFFFC作用。');
  });

  it('limits function-call exclusions to their local source context', () => {
    const blocks = [b('q', '1．解释print()函数，填入参数使sin( )=0。'), b('a', '【答案】0')];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('fill_in_the_blank');
    expect(reference.blanks).toHaveLength(1);
    expect(projected(blocks, [reference.blanks![0].marker])).toBe(' ');
    expect(reference.blanks![0].marker.start).toBe(
      sourceText(blocks[0].content).indexOf('sin( ') + 4,
    );
  });
});

describe('XW-07 local explicit call evidence', () => {
  it('retains parameter filling after a locally identified function call', () => {
    const blocks = [b('q', '1．调用print()后，填入参数使sin( )=0。'), b('a', '【答案】0')];
    const [reference] = fastWordReferences(blocks);
    expect(reference.questionType).toBe('fill_in_the_blank');
    expect(reference.blanks).toHaveLength(1);
    expect(reference.blanks![0].marker.start).toBe(
      sourceText(blocks[0].content).indexOf('sin( ') + 4,
    );
  });
});

const image = (id: string): WordSourceBlock => ({
  id,
  content: [{ type: 'image', attrs: { sourceMediaId: id } }],
});
const owners = (blocks: WordSourceBlock[], id: string) => {
  const result: Array<{ path: string; field: string }> = [];
  const visit = (q: WordQuestionReference, path: string) => {
    for (const field of ['question', 'answer', 'analysis'] as const)
      if (q[field].some((r) => r.blockId === id)) result.push({ path, field });
    q.children.forEach((child, i) => visit(child, `${path}/${i + 1}`));
  };
  fastWordReferences(blocks).forEach((q, i) => visit(q, `${i + 1}`));
  return result;
};

describe('XW-01 bounded textual children after analysis', () => {
  it.each(['short_answer', 'fill_in_the_blank', 'single_choice'])(
    'keeps each child own source fields: %s',
    (kind) => {
      const blocks = [
        b('q', '1．完成以下问题。'),
        b('c1', kind === 'fill_in_the_blank' ? '(1)太阳从____升起。' : '(1)太阳从哪里升起？'),
        ...(kind === 'single_choice' ? [b('o1', 'A．东方　B．西方')] : []),
        b('a1', kind === 'single_choice' ? '【答案】A' : '【答案】东方'),
        b('n1', '【解析】地球自西向东自转。'),
        b('c2', kind === 'fill_in_the_blank' ? '(2)太阳从____落下。' : '(2)下图箭头表示哪个方向？'),
        image('diagram'),
        ...(kind === 'single_choice' ? [b('o2', 'A．东方　B．西方')] : []),
        b('a2', kind === 'single_choice' ? '【答案】B' : '【答案】西方'),
        b('n2', '【解析】箭头指向日落方向。'),
      ];
      const [root] = fastWordReferences(blocks);
      expect(root.children).toHaveLength(2);
      expect(root.children.map((q) => q.questionType)).toEqual([kind, kind]);
      expect(root.children.map((q) => projected(blocks, q.answer))).toEqual(
        kind === 'single_choice' ? ['A', 'B'] : ['东方', '西方'],
      );
      expect(root.children.map((q) => projected(blocks, q.analysis))).toEqual([
        '地球自西向东自转。',
        '箭头指向日落方向。',
      ]);
      expect(owners(blocks, 'diagram')).toEqual([{ path: '1/2', field: 'question' }]);
      expect(owners(blocks, 'c2')).toEqual([{ path: '1/2', field: 'question' }]);
      const preview = parseWordFast(blocks, `child-${kind}`);
      expect(preview.questions[0].sub_problems).toHaveLength(2);
      expect(preview.unresolvedItems ?? []).toEqual([]);
    },
  );

  it.each(['no-key', 'later-root-key', 'empty-key', 'repeated-conclusion'])(
    'keeps explanation enumeration without independent task evidence: %s',
    (kind) => {
      const blocks = [
        b('q', '1．计算以下式子。'),
        b('c1', '(1)计算第一式。'),
        b('a1', '【答案】3'),
        b('n1', '【解析】先计算第一步。'),
        b('step', '(2)然后计算第二步。'),
        ...(kind === 'empty-key' ? [b('empty', '【答案】')] : []),
        ...(kind === 'repeated-conclusion' ? [b('restatement', '【答案】3')] : []),
        ...(kind === 'later-root-key' ? [b('q2', '2．求另一式的值。'), b('a2', '【答案】5')] : []),
      ];
      const root = fastWordReferences(blocks)[0];
      expect(root.children).toHaveLength(1);
      expect(owners(blocks, 'step')).toEqual([{ path: '1/1', field: 'analysis' }]);
      expect(projected(blocks, root.children[0].analysis)).toContain('(2)然后计算第二步。');
    },
  );

  it('keeps nested child ownership after its own analysis', () => {
    const blocks = [
      b('q', '1．解释以下现象。'),
      b('c1', '(1)解释第一类现象。'),
      b('g1', '①为什么出现彩虹？'),
      b('a1', '【答案】光的折射。'),
      b('n1', '【解析】水滴折射光线。'),
      b('g2', '②为什么出现倒影？'),
      image('reflection'),
      b('a2', '【答案】光的反射。'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].children).toHaveLength(2);
    expect(owners(blocks, 'reflection')).toEqual([{ path: '1/1/2', field: 'question' }]);
    expect(root.children[0].children.map((q) => projected(blocks, q.answer))).toEqual([
      '光的折射。',
      '光的反射。',
    ]);
  });
});

describe('XW-02 inline numbered statements require task evidence', () => {
  it.each(['root', 'continuation', 'declared', 'english'])(
    'keeps choice statements as one question: %s',
    (kind) => {
      const statement = kind === 'english' ? '(1) 1+1=2;(2) 2+2=5.' : '(1) 1+1=2；(2) 2+2=5。';
      const prompt =
        kind === 'english' ? 'Which statements are true?  ' : '下列说法正确的是（ ）  ';
      const blocks = [
        ...(kind === 'declared' ? [b('section', '一、单项选择题')] : []),
        b('q', `1．${prompt}${kind === 'continuation' ? '' : statement}`),
        ...(kind === 'continuation' ? [b('statements', statement)] : []),
        b('o', 'A．只有(1)  B．只有(2)  C．都正确  D．都错误'),
        b('a', '【答案】A'),
      ];
      const [root] = fastWordReferences(blocks);
      expect(root.children).toEqual([]);
      expect(root.questionType).toBe('single_choice');
      expect(projected(blocks, root.question)).toContain(statement);
      expect(projected(blocks, root.answer)).toBe('A');
      expect(root.options).toHaveLength(4);
      expect(parseWordFast(blocks, 'statements').questions[0].answer).toEqual(['A']);
    },
  );

  it.each(['root', 'continuation'])('keeps proof premises in their owning question: %s', (kind) => {
    const premises = '(1) a=b；(2) b=c。证明a=c。';
    const blocks = [
      b('q', `1．已知两个条件：  ${kind === 'root' ? premises : ''}`),
      ...(kind === 'continuation' ? [b('premises', premises)] : []),
      b('a', '【答案】由等式的传递性可知a=c。'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toEqual([]);
    expect(projected(blocks, root.question)).toContain(premises);
    expect(projected(blocks, root.answer)).toBe('由等式的传递性可知a=c。');
  });

  it.each(['root', 'continuation'])(
    'preserves source-keyed genuine inline calculations: %s',
    (kind) => {
      const tasks = '(1) 2+3=____；(2) 6÷2=____。';
      const blocks = [
        b('q', `1．计算：  ${kind === 'root' ? tasks : ''}`),
        ...(kind === 'continuation' ? [b('tasks', tasks)] : []),
        b('a', '【答案】(1)5  (2)3'),
      ];
      const [root] = fastWordReferences(blocks);
      expect(root.children).toHaveLength(2);
      expect(root.children.map((q) => projected(blocks, q.answer))).toEqual(['5  ', '3']);
      expect(root.children.map((q) => q.blanks?.length)).toEqual([1, 1]);
    },
  );
});

describe('XW-08 independently evidenced combined root answer keys', () => {
  it.each(['two-roots', 'three-roots', 'restart', 'numeric'])(
    'retains current answer enumeration: %s',
    (kind) => {
      const answer = kind === 'numeric' ? '1．12  2．34' : '1．节约用水  2．减少塑料';
      const blocks = [
        ...(kind === 'three-roots' ? [b('unrelated', '8．写一篇短文。')] : []),
        ...(kind === 'restart'
          ? [b('old', '1．描述一次旅行。'), b('old-a', '【答案】略。'), b('section', '二、简答题')]
          : []),
        b('q1', '1．写一篇描写春天的作文。'),
        b('q2', '2．请写出两项保护环境的建议。'),
        b('a', `【答案】${answer}`),
      ];
      const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
      const roots = fastWordReferences(blocks, diagnostics);
      const latest = roots.at(-1)!;
      expect(projected(blocks, latest.answer)).toBe(answer);
      expect(roots.at(-2)!.answer).toEqual([]);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: 'word-import.check-question-boundary', blockId: 'a' }),
      );
      expect(owners(blocks, 'a')).toEqual([{ path: String(roots.length), field: 'answer' }]);
    },
  );

  it('preserves higher-numbered combined keys corroborated by independent analyses', () => {
    const blocks = [
      b('q1', '9．解释第一个词语。'),
      b('q2', '10．解释第二个词语。'),
      b('a', '【答案】9．安静。    10．快乐。'),
      b('n1', '【详解】9．第一个词语描述声音。'),
      b('n2', '10．第二个词语描述心情。'),
    ];
    const roots = fastWordReferences(blocks);
    expect(roots.map((q) => projected(blocks, q.answer).trim())).toEqual(['安静。', '快乐。']);
    expect(owners(blocks, 'n1')).toEqual([{ path: '1', field: 'analysis' }]);
    expect(owners(blocks, 'n2')).toEqual([{ path: '2', field: 'analysis' }]);
  });

  it('preserves combined keys starting at one with independent per-root blank contracts', () => {
    const blocks = [
      b('section', '一、填空题'),
      b('q1', '1．太阳从____升起。'),
      b('q2', '2．太阳从____落下。'),
      b('a', '【答案】1．东方    2．西方'),
      b('n1', '【详解】1．日出在东方。'),
      b('n2', '2．日落在西方。'),
    ];
    const roots = fastWordReferences(blocks);
    expect(roots.map((question) => projected(blocks, question.answer).trim())).toEqual([
      '东方',
      '西方',
    ]);
    expect(roots.map((question) => projected(blocks, question.blanks![0].answer).trim())).toEqual([
      '东方',
      '西方',
    ]);
  });

  it('preserves explicit appendix key ownership', () => {
    const blocks = [
      b('q1', '1．写一篇短文。'),
      b('q2', '2．说明理由。'),
      b('appendix', '参考答案'),
      b('a1', '1．示例短文。'),
      b('a2', '2．因为阳光充足。'),
    ];
    expect(fastWordReferences(blocks).map((q) => projected(blocks, q.answer))).toEqual([
      '示例短文。',
      '因为阳光充足。',
    ]);
  });
});

describe('XW-09 ambiguity diagnostics advance without creating roots', () => {
  it('warns for every label in an ambiguous ASCII chain', () => {
    const blocks = [
      b('q1', '1.计算：3+4='),
      b('q2', '2.12的因数有哪些？'),
      b('q3', '3.5个5相加是多少？'),
    ];
    const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
    const roots = fastWordReferences(blocks, diagnostics);
    expect(roots).toHaveLength(1);
    expect(projected(blocks, roots[0].question)).toBe(
      '计算：3+4=2.12的因数有哪些？3.5个5相加是多少？',
    );
    expect(
      diagnostics
        .filter((d) => d.code === 'word-import.check-question-boundary')
        .map((d) => d.blockId),
    ).toEqual(['q2', 'q3']);
  });

  it('bounds the diagnostic chain at real roots and sections', () => {
    const blocks = [
      b('q1', '1.计算：3+4='),
      b('q2', '2.12的因数有哪些？'),
      b('q3', '3.5个5相加是多少？'),
      b('real', '4．计算20÷4。'),
      b('section', '二、填空题'),
      b('new', '1．填写____。'),
      b('decimal', '3.5米长的绳子。'),
    ];
    const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
    const roots = fastWordReferences(blocks, diagnostics);
    expect(roots.map((q) => q.sourceLabel)).toEqual(['1', '4', '1']);
    expect(
      diagnostics
        .filter((d) => d.code === 'word-import.check-question-boundary')
        .map((d) => d.blockId),
    ).toEqual(['q2', 'q3']);
  });

  it('keeps actual decimal calculations as source continuation', () => {
    const blocks = [
      b('q', '1．计算以下式子。'),
      b('decimal', '2.625×80=210'),
      b('a', '【答案】210'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.sourceLabel).toBe('1');
    expect(root.children).toEqual([]);
    expect(projected(blocks, root.question)).toBe('计算以下式子。2.625×80=210');
    expect(projected(blocks, root.answer)).toBe('210');
  });
});

describe('XW-01 independent answer competition controls', () => {
  it.each([
    '说明光合作用与呼吸作用的区别。',
    '请说明光合作用与呼吸作用的区别。',
    '分析光合作用对生态系统的作用。',
    '简述植物呼吸作用的过程。',
    'Explain the difference between the two processes.',
    'Please explain the difference between the two processes.',
    '说出光合作用与呼吸作用的区别。',
    '概括植物呼吸作用的过程。',
    'Describe the difference between the two processes.',
  ])('keeps an independently keyed imperative task after analysis: %s', (stem) => {
    const blocks = [
      b('q', '1．回答以下问题。'),
      b('c1', '(1)什么是光合作用？'),
      b('a1', '【答案】植物利用光能合成有机物。'),
      b('n1', '【解析】本题考查光合作用的概念。'),
      b('c2', `(2)${stem}`),
      b('a2', '【答案】光合作用制造有机物，呼吸作用分解有机物。'),
      b('n2', '【解析】两种过程的物质与能量变化不同。'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toHaveLength(2);
    expect(root.children.map((child) => child.questionType)).toEqual([
      'short_answer',
      'short_answer',
    ]);
    expect(projected(blocks, root.children[0].answer)).toBe('植物利用光能合成有机物。');
    expect(projected(blocks, root.children[0].analysis)).toBe('本题考查光合作用的概念。');
    expect(projected(blocks, root.children[1].question)).toBe(stem);
    expect(projected(blocks, root.children[1].answer)).toBe(
      '光合作用制造有机物，呼吸作用分解有机物。',
    );
    expect(projected(blocks, root.children[1].analysis)).toBe('两种过程的物质与能量变化不同。');
  });

  it.each([
    '说明了植物利用光能合成有机物。',
    '分析表明植物利用光能合成有机物。',
    '分析可得植物利用光能合成有机物。',
    '简述如下：植物利用光能合成有机物。',
    '然后说明光合作用的过程。',
    'Then explain how the plant uses light.',
  ])('keeps explanatory or narrative wording despite a repeated key: %s', (stem) => {
    const blocks = [
      b('q', '1．回答以下问题。'),
      b('c1', '(1)什么是光合作用？'),
      b('a1', '【答案】植物利用光能合成有机物。'),
      b('n1', '【解析】本题考查光合作用的概念。'),
      b('step', `(2)${stem}`),
      b('restatement', '【答案】植物利用光能合成有机物。'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toHaveLength(1);
    expect(owners(blocks, 'step')).toEqual([{ path: '1/1', field: 'analysis' }]);
  });

  it('diagnoses an unfamiliar independently keyed prompt instead of silently merging it', () => {
    const blocks = [
      b('q', '1．回答以下问题。'),
      b('c1', '(1)什么是光合作用？'),
      b('a1', '【答案】植物利用光能合成有机物。'),
      b('n1', '【解析】本题考查光合作用的概念。'),
      b('candidate', '(2)论证光合作用对生态系统的价值。'),
      b('a2', '【答案】为生态系统提供物质与能量。'),
    ];
    const preview = parseWordFast(blocks, 'unfamiliar-imperative');
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'word-import.check-question-boundary',
        blockId: 'candidate',
      }),
    );
  });

  it.each([
    ['然后回答：图中是什么？', '地球'],
    ['接着填空：地球绕____旋转。', '太阳'],
  ])('lets direct task evidence outrank a sequencing word: %s', (stem, answer) => {
    const blocks = [
      b('q', '1．回答以下问题。'),
      b('c1', '(1)解释第一种现象。'),
      b('a1', '【答案】东方'),
      b('n1', '【解析】地球自西向东自转。'),
      b('c2', `(2)${stem}`),
      b('a2', `【答案】${answer}`),
      b('n2', '【解析】依据图示回答。'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toHaveLength(2);
    expect(projected(blocks, root.children[1].question)).toBe(stem);
    expect(projected(blocks, root.children[1].answer)).toBe(answer);
    expect(projected(blocks, root.children[1].analysis)).toBe('依据图示回答。');
  });
  it.each(['求得x=2。', '根据上式，x=2。'])(
    'keeps completed mathematical conclusions in analysis: %s',
    (conclusion) => {
      const blocks = [
        b('q', '1．回答以下问题。'),
        b('c1', '(1)求x的值。'),
        b('a1', '【答案】2'),
        b('n1', '【解析】化简方程。'),
        b('conclusion', `(2)${conclusion}【答案】2`),
      ];
      const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
      const [root] = fastWordReferences(blocks, diagnostics);
      expect(root.children).toHaveLength(1);
      expect(projected(blocks, root.children[0].analysis)).toContain(conclusion);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'word-import.check-question-boundary',
          blockId: 'conclusion',
        }),
      );
    },
  );
  it.each(['(3)解释第三种现象？', '(1)解释另一类现象？', '2．解释第三种现象？'])(
    'rejects a same-block competing label before the formal key: %s',
    (competitor) => {
      const blocks = [
        b('q', '1．回答以下问题。'),
        b('c1', '(1)解释第一种现象？'),
        b('a1', '【答案】东方'),
        b('n1', '【解析】第一种现象与地球自转有关。'),
        b('candidate', `(2)解释第二种现象？ ${competitor}【答案】西方`),
      ];
      const [root] = fastWordReferences(blocks);
      expect(root.children).toHaveLength(1);
      expect(owners(blocks, 'candidate').some((owner) => owner.field === 'question')).toBe(false);
      expect(projected(blocks, root.children[0].analysis)).toContain('(2)解释第二种现象？');
    },
  );

  it('permits the candidate own formal key in the same block', () => {
    const blocks = [
      b('q', '1．回答以下问题。'),
      b('c1', '(1)解释第一种现象？'),
      b('a1', '【答案】东方'),
      b('n1', '【解析】第一种现象与地球自转有关。'),
      b('candidate', '(2)解释第二种现象？【答案】西方【解析】第二种现象与日落有关。'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toHaveLength(2);
    expect(projected(blocks, root.children[1].question)).toBe('解释第二种现象？');
    expect(projected(blocks, root.children[1].answer)).toBe('西方');
    expect(projected(blocks, root.children[1].analysis)).toBe('第二种现象与日落有关。');
  });
  it('permits native letter options before a new child own answer', () => {
    const blocks = [
      b('q', '1．回答以下问题。'),
      b('c1', '(1)解释第一个词。'),
      b('a1', '【答案】安静。'),
      b('n1', '【解析】这是声音的描写。'),
      b('c2', '(2)选出正确的一项。'),
      ...options(true),
      b('a2', '【答案】B'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toHaveLength(2);
    expect(root.children[1].questionType).toBe('single_choice');
    expect(root.children[1].options).toHaveLength(2);
    expect(projected(blocks, root.children[1].answer)).toBe('B');
  });

  it.each(['next-sibling', 'analysis-restart'])(
    'does not borrow a formal answer across %s',
    (kind) => {
      const blocks = [
        b('q', '1．回答以下问题。'),
        b('c1', '(1)说明第一个现象。'),
        b('a1', '【答案】折射。'),
        b('n1', '【解析】水滴改变光线方向。'),
        b('candidate', '(2)说明第二个现象。'),
        ...(kind === 'next-sibling'
          ? [b('next', '(3)说明第三个现象。')]
          : [b('restart', '【解析】进一步说明第二个步骤。')]),
        b('a3', '【答案】反射。'),
      ];
      const [root] = fastWordReferences(blocks);
      expect(root.children).toHaveLength(1);
      expect(owners(blocks, 'candidate')).toEqual([{ path: '1/1', field: 'analysis' }]);
    },
  );
});

describe('XW-02 local declared choice guards', () => {
  it.each(wordbankLegacy.cases)(
    'preserves exact 8e word-bank references and full preview (explicit=$explicit)',
    (legacy) => {
      const sources = legacy.sources as WordSourceBlock[];
      expect(JSON.parse(JSON.stringify(fastWordReferences(sources)))).toEqual(legacy.references);
      expect(JSON.parse(JSON.stringify(parseWordFast(sources, 'wordbank-legacy')))).toEqual(
        legacy.preview,
      );
    },
  );
  it.each([false, true])('retains a same-block choice and own source key (native=%s)', (native) => {
    const blocks: WordSourceBlock[] = [
      {
        ...b(
          'q',
          `${native ? '' : '1．'}选出正确的一项：  (1)2+3=____；(2)6÷2=____。 A．5和3　B．6和4【答案】A`,
        ),
        ...(native ? { numbering: { level: 0, label: '1.', format: 'decimal' } } : {}),
      },
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toEqual([]);
    expect(root.questionType).toBe('single_choice');
    expect(root.options?.map((option) => projected(blocks, option.label).trim())).toEqual([
      '5和3',
      '6和4',
    ]);
    expect(projected(blocks, root.answer)).toBe('A');
    expect(parseWordFast(blocks, 'same-block-choice').questions[0].answer).toEqual(['A']);
  });
  it('protects a locally declared single choice with task-shaped statements', () => {
    const blocks = [
      b('q', '1．(单选)选出正确的一项：  (1)2+3=____；(2)6÷2=____。'),
      b('o', 'A．5和3　B．6和4'),
      b('a', '【答案】A'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toEqual([]);
    expect(root.questionType).toBe('single_choice');
    expect(projected(blocks, root.answer)).toBe('A');
  });
  it('protects inferred choice statements with native Word options', () => {
    const blocks = [
      b('q', '1．选出正确的一项：  (1)2+3=____；(2)6÷2=____。'),
      ...options(true),
      b('a', '【答案】A'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.children).toEqual([]);
    expect(root.questionType).toBe('single_choice');
    expect(root.options).toHaveLength(2);
  });
});

describe('XW-08 bounded independent key proof controls', () => {
  it('keeps a current answer and its enumerated analysis away from an unrelated root', () => {
    const blocks = [
      b('q1', '1．请以“我的家乡”为题写一篇短文。'),
      b('q2', '2．谈谈你对环保的看法。'),
      b('a2', '【答案】1．节约用水  2．减少塑料'),
      b('n2', '【解析】1．节约用水可以保护水资源。'),
      b('n2b', '2．减少塑料可以减少污染。'),
    ];
    const [first, second] = fastWordReferences(blocks);
    expect(first.answer).toEqual([]);
    expect(first.analysis).toEqual([]);
    expect(projected(blocks, second.answer)).toBe('1．节约用水  2．减少塑料');
    expect(projected(blocks, second.analysis)).toBe(
      '1．节约用水可以保护水资源。2．减少塑料可以减少污染。',
    );
    expect(parseWordFast(blocks, 'current-enumerated-answer').diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.check-question-boundary', blockId: 'a2' }),
    );
  });
  it.each(['higher-labels', 'unrelated-later-analysis', 'wrong-order', 'empty-analysis'])(
    'keeps bare or mismatched prose keys intact: %s',
    (kind) => {
      const labels = kind === 'higher-labels' ? [9, 10] : [1, 2];
      const answer = `${labels[0]}．节约用水    ${labels[1]}．减少塑料`;
      const blocks = [
        b('q1', `${labels[0]}．写一篇短文。`),
        b('q2', `${labels[1]}．提出两条建议。`),
        b('a', `【答案】${answer}`),
        ...(kind === 'unrelated-later-analysis'
          ? [
              b('next', '3．解释原因。'),
              b('next-a', '【答案】阳光充足。'),
              b('n1', '【详解】1．先说第一个原因。'),
              b('n2', '2．再说第二个原因。'),
            ]
          : []),
        ...(kind === 'wrong-order'
          ? [b('n1', '【详解】2．第二项建议。'), b('n2', '1．第一项建议。')]
          : []),
        ...(kind === 'empty-analysis' ? [b('n1', '【详解】1．'), b('n2', '2．第二项建议。')] : []),
      ];
      const roots = fastWordReferences(blocks);
      expect(roots[0].answer).toEqual([]);
      expect(projected(blocks, roots[1].answer)).toBe(answer);
    },
  );

  it('corroborates restarted labels only within their current section', () => {
    const blocks = [
      b('old', '9．解释一个词。'),
      b('old-a', '【答案】宁静。'),
      b('section', '二、简答题'),
      b('q1', '9．解释第一个词。'),
      b('q2', '10．解释第二个词。'),
      b('a', '【答案】9．快乐。    10．安静。'),
      b('n1', '【详解】9．第一个词描述心情。'),
      b('n2', '10．第二个词描述声音。'),
    ];
    expect(fastWordReferences(blocks).map((q) => projected(blocks, q.answer).trim())).toEqual([
      '宁静。',
      '快乐。',
      '安静。',
    ]);
  });
});

describe('XW-04 bounded mathematical headings', () => {
  it.each(['四、计算题：（说明', '四、计算题：直接写出得数。）'])(
    'preserves malformed heading tails as source: %s',
    (heading) => {
      const blocks = [b('q', '1．解释方法。'), b('a', '【答案】说明。'), b('tail', heading)];
      const reference: WordQuestionReference = {
        questionType: 'short_answer',
        question: [{ blockId: 'q' }],
        answer: [{ blockId: 'a', start: 4 }],
        analysis: [],
        children: [],
      };
      expect(isWordStructuralLabel(heading)).toBe(false);
      expect(owners(blocks, 'tail')).toEqual([{ path: '1', field: 'answer' }]);
      expect(() => smart(blocks, reference)).toThrow('word-import.unaccounted-source');
    },
  );

  it.each(['四 、计算题', '四）计算题', '四 ) 判断题'])(
    'preserves legacy section separators in fast and smart coverage: %s',
    (heading) => {
      const blocks = [b('section', heading), b('q', '1．解释方法。'), b('a', '说明。')];
      const reference: WordQuestionReference = {
        questionType: 'short_answer',
        question: [{ blockId: 'q' }],
        answer: [{ blockId: 'a' }],
        analysis: [],
        children: [],
      };
      expect(isWordStructuralLabel(heading)).toBe(true);
      expect(owners(blocks, 'section')).toEqual([]);
      expect(smart(blocks, reference).unresolvedItems ?? []).toEqual([]);
    },
  );

  it('preserves a native decimal level-zero section with a standard instruction', () => {
    const blocks: WordSourceBlock[] = [
      b('q1', '1．解释方法。'),
      b('a1', '【答案】先列式。'),
      {
        ...b('section', '计算题：直接写出得数。'),
        numbering: { level: 0, label: '1.', format: 'decimal' },
      },
      b('q2', '2．计算3+4。'),
      b('a2', '【答案】7'),
    ];
    expect(isWordStructuralLabel(sourceText(blocks[2].content), blocks[2].numbering)).toBe(true);
    expect(owners(blocks, 'section')).toEqual([]);
    expect(fastWordReferences(blocks)).toHaveLength(2);
    expect(projected(blocks, fastWordReferences(blocks)[0].answer)).toBe('先列式。');
  });

  it.each(['1.', '二、'])(
    'retains a native level-one standard instruction as task text (label=%s)',
    (label) => {
      const blocks: WordSourceBlock[] = [
        {
          ...b('q', '计算题：直接写出得数。'),
          numbering: {
            level: 1,
            label,
            format: label === '1.' ? 'decimal' : 'chineseCounting',
          },
        },
        b('a', '【答案】7'),
      ];
      const roots = fastWordReferences(blocks);
      expect(roots).toHaveLength(1);
      expect(projected(blocks, roots[0].question)).toBe('计算题：直接写出得数。');
      expect(projected(blocks, roots[0].answer)).toBe('7');
      expect(isWordStructuralLabel(sourceText(blocks[0].content), blocks[0].numbering)).toBe(false);
    },
  );

  it('retains an Arabic-numbered instructional calculation task', () => {
    const blocks = [b('q', '1．计算题：说说如何验算。'), b('a', '【答案】用逆运算。')];
    const [root] = fastWordReferences(blocks);
    expect(root.sourceLabel).toBe('1');
    expect(projected(blocks, root.question)).toBe('计算题：说说如何验算。');
    expect(projected(blocks, root.answer)).toBe('用逆运算。');
    expect(isWordStructuralLabel(sourceText(blocks[0].content))).toBe(false);
  });

  it.each([1, 0])(
    'retains a native ordinary task with an instructional suffix (level=%s)',
    (level) => {
      const blocks: WordSourceBlock[] = [
        {
          ...b('q', '计算题：说说如何验算。'),
          numbering: {
            level,
            label: level ? '二、' : '1.',
            format: level ? 'chineseCounting' : 'decimal',
          },
        },
        b('a', '【答案】用逆运算。'),
      ];
      const roots = fastWordReferences(blocks);
      expect(roots).toHaveLength(1);
      expect(projected(blocks, roots[0].question)).toBe('计算题：说说如何验算。');
      expect(projected(blocks, roots[0].answer)).toBe('用逆运算。');
      expect(isWordStructuralLabel(sourceText(blocks[0].content), blocks[0].numbering)).toBe(false);
    },
  );

  it('preserves the existing short Arabic pure-heading behavior', () => {
    const blocks = [b('section', '1．计算题'), b('q', '2．计算3+4。'), b('a', '【答案】7')];
    const roots = fastWordReferences(blocks);
    expect(roots.map((q) => q.sourceLabel)).toEqual(['2']);
    expect(roots[0].questionType).toBe('short_answer');
    expect(owners(blocks, 'section')).toEqual([]);
  });
  it.each([
    '四、计算题：直接写出得数。',
    '四、计算题：(每小题4分，共16分)',
    '四、计算题。（共20分）',
    '四、计算题：直接写出得数（每题2分）。',
  ])('changes section without polluting preceding fields: %s', (heading) => {
    const blocks = [
      b('choice-section', '一、选择题'),
      b('q1', '1．选出最大数。'),
      b('o1', 'A．1　B．3'),
      b('a1', '【答案】B'),
      b('n1', '【解析】3最大。'),
      b('section', heading),
      b('q2', '2．计算：3+4'),
      b('a2', '【答案】7'),
    ];
    const roots = fastWordReferences(blocks);
    expect(roots.map((q) => q.questionType)).toEqual(['single_choice', 'short_answer']);
    expect(projected(blocks, roots[0].answer)).toBe('B');
    expect(projected(blocks, roots[0].analysis)).toBe('3最大。');
    expect(projected(blocks, roots[1].answer)).toBe('7');
    expect(owners(blocks, 'section')).toEqual([]);
    expect(isWordStructuralLabel(heading)).toBe(true);
    const preview = parseWordFast(blocks, 'heading');
    expect(preview.questions[1].question_type).toBe('short_answer');
    expect(answerText(preview.questions[1].answer)).toBe('7');
    expect(
      preview.unresolvedItems?.some((item) =>
        item.sourceRanges.some((range) => range.blockId === 'section'),
      ),
    ).toBe(false);
  });

  it.each([
    '1．计算题中哪些算式相等？',
    '1．计算题：直接写出得数。3+4=',
    '1．计算题：填写____。',
    '1．计算题：回答（ ）的问题。',
    '1．计算题：答案：7。',
    '1．计算题：解析：先列式。',
  ])('preserves substantive numbered tasks: %s', (stem) => {
    const blocks = [b('q', stem), b('a', '【答案】7')];
    expect(fastWordReferences(blocks)).toHaveLength(1);
    expect(owners(blocks, 'q')).toContainEqual({ path: '1', field: 'question' });
    expect(isWordStructuralLabel(stem)).toBe(false);
  });

  it.each(['answer', 'analysis'])('retains heading-like prose within previous %s', (field) => {
    const blocks = [
      b('q', '1．解释解题方法。'),
      b('a', '【答案】先列式。'),
      ...(field === 'analysis' ? [b('n', '【解析】步骤如下。')] : []),
      b('prose', '计算题需要合理步骤。'),
    ];
    expect(owners(blocks, 'prose')).toEqual([{ path: '1', field }]);
    expect(isWordStructuralLabel('计算题需要合理步骤。')).toBe(false);
  });

  it('rejects headings containing native atoms', () => {
    const blocks: WordSourceBlock[] = [
      b('q', '1．解释方法。'),
      b('a', '【答案】先列式。'),
      {
        id: 'prose',
        content: [
          { type: 'text', text: '四、计算题：' },
          { type: 'inlineMath', attrs: { latex: '3+4' } },
        ],
      },
    ];
    expect(owners(blocks, 'prose')).toEqual([{ path: '1', field: 'answer' }]);
  });
});

describe('XW-06 bounded sections end inferred generic choice state', () => {
  it.each([
    { nativeLabel: undefined, heading: '计算题：直接写出得数。', secondType: 'short_answer' },
    { nativeLabel: '1.', heading: '计算题：直接写出得数。', secondType: 'short_answer' },
    { nativeLabel: '二、', heading: '计算题：直接写出得数。', secondType: 'short_answer' },
    { nativeLabel: '二、', heading: '应用题', secondType: 'single_choice' },
    { nativeLabel: '1.', heading: '解决问题', secondType: 'single_choice' },
  ])(
    'does not infer choice statements from options after a native section (label=$nativeLabel, heading=$heading)',
    ({ nativeLabel, heading, secondType }) => {
      const blocks: WordSourceBlock[] = [
        b('q1', '1．计算下面各题。'),
        b('c1', '(1)1+1=____。'),
        b('c2', '(2)2+2=____。'),
        {
          ...b('section', `${nativeLabel ? '' : '二、'}${heading}`),
          ...(nativeLabel
            ? {
                numbering: {
                  level: 0,
                  label: nativeLabel,
                  format:
                    nativeLabel === '1.' ? ('decimal' as const) : ('chineseCounting' as const),
                },
              }
            : {}),
        },
        b('q2', '选出2+3的得数。'),
        b('o2', 'A．5　B．6'),
        b('a2', '【答案】A'),
      ];
      const roots = fastWordReferences(blocks);
      expect(roots).toHaveLength(2);
      const [first, second] = roots;
      expect(first.children).toHaveLength(2);
      expect(projected(blocks, first.question)).toBe('计算下面各题。');
      expect(first.children.map((child) => projected(blocks, child.question))).toEqual([
        '1+1=____。',
        '2+2=____。',
      ]);
      expect(first.children.map((child) => child.questionType)).toEqual([
        'fill_in_the_blank',
        'fill_in_the_blank',
      ]);
      expect(first.options).toBeUndefined();
      expect(first.answer).toEqual([]);
      expect(first.children.every((child) => child.answer.length === 0)).toBe(true);
      expect(second.questionType).toBe(secondType);
      expect(projected(blocks, second.question)).toBe('选出2+3的得数。');
      expect(second.options?.map((option) => projected(blocks, option.label).trim())).toEqual([
        '5',
        '6',
      ]);
      expect(projected(blocks, second.answer)).toBe('A');
      expect(owners(blocks, 'section')).toEqual([]);
    },
  );

  it.each(['五、解决问题。（说明过程）', '五、应用题。（共____分）'])(
    'retains a non-score or incomplete punctuation suffix: %s',
    (heading) => {
      const blocks = [b('q', '1．解释方法。'), b('a', '【答案】先列式。'), b('tail', heading)];
      expect(isWordStructuralLabel(heading)).toBe(false);
      expect(owners(blocks, 'tail')).toEqual([{ path: '1', field: 'answer' }]);
    },
  );

  it.each(['C', 'A'])('preserves full text option continuation and source key %s', (answer) => {
    const blocks = [
      b('q', '1．选择正确的一项：  (1)2+3=____；(2)6÷2=____。 A．6和4  B．7和5'),
      b('options', 'C．5和3  D．8和6'),
      b('a', `【答案】${answer}`),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.questionType).toBe('single_choice');
    expect(root.children).toEqual([]);
    expect(root.options?.map((option) => option.sourceLabel)).toEqual(['A', 'B', 'C', 'D']);
    expect(root.options?.map((option) => projected(blocks, option.label).trim())).toEqual([
      '6和4',
      '7和5',
      '5和3',
      '8和6',
    ]);
    expect(projected(blocks, root.question)).toBe('选择正确的一项：  (1)2+3=____；(2)6÷2=____。 ');
    expect(projected(blocks, root.answer)).toBe(answer);
    const preview = parseWordFast(blocks, 'text-option-continuation');
    expect(preview.questions[0].options?.map((option) => option.value)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(preview.questions[0].answer).toEqual([answer]);
    expect(preview.unresolvedItems ?? []).toEqual([]);
  });

  it.each(['upperLetter', 'lowerLetter'])(
    'retains full same-task native option continuations: %s',
    (format) => {
      const answer = format === 'upperLetter' ? 'C' : 'A';
      const blocks: WordSourceBlock[] = [
        b('q', '1．选出正确的一项：  (1)1+1=____；(2)2+2=____。 A．2和4　B．1和3'),
        {
          ...b('oc', '都不正确'),
          numbering: { level: 0, label: format === 'upperLetter' ? 'C.' : 'c.', format },
        },
        {
          ...b('od', '都正确'),
          numbering: { level: 0, label: format === 'upperLetter' ? 'D.' : 'd.', format },
        },
        b('a', `【答案】${answer}`),
      ];
      const [root] = fastWordReferences(blocks);
      expect(root.questionType).toBe('single_choice');
      expect(root.children).toEqual([]);
      expect(root.options?.map((option) => projected(blocks, option.label).trim())).toEqual([
        '2和4',
        '1和3',
        '都不正确',
        '都正确',
      ]);
      expect(projected(blocks, root.answer)).toBe(answer);
      expect(parseWordFast(blocks, 'mixed-native-options').questions[0].answer).toEqual([answer]);
    },
  );

  it.each([
    { label: '2.', format: 'decimal', text: '描述字母A的含义。' },
    { label: 'E.', format: 'upperLetter', text: '另一种结论。' },
  ])('does not borrow choice proof across a competing native label: $label', (boundary) => {
    const blocks: WordSourceBlock[] = [
      b('q1', '1．计算：  (1)1+1=____；(2)2+2=____。 A．2　B．4'),
      {
        ...b('next', boundary.text),
        numbering: { level: 0, label: boundary.label, format: boundary.format },
      },
      b('a2', '【答案】A'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.questionType).not.toBe('single_choice');
    expect(root.children).toHaveLength(2);
    expect(root.answer.some((range) => range.blockId === 'a2')).toBe(false);
    expect(
      root.children.every((child) => child.answer.every((range) => range.blockId !== 'a2')),
    ).toBe(true);
  });

  it('never borrows a choice key across a native level-zero boundary', () => {
    const blocks: WordSourceBlock[] = [
      b('q1', '1．计算：  (1)1+1=____；(2)2+2=____。 A．2　B．4'),
      {
        ...b('section', '应用题'),
        numbering: { level: 0, label: '二、', format: 'chineseCounting' },
      },
      b('q2', '描述字母A的含义。'),
      b('a2', '【答案】A'),
    ];
    const [root] = fastWordReferences(blocks);
    expect(root.questionType).not.toBe('single_choice');
    expect(root.children).toHaveLength(2);
    expect(root.children.map((child) => child.questionType)).toEqual([
      'fill_in_the_blank',
      'fill_in_the_blank',
    ]);
    expect(root.answer).toEqual([]);
    expect(root.children.every((child) => child.answer.length === 0)).toBe(true);
  });

  it('uses native reset metadata for smart source coverage', () => {
    const blocks: WordSourceBlock[] = [
      {
        ...b('section', '应用题'),
        numbering: { level: 0, label: '二、', format: 'chineseCounting' },
      },
      b('q', '计算3+4。'),
      b('a', '7'),
    ];
    const reference: WordQuestionReference = {
      questionType: 'short_answer',
      question: [{ blockId: 'q' }],
      answer: [{ blockId: 'a' }],
      analysis: [],
      children: [],
    };
    expect(smart(blocks, reference).unresolvedItems ?? []).toEqual([]);
    blocks[0].numbering!.level = 1;
    expect(() => smart(blocks, reference)).toThrow('word-import.unaccounted-source');
  });
  it.each([
    '五、应用题',
    '五、解决问题。',
    '四、操作题',
    '四、计算。',
    '五、解决问题。（共20分）',
    '五、解决问题：（每题5分，共20分）',
    '五、应用题。(每小题5分，共20分)',
    '四、计算。（共12分）',
  ])('resets at a proven heading: %s', (heading) => {
    const blocks = [
      b('section1', '一、选择题'),
      b('q1', '1．选出最大数。'),
      b('o', 'A．1　B．3'),
      b('a1', '【答案】B'),
      b('section2', heading),
      b('q2', '2．有5个苹果，吃了2个，还剩几个？'),
      b('a2', '【答案】3个'),
    ];
    const roots = fastWordReferences(blocks);
    expect(roots.map((q) => q.questionType)).toEqual(['single_choice', 'short_answer']);
    expect(projected(blocks, roots[1].question)).toBe('有5个苹果，吃了2个，还剩几个？');
    expect(projected(blocks, roots[1].answer)).toBe('3个');
    expect(owners(blocks, 'section2')).toEqual([]);
    expect(isWordStructuralLabel(heading)).toBe(true);
  });

  it('keeps a true explicit choice without options as a diagnosed choice', () => {
    const blocks = [
      b('section', '一、单项选择题'),
      b('q', '1．选出正确的一项。'),
      b('a', '【答案】A'),
    ];
    const result = parseWordFast(blocks, 'declared-choice');
    expect(result.questions[0].question_type).toBe('single_choice');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.missing-options' }),
    );
  });

  it('keeps substantive Arabic-numbered problem-solving stems', () => {
    const blocks = [
      b('q', '1．解决问题：小明有5个苹果，吃了2个，还剩几个？'),
      b('a', '【答案】3个'),
    ];
    expect(fastWordReferences(blocks)).toHaveLength(1);
    expect(isWordStructuralLabel(sourceText(blocks[0].content))).toBe(false);
  });

  it.each([0, 1])('recognizes reset metadata only at native level %s', (level) => {
    const blocks: WordSourceBlock[] = [
      b('section1', '一、选择题'),
      b('q1', '1．选出最大数。'),
      b('o', 'A．1　B．3'),
      b('a1', '【答案】B'),
      {
        ...b('section2', '应用题'),
        numbering: { level, label: '二、', format: 'chineseCounting' },
      },
      b('q2', '2．求5与2的差。'),
      b('a2', '【答案】3'),
    ];
    const roots = fastWordReferences(blocks);
    if (!level) {
      expect(roots.map((q) => q.questionType)).toEqual(['single_choice', 'short_answer']);
      expect(owners(blocks, 'section2')).toEqual([]);
    } else expect(owners(blocks, 'section2')).not.toEqual([]);
  });
});
