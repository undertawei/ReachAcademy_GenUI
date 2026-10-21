import { describe, expect, it } from 'vitest';
import {
  fastWordReferences,
  sourceText,
  type WordSourceBlock,
  type WordSourceRange,
} from '../src/word-import/index.js';

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const math = (id: string, parts: string[]): WordSourceBlock => ({
  id,
  content: parts.map((part, index) =>
    index % 2 ? { type: 'inlineMath', attrs: { latex: part } } : { type: 'text', text: part },
  ),
});
const projected = (blocks: WordSourceBlock[], refs: WordSourceRange[]) =>
  refs
    .map((ref) =>
      sourceText(blocks.find((b) => b.id === ref.blockId)!.content).slice(ref.start, ref.end),
    )
    .join('\n');
const tasks = () => [
  block('root', '1．Material.'),
  block('t1', '(1) First task.'),
  block('t2', '(2) Second task.'),
];
const circles = () => [...tasks(), block('i1', '① First task.'), block('i2', '② Second task.')];

describe('Grade ten mathematics conservative parser regressions', () => {
  it.each(['阅读材料：', '从以下三个条件中选择两个作为已知，求参数范围．'])(
    'keeps immediate premise paragraphs on their exact owning task: %s',
    (cue) => {
      const sources = [
        block('root', '1．Material.'),
        block('task', `(1)${cue}`),
        math('p1', ['①若', 'x>0', '，则结论成立；']),
        math('p2', ['②若', 'x<0', '，则另一结论成立．']),
        block('request', '请依据以上材料求证结论。'),
        block('a', '【答案】(1)Proof.'),
      ];
      const refs = fastWordReferences(sources);
      expect(refs[0].children[0].children).toEqual([]);
      expect(projected(sources, refs[0].children[0].question)).toContain('①若');
      expect(projected(sources, refs[0].children[0].answer)).toBe('Proof.');
    },
  );

  it.each(['判断各说法是否正确？', '正确的是（ ）', '结果为____', '求值？'])(
    'retains real circled questions after a reading cue: %s',
    (prompt) => {
      const sources = [
        block('root', '1．Material.'),
        block('t', '(1)阅读材料：'),
        block('i1', `①${prompt}`),
        block('i2', '②Second task.'),
        block('a', '【答案】(1)①Yes.  ②No.'),
      ];
      expect(fastWordReferences(sources)[0].children[0].children.map((c) => c.sourceLabel)).toEqual(
        ['①', '②'],
      );
    },
  );

  it('retains explicit circled answer corroboration even for declarative stems', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      block('i1', '①Statement one.'),
      block('i2', '②Statement two.'),
      block('a', '【答案】(1)①Yes.  ②No.'),
    ];
    expect(fastWordReferences(sources)[0].children[0].children).toHaveLength(2);
  });

  it('stops the premise list before a later fresh circled task sequence', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      block('p1', '①Premise one.'),
      block('p2', '②Premise two.'),
      block('request', '回答以下问题。'),
      block('i1', '①求第一个值？'),
      block('i2', '②求第二个值？'),
      block('a', '【答案】(1)①Yes.  ②No.'),
    ];
    const task = fastWordReferences(sources)[0].children[0];
    expect(task.children.map((c) => c.sourceLabel)).toEqual(['①', '②']);
    expect(projected(sources, task.question)).toContain('Premise two.');
    expect(projected(sources, task.children[0].question)).toContain('求第一个值');
  });

  it.each([
    [[block('root', '1．阅读材料：'), block('t', '(1)Material.')]],
    [[block('root', '1．阅读材料：')]],
  ])('does not borrow a cue from an ancestor or root list', (prefix) => {
    const refs = fastWordReferences([
      ...prefix,
      block('p1', '①Premise one.'),
      block('p2', '②Premise two.'),
    ]);
    const task = prefix.length === 2 ? refs[0].children[0] : refs[0];
    expect(
      task.children.length ||
        projected(
          [...prefix, block('p1', '①Premise one.'), block('p2', '②Premise two.')],
          task.question,
        ).length,
    ).toBeGreaterThan(0);
    if (prefix.length === 2) expect(task.children).toHaveLength(2);
  });

  it.each([
    ['【答案】(1)', '3', '(2)', '-9', ''],
    [
      '【答案】（1）',
      '\\left\\{\\left.m\\right|-1',
      '或',
      '\\left.m>\\frac{1}{2}\\right\\}',
      '（2）',
      'R',
      '',
    ],
  ])('splits compact parenthesis answers only at existing adjacent siblings', (...parts) => {
    const sources = [...tasks(), math('a', parts)];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources)[0].children;
    expect(refs[0].answer).toHaveLength(1);
    expect(projected(sources, refs[0].answer)).not.toContain('(2)');
    expect(projected(sources, refs[0].answer)).not.toContain('（2）');
    expect(projected(sources, refs[1].answer)).toBe('\uFFFC');
    expect(JSON.stringify(sources)).toBe(before);
  });

  it.each([' ', '\u00a0', '\u3000'])(
    'routes nested compact circled answers with one horizontal space %j',
    (space) => {
      const sources = [...circles(), math('a', ['【答案】(2)①', 'a=2', `${space}②`, 'm>3', ''])];
      const refs = fastWordReferences(sources)[0].children[1].children;
      expect(projected(sources, refs[0].answer)).toBe(`\uFFFC${space}`);
      expect(projected(sources, refs[1].answer)).toBe('\uFFFC');
    },
  );

  it.each(['f(1)(2)', 'a(1)(2)', '(1)3(2)4', '(1)Result(2)Next'])(
    'does not create a compact parenthesis boundary in plain prose: %s',
    (value) => {
      const refs = fastWordReferences([...tasks(), block('a', `【答案】(1)${value}`)])[0].children;
      expect(refs[1].answer).toEqual([]);
    },
  );

  it.each([
    'x',
    '\\sin',
    '\\log',
    'x_{1}',
    'f(1)',
    'f\\left(1\\right)',
    '\\sin{1}',
    '\\sin 1',
    '\\log_{2}{1}',
    'x_1',
    'x_{1}^{2}',
    'a(1)',
    '\\operatorname{f}(1)',
    '\\left(f(1)\\right)',
  ])('rejects function/letter/subscript terminal formulas: %s', (latex) => {
    const sources = [...tasks(), math('a', ['【答案】(1)', latex, '(2)', '4', ''])];
    expect(fastWordReferences(sources)[0].children[1].answer).toEqual([]);
  });

  it.each([
    '3',
    '-3',
    '3.5',
    '\\frac{1}{2}',
    'a=2',
    'm>\\frac{1}{2}',
    '\\left.m>\\frac{1}{2}\\right\\}',
    '\\left(3\\right)',
  ])('allows a complete numeric or single-variable numeric comparison atom: %s', (latex) => {
    const sources = [...tasks(), math('a', ['【答案】(1)', latex, '(2)', '4', ''])];
    expect(projected(sources, fastWordReferences(sources)[0].children[1].answer)).toBe('\uFFFC');
  });

  it('requires an earlier genuine ownership key in the same block', () => {
    const sources = [
      ...tasks(),
      block('a1', '【答案】(1)First.'),
      math('a', ['', '3', '(2)', '4', '']),
    ];
    expect(fastWordReferences(sources)[0].children[1].answer).toEqual([]);
  });

  it('rejects skipped siblings', () => {
    const sources = [
      ...tasks(),
      block('t3', '(3) Third task.'),
      math('a', ['【答案】(1)', '3', '(3)', '4', '']),
    ];
    expect(fastWordReferences(sources)[0].children[2].answer).toEqual([]);
  });

  it('does not use an ancestor sibling for a nested compact key', () => {
    const sources = [
      ...tasks(),
      block('n1', '①Nested task.'),
      math('a', ['【答案】(2)①', '3', '(1)', '4', '']),
    ];
    expect(fastWordReferences(sources)[0].children[0].answer).toEqual([]);
  });

  it('does not loosen analysis boundaries', () => {
    const sources = [...tasks(), math('a', ['【详解】(1)', '3', '(2)', '4', ''])];
    expect(fastWordReferences(sources)[0].children[1].analysis).toEqual([]);
  });

  it.each(['+', '＋', '−', '='])(
    'does not route a formula key followed by an operator: %s',
    (operator) => {
      const sources = [...tasks(), math('a', ['【答案】(1)', '3', `(2)${operator}`, '4', ''])];
      expect(fastWordReferences(sources)[0].children[1].answer).toEqual([]);
    },
  );

  it.each([' ②可得', ' ②式', '、②', '\n②', '\t②'])(
    'retains compact circled references instead of routing: %j',
    (suffix) => {
      const sources = [...circles(), math('a', ['【答案】(2)①', '3', suffix, '4', ''])];
      expect(fastWordReferences(sources)[0].children[1].children[1].answer).toEqual([]);
    },
  );

  it.each(['①3 ②4', '①Text ②Other', '①②联立'])(
    'does not widen spaces after ordinary text or digits: %s',
    (value) => {
      const refs = fastWordReferences([...circles(), block('a', `【答案】(2)${value}`)])[0]
        .children[1].children;
      expect(refs[1].answer).toEqual([]);
    },
  );

  it.each(['reading', 'diagram'])(
    'does not enable compact routing between nested children of a real %s group',
    (group) => {
      const sources = [
        ...(group === 'diagram'
          ? [
              block('prior', '9．Previous task.'),
              block('prior-a', '【答案】Previous answer.'),
              block('root', 'The following chart describes the measurements.'),
              { id: 'chart', content: [{ type: 'image', attrs: { src: 'chart.png' } }] },
            ]
          : [block('root', '阅读下面材料，完成1～2题。')]),
        block('r1', '1．First group.'),
        block('t1', '(1)First task.'),
        block('t2', '(2)Second task.'),
        block('r2', '2．Second group.'),
        math('a', ['【答案】1．(1)', '3', '(2)', '4', '  2．Second answer.']),
      ];
      const refs = fastWordReferences(sources);
      const material = refs[group === 'diagram' ? 1 : 0];
      expect(material.children[0].children.map((c) => c.sourceLabel)).toEqual(['1', '2']);
      expect(projected(sources, material.children[0].children[0].answer)).toBe('\uFFFC(2)\uFFFC');
      expect(material.children[0].children[1].answer).toEqual([]);
    },
  );

  it('leaves compact labels embedded in options on the question surface', () => {
    const sources = [
      block('root', '1．Which?'),
      math('o', ['A. (1)', '3', '(2)', '4', '  B. Another']),
      block('a', '【答案】A'),
    ];
    expect(fastWordReferences(sources)[0].children).toEqual([]);
  });

  it.each(['-x', '-9+4', '-\\frac{9}{2}'])(
    'rejects signed formula expressions rather than full signed numeric literals: %s',
    (value) => {
      const sources = [...tasks(), math('a', ['【答案】(1)', '3', '(2)', value, ''])];
      expect(fastWordReferences(sources)[0].children[1].answer).toEqual([]);
    },
  );

  const comparison = () => [
    block('root', '1．比较下列各组数的大小：'),
    math('q', [
      '(1)',
      '3^{-2}',
      '和',
      '4^{-2}',
      '；(2)',
      '-8^{-1}',
      '和',
      '-9^{-1}',
      '；(3)',
      '2^3',
      '和',
      '3^2',
      '；',
    ]),
  ];
  const comparisonAnswer = () =>
    math('a', [
      '【答案】(1)',
      '3^{-2}>4^{-2}',
      '；(2)',
      '-8^{-1}<-9^{-1}',
      '；(3)',
      '2^3<3^2',
      '.',
    ]);

  it('splits explicit comparison groups with source math and matching bounded answers', () => {
    const sources = [...comparison(), comparisonAnswer()];
    const refs = fastWordReferences(sources)[0];
    expect(refs.children.map((c) => c.sourceLabel)).toEqual(['1', '2', '3']);
    expect(refs.children.every((c) => c.answer.length > 0)).toBe(true);
    expect(refs.children.map((c) => projected(sources, c.question))).toEqual([
      '\uFFFC和\uFFFC；',
      '\uFFFC和\uFFFC；',
      '\uFFFC和\uFFFC；',
    ]);
  });

  it.each([
    '【答案】(1)First；(2)Second；(4)Fourth',
    '【答案】(1)First；(3)Third',
    '【答案】(1)First，(2)Second，(3)Third',
    '【答案】(1)First；(2)；(3)Third',
  ])('retains the complete comparison parent with insufficient answer evidence: %s', (answer) => {
    const sources = [...comparison(), block('a', answer)];
    const refs = fastWordReferences(sources)[0];
    expect(refs.children).toEqual([]);
    expect(projected(sources, refs.question)).toContain('(3)');
  });

  it('does not borrow comparison answer evidence from the next root', () => {
    const sources = [...comparison(), block('r2', '2．Different task.'), comparisonAnswer()];
    expect(fastWordReferences(sources)[0].children).toEqual([]);
  });

  it.each(['image', 'docxUnavailable'] as const)(
    'does not count %s as comparison formula evidence',
    (nodeType) => {
      const sources = comparison();
      sources[1].content[1] =
        nodeType === 'image'
          ? { type: 'image', attrs: { src: 'test.png' } }
          : { type: 'docxUnavailable', attrs: { reason: 'docx.math.unsupported' } };
      expect(fastWordReferences([...sources, comparisonAnswer()])[0].children).toEqual([]);
    },
  );

  it('retains the entire same-paragraph colon prompt without widening global label boundaries', () => {
    const sources = comparison();
    sources[0] = math('root', [
      '1．比较下列各组数的大小：(1)',
      '3',
      '和',
      '4',
      '；(2)',
      '5',
      '和',
      '6',
      '；',
    ]);
    sources.splice(1, 1);
    const refs = fastWordReferences([...sources, block('a', '【答案】(1)First；(2)Second')])[0];
    expect(refs.children).toEqual([]);
    expect(projected(sources, refs.question)).toContain('(1)');
  });

  it('retains declarative circled tasks corroborated by standalone answer paragraphs', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      block('i1', '①Statement one.'),
      block('i2', '②Statement two.'),
      block('a', '【答案】(1)'),
      block('a1', '①Yes.'),
      block('a2', '②No.'),
    ];
    expect(fastWordReferences(sources)[0].children[0].children).toHaveLength(2);
  });

  it('retains native blank nodes as real circled tasks', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      {
        id: 'i1',
        content: [
          { type: 'text' as const, text: '①Result' },
          { type: 'quizBlank', attrs: { blankIndex: 1 } },
        ],
      },
      block('i2', '②Statement two.'),
    ];
    expect(fastWordReferences(sources)[0].children[0].children).toHaveLength(2);
  });

  it('does not retry a condition list after an unnumbered transition to real tasks', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)从以下三个条件中选择两个作为已知，完成下列问题．'),
      math('p1', ['①', 'a>0', '；']),
      math('p2', ['②', 'b>0', '；']),
      math('p3', ['③', 'c>0', '．']),
      block('transition', '请完成以下两问：'),
      block('i1', '①求a的取值范围；'),
      block('i2', '②求f(x)的最小值．'),
      block('a', '【答案】(1)略'),
    ];
    const owner = fastWordReferences(sources)[0].children[0];
    expect(owner.children.map((c) => c.sourceLabel)).toEqual(['①', '②']);
    expect(projected(sources, owner.question)).toContain('③');
    expect(projected(sources, owner.children[0].question)).toContain('求a');
  });

  it.each(['', '则f(x)>0；'])(
    'does not suppress only a prefix of a circled list interrupted by %j',
    (continuation) => {
      const sources = [
        block('root', '1．Material.'),
        block('t', '(1)从以下三个条件中选择两个作为已知，求参数范围．'),
        math('p1', ['①', 'a>0', '；']),
        math('p2', ['②若', 'x>1', '，']),
        block('continuation', continuation),
        math('p3', ['③', 'c>0', '．']),
        math('a', ['【答案】(1)', 'a>1', '']),
      ];
      const owner = fastWordReferences(sources)[0].children[0];
      expect(owner.children.map((c) => c.sourceLabel)).toEqual(continuation ? ['①', '②', '③'] : []);
    },
  );

  it.each(['【答案】(1)3；(2)①Yes.  ②No.', '【答案】解：(2)①Yes.  ②No.'])(
    'retains declarative circled tasks with bounded combined answer evidence: %s',
    (answer) => {
      const sources = [
        block('root', '1．Material.'),
        block('t1', '(1)First task.'),
        block('t2', '(2)阅读材料：'),
        block('i1', '①Statement one.'),
        block('i2', '②Statement two.'),
        block('a', answer),
      ];
      expect(fastWordReferences(sources)[0].children[1].children).toHaveLength(2);
    },
  );

  it.each(['>', '<', '\\le', '\\ge', '\\lt', '\\gt', '\\Rightarrow', '\\therefore'])(
    'does not open a compact answer boundary before a relation or proof operator: %s',
    (operator) => {
      const sources = [...tasks(), math('a', ['【答案】(1)', 'x=3', '(2)', `${operator} y=1`, ''])];
      expect(fastWordReferences(sources)[0].children[1].answer).toEqual([]);
    },
  );

  it.each(['>', '<', '\\le', '\\ge', '\\lt', '\\gt', '\\Rightarrow', '\\therefore'])(
    'does not open a spaced circled answer boundary before a relation or proof operator: %s',
    (operator) => {
      const sources = [...circles(), math('a', ['【答案】(2)①', 'x=3', ' ②', `${operator}4`, ''])];
      expect(fastWordReferences(sources)[0].children[1].children[1].answer).toEqual([]);
    },
  );

  it('does not treat a circled key on the same paragraph analysis surface as answer corroboration', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      block('p1', '①Statement one.'),
      block('p2', '②Statement two.'),
      block('a', '【答案】(1)Proof.【详解】(1)①Explanation one.  ②Explanation two.'),
    ];
    expect(fastWordReferences(sources)[0].children[0].children).toEqual([]);
  });

  it('ends answer corroboration at an inline analysis marker before later circled analysis', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      block('p1', '①Statement one.'),
      block('p2', '②Statement two.'),
      block('a', '【答案】(1)Proof.【详解】Explanation.'),
      block('an1', '①Reference one.'),
      block('an2', '②Reference two.'),
    ];
    expect(fastWordReferences(sources)[0].children[0].children).toEqual([]);
  });

  it.each(['\\Longrightarrow', '\\iff', '\\approx', '\\because', '\\in', '\\ne', '＞', '＜'])(
    'retains incoming relation alias %s on its current parenthesized answer owner',
    (operator) => {
      const sources = [...tasks(), math('a', ['【答案】(1)', 'x=3', '(2)', `${operator}4`, ''])];
      expect(fastWordReferences(sources)[0].children[1].answer).toEqual([]);
    },
  );

  it.each(['\\Longrightarrow', '\\iff', '\\approx', '\\because', '\\in', '\\ne', '＞', '＜'])(
    'retains incoming relation alias %s on its current spaced circled answer owner',
    (operator) => {
      const sources = [...circles(), math('a', ['【答案】(2)①', 'x=3', ' ②', `${operator}4`, ''])];
      expect(fastWordReferences(sources)[0].children[1].children[1].answer).toEqual([]);
    },
  );

  it('recognizes resumed answer corroboration after a same-paragraph analysis segment', () => {
    const sources = [
      block('root', '1．Material.'),
      block('t', '(1)阅读材料：'),
      block('p1', '①Statement one.'),
      block('p2', '②Statement two.'),
      block('a', '【答案】(1)Proof.【详解】Explanation.【答案】(1)①Yes.  ②No.'),
    ];
    expect(fastWordReferences(sources)[0].children[0].children.map((c) => c.sourceLabel)).toEqual([
      '①',
      '②',
    ]);
  });

  it('does not mistake the infinity constant for the membership relation alias', () => {
    const sources = [...tasks(), math('a', ['【答案】(1)', '3', '(2)', '\\infty', ''])];
    expect(projected(sources, fastWordReferences(sources)[0].children[1].answer)).toBe('\uFFFC');
  });
});
