import { describe, expect, it } from 'vitest';
import {
  fastWordReferences,
  parseWordFast,
  sourceText,
  type WordSourceBlock,
  type WordSourceRange,
} from '../src/word-import/index.js';

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const marked = (id: string, labels: number[], prefix: string): WordSourceBlock => ({
  id,
  content: [
    { type: 'text', text: prefix },
    ...labels.flatMap((label) => [
      { type: 'text' as const, text: `    ${label}    `, marks: [{ type: 'underline' }] },
      { type: 'text' as const, text: ' continues the story. ' },
    ]),
  ],
});
const table = (id: string, inner: WordSourceBlock[]): WordSourceBlock => ({
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
              content: inner.map((b) => ({ type: 'paragraph', content: b.content })),
            },
          ],
        },
      ],
    },
  ],
});
const projected = (sources: WordSourceBlock[], refs: WordSourceRange[]) =>
  refs
    .map((r) => sourceText(sources.find((b) => b.id === r.blockId)!.content).slice(r.start, r.end))
    .join('\n');
const text = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  const node = value as { text?: string; content?: unknown };
  return node.text ?? text(node.content);
};
const parse = (sources: WordSourceBlock[]) => {
  const original = JSON.stringify(sources);
  const p = parseWordFast(sources, 'grade-seven-synthetic');
  expect(JSON.stringify(sources)).toBe(original);
  return p;
};
const oldCloze = (): WordSourceBlock[] => [
  block('heading', '完形填空'),
  marked('old', [1, 2], 'Tom likes '),
  block('old1', '1．A．apples\tB．pears'),
  block('old2', '2．A．green\tB．red'),
  block('oldKey', '【答案】1．A    2．B'),
  block('oldAnalysis1', '【详解】1．First original explanation.'),
  block('oldAnalysis2', '2．Final original explanation.'),
];
const reading = (prefix = 'r', labels = [3, 4]): WordSourceBlock[] => [
  block(`${prefix}material`, 'Ann has a cat. It is white. She likes her pet very much.'),
  block(`${prefix}q1`, `${labels[0]}．Who has a cat?`),
  block(`${prefix}o1`, 'A．Ann\tB．Tom'),
  block(`${prefix}q2`, `${labels[1]}．What colour is it?`),
  block(`${prefix}o2`, 'A．black\tB．white'),
  block(`${prefix}key`, `【答案】${labels[0]}．A    ${labels[1]}．B`),
  block(`${prefix}analysis1`, `【详解】${labels[0]}．Ann has a cat.`),
  block(`${prefix}analysis2`, `${labels[1]}．It is white.`),
];
const longMaterial = 'The children spend their holidays on a farm near their school. '.repeat(5);

