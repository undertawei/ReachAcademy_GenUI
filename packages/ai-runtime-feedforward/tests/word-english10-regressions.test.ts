import { describe, expect, it } from 'vitest';
import {
  fastWordReferences,
  parseWordFast,
  sourceText,
  type WordSourceBlock,
} from '../src/word-import/index.js';

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const marked = (id: string, labels: number[]): WordSourceBlock => ({
  id,
  content: [
    { type: 'text', text: 'The children like apples. ' },
    ...labels.flatMap((label) => [
      { type: 'text' as const, text: `    ${label}    `, marks: [{ type: 'underline' }] },
      { type: 'text' as const, text: ' continues the story. ' },
    ]),
  ],
});
const reading = (prefix: string, labels: number[], state = 'complete'): WordSourceBlock[] => [
  block(`${prefix}material`, 'Ann has a cat. It is white. She likes her pet very much.'),
  ...labels.flatMap((label) => [
    block(`${prefix}q${label}`, `${label}．Who has a cat?`),
    block(`${prefix}o${label}`, 'A．Ann\tB．Tom'),
  ]),
  block(`${prefix}key`, `【答案】${labels.map((label) => `${label}．A`).join('    ')}`),
  ...(state === 'answer'
    ? []
    : labels
        .slice(0, state === 'incomplete' ? -1 : undefined)
        .map((label, index) =>
          block(`${prefix}analysis${label}`, `${index ? '' : '【详解】'}${label}．Ann has a cat.`),
        )),
];
const cloze = (prefix: string, labels: number[], shared: boolean, state = 'complete') => [
  ...(!shared ? [block(`${prefix}heading`, '完形填空')] : []),
  marked(`${prefix}material`, labels),
  ...(shared
    ? [
        block(
          `${prefix}pool`,
          'A．The cat likes apples.\tB．The dog likes pears.\tC．The bird likes milk.',
        ),
      ]
    : labels.map((label) => block(`${prefix}o${label}`, `${label}．A．apples\tB．pears`))),
  block(`${prefix}key`, `【答案】${labels.map((label) => `${label}．A`).join('    ')}`),
  ...(state === 'answer'
    ? []
    : labels
        .slice(0, state === 'incomplete' ? -1 : undefined)
        .map((label, index) =>
          block(
            `${prefix}analysis${label}`,
            `${index ? '' : '【详解】'}${label}．Final original explanation.`,
          ),
        )),
];
const group = (kind: string, prefix: string, labels: number[], state = 'complete') =>
  kind === 'reading'
    ? reading(prefix, labels, state)
    : cloze(prefix, labels, kind === 'shared', state);