describe('Grade seven English exact legacy compatibility', () => {
  it.each(['plain-short', 'instructed', 'plain-long', 'wrapped-keys'])(
    'binds wrapped C/D choices to each numbered candidate row: %s',
    (kind) => {
      const sources = [
        ...oldCloze(),
        ...(kind === 'instructed'
          ? [block('instruction', '阅读短文，从下列选项中选出正确答案。')]
          : []),
        marked('fresh', [3, 4], kind === 'plain-long' ? longMaterial : 'Ann likes '),
        block('new3', '3．A．cats\tB．dogs'),
        block('new3wrap', 'C．pigs\tD．cows'),
        block('new4', '4．A．black\tB．white'),
        block('new4wrap', 'C．red\tD．blue'),
        block('newMarker', '【答案】'),
        block('newKey', kind === 'wrapped-keys' ? '3．D    4．C' : '3．B    4．A'),
        block('newAnalysis3', '【详解】3．First fresh explanation.'),
        block('newAnalysis4', '4．Final fresh explanation.'),
      ];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(refs).toHaveLength(2);
      expect(refs[0].analysis.map((r) => r.blockId)).toEqual(['oldAnalysis1', 'oldAnalysis2']);
      expect(refs[1].questionType).toBe('cloze');
      expect(refs[1].question.map((r) => r.blockId)).toEqual(
        kind === 'instructed' ? ['instruction', 'fresh'] : ['fresh'],
      );
      expect(p.questions[1].blanks?.map((b) => b.answer)).toEqual(
        kind === 'wrapped-keys' ? [['D'], ['C']] : [['B'], ['A']],
      );
      expect(
        p.questions[1].blanks?.map((b) => b.candidates?.map((o) => text(o.label).trim())),
      ).toEqual([
        ['cats', 'dogs', 'pigs', 'cows'],
        ['black', 'white', 'red', 'blue'],
      ]);
      expect(refs[1].blanks?.[0].candidates?.flatMap((o) => o.label.map((r) => r.blockId))).toEqual(
        ['new3', 'new3', 'new3wrap', 'new3wrap'],
      );
      expect(refs[1].blanks?.[1].candidates?.flatMap((o) => o.label.map((r) => r.blockId))).toEqual(
        ['new4', 'new4', 'new4wrap', 'new4wrap'],
      );
      expect(refs[1].options).toBeUndefined();
    },
  );

  it.each(['E．pigs\tF．cows', 'C．pigs\tE．cows', 'A．pigs\tB．cows'])(
    'retains an unsupported row continuation without assigning it to the wrong blank: %s',
    (continuation) => {
      const sources = [
        ...oldCloze(),
        marked('fresh', [3, 4], longMaterial),
        block('new3', '3．A．cats\tB．dogs'),
        block('unsupported', continuation),
        block('new4', '4．A．black\tB．white'),
        block('key', '【答案】3．B 4．A'),
      ];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(refs).toHaveLength(2);
      expect(
        p.questions[1].blanks?.map((b) => b.candidates?.map((o) => text(o.label).trim())),
      ).toEqual([
        ['cats', 'dogs'],
        ['black', 'white'],
      ]);
      expect(
        refs[1].blanks?.every((b) =>
          b.candidates?.every((o) => o.label.every((r) => r.blockId !== 'unsupported')),
        ),
      ).toBe(true);
      expect(
        projected(
          sources,
          refs[1].options!.flatMap((o) => o.label),
        ),
      ).toContain('pigs');
      expect(
        projected(
          sources,
          refs[1].options!.flatMap((o) => o.label),
        ),
      ).toContain('cows');
      expect(p.questions[1].blanks?.map((b) => b.answer)).toEqual([['B'], ['A']]);
    },
  );

  const legacyBanks = [
    { name: 'text keys', pool: 'A．apples\tB．pears\tC．milk', key: '1．apples    2．pears' },
    { name: 'lowercase pool', pool: 'a．apples\tb．pears\tc．milk', key: '1．A    2．B' },
    { name: 'lowercase keys', pool: 'A．apples\tB．pears\tC．milk', key: '1．a    2．b' },
    { name: 'sparse pool', pool: 'A．apples\tC．pears', key: '1．A    2．C' },
    { name: 'outside key', pool: 'A．apples\tB．pears', key: '1．A    2．D' },
    { name: 'small pool', pool: 'A．apples', key: '1．A    2．A' },
    {
      name: 'letter with word',
      pool: 'A．apples\tB．pears\tC．milk',
      key: '1．A apples    2．B pears',
    },
    {
      name: 'letter with parentheses',
      pool: 'A．apples\tB．pears\tC．milk',
      key: '1．A (apples)    2．B (pears)',
    },
  ];
  it.each(legacyBanks)('preserves instructed fill fallback for $name', ({ pool, key }) => {
    for (const consecutive of [false, true]) {
      const labels = consecutive ? [3, 4] : [1, 2];
      const actualKey = consecutive ? key.replace(/1．/g, '3．').replace(/2．/g, '4．') : key;
      const sources = [
        ...(consecutive ? oldCloze() : []),
        block('instruction', '阅读短文，从方框中选择合适的单词填空。'),
        marked('passage', labels, 'Tom likes '),
        block('bank', pool),
        block('key', `【答案】${actualKey}`),
      ];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(refs).toHaveLength(consecutive ? 2 : 1);
      const q = refs.at(-1)!;
      expect(q.questionType).toBe('fill_in_the_blank');
      expect(q.question.map((r) => r.blockId)).toEqual(['instruction', 'passage']);
      expect(projected(sources, q.answer)).toBe(actualKey);
      expect(q.blanks?.map((b) => b.sourceLabel)).toEqual(labels.map(String));
      expect(q.blanks?.every((b) => b.candidates === undefined)).toBe(true);
      expect(q.options?.flatMap((o) => o.label.map((r) => r.blockId))).not.toEqual([]);
      expect(p.questions.at(-1)?.question_type).toBe('fill_in_the_blank');
      if (consecutive)
        expect(refs[0].analysis.map((r) => r.blockId)).toEqual(['oldAnalysis1', 'oldAnalysis2']);
    }
  });

  const incompleteOld = (state: string): WordSourceBlock[] => [
    ...oldCloze().slice(0, 5),
    ...(state === 'analysis'
      ? [block('unenumerated', '【解析】This original explanation has no numbered endings.')]
      : []),
  ];
  it.each(['answer', 'analysis'])(
    'preserves a proved instructed legacy group after only previous %s',
    (state) => {
      for (const native of [false, true]) {
        const passage = marked('passage', [3, 4], 'Tom likes apples. Ann likes pears. ');
        const body = native ? table('passage', [passage]) : passage;
        const sources = [
          ...incompleteOld(state),
          block(
            'instruction',
            native
              ? '根据短文内容，从A—C选项中选出两个适当的选项补全短文。'
              : '阅读短文，从方框中选择合适的单词填空。',
          ),
          body,
          block(
            'bank',
            'A．The cat likes apples.\tB．The dog likes pears.\tC．The bird likes milk.',
          ),
          block('key', '【答案】3．A 4．B'),
        ];
        const refs = fastWordReferences(sources);
        const p = parse(sources);
        expect(refs).toHaveLength(2);
        expect(refs[1].questionType).toBe(native ? 'short_answer' : 'fill_in_the_blank');
        expect(refs[1].question.map((r) => r.blockId)).toEqual(['instruction', 'passage']);
        expect(refs[1].options?.map((o) => o.sourceLabel)).toEqual(['A', 'B', 'C']);
        expect(projected(sources, refs[1].answer)).toBe('3．A 4．B');
        expect(refs[0].answer.map((r) => r.blockId)).toEqual(['oldKey']);
        expect(refs[0].analysis.map((r) => r.blockId)).toEqual(
          state === 'analysis' ? ['unenumerated'] : [],
        );
        expect(p.questions[0].blanks?.map((b) => b.answer)).toEqual([['A'], ['B']]);
        if (native) expect(p.questions[1].question.content).toContainEqual(body.content[0]);
        else expect(refs[1].blanks?.every((b) => b.candidates === undefined)).toBe(true);
      }
    },
  );

  it.each(['3．A apples 4．B pears', '3．A (apples) 4．B (pears)'])(
    'retains whole annotated table keys instead of a shared upgrade: %s',
    (key) => {
      for (const state of ['standalone', 'completed', 'answer', 'analysis']) {
        const labels = state === 'standalone' ? [1, 2] : [3, 4];
        const actualKey =
          state === 'standalone' ? key.replace(/3．/g, '1．').replace(/4．/g, '2．') : key;
        const body = table('passage', [
          marked('inner', labels, 'Tom likes apples. Ann likes pears. '),
        ]);
        const sources = [
          ...(state === 'standalone'
            ? []
            : state === 'completed'
              ? oldCloze()
              : incompleteOld(state)),
          block('instruction', '根据短文内容，从A—C选项中选出两个适当的选项补全短文。'),
          body,
          block(
            'bank',
            'A．The cat likes apples.\tB．The dog likes pears.\tC．The bird likes milk.',
          ),
          block('key', `【答案】${actualKey}`),
        ];
        const refs = fastWordReferences(sources);
        const p = parse(sources);
        expect(refs).toHaveLength(state === 'standalone' ? 1 : 2);
        const q = refs.at(-1)!;
        expect(q.questionType).toBe('short_answer');
        expect(q.question.map((r) => r.blockId)).toEqual(['instruction', 'passage']);
        expect(projected(sources, q.answer)).toBe(actualKey);
        expect(q.options?.map((o) => o.sourceLabel)).toEqual(['A', 'B', 'C']);
        expect(p.questions.at(-1)!.question.content).toContainEqual(body.content[0]);
      }
    },
  );

  it.each(['answer', 'analysis'])(
    'keeps the new plain shared material state boundary after previous %s',
    (state) => {
      const sources = [
        ...incompleteOld(state),
        marked('fresh', [3, 4], 'Tom likes apples. Ann likes pears. '),
        block('bank', 'A．The cat likes apples.\tB．The dog likes pears.\tC．The bird likes milk.'),
        block('key', '【答案】3．A 4．B'),
      ];
      const refs = fastWordReferences(sources);
      expect(
        refs.some(
          (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'fresh'),
        ),
      ).toBe(false);
      parse(sources);
    },
  );

  it('does not prove a new plain shared group from a letter-plus-word key prefix', () => {
    const sources = [
      ...oldCloze(),
      marked('fresh', [3, 4], 'Tom likes apples. Ann likes pears. '),
      block('bank', 'A．The cat likes apples.\tB．The dog likes pears.\tC．The bird likes milk.'),
      block('key', '【答案】3．A apples 4．B pears'),
    ];
    const refs = fastWordReferences(sources);
    expect(
      refs.some(
        (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'fresh'),
      ),
    ).toBe(false);
    parse(sources);
  });

  it.each(['1．A 2．B', '1．A 2．B 3．A 4．B'])(
    'preserves an instructed atomic table, external pool and original answer: %s',
    (key) => {
      const nativeTable = table('nativeTable', [marked('inner', [1, 2], 'Ann has a cat. ')]);
      const sources = [
        block('instruction', '读一读，选择正确的字母编号填写在横线上。'),
        nativeTable,
        block('bank', 'A．kind\tB．quiet\tC．clean'),
        block('key', `【答案】${key}`),
      ];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(refs).toHaveLength(1);
      expect(refs[0].questionType).toBe('short_answer');
      expect(refs[0].question.map((r) => r.blockId)).toEqual(['instruction', 'nativeTable']);
      expect(refs[0].blanks).toBeUndefined();
      expect(projected(sources, refs[0].answer)).toBe(key);
      expect(p.questions[0].question.content).toContainEqual(nativeTable.content[0]);
      if (key.includes('3．'))
        expect(p.diagnostics.some((d) => d.code === 'word-import.uncertain-block')).toBe(true);
      expect(refs[0].options?.map((o) => o.sourceLabel)).toEqual(['A', 'B', 'C']);
    },
  );

  it('preserves the instructed word-bank fallback when a bank precedes further slots', () => {
    const sources = [
      ...oldCloze(),
      block('instruction', '阅读短文，从方框中选择合适的单词填空。'),
      marked('first', [3], 'Ann has a cat. '),
      block('bank', 'A．apples\tB．pears\tC．milk'),
      marked('second', [4], 'She likes her pet. '),
      block('key', '【答案】3．A 4．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].questionType).toBe('fill_in_the_blank');
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['instruction', 'first', 'second']);
    expect(refs[1].blanks?.map((b) => b.sourceLabel)).toEqual(['3', '4']);
    expect(refs[1].blanks?.every((b) => b.candidates === undefined)).toBe(true);
    expect(refs[1].options?.map((o) => o.sourceLabel)).toEqual(['A', 'B', 'C']);
    parse(sources);
  });

  it('retains a fully proved atomic-table sentence-completion bank in the exchange stem', () => {
    const nativeTable = table('nativeTable', [marked('inner', [1, 2], longMaterial)]);
    const sources = [
      block('instruction', '根据短文内容，从短文后的A—C选项中，选出2个适当的选项补全短文。'),
      nativeTable,
      block('bankA', 'A．The children like the farm.'),
      block('bankB', 'B．They spend their holidays there.'),
      block('bankC', 'C．The school is near the farm.'),
      block('key', '【答案】1．A 2．B'),
    ];
    const refs = fastWordReferences(sources);
    const p = parse(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].questionType).toBe('short_answer');
    expect(refs[0].question.map((r) => r.blockId)).toEqual([
      'instruction',
      'nativeTable',
      'bankA',
      'bankB',
      'bankC',
    ]);
    expect(refs[0].options).toBeUndefined();
    expect(refs[0].blanks).toBeUndefined();
    expect(p.questions[0].question.content).toContainEqual(nativeTable.content[0]);
    expect(p.diagnostics.some((d) => d.code === 'word-import.unexpected-options')).toBe(false);
    expect(projected(sources, refs[0].answer)).toBe('1．A 2．B');
  });

  it('still rejects the corresponding unordered bank on the new plain structural path', () => {
    const sources = [
      ...oldCloze(),
      marked('first', [3], longMaterial),
      block('bank', 'A．apples\tB．pears\tC．milk'),
      marked('second', [4], 'She likes her pet. '),
      block('key', '【答案】3．A 4．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(
      refs.some(
        (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'first'),
      ),
    ).toBe(false);
    parse(sources);
  });
});

describe('Grade seven English source-proven exercise boundaries', () => {
  it.each(['short', 'long', 'leading-image'])(
    'owns fresh numbered candidate cloze after an existing solution: %s',
    (kind) => {
      const fresh = marked('fresh', [3, 4], kind === 'long' ? longMaterial : 'Ann likes ');
      const sources = [
        ...oldCloze(),
        ...(kind === 'leading-image'
          ? [
              {
                id: 'freshImage',
                content: [{ type: 'image', attrs: { sourceMediaId: 'farm' } }],
              } satisfies WordSourceBlock,
            ]
          : []),
        fresh,
        block('new3', '3．A．cats\tB．dogs'),
        block('new4', '4．A．black\tB．white'),
        block('newMarker', '【答案】'),
        block('newKey', '3．B    4．A'),
        block('newAnalysis3', '【详解】3．First fresh explanation.'),
        block('newAnalysis4', '4．Final fresh explanation.'),
      ];
      const p = parse(sources);
      expect(p.questions).toHaveLength(2);
      expect(p.questions.map((q) => q.blanks?.map((b) => b.answer))).toEqual([
        [['A'], ['B']],
        [['B'], ['A']],
      ]);
      expect(text(p.questions[0].analysis)).not.toContain('Ann likes');
      expect(text(p.questions[0].analysis)).not.toContain('holidays');
      expect(text(p.questions[1].analysis)).toContain('Final fresh explanation');
      expect(text(p.questions[1].question)).toContain(kind === 'long' ? 'holidays' : 'Ann likes');
      expect(p.questions[1].blanks?.[0].candidates?.map((o) => text(o.label).trim())).toEqual([
        'cats',
        'dogs',
      ]);
      if (kind === 'leading-image') {
        expect(JSON.stringify(p.questions[1].question)).toContain('farm');
        expect(JSON.stringify(p.questions[0].analysis)).not.toContain('farm');
      }
    },
  );

  it.each(['short', 'long', 'table', 'image-only-table'])(
    'owns plain reading material and its exact keys without an instruction: %s',
    (kind) => {
      const group = reading();
      if (kind === 'long') group[0] = block('rmaterial', longMaterial);
      if (kind === 'table') group[0] = table('rmaterial', [block('cell', longMaterial)]);
      if (kind === 'image-only-table')
        group[0] = table('rmaterial', [
          { id: 'cell', content: [{ type: 'image', attrs: { sourceMediaId: 'reading-photo' } }] },
        ]);
      if (kind === 'image-only-table')
        group.splice(1, 0, block('photoCaption', 'Ann has a cat. It is white. She likes her pet.'));
      const sources = [...oldCloze(), block('readingHeading', '二、阅读理解'), ...group];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(p.questions).toHaveLength(2);
      expect(p.questions[1].sub_problems.map((q) => q.answer)).toEqual([['A'], ['B']]);
      expect(p.questions[1].sub_problems.map((q) => q.question_type)).toEqual([
        'single_choice',
        'single_choice',
      ]);
      expect(refs[1].question.map((r) => r.blockId)).toContain('rmaterial');
      expect(refs[1].children[0].analysis.map((r) => r.blockId)).toEqual(['ranalysis1']);
      expect(refs[1].children[1].analysis.map((r) => r.blockId)).toEqual(['ranalysis2']);
      if (kind.includes('table'))
        expect(p.questions[1].question.content).toContainEqual(group[0].content[0]);
    },
  );

  it('bounds consecutive plain reading groups without routing later material into earlier analyses', () => {
    const sources = [block('heading', '阅读理解'), ...reading(), ...reading('next', [5, 6])];
    const refs = fastWordReferences(sources);
    const p = parse(sources);
    expect(p.questions).toHaveLength(2);
    expect(p.questions.flatMap((q) => q.sub_problems.map((c) => c.answer))).toEqual([
      ['A'],
      ['B'],
      ['A'],
      ['B'],
    ]);
    expect(refs[0].children[1].analysis.map((r) => r.blockId)).toEqual(['ranalysis2']);
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['nextmaterial']);
  });

  it.each(['1．A', '2．B    1．A', '1．A    1．B', '1．A    3．B', '1．A    2．'])(
    'does not prove a plain reading group from partial or mismatched keys: %s',
    (keys) => {
      const sources = reading('r', [1, 2]);
      sources[5] = block('rkey', `【答案】${keys}`);
      const refs = fastWordReferences(sources);
      expect(refs.some((q) => q.children.map((c) => c.sourceLabel).join(',') === '1,2')).toBe(
        false,
      );
      const p = parse(sources);
      expect(text(p.questions.map((q) => q.question))).toContain('Ann has a cat');
    },
  );

  it('keeps long ordinary analysis with numeric prose on its original source owner', () => {
    const sources = [
      block('q', '1．Choose a colour.'),
      block('pool', 'A．red\tB．blue'),
      block('key', '【答案】A'),
      block('analysis', '【详解】The author describes the school.'),
      block('prose', `${longMaterial}The pupils in Class 4. meet in Room 3. every day.`),
      block('next', '2．What is your name?'),
      block('nextKey', '【答案】Ann'),
    ];
    const refs = fastWordReferences(sources);
    const p = parse(sources);
    expect(p.questions).toHaveLength(2);
    expect(refs[0].analysis.map((r) => r.blockId)).toEqual(['analysis', 'prose']);
    expect(text(p.questions[0].analysis)).toContain('Class 4.');
    expect(p.questions[0].answer).toEqual(['A']);
    expect(text(p.questions[1].answer)).toBe('Ann');
  });

  it('keeps quoted marked blanks in long analysis before a different real task range', () => {
    const sources = [
      ...oldCloze(),
      marked('quoted', [3, 4], `The explanation quotes a worksheet passage. ${longMaterial}`),
      ...reading('next', [5, 6]).slice(1),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('quoted');
    expect(refs.some((q) => q.question.some((r) => r.blockId === 'quoted'))).toBe(false);
    const p = parse(sources);
    expect(text(p.questions[0].analysis)).toContain('The explanation quotes a worksheet passage.');
    expect(p.questions[0].blanks?.map((b) => b.answer)).toEqual([['A'], ['B']]);
  });

  it.each(['no choices', 'one incomplete pool', 'ordinary numbered analysis'])(
    'does not prove a plain English reading group from exact keys with %s',
    (kind) => {
      const sources = [
        block(
          'material',
          kind === 'ordinary numbered analysis'
            ? `${longMaterial}This paragraph explains the previous answer.`
            : 'Ann has a cat. It is white.',
        ),
        block(
          'q1',
          kind === 'ordinary numbered analysis'
            ? '1．Ann lives in the country.'
            : '1．Who has a cat?',
        ),
        ...(kind === 'one incomplete pool' ? [block('o1', 'A．Ann')] : []),
        block(
          'q2',
          kind === 'ordinary numbered analysis'
            ? '2．The cat is white.'
            : '2．What colour is the cat?',
        ),
        block('key', '【答案】1．A    2．B'),
      ];
      const refs = fastWordReferences(sources);
      expect(refs.some((q) => q.children.map((c) => c.sourceLabel).join(',') === '1,2')).toBe(
        false,
      );
      const p = parse(sources);
      expect(text(p.questions.map((q) => q.question))).toContain(
        kind === 'ordinary numbered analysis' ? 'This paragraph explains' : 'Ann has a cat',
      );
    },
  );
});

describe('Grade seven English shared sentence choices and atomic tables', () => {
  const pool = [
    block('poolA', 'A．The cat is white.'),
    block('poolB', 'B．Ann likes cats.'),
    block('poolC', 'C．It lives on a farm.'),
  ];
  it.each(['plain', 'instruction', 'long'])(
    'owns marked sentence blanks with their full shared letter pool: %s',
    (kind) => {
      const sources = [
        ...oldCloze(),
        ...(kind === 'instruction'
          ? [block('instruction', '请根据短文内容，从下面方框中选出两个可以填入空白处的最佳选项。')]
          : []),
        marked('fresh', [3, 4], kind === 'long' ? longMaterial : 'Ann has a cat. '),
        ...pool,
        block('key', '【答案】3．B    4．A'),
        block('x3', '【详解】3．The first new blank.'),
        block('x4', '4．The last new blank.'),
      ];
      const p = parse(sources);
      expect(p.questions).toHaveLength(2);
      expect(p.questions[1].blanks?.map((b) => b.answer)).toEqual([['B'], ['A']]);
      expect(
        p.questions[1].blanks?.map((b) => b.candidates?.map((c) => text(c.label).trim())),
      ).toEqual([
        ['The cat is white.', 'Ann likes cats.', 'It lives on a farm.'],
        ['The cat is white.', 'Ann likes cats.', 'It lives on a farm.'],
      ]);
      expect(text(p.questions[0].analysis)).not.toContain('Ann has a cat');
      expect(text(p.questions[1].analysis)).toContain('The last new blank');
      expect(p.questions[1].has_answer).toBe(true);
      if (kind === 'instruction') {
        expect(text(p.questions[1].question)).toContain('选出两个可以填入');
        expect(text(p.questions[0].analysis)).not.toContain('选出两个可以填入');
      }
    },
  );

  it('does not manufacture letter candidates for a labeled passage without a choice pool', () => {
    const sources = [
      marked('material', [1, 2], 'Ann has a cat. '),
      block('key', '【答案】1．A    2．B'),
    ];
    const p = parse(sources);
    expect(p.questions.flatMap((q) => q.blanks || []).every((b) => !b.candidates?.length)).toBe(
      true,
    );
  });

  it('retains a plain native table with internal blanks as one full-answer fallback', () => {
    const material = table('native', [
      { id: 'image', content: [{ type: 'image', attrs: { sourceMediaId: 'three-students' } }] },
      marked('internal', [3, 4], longMaterial),
    ]);
    const sources = [
      ...oldCloze(),
      material,
      ...pool,
      block('key', '【答案】3．B    4．A'),
      block('x3', '【详解】3．First table explanation.'),
      block('x4', '4．Final table explanation.'),
    ];
    const refs = fastWordReferences(sources);
    const p = parse(sources);
    expect(p.questions).toHaveLength(2);
    expect(p.questions[1].question_type).toBe('short_answer');
    expect(p.questions[1].blanks).toBeUndefined();
    expect(p.questions[1].sub_problems).toEqual([]);
    expect(p.questions[1].question.content).toContainEqual(material.content[0]);
    expect(text(p.questions[1].question)).toContain('Ann likes cats');
    expect(text(p.questions[1].answer)).toBe('3．B    4．A');
    expect(projected(sources, refs[1].analysis)).toContain('Final table explanation');
    expect(p.questions[1].has_answer).toBe(true);
  });

  it.each(
    ['cloze', 'shared', 'table'].flatMap((kind) =>
      ['3．B', '4．A    3．B', '3．B    3．A', '3．B    4．'].map((key) => ({ kind, key })),
    ),
  )('requires complete ordered nonempty new $kind keys: $key', ({ kind, key }) => {
    const material = marked('fresh', [3, 4], longMaterial);
    const sources = [
      ...oldCloze(),
      kind === 'table' ? table('fresh', [material]) : material,
      ...(kind === 'cloze'
        ? [block('o3', '3．A．first\tB．second'), block('o4', '4．A．third\tB．fourth')]
        : pool),
      block('key', `【答案】${key}`),
    ];
    const refs = fastWordReferences(sources);
    expect(
      refs.some(
        (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'fresh'),
      ),
    ).toBe(false);
  });

  it.each([
    { name: 'discontinuous', choices: 'A．one\tC．two\tD．three', key: '3．A    4．C' },
    { name: 'duplicate', choices: 'A．one\tB．two\tB．three', key: '3．A    4．B' },
    { name: 'lowercase', choices: 'a. one\tb. two\tc. three', key: '3．A    4．B' },
    { name: 'outside pool', choices: 'A．one\tB．two\tC．three', key: '3．D    4．B' },
    { name: 'unlabelled words', choices: 'one two three', key: '3．A    4．B' },
  ])('does not prove a new shared pool with $name', ({ choices, key }) => {
    const sources = [
      ...oldCloze(),
      marked('fresh', [3, 4], longMaterial),
      block('pool', choices),
      block('key', `【答案】${key}`),
    ];
    const refs = fastWordReferences(sources);
    expect(
      refs.some(
        (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'fresh'),
      ),
    ).toBe(false);
  });

  it('does not treat a bank before marked blanks as a new trailing sentence pool', () => {
    const sources = [
      ...oldCloze(),
      block('leadingPool', 'A．one\tB．two\tC．three'),
      marked('fresh', [3, 4], longMaterial),
      block('key', '【答案】3．A    4．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(
      refs.some(
        (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'fresh'),
      ),
    ).toBe(false);
  });
});

describe('Grade seven English bounded structural proof and lookahead', () => {
  it.each([
    'On Friday afternoon, Tom meets his good friend Jack and says, “Jack, can you come to my home after school? I want you to meet my cousin. He loves the same ball game as you.” Jack says happily, “Sure.”',
    `${longMaterial}Look! Mrs. Green comes and says, “Good morning. Boys and girls, I am your new English teacher. Nice to meet you!”`,
  ])('keeps multi-sentence story speech as proven new material: %s', (material) => {
    const group = reading();
    group[0] = block('rmaterial', material);
    const sources = [...oldCloze(), ...group];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).not.toContain('rmaterial');
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial']);
    expect(parse(sources).questions[1].sub_problems.map((q) => q.answer)).toEqual([['A'], ['B']]);
  });

  it.each([
    'Ann said, "The cat likes the farm."',
    '“That’s enough!” his mother says, “Clean up these books and get to bed!”',
  ])('keeps a genuine dialogue paragraph after proven material: %s', (dialogue) => {
    const group = reading();
    group.splice(1, 0, block('dialogue', dialogue));
    const sources = [...oldCloze(), ...group];
    const refs = fastWordReferences(sources);
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial', 'dialogue']);
    expect(text(parse(sources).questions[1].question)).toContain(dialogue);
  });

  it.each(['paragraph', 'table'])(
    'keeps real post-%s reading instructions and the entire source material',
    (kind) => {
      for (const instruction of [
        '根据材料内容选择最佳答案。',
        '根据材料内容选择最佳答案，并在答题卡上将该项涂黑。',
        '根据短文内容选择最佳答案。',
        '根据文章内容选出正确答案。',
      ]) {
        const group = reading();
        if (kind === 'table') group[0] = table('rmaterial', [block('cell', longMaterial)]);
        group.splice(1, 0, block('instruction', instruction));
        const sources = [...oldCloze(), ...group];
        const refs = fastWordReferences(sources);
        expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial', 'instruction']);
        const p = parse(sources);
        expect(p.questions[1].sub_problems.map((q) => q.answer)).toEqual([['A'], ['B']]);
        expect(text(p.questions[1].question)).toContain(instruction);
        if (kind === 'table')
          expect(p.questions[1].question.content).toContainEqual(group[0].content[0]);
      }
    },
  );

  it.each([
    'Ann said, "The cat likes the farm."',
    'Ann said: "The cat likes the farm."',
    "Ann said 'The cat likes the farm.'",
    'Ann says, “The cat likes the farm.”',
    "Ann SAYS: 'The cat likes the farm.'",
    'Ann wrote: ‘The cat likes the farm.’',
    'This sentence explains the original answer.',
    'This paragraph explains the previous solution.',
  ])('retains a finite explicit English analysis continuation: %s', (continuation) => {
    const sources = [...oldCloze(), block('continuation', continuation), ...reading()];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('continuation');
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial']);
    const p = parse(sources);
    expect(text(p.questions[0].analysis)).toContain(continuation);
  });

  it.each(['image', 'instruction'])(
    'keeps a leading %s and intervening explicit Chinese analysis on the old owner',
    (kind) => {
      const prefix: WordSourceBlock =
        kind === 'image'
          ? { id: 'prefix', content: [{ type: 'image', attrs: { sourceMediaId: 'old-photo' } }] }
          : block('prefix', '请从下列选项中选出正确答案。');
      const sources = [
        ...oldCloze(),
        prefix,
        block('note', '根据上文可知，这是原题的补充解析。'),
        ...reading(),
      ];
      const refs = fastWordReferences(sources);
      expect(refs[0].analysis.map((r) => r.blockId)).toEqual([
        'oldAnalysis1',
        'oldAnalysis2',
        'prefix',
        'note',
      ]);
      expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial']);
      const p = parse(sources);
      expect(text(p.questions[0].analysis)).toContain('补充解析');
      if (kind === 'image') expect(JSON.stringify(p.questions[0].analysis)).toContain('old-photo');
    },
  );

  it('retains a quoted analysis continuation after an unproven leading image', () => {
    const sources = [
      ...oldCloze(),
      {
        id: 'prefix',
        content: [{ type: 'image', attrs: { sourceMediaId: 'old-photo' } }],
      } satisfies WordSourceBlock,
      block('note', 'Ann wrote, “The cat likes the farm.”'),
      ...reading(),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('prefix');
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('note');
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial']);
    parse(sources);
  });

  it('rejects a same-block bank before numbered slots and retains its full source', () => {
    const malformed = marked(
      'badPool',
      [3, 4],
      'A．The cat is white.\tB．Ann likes cats.\tC．It lives on a farm. ',
    );
    const sources = [
      ...oldCloze(),
      block('intro', 'Ann has a cat. It is white. She likes her pet very much.'),
      malformed,
      block('key', '【答案】3．A    4．B'),
    ];
    const refs = fastWordReferences(sources);
    const owner = refs.find((q) =>
      [...q.question, ...q.analysis].some((r) => r.blockId === 'badPool'),
    );
    expect(owner).toBeDefined();
    expect(
      refs.some(
        (q) => q.sourceLabel === undefined && q.question.some((r) => r.blockId === 'intro'),
      ),
    ).toBe(false);
    expect(projected(sources, [...owner!.question, ...owner!.analysis])).toContain(
      sourceText(malformed.content),
    );
    parse(sources);
  });

  it.each(['separated', 'touching'])(
    'retains same-block slots before a %s trailing bank with exact source ranges',
    (placement) => {
      const combined = marked('combined', [3, 4], 'Ann has a cat. ');
      if (placement === 'touching') combined.content.pop();
      combined.content.push({
        type: 'text',
        text: `${placement === 'separated' ? '\n' : ''}A．The cat is white.\tB．Ann likes cats.\tC．It lives on a farm.`,
      });
      const sources = [
        ...oldCloze(),
        block('intro', 'Ann has a cat. It is white. She likes her pet very much.'),
        combined,
        block('key', '【答案】3．A    4．B'),
      ];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(refs).toHaveLength(2);
      expect(p.questions[1].blanks?.map((blank) => blank.answer)).toEqual([['A'], ['B']]);
      expect(
        p.questions[1].blanks?.map((blank) => blank.candidates?.map((o) => text(o.label).trim())),
      ).toEqual([
        ['The cat is white.', 'Ann likes cats.', 'It lives on a farm.'],
        ['The cat is white.', 'Ann likes cats.', 'It lives on a farm.'],
      ]);
      const retained = projected(sources, refs[1].question);
      expect(retained).toContain('3    ');
      expect(retained).toContain('4    ');
      expect(retained).not.toContain('A．The cat');
      expect(refs[1].blanks?.every((blank) => blank.marker.blockId === 'combined')).toBe(true);
    },
  );

  it.each([
    'Ann said hello to her friend and then they visited the farm.',
    'The children wrote postcards to their parents during the holidays.',
    'The answer to the mystery was hidden inside the box.',
  ])('retains ordinary English story material: %s', (material) => {
    const group = reading();
    group[0] = block('rmaterial', material);
    const sources = [...oldCloze(), ...group];
    const refs = fastWordReferences(sources);
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['rmaterial']);
    expect(parse(sources).questions[1].sub_problems.map((q) => q.answer)).toEqual([['A'], ['B']]);
  });

  const completedChoice = (solution = 'The previous solution ends here. 故选D。') => [
    block('previousQuestion', '30．Choose the correct answer.'),
    block('previousOptions', 'A．one\tB．two\tC．three\tD．four'),
    block('previousKey', '【答案】D'),
    block('previousSolution', `【详解】${solution}`),
  ];

  it('owns an adjacent speaker attribution with the proven reading after a completed solution', () => {
    const sources = [
      ...completedChoice(),
      block('speaker', 'Akane, Canada'),
      ...reading('new', [31, 32]),
    ];
    const refs = fastWordReferences(sources);
    const p = parse(sources);
    expect(refs).toHaveLength(2);
    expect(refs[0].analysis.map((r) => r.blockId)).toEqual(['previousSolution']);
    expect(refs[1].question.map((r) => r.blockId)).toEqual(['speaker', 'newmaterial']);
    expect(text(p.questions[1].question)).toContain('Akane, Canada');
    expect(p.questions[1].sub_problems.map((q) => q.answer)).toEqual([['A'], ['B']]);
  });

  it.each(['31．A', '32．B    31．A'])(
    'does not move a speaker attribution before an incomplete or disordered reading key: %s',
    (keys) => {
      const group = reading('new', [31, 32]);
      group[5] = block('newkey', `【答案】${keys}`);
      const sources = [...completedChoice(), block('speaker', 'Akane, Canada'), ...group];
      const refs = fastWordReferences(sources);
      expect(refs[0].analysis.map((r) => r.blockId)).toContain('speaker');
      expect(refs.some((q) => q.question.some((r) => r.blockId === 'speaker'))).toBe(false);
      parse(sources);
    },
  );

  it('does not move a speaker attribution after an unfinished solution', () => {
    const sources = [
      ...completedChoice('This explanation continues in the next paragraph.'),
      block('speaker', 'Akane, Canada'),
      ...reading('new', [31, 32]),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('speaker');
    expect(refs.some((q) => q.question.some((r) => r.blockId === 'speaker'))).toBe(false);
    parse(sources);
  });

  it('keeps a quoted speaker continuation in the previous analysis', () => {
    const sources = [
      ...oldCloze(),
      block('speakerQuote', 'Ann said "Akane, Canada".'),
      ...reading(),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('speakerQuote');
    expect(refs.find((q) => q.children.length === 2)?.question.map((r) => r.blockId)).toEqual([
      'rmaterial',
    ]);
    parse(sources);
  });

  it('does not treat uppercase mathematics labels as a speaker attribution', () => {
    const sources = [
      ...completedChoice(),
      block('mathComma', 'AB, AC'),
      ...reading('new', [31, 32]),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('mathComma');
    expect(refs.some((q) => q.question.some((r) => r.blockId === 'mathComma'))).toBe(false);
    parse(sources);
  });

  it('leaves the previous final analysis quote continuation with its original owner', () => {
    const sources = [
      ...oldCloze(),
      block('quote', 'Ann said "The cat likes the farm."'),
      ...reading(),
    ];
    const refs = fastWordReferences(sources);
    const p = parse(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('quote');
    expect(refs.find((q) => q.children.length === 2)?.question.map((r) => r.blockId)).toEqual([
      'rmaterial',
    ]);
    expect(text(p.questions[0].analysis)).toContain('Ann said');
  });

  it('keeps a numbered final cloze analysis when lookahead finds the next proven exercise', () => {
    const sources = [
      ...oldCloze().slice(0, -1),
      block('last', '2．The last explanation has no formal marker.'),
      ...reading(),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].analysis.map((r) => r.blockId)).toContain('last');
    const p = parse(sources);
    expect(p.questions[0].blanks?.map((b) => b.answer)).toEqual([['A'], ['B']]);
    expect(p.questions[1].sub_problems.map((q) => q.answer)).toEqual([['A'], ['B']]);
  });

  it('retains the established mathematics ABC material behavior', () => {
    const sources = [
      block('material', '△ABC，AB = AC，求下列各题。'),
      block('q1', '1．求角A。'),
      block('o1', 'A．30°\tB．60°'),
      block('q2', '2．求角B。'),
      block('o2', 'A．30°\tB．60°'),
      block('key', '【答案】1．A    2．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs.some((q) => q.children.length === 2)).toBe(false);
    expect(projected(sources, refs[0].question)).toBe('△ABC，AB = AC，求下列各题。');
  });
});

describe('Grade seven English lowercase facts followed by real combination choices', () => {
  it.each(['separate', 'inline'])(
    'keeps the lowercase facts in the question and only the proven final uppercase pool: %s',
    (placement) => {
      const facts =
        placement === 'separate'
          ? [
              block('factA', 'a. grow carrots'),
              block('factB', 'b. teach pupils'),
              block('factC', 'c. grow beans'),
              block('factD', 'd. take photos'),
            ]
          : [
              block('factAB', 'a. grow carrots    b. teach pupils'),
              block('factCD', 'c. grow beans    d. take photos'),
            ];
      const sources = [
        block('q', '21．What do the students do on the farm?'),
        ...facts,
        block('realPool', 'A．a,b\tB．b,c\tC．a,d\tD．c,d'),
        block('key', '【答案】B'),
      ];
      const refs = fastWordReferences(sources);
      const p = parse(sources);
      expect(p.questions[0].options?.map((o) => text(o.label).trim())).toEqual([
        'a,b',
        'b,c',
        'a,d',
        'c,d',
      ]);
      expect(p.questions[0].answer).toEqual(['B']);
      for (const b of facts) expect(refs[0].question.map((r) => r.blockId)).toContain(b.id);
      expect(text(p.questions[0].question)).toContain('a. grow carrots');
      expect(text(p.questions[0].question)).toContain('d. take photos');
      expect(refs[0].options?.every((o) => o.label.every((r) => r.blockId === 'realPool'))).toBe(
        true,
      );
    },
  );

  it('preserves a normal lowercase-only choice pool', () => {
    const p = parse([
      block('q', '1．Which colour?'),
      block('pool', 'a. red\tb. blue\tc. white\td. black'),
      block('key', '【答案】b'),
    ]);
    expect(p.questions[0].options?.map((o) => text(o.label).trim())).toEqual([
      'red',
      'blue',
      'white',
      'black',
    ]);
    expect(p.questions[0].answer).toEqual(['B']);
  });

  it('preserves an established mixed-case pool', () => {
    const p = parse([
      block('q', '1．Which colour?'),
      block('pool', 'a. red\tB. blue\tc. white\tD. black'),
      block('key', '【答案】B'),
    ]);
    expect(p.questions[0].options?.map((o) => text(o.label).trim())).toEqual([
      'red',
      'blue',
      'white',
      'black',
    ]);
    expect(p.questions[0].answer).toEqual(['B']);
  });

  it('does not silently discard a preceding lowercase pool when the later pool lacks combination proof', () => {
    const sources = [
      block('q', '1．Which colour?'),
      block('lower', 'a. red\tb. blue\tc. white\td. black'),
      block('upper', 'A．one\tB．two\tC．three\tD．four'),
      block('key', '【答案】B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].options).toHaveLength(8);
    expect(projected(sources, refs[0].question)).not.toContain('a. red');
  });

  it('does not duplicate a block that combines lowercase facts and uppercase choices', () => {
    const sources = [
      block('q', '1．What do the pupils do?'),
      block(
        'combined',
        'a. grow carrots    b. teach pupils    c. grow beans    d. take photos\nA．ab\tB．bc\tC．ad\tD．cd',
      ),
      block('key', '【答案】B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].question.some((r) => r.blockId === 'combined')).toBe(false);
    expect(refs[0].options).toHaveLength(8);
    expect(projected(sources, refs[0].question)).toBe('What do the pupils do?');
  });
});