const parse = (sources: WordSourceBlock[]) => {
  const frozen = JSON.stringify(sources);
  const result = parseWordFast(sources, 'grade-ten-english');
  expect(JSON.stringify(sources)).toBe(frozen);
  return result;
};
const owners = (sources: WordSourceBlock[], id: string) => {
  const result: Array<{ root: number; field: string }> = [];
  const refs = fastWordReferences(sources);
  const walk = (q: (typeof refs)[number], root: number) => {
    for (const field of ['question', 'answer', 'analysis'] as const)
      if (q[field].some((range) => range.blockId === id)) result.push({ root, field });
    q.children.forEach((child) => walk(child, root));
  };
  refs.forEach((q, i) => walk(q, i));
  return result;
};
const schedule: WordSourceBlock = {
  id: 'schedule',
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
                  content: [{ type: 'text', text: 'Sunday morning: beautiful park meeting.' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const titled = () => [
  block('title', 'HABITAT RESTORATION TEAM'),
  block('body', 'Help restore and protect our natural areas. Volunteers explore beautiful parks.'),
  schedule,
  ...reading('next', [3, 4]).slice(1),
];
const workbook = () => [
  block('h1', '一、完成句子'),
  block('q1', '1．有必要的话，你可以给我打电话。'),
  block('sentence', '________  ________, you can call me.'),
  block('key1', '【答案】     If     necessary'),
  block('analysis1', '【详解】根据汉语提示，表示“有必要的话”用if necessary。'),
  block('h2', '二、语法填空'),
  {
    id: 'q2',
    content: [
      { type: 'text' as const, text: '2．I suggest that you ' },
      { type: 'text' as const, text: '        ', marks: [{ type: 'underline' }] },
      {
        type: 'text' as const,
        text: ' (communicate) with your parents about your study pressure. （所给词的适当形式填空）',
      },
    ],
  },
  block('key2', '【答案】should communicate /communicate'),
  block('analysis2', '【详解】考查虚拟语气。suggest可省略should。'),
];

describe('Grade ten English completed state across empty formal tips', () => {
  it.each(
    ['reading', 'shared', 'cloze'].flatMap((previous) =>
      ['reading', 'shared', 'cloze'].map((next) => ({ previous, next })),
    ),
  )('preserves $previous -> $next source groups', ({ previous, next }) => {
    const prefix = group(previous, 'old', [1, 2]);
    const suffix = group(next, 'next', [3, 4]).filter((b) => b.id !== 'nextheading');
    const sources = [...prefix, block('tip', '【点睛】'), ...suffix];
    const refs = fastWordReferences(sources);
    expect(refs).toEqual(fastWordReferences([...prefix, ...suffix]));
    expect(owners(sources, 'nextmaterial')).toEqual([{ root: 1, field: 'question' }]);
    expect(owners(sources, 'nextkey').every((owner) => owner.root === 1)).toBe(true);
    const p = parse(sources);
    expect(p.questions).toHaveLength(2);
    expect(p.unresolvedItems).toEqual([]);
  });

  it.each(['reading', 'cloze'])('handles repeated empty tips and empty blocks: %s', (kind) => {
    const old = group(kind, 'old', [1, 2]);
    const next = reading('next', [3, 4]);
    const sources = [
      ...old,
      block('tip1', '  【点睛】  '),
      block('empty', ' '),
      block('tip2', '【点睛】'),
      ...next,
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1]).toEqual(fastWordReferences([...old, ...next])[1]);
    expect(owners(sources, 'oldmaterial')).toEqual([{ root: 0, field: 'question' }]);
    expect(owners(sources, 'oldanalysis2')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(parse(sources).questions).toHaveLength(2);
  });

  it.each(
    ['reading', 'shared', 'cloze'].flatMap((kind) =>
      ['answer', 'incomplete'].map((state) => ({ kind, state })),
    ),
  )('does not complete $kind with $state state', ({ kind, state }) => {
    const sources = [
      ...group(kind, 'old', [1, 2], state),
      block('tip', '【点睛】'),
      ...reading('next', [3, 4]),
    ];
    expect(owners(sources, 'nextmaterial')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(parse(sources).questions[0].question_type).toBe(
      kind === 'reading' ? 'short_answer' : 'cloze',
    );
  });

  it.each([
    block('tip', '【点睛】Ann has a cat. This is additional original analysis.'),
    block('tip', 'Additional original analysis.【点睛】'),
    {
      id: 'tip',
      content: [
        { type: 'text' as const, text: '【点睛】' },
        { type: 'image' as const, attrs: { sourceMediaId: 'tip-image' } },
      ],
    },
    { id: 'tip', content: [{ type: 'text' as const, text: '【点睛】' }, ...schedule.content] },
    {
      id: 'tip',
      content: [
        { type: 'text' as const, text: '【点睛】' },
        { type: 'inlineMath' as const, attrs: { latex: 'AB=AC' } },
      ],
    },
  ])('preserves substantive or inline tip content: $id', (tip) => {
    const sources = [...cloze('old', [1, 2], false), tip, ...reading('next', [3, 4])];
    expect(owners(sources, 'tip')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(owners(sources, 'nextmaterial')).toEqual([{ root: 0, field: 'analysis' }]);
    parse(sources);
  });

  it('retains the original root owner for real tip body and numbering restart', () => {
    const old = reading('old', [1, 2]);
    const sources = [
      ...old,
      block('tip', '【点睛】'),
      block('body', 'This sentence explains the original answer.'),
      block('numbered', '1．Additional original explanation.'),
    ];
    expect(owners(sources, 'body')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(owners(sources, 'numbered')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(parse(sources).questions).toHaveLength(1);
  });

  it('keeps quoted continuation on the original solution after the empty tip', () => {
    const sources = [
      ...cloze('old', [1, 2], false),
      block('tip', '【点睛】'),
      block('quote', 'Ann said, "The cat likes the farm."'),
      ...reading('next', [3, 4]),
    ];
    expect(owners(sources, 'quote')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(owners(sources, 'nextmaterial')).toEqual([{ root: 0, field: 'analysis' }]);
  });

  it.each([
    '【答案】3．A',
    '【答案】4．A    3．B',
    '【答案】3．A    3．B',
    '【答案】3．A apples    4．B pears',
  ])('retains strict next keys: %s', (key) => {
    const next = reading('next', [3, 4]).map((b) => (b.id === 'nextkey' ? block(b.id, key) : b));
    const sources = [...cloze('old', [1, 2], false), block('tip', '【点睛】'), ...next];
    expect(owners(sources, 'nextmaterial')).toEqual([{ root: 0, field: 'analysis' }]);
  });

  it.each(['A．Ann\tC．Tom', 'A．Ann\tA．Tom', 'C．Ann\tD．Tom'])(
    'retains strict next option pools: %s',
    (pool) => {
      const next = reading('next', [3, 4]).map((b) =>
        b.id.startsWith('nexto') ? block(b.id, pool) : b,
      );
      const sources = [...cloze('old', [1, 2], false), block('tip', '【点睛】'), ...next];
      expect(owners(sources, 'nextmaterial')).toEqual([{ root: 0, field: 'analysis' }]);
    },
  );

  it.each(['reading', 'shared', 'cloze'])(
    'does not complete partial %s when its first explanation ends with a choice',
    (kind) => {
      const previous = group(kind, 'old', [1, 2], 'incomplete').map((b) =>
        b.id === 'oldanalysis1'
          ? block(b.id, '【详解】1．This is the first explanation. 故选A。')
          : b,
      );
      const sources = [...previous, block('tip', '【点睛】'), ...reading('next', [3, 4])];
      expect(owners(sources, 'nextmaterial')).toEqual([{ root: 0, field: 'analysis' }]);
    },
  );
});

describe('Grade ten English source-proven uppercase reading title', () => {
  it.each(['3．Ann    4．Ann', '3．A'])(
    'preserves legacy uppercase instruction with non-strict keys: %s',
    (key) => {
      const sources = [
        block('instruction', 'READ AND CHOOSE'),
        ...reading('next', [3, 4]).map((b) =>
          b.id === 'nextkey' ? block(b.id, `【答案】${key}`) : b,
        ),
      ];
      const equivalent = sources.map((b) =>
        b.id === 'instruction' ? block(b.id, 'Read and choose') : b,
      );
      expect(fastWordReferences(sources)).toEqual(fastWordReferences(equivalent));
      expect(parse(sources).questions.map((q) => q.sub_problems)).toEqual(
        parse(equivalent).questions.map((q) => q.sub_problems),
      );
    },
  );
  it('keeps the title and native schedule on the actual reading root', () => {
    const sources = titled();
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].question.map((r) => r.blockId)).toEqual(['title', 'body', 'schedule']);
    expect(refs[0].children.map((q) => q.sourceLabel)).toEqual(['3', '4']);
    const p = parse(sources);
    expect(p.questions[0].question.content?.find((n) => n.type === 'table')).toEqual(
      schedule.content[0],
    );
    expect(p.questions[0].sub_problems?.map((q) => q.answer)).toEqual([['A'], ['A']]);
  });

  it.each([
    'AB AC BC',
    'A．CAT\tB．DOG\tC．BIRD',
    '3．HABITAT RESTORATION TEAM',
    '这是中文标题',
    'HABITAT',
  ])('does not treat %s as a title prelude', (title) => {
    const sources = [block('title', title), ...titled().slice(1)];
    expect(
      fastWordReferences(sources).some(
        (q) => q.children.length && q.question.some((r) => r.blockId === 'title'),
      ),
    ).toBe(false);
  });

  it.each([
    '根据上文可知，这是原题的补充解析。',
    'Ann said, "The cat likes the farm."',
    'The explanation explains the previous answer.',
    '这是一篇完全中文的材料。',
  ])('does not cross intervening body %s', (note) => {
    const sources = [
      block('title', 'HABITAT RESTORATION TEAM'),
      block('note', note),
      ...titled().slice(1),
    ];
    expect(
      fastWordReferences(sources).some(
        (q) => q.children.length && q.question.some((r) => r.blockId === 'title'),
      ),
    ).toBe(false);
  });

  it.each(['【答案】3．A', '【答案】4．A    3．B', '【答案】3．A    3．B'])(
    'requires full ordered title keys: %s',
    (key) => {
      const sources = titled().map((b) => (b.id === 'nextkey' ? block(b.id, key) : b));
      expect(
        fastWordReferences(sources).some(
          (q) => q.children.length && q.question.some((r) => r.blockId === 'title'),
        ),
      ).toBe(false);
    },
  );

  it('keeps native-numbered titles out of the prelude exception', () => {
    const sources = [
      { ...titled()[0], numbering: { label: '3.', level: 0 } },
      ...titled().slice(1),
    ];
    expect(
      fastWordReferences(sources).some(
        (q) => q.children.length && q.question.some((r) => r.blockId === 'title'),
      ),
    ).toBe(false);
  });

  it('requires the previous solution to be complete', () => {
    const sources = [...cloze('old', [1, 2], false, 'answer'), ...titled()];
    expect(
      fastWordReferences(sources).some(
        (q) => q.children.length && q.question.some((r) => r.blockId === 'title'),
      ),
    ).toBe(false);
  });

  it('does not accept a title after only the first cloze explanation concludes', () => {
    const previous = cloze('old', [1, 2], false, 'incomplete').map((b) =>
      b.id === 'oldanalysis1'
        ? block(b.id, '【详解】1．This is the first explanation. 故选A。')
        : b,
    );
    const sources = [...previous, ...titled().filter((b) => b.id !== 'schedule')];
    expect(owners(sources, 'title')).toEqual([{ root: 0, field: 'analysis' }]);
    expect(owners(sources, 'body')).toEqual([{ root: 0, field: 'analysis' }]);
  });

  it('preserves generic native-table fallthrough when the title upgrade is rejected', () => {
    const previous = cloze('old', [1, 2], false, 'incomplete').map((b) =>
      b.id === 'oldanalysis1'
        ? block(b.id, '【详解】1．This is the first explanation. 故选A。')
        : b,
    );
    const sources = [...previous, ...titled()];
    expect(owners(sources, 'title')).toEqual([{ root: 1, field: 'question' }]);
    expect(owners(sources, 'body')).toEqual([{ root: 2, field: 'question' }]);
    expect(owners(sources, 'schedule')).toEqual([{ root: 2, field: 'question' }]);
    expect(parse(sources).questions).toHaveLength(3);
  });

  it('preserves an existing short Chinese reading instruction', () => {
    const sources = [block('title', '这是阅读标题'), ...titled().slice(1)];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].question.map((r) => r.blockId)).toEqual(['title', 'body', 'schedule']);
    expect(refs[0].children.map((q) => q.sourceLabel)).toEqual(['3', '4']);
  });

  it('does not turn math labels into English material', () => {
    const sources = [
      block('title', 'AB AC BC'),
      block('geometry', '△ABC，AB = AC，求证下面两个结论。'),
      ...reading('next', [3, 4]).slice(1),
    ];
    expect(
      fastWordReferences(sources).some(
        (q) => q.children.length && q.question.some((r) => r.blockId === 'title'),
      ),
    ).toBe(false);
  });

  it('does not attach uppercase titles to shared blanks', () => {
    const sources = [block('title', 'HABITAT RESTORATION TEAM'), ...cloze('next', [3, 4], true)];
    expect(
      fastWordReferences(sources).some(
        (q) => q.blanks?.length && q.question.some((r) => r.blockId === 'title'),
      ),
    ).toBe(false);
  });
});

describe('Grade ten exact workbook headings before numbered leaves', () => {
  it('keeps native numbered heading-shaped task content', () => {
    const sources = workbook().map((b) =>
      b.id === 'h1' ? { ...b, numbering: { label: '1.', level: 0 } } : b,
    );
    expect(owners(sources, 'h1').length).toBeGreaterThan(0);
  });
  it('matches deleting headings without ghosts, ownership drift or unresolved ranges', () => {
    const sources = workbook();
    const without = sources.filter((b) => !['h1', 'h2'].includes(b.id));
    expect(fastWordReferences(sources)).toEqual(fastWordReferences(without));
    const p = parse(sources);
    expect(p.questions).toEqual(parse(without).questions);
    expect(p.questions).toHaveLength(2);
    expect(p.questions.map((q) => q.question_type)).toEqual([
      'fill_in_the_blank',
      'fill_in_the_blank',
    ]);
    expect(p.unresolvedItems).toEqual([]);
    expect(owners(sources, 'h1')).toEqual([]);
    expect(owners(sources, 'h2')).toEqual([]);
  });

  it.each(['完成句子', '一、完成句子：', '二、语法填空。'])(
    'recognizes exact contextual heading %s',
    (heading) => {
      const sources = workbook().map((b) => (b.id === 'h1' ? block(b.id, heading) : b));
      expect(fastWordReferences(sources)).toEqual(
        fastWordReferences(sources.filter((b) => !['h1', 'h2'].includes(b.id))),
      );
      expect(parse(sources).unresolvedItems).toEqual([]);
    },
  );

  it('preserves grouped grammar headed by an instruction before unnumbered material', () => {
    const sources = [
      block('heading', '二、语法填空'),
      block('instruction', '阅读下面短文，在空白处填入适当的单词。'),
      marked('material', [1, 2]),
      block('key', '【答案】1．apples    2．pears'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].question.map((r) => r.blockId)).toEqual(['heading', 'instruction', 'material']);
    expect(parse(sources).questions[0].question_type).toBe('fill_in_the_blank');
  });

  it.each([
    '一、完成句子，然后讨论你的答案。',
    '语法填空需要根据上下文可知。',
    '一、完成句子'.repeat(10),
  ])('retains substantive or oversized heading text %s', (heading) => {
    const sources = workbook().map((b) => (b.id === 'h1' ? block(b.id, heading) : b));
    expect(owners(sources, 'h1').length).toBeGreaterThan(0);
  });

  it('does not treat numbered analysis as a new workbook section', () => {
    const sources = [
      ...cloze('old', [1, 2], false),
      block('heading', '二、语法填空'),
      block('numbered', '3．根据上文可知，这里仍然是原题的解析。'),
      block('key', '【答案】A'),
    ];
    expect(owners(sources, 'heading')).toEqual([{ root: 0, field: 'analysis' }]);
  });

  it('requires the immediate real task to supply its own answer', () => {
    const sources = workbook().filter((b) => b.id !== 'key1');
    expect(owners(sources, 'h1').length).toBeGreaterThan(0);
  });
});
