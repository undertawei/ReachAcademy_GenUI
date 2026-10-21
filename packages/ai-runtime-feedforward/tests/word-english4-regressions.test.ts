import { describe, expect, it } from 'vitest';
import {
  fastWordReferences as rawFastWordReferences,
  parseWordFast as rawParseWordFast,
  sourceText,
  type WordSourceBlock,
  type WordSourceRange,
} from '../src/word-import/index.js';

const fastWordReferences = (sources: WordSourceBlock[]) => {
  const before = JSON.stringify(sources);
  const result = rawFastWordReferences(sources);
  expect(JSON.stringify(sources)).toBe(before);
  return result;
};
const parseWordFast = (sources: WordSourceBlock[], identity: string) => {
  const before = JSON.stringify(sources);
  const result = rawParseWordFast(sources, identity);
  expect(JSON.stringify(sources)).toBe(before);
  return result;
};

const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const projected = (blocks: WordSourceBlock[], refs: WordSourceRange[]) =>
  refs
    .map((ref) =>
      sourceText(blocks.find((item) => item.id === ref.blockId)!.content).slice(ref.start, ref.end),
    )
    .join('\n');
const marked = (id: string, prefix: string, suffix = '.'): WordSourceBlock => ({
  id,
  content: [
    { type: 'text', text: prefix },
    { type: 'text', text: '        ', marks: [{ type: 'underline' }] },
    { type: 'text', text: suffix },
  ],
});
const cloze = (id: string, labels: number[], prefix = 'Mum: Come on. '): WordSourceBlock => ({
  id,
  content: [
    { type: 'text', text: prefix },
    ...labels.flatMap((label) => [
      { type: 'text' as const, text: `    ${label}    `, marks: [{ type: 'underline' }] },
      { type: 'text' as const, text: ' word ' },
    ]),
  ],
});

describe('Grade four English conservative parser regressions', () => {
  it.each([
    'noodles',
    'pudding',
    'milk',
    'beef',
    'USA',
    'So do I',
    'Class B',
    'a.m',
    'p.m',
    'P.E',
    'U.S.A',
    'Bob',
    'Mr',
  ])('keeps sentence-final Latin suffixes inside their source option: %s', (word) => {
    const options = `A．I like ${word}.\tB．I like rice.`;
    const sources = [
      block('q', '1．Choose the correct answer.'),
      block('o', options),
      block('a', '【答案】B'),
    ];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources);
    expect(refs[0].options?.map((option) => option.sourceLabel)).toEqual(['A', 'B']);
    expect(refs[0].options?.map((option) => projected(sources, option.label))).toEqual([
      `I like ${word}.\t`,
      'I like rice.',
    ]);
    expect(refs[0].options?.[0].label).toEqual([
      { blockId: 'o', start: 2, end: options.indexOf('B．') },
    ]);
    const preview = parseWordFast(sources, `english-option-${word}`);
    expect(preview.questions[0].options).toHaveLength(2);
    expect(preview.questions[0].answer).toEqual(['B']);
    expect(JSON.stringify(sources)).toBe(before);
  });

  it.each([
    ['a. one\tb. two', ['a', 'b'], ['one\t', 'two']],
    ['A．甲B．乙', ['A', 'B'], ['甲', '乙']],
    ['A．oneB．two', ['A', 'B'], ['one', 'two']],
    ['a．oneb．two', ['a', 'b'], ['one', 'two']],
    ['A．甲C．丙', ['A', 'C'], ['甲', '丙']],
  ])('preserves established adjacent and lowercase pools: %s', (text, labels, values) => {
    const sources = [block('q', '1．Choose.'), block('o', text)];
    const options = fastWordReferences(sources)[0].options;
    expect(options?.map((option) => option.sourceLabel)).toEqual(labels);
    expect(options?.map((option) => projected(sources, option.label))).toEqual(values);
  });

  it('does not accept an empty compact suffix as the next lowercase option', () => {
    const sources = [block('q', '1．Choose.'), block('o', 'a．I see a crab.\tb．I see a dog.')];
    const options = fastWordReferences(sources)[0].options;
    expect(options?.map((option) => option.sourceLabel)).toEqual(['a', 'b']);
    expect(options?.map((option) => projected(sources, option.label))).toEqual([
      'I see a crab.\t',
      'I see a dog.',
    ]);
  });

  it.each(['a.m. today', 'p.m. today', 'P.E. lessons', 'U.S.A. today', 'Mr. Smith'])(
    'retains abbreviations inside complete option sentences: %s',
    (phrase) => {
      const sources = [block('q', '1．Choose.'), block('o', `A．It is ${phrase}.\tB．Other.`)];
      const options = fastWordReferences(sources)[0].options;
      expect(options?.map((option) => option.sourceLabel)).toEqual(['A', 'B']);
      expect(projected(sources, options![0].label)).toBe(`It is ${phrase}.\t`);
    },
  );

  it('requires the compact Latin exception to retain the original punctuation family', () => {
    const sources = [
      block('q', '1．Choose.'),
      block('o', 'a．This is Bob. He is tall.\tb．Other.'),
    ];
    const options = fastWordReferences(sources)[0].options;
    expect(options?.map((option) => option.sourceLabel)).toEqual(['a', 'b']);
    expect(projected(sources, options![0].label)).toBe('This is Bob. He is tall.\t');
  });

  it.each(['A．I.\tB．You.', 'a. a.m.\tb. p.m.', 'A．First.\tb．Second.'])(
    'keeps real source option boundaries around short labels: %s',
    (text) => {
      const sources = [block('q', '1．Choose.'), block('o', text)];
      const options = fastWordReferences(sources)[0].options;
      expect(options?.map((option) => option.sourceLabel.toUpperCase())).toEqual(['A', 'B']);
      expect(options?.every((option) => projected(sources, option.label).trim())).toBe(true);
    },
  );

  it.each(
    [0, 1, 2].flatMap((position) =>
      ['.', '．'].flatMap((separator) =>
        ['I.', 'B.', 'a.m.', 'p.m.', 'U.S.A.', 'P.E.'].map((body) => ({
          position,
          separator,
          body,
        })),
      ),
    ),
  )(
    'preserves every standalone option body at $position with $separator: $body',
    ({ position, separator, body }) => {
      const values = ['First.', 'Middle.', 'Last.'];
      values[position] = body;
      const text = values
        .map((value, index) => `${String.fromCharCode(65 + index)}${separator}${value}`)
        .join('\t');
      const sources = [
        block('q', '1．Choose.'),
        block('o', text),
        block('a', `【答案】${String.fromCharCode(65 + position)}`),
      ];
      const options = fastWordReferences(sources)[0].options;
      expect(options?.map((option) => option.sourceLabel)).toEqual(['A', 'B', 'C']);
      expect(options?.map((option) => projected(sources, option.label))).toEqual(
        values.map((value, index) => value + (index < 2 ? '\t' : '')),
      );
      expect(parseWordFast(sources, 'english-standalone-position').questions[0].answer).toEqual([
        String.fromCharCode(65 + position),
      ]);
    },
  );

  it('keeps numbered cloze analyses on the existing labeled blank owner', () => {
    const passage: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '6．Complete the passage: ' },
        ...[6, 7, 8, 9, 10].flatMap((label) => [
          { type: 'text' as const, text: String(label), marks: [{ type: 'underline' }] },
          { type: 'text' as const, text: ' word ' },
        ]),
      ],
    };
    const sources = [
      block('h', '完形填空'),
      passage,
      ...[6, 7, 8, 9, 10].map((label) => block(`o${label}`, `${label}．A．one\tB．two`)),
      block('a', '【答案】6．A 7．B 8．A 9．B 10．A'),
      block('analysis', '【解析】'),
      ...[6, 7, 8, 9, 10].map((label) =>
        block(`analysis${label}`, `${label}．Explanation ${label}.`),
      ),
      block('next', '11．A genuine later question.'),
      block('nextAnswer', '【答案】Next answer.'),
    ];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources);
    expect(refs.map((question) => question.sourceLabel)).toEqual(['6', '11']);
    expect(refs[0].blanks?.map((blank) => blank.sourceLabel)).toEqual(['6', '7', '8', '9', '10']);
    expect(refs[0].analysis.map((ref) => ref.blockId)).toEqual([
      'analysis6',
      'analysis7',
      'analysis8',
      'analysis9',
      'analysis10',
    ]);
    expect(projected(sources, refs[0].analysis)).toContain('Explanation 10.');
    expect(projected(sources, refs[1].answer)).toBe('Next answer.');
    const preview = parseWordFast(sources, 'english-numbered-cloze-analysis');
    expect(preview.questions).toHaveLength(2);
    expect(preview.questions[0].blanks?.map((blank) => blank.answer)).toEqual([
      ['A'],
      ['B'],
      ['A'],
      ['B'],
      ['A'],
    ]);
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('preserves marked leading whitespace after a main question label', () => {
    const question: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '1． ' },
        { type: 'text', text: '        ', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' (be) these your shoes?' },
      ],
    };
    const sources = [question, block('a', '【答案】Are')];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources);
    expect(refs[0].question[0].start).toBe(3);
    expect(refs[0].blanks?.map((blank) => blank.marker)).toEqual([
      { blockId: 'q', start: 3, end: 11 },
    ]);
    expect(projected(sources, refs[0].question)).toBe('         (be) these your shoes?');
    expect(projected(sources, refs[0].blanks![0].answer)).toBe('Are');
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('preserves both a leading and internal marked blank and two source answers', () => {
    const question: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '28.' },
        { type: 'text', text: '        ', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' name is Sarah. ' },
        { type: 'text', text: '        ', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' name is John. (His / Her)' },
      ],
    };
    const sources = [question, block('a', '【答案】Her    His')];
    const refs = fastWordReferences(sources);
    expect(refs[0].blanks).toHaveLength(2);
    expect(refs[0].blanks?.map((blank) => projected(sources, [blank.marker]))).toEqual([
      '        ',
      '        ',
    ]);
    expect(refs[0].blanks?.map((blank) => projected(sources, blank.answer))).toEqual([
      'Her',
      'His',
    ]);
  });

  it('keeps local analyses 1 through 7 on absolute cloze blanks 6 through 12', () => {
    const labels = [6, 7, 8, 9, 10, 11, 12];
    const sources = [
      block('h', '完形填空'),
      cloze('q', labels, '6．Complete the dialogue. '),
      ...labels.map((label) => block(`o${label}`, `${label}．A．one\tB．two`)),
      block('a', `【答案】${labels.map((label) => `${label}．A`).join(' ')}`),
      block('x1', '【详解】1．First explanation.'),
      ...[2, 3, 4, 5, 6, 7].map((label) => block(`x${label}`, `${label}．Explanation ${label}.`)),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].analysis.map((ref) => ref.blockId)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((label) => `x${label}`),
    );
    expect(refs[0].blanks?.map((blank) => projected(sources, blank.answer).trim())).toEqual(
      labels.map(() => 'A'),
    );
  });

  it('keeps a separate answer continuation on absolute owned cloze blanks', () => {
    const labels = [6, 7, 8, 9, 10];
    const sources = [
      block('h', '完形填空'),
      cloze('q', labels, 'Complete the dialogue. '),
      ...labels.map((label) => block(`o${label}`, `${label}．A．one\tB．two`)),
      block('answerMarker', '【答案】'),
      block('a', '6．A 7．B 8．A 9．B 10．A'),
      block('next', '11．A genuine later question.'),
      block('nextAnswer', '【答案】Next answer.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].sourceLabel).toBe('11');
    const preview = parseWordFast(sources, 'english-cloze-answer-continuation');
    expect(preview.questions[0].blanks?.map((blank) => blank.answer)).toEqual([
      ['A'],
      ['B'],
      ['A'],
      ['B'],
      ['A'],
    ]);
  });

  it('preserves leading marked whitespace in an existing reading child', () => {
    const sources = [
      block('p', '阅读下面短文，回答问题。'),
      block('material', 'Tom has a cat.'),
      marked('q1', '1． ', ' (be) the cat black?'),
      marked('q2', '2．It ', ' (be) white.'),
      block('a', '【答案】1．Is 2．is'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs[0].children[0].question[0].start).toBe(3);
    expect(refs[0].children[0].blanks?.[0].marker).toEqual({ blockId: 'q1', start: 3, end: 11 });
  });

  it('preserves leading marked whitespace following a native numbering prefix', () => {
    const question: WordSourceBlock = {
      ...marked('q', '1) ', ' (be) these shoes black?'),
      numbering: { level: 0, label: '1)', format: 'decimal' },
    };
    const refs = fastWordReferences([question, block('a', '【答案】Are')]);
    expect(refs[0].question[0].start).toBe(3);
    expect(refs[0].blanks?.[0].marker).toEqual({ blockId: 'q', start: 3, end: 11 });
  });

  it('retains a genuinely new question whose label overlaps an incompletely analyzed cloze blank', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('q', [6, 7], 'Complete the dialogue. '),
      block('o6', '6．A．one\tB．two'),
      block('o7', '7．A．three\tB．four'),
      block('a', '【答案】6．A 7．B'),
      block('x', '【详解】6．句意：First explanation.'),
      block('next', '7．What is your name?'),
      block('nextAnswer', '【答案】Tom.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].sourceLabel).toBe('7');
    expect(projected(sources, refs[1].answer)).toBe('Tom.');
  });

  it('retains a genuinely new overlapping question with its answer on the same source block', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('q', [6, 7]),
      block('o6', '6．A．one\tB．two'),
      block('o7', '7．A．three\tB．four'),
      block('a', '【答案】6．A 7．B'),
      block('x', '【详解】6．句意：First explanation.'),
      block('next', '7．What is your name?【答案】Tom.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(projected(sources, refs[1].answer)).toBe('Tom.');
  });

  it('pins local analysis enumeration to the blank count before a later unanswered root', () => {
    const labels = [6, 7, 8, 9, 10, 11, 12];
    const sources = [
      block('h', '完形填空'),
      cloze('q', labels),
      ...labels.map((label) => block(`o${label}`, `${label}．A．one\tB．two`)),
      block('a', `【答案】${labels.map((label) => `${label}．A`).join(' ')}`),
      block('x1', '【详解】1．Explanation 1.'),
      ...[2, 3, 4, 5, 6, 7].map((label) => block(`x${label}`, `${label}．Explanation ${label}.`)),
      block('next', '8．An unanswered later question.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].sourceLabel).toBe('8');
  });

  it('keeps one marked layout space outside the question without inventing a blank', () => {
    const question: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '1．' },
        { type: 'text', text: ' ', marks: [{ type: 'underline' }] },
        { type: 'text', text: 'A sentence.' },
      ],
    };
    const sources = [question, block('a', '【答案】Answer.')];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].question)).toBe('A sentence.');
    expect(refs[0].blanks).toBeUndefined();
  });

  it('keeps ordinary layout whitespace outside the question and does not invent a blank', () => {
    const sources = [block('q', '1．         A sentence.'), block('a', '【答案】Answer.')];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].question)).toBe('A sentence.');
    expect(refs[0].blanks).toBeUndefined();
  });
});

describe('Grade four English source-owned groups and atomic material', () => {
  it.each(
    ['.', '．'].flatMap((separator) =>
      ['marker', 'continuation'].flatMap((placement) =>
        ['【详解】', '【解析】', '【分析】', '详解：', '解析:'].map((analysis) => ({
          separator,
          placement,
          analysis,
        })),
      ),
    ),
  )(
    'closes incomplete key evidence at $analysis in $placement with $separator',
    ({ separator, placement, analysis }) => {
      const sources = [
        block('p', '阅读短文，选择正确答案。'),
        block('m', 'Tom likes apples. Ann likes pears.'),
        block('q1', '1．Who likes apples?'),
        block('o1', 'A．Tom\tB．Ann'),
        block('q2', '2．Who likes pears?'),
        block('o2', 'A．Tom\tB．Ann'),
        ...(placement === 'continuation' ? [block('marker', '【答案】')] : []),
        block(
          'partial',
          `${placement === 'marker' ? '【答案】' : ''}1${separator}A${analysis}1${separator}根据第一段 Tom likes apples. 可知选A。`,
        ),
        block('analysis2', `2${separator}根据第二段可知选B。`),
      ];
      expect(
        fastWordReferences(sources).some(
          (root) => root.children.map((child) => child.sourceLabel).join(',') === '1,2',
        ),
      ).toBe(false);
    },
  );

  it.each(
    ['.', '．'].flatMap((separator) =>
      ['marker', 'continuation'].flatMap((placement) =>
        ['【详解】', '【解析】', '【分析】', '详解：', '解析:'].map((analysis) => ({
          separator,
          placement,
          analysis,
        })),
      ),
    ),
  )(
    'accepts complete key evidence before $analysis in $placement with $separator',
    ({ separator, placement, analysis }) => {
      const sources = [
        block('p', '阅读短文，选择正确答案。'),
        block('m', 'Tom likes apples. Ann likes pears.'),
        block('q1', '1．Who likes apples?'),
        block('o1', 'A．Tom\tB．Ann'),
        block('q2', '2．Who likes pears?'),
        block('o2', 'A．Tom\tB．Ann'),
        ...(placement === 'continuation'
          ? [block('marker', '【答案】'), block('firstKey', `1${separator}A`)]
          : []),
        block(
          'complete',
          `${placement === 'marker' ? `【答案】1${separator}A    ` : ''}2${separator}B${analysis}2${separator}根据第二段可知选B。`,
        ),
      ];
      const refs = fastWordReferences(sources);
      expect(refs).toHaveLength(1);
      expect(refs[0].children.map((child) => child.sourceLabel)).toEqual(['1', '2']);
      expect(refs[0].children.map((child) => projected(sources, child.answer).trim())).toEqual([
        'A',
        'B',
      ]);
      expect(projected(sources, refs[0].children[1].analysis)).toContain('根据第二段可知选B。');
    },
  );
  it('owns a fresh reading group whose exact keys continue across multiple source paragraphs', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('old', [1, 2], 'Complete '),
      block('oo1', '1．A．one\tB．two'),
      block('oo2', '2．A．three\tB．four'),
      block('oa', '【答案】1．A 2．B'),
      block('ox', '【详解】1．Explanation.'),
      block('ox2', '2．Explanation.'),
      block('p', '阅读短文，选择正确答案。'),
      block('m', 'Ann has a cat. It is white.'),
      block('q3', '3．Who has a cat?'),
      block('o3', 'A．Ann\tB．Tom'),
      block('q4', '4．What colour is it?'),
      block('o4', 'A．black\tB．white'),
      block('marker', '【答案】'),
      block('a3', '3．A'),
      block('a4', '4．B'),
      block('x3', '【详解】3．Ann has a cat.'),
      block('x4', '4．It is white.'),
      block('next', '5．A genuine later question.'),
      block('nextAnswer', '【答案】Later answer.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(3);
    expect(projected(sources, refs[1].question)).toContain('Ann has a cat.');
    expect(refs[1].children.map((child) => projected(sources, child.answer))).toEqual(['A', 'B']);
    expect(refs[2].sourceLabel).toBe('5');
    for (const continuation of ['6．B', '3．B', '4．', '4．【详解】Unexpected.']) {
      const incomplete = [...sources.slice(0, 15), block('invalid', continuation)];
      expect(
        fastWordReferences(incomplete).some(
          (root) => root.children.map((child) => child.sourceLabel).join(',') === '3,4',
        ),
      ).toBe(false);
    }
  });

  it.each([
    'Class 4. He has a cat.',
    'Room 3. It is big.',
    'Grade 4. She is nine.',
    'She is 9. Her cat is white.',
  ])('keeps source task-number mentions inside their owning English analysis: %s', (sentence) => {
    const sources = [
      block('p', '阅读短文，选择正确答案。'),
      block('m', 'Tom has a cat. It is white.'),
      block('q3', '3．Who has a cat?'),
      block('o3', 'A．Tom\tB．Ann'),
      block('q4', '4．What colour is it?'),
      block('o4', 'A．black\tB．white'),
      block('a', '【答案】3．A 4．B'),
      block('x3', `【详解】3．Tom is in ${sentence}`),
      block('x4', '4．A genuine explanation for question four.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[0].analysis)).toBe(`Tom is in ${sentence}`);
    expect(projected(sources, refs[0].children[1].analysis)).toBe(
      'A genuine explanation for question four.',
    );
  });

  it('splits corroborated adjacent inline English analyses only after a complete sentence boundary', () => {
    const sources = [
      block('p', '阅读短文，选择正确答案。'),
      block('m', 'Tom has a cat.'),
      block('q3', '3．First?'),
      block('o3', 'A．Tom\tB．Ann'),
      block('q4', '4．Second?'),
      block('o4', 'A．yes\tB．no'),
      block('a', '【答案】3．A 4．B'),
      block('x', '【详解】3．First explanation. 4．Second explanation.'),
    ];
    const refs = fastWordReferences(sources);
    expect(projected(sources, refs[0].children[0].analysis).trim()).toBe('First explanation.');
    expect(projected(sources, refs[0].children[1].analysis)).toBe('Second explanation.');
  });
  it('keeps a final cloze analysis before the next word-bank key and owns its labeled analyses', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('q', [6, 7], '读一读。 '),
      block('o6', '6．A．one\tB．two'),
      block('o7', '7．A．three\tB．four'),
      block('a', '【答案】6．A    7．B'),
      block('x6', '【详解】6．句意：First explanation.'),
      block('x7', '7．句意：Final explanation.'),
      block('prompt', '看图，选择正确的单词补全介绍。'),
      block('bank', 'autumn  winter'),
      cloze('wordbank', [8, 9], 'I like '),
      block('bankAnswer', '【答案】8．autumn    9．winter'),
      block('x8', '【详解】8．句意：First bank explanation.'),
      block('x9', '9．句意：Second bank explanation.'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[0].analysis.some((ref) => ref.blockId === 'x7')).toBe(true);
    expect(refs[1].analysis.map((ref) => ref.blockId)).toEqual(['x8', 'x9']);
    const preview = parseWordFast(sources, 'english-cloze-before-wordbank');
    expect(preview.questions.every((question) => question.has_answer)).toBe(true);
  });
  it('bounds consecutive reading groups and infers choices independently of former cloze', () => {
    const sources = [
      block('clozeHeading', '完形填空'),
      cloze('cloze', [1, 2], 'Choose '),
      block('co1', '1．A．one\tB．two'),
      block('co2', '2．A．three\tB．four'),
      block('ca', '【答案】1．A 2．B'),
      block('cx', '【详解】1．First explanation.'),
      block('cx2', '2．Second explanation.'),
      block('readingHeading', '二、阅读选择'),
      block('prompt1', '阅读短文，选择最佳答案。'),
      block('material1', 'Tom has a cat. It is white.'),
      block('q3', '3．Tom has a ______.'),
      block('o3', 'A．cat\tB．dog'),
      block('q4', '4．It is ______.'),
      block('o4', 'A．white\tB．black'),
      block('a34', '【答案】3．A 4．A'),
      block('x34', '【详解】3．He has a cat.'),
      block('x4', '4．It is white.'),
      block('prompt2', '阅读短文，选择正确答案。'),
      block('material2', 'Ann has a dog. It is black.'),
      block('q5', '5．Ann has a ______.'),
      block('o5', 'A．dog\tB．cat'),
      block('q6', '6．It is ______.'),
      block('o6', 'A．white\tB．black'),
      block('a56', '【答案】5．A 6．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(3);
    expect(refs[1].questionType).toBe('short_answer');
    expect(refs[1].children.map((child) => child.sourceLabel)).toEqual(['3', '4']);
    expect(refs[2].children.map((child) => child.sourceLabel)).toEqual(['5', '6']);
    expect(
      refs.slice(1).flatMap((root) => root.children.map((child) => child.questionType)),
    ).toEqual(['single_choice', 'single_choice', 'single_choice', 'single_choice']);
    expect(refs.slice(1).flatMap((root) => root.children.map((child) => child.blanks))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const preview = parseWordFast(sources, 'english-consecutive-readings');
    expect(
      preview.questions.slice(1).flatMap((root) => root.sub_problems.map((child) => child.answer)),
    ).toEqual([['A'], ['A'], ['A'], ['B']]);
  });

  it.each(['判断正(T)误(F)', '判断正(T)误(T)', '判断正（T）误（F）'])(
    'preserves T/F keys and reading placeholders without independent scoring blanks: %s',
    (cue) => {
      const sources = [
        block('heading', '三、阅读判断'),
        block('prompt', `阅读短文，${cue}。`),
        block('material', 'Tom has a cat.'),
        block('q1', '1．Tom has a cat. ( )'),
        block('q2', '2．Tom has a dog. ( )'),
        block('a', '【答案】1．T 2．F'),
      ];
      const before = JSON.stringify(sources);
      const refs = fastWordReferences(sources);
      expect(refs).toHaveLength(1);
      expect(refs[0].children.map((child) => projected(sources, child.answer).trim())).toEqual([
        'T',
        'F',
      ]);
      expect(refs[0].children.map((child) => child.blanks)).toEqual([undefined, undefined]);
      expect(projected(sources, refs[0].children[0].question)).toContain('( )');
      expect(JSON.stringify(sources)).toBe(before);
    },
  );

  it('copies only a proven labeled pool to shared fill children and resets the next task', () => {
    const sources = [
      block('prompt', '根据语境，选择合适的疑问词补全对话。'),
      block('pool', 'A．Where\tB．What\tC．Why'),
      marked('q1', '1．', ' do you live?'),
      marked('q2', '2．', ' are you happy?'),
      block('a', '【答案】1．A 2．C'),
      block('x', '【详解】1．First explanation.'),
      block('x2', '2．Second explanation.'),
      marked('q3', '3．There ', ' (is / are) a cat.'),
      block('a3', '【答案】is'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[0].children.map((child) => child.questionType)).toEqual([
      'fill_with_candidates',
      'fill_with_candidates',
    ]);
    expect(
      refs[0].children.map((child) => child.options?.map((option) => option.sourceLabel)),
    ).toEqual([
      ['A', 'B', 'C'],
      ['A', 'B', 'C'],
    ]);
    expect(refs[1].questionType).toBe('fill_in_the_blank');
    const preview = parseWordFast(sources, 'english-shared-labeled-pool');
    expect(preview.questions[0].sub_problems.map((child) => child.blanks?.[0].answer)).toEqual([
      ['A'],
      ['C'],
    ]);
    expect(JSON.stringify(preview.questions[1].blanks?.[0].answer)).toContain('is');
  });

  it('keeps two genuine blanks with two source candidate keys on their owning child', () => {
    const sources = [
      block('prompt', '选词填空。根据对话内容，选择恰当的单词补全句子。'),
      block('pool', 'A．autumn\tB．spring\tC．summer\tD．winter\tE．season'),
      marked('q36', '36．I like ', '.'),
      {
        id: 'q37',
        content: [
          { type: 'text', text: '37．' },
          { type: 'text', text: '        ', marks: [{ type: 'underline' }] },
          { type: 'text', text: ' is my favourite ' },
          { type: 'text', text: '        ', marks: [{ type: 'underline' }] },
          { type: 'text', text: '.' },
        ],
      } satisfies WordSourceBlock,
      block('a', '【答案】36．B 37．A    E'),
    ];
    const before = JSON.stringify(sources);
    const preview = parseWordFast(sources, 'english-double-candidate-key');
    expect(preview.questions).toHaveLength(1);
    expect(preview.questions[0].sub_problems[1].blanks?.map((blank) => blank.answer)).toEqual([
      ['A'],
      ['E'],
    ]);
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('keeps a shared choice with two placeholders and one key outside the scoring blank contract', () => {
    const sources = [
      block('prompt', '根据语境，选择合适的单词补全句子。'),
      block('pool', 'A．is\tB．are'),
      block('q1', '1．There ______ a cat. ( )'),
      block('q2', '2．There ______ two cats. ( )'),
      block('a', '【答案】1．A 2．B'),
    ];
    const before = JSON.stringify(sources);
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].children.map((child) => child.questionType)).toEqual([
      'single_choice',
      'single_choice',
    ]);
    expect(refs[0].children.map((child) => child.blanks)).toEqual([undefined, undefined]);
    expect(projected(sources, refs[0].children[0].question)).toContain('( )');
    expect(refs[0].children[0].options?.map((option) => option.sourceLabel)).toEqual(['A', 'B']);
    expect(JSON.stringify(sources)).toBe(before);
  });

  it('keeps unlabelled banks and image keys as rich source content across independent groups', () => {
    const imageTask = (id: string, label: number, media: string): WordSourceBlock => ({
      id,
      content: [
        { type: 'text', text: `${label}．I like ` },
        { type: 'image', attrs: { sourceMediaId: media } },
        { type: 'text', text: '.' },
      ],
    });
    const imageKeys = (id: string, labels: number[]): WordSourceBlock => ({
      id,
      content: [
        { type: 'text', text: '【答案】' },
        ...labels.flatMap((label) => [
          { type: 'text' as const, text: `${label}．` },
          { type: 'image' as const, attrs: { sourceMediaId: `answer-${label}` } },
          { type: 'text' as const, text: '    ' },
        ]),
      ],
    });
    const sources = [
      block('p1', '根据图片提示，选择恰当的单词将句子补充完整。'),
      block('bank1', 'spring  summer'),
      imageTask('q1', 1, 'blank-1'),
      imageTask('q2', 2, 'blank-2'),
      imageKeys('a12', [1, 2]),
      block('x', '【详解】1．First explanation.'),
      block('x2', '2．Second explanation.'),
      block('p2', '选词填空。选择恰当的单词补全句子并规范地书写在四线三格上。'),
      block('bank2', 'autumn  winter'),
      imageTask('q3', 3, 'blank-3'),
      imageTask('q4', 4, 'blank-4'),
      imageKeys('a34', [3, 4]),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs.map((root) => root.children.map((child) => child.sourceLabel))).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(projected(sources, refs[0].question)).toContain('spring  summer');
    expect(projected(sources, refs[1].question)).toContain('autumn  winter');
    expect(refs.flatMap((root) => root.children.map((child) => child.questionType))).toEqual([
      'short_answer',
      'short_answer',
      'short_answer',
      'short_answer',
    ]);
    const preview = parseWordFast(sources, 'english-image-keys');
    expect(
      preview.questions.flatMap((root) =>
        root.sub_problems.map((child) => JSON.stringify(child.answer)),
      ),
    ).toEqual([1, 2, 3, 4].map((label) => expect.stringContaining(`answer-${label}`)));
    const media = JSON.stringify(preview.questions).match(/sourceMediaId/g);
    expect(media).toHaveLength(8);
  });

  it('recognizes a fresh unprompted cloze only through matching marked labels, rows and keys', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('q1', [1, 2], 'Choose '),
      block('o1', '1．A．one\tB．two'),
      block('o2', '2．A．three\tB．four'),
      block('a1', '【答案】1．A 2．B'),
      block('x', '【详解】1．First explanation.'),
      block('x2', '2．Second explanation.'),
      cloze('q2', [6, 7]),
      block('o6', '6．A．to\tB．for'),
      block('o7', '7．A．colour\tB．weather'),
      block('a2', '【答案】6．A 7．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs.map((root) => root.blanks?.map((blank) => blank.sourceLabel))).toEqual([
      ['1', '2'],
      ['6', '7'],
    ]);
    const preview = parseWordFast(sources, 'english-fresh-unprompted-cloze');
    expect(preview.questions.map((root) => root.blanks?.map((blank) => blank.answer))).toEqual([
      [['A'], ['B']],
      [['A'], ['B']],
    ]);
    const incomplete = sources.slice(0, -1);
    expect(fastWordReferences(incomplete)).toHaveLength(1);
    const nonconsecutive = [
      ...sources.slice(0, 7),
      cloze('nonconsecutive', [6, 8]),
      block('nc6', '6．A．to\tB．for'),
      block('nc8', '8．A．colour\tB．weather'),
      block('nca', '【答案】6．A 8．B'),
    ];
    expect(fastWordReferences(nonconsecutive)).toHaveLength(1);
  });

  it('retains a native table and full key as an atomic short-answer fallback', () => {
    const table: WordSourceBlock = {
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
                      content: [{ type: 'image', attrs: { sourceMediaId: 'table-image' } }],
                    },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Lily is ' },
                        { type: 'text', text: '  1  ', marks: [{ type: 'underline' }] },
                        { type: 'text', text: '(A．kind B．quiet).' },
                      ],
                    },
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'She ' },
                        { type: 'text', text: '  2  ', marks: [{ type: 'underline' }] },
                        { type: 'text', text: '(A．clean B．cleans).' },
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
    const sources = [
      block('h', '完形填空'),
      block('p', '读一读，选择正确的字母编号填写在横线上。'),
      table,
      block('a', '【答案】1．A 2．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].questionType).toBe('short_answer');
    expect(refs[0].blanks).toBeUndefined();
    expect(refs[0].children).toEqual([]);
    const preview = parseWordFast(sources, 'english-atomic-table');
    expect(JSON.stringify(preview.questions[0].question)).toContain('table-image');
    expect(JSON.stringify(preview.questions[0].question)).toContain('(A．kind B．quiet).');
    expect(JSON.stringify(preview.questions[0].answer)).toContain('1．A 2．B');
    expect(sourceText(table.content)).toBe('\uFFFC');
    expect(preview.unresolvedItems?.some((item) => /unassigned|excluded/.test(item.code))).toBe(
      false,
    );
    expect(preview.diagnostics.every((item) => item.code.startsWith('word-import.'))).toBe(true);

    const consecutive = [
      ...sources,
      cloze('next', [3, 4], '情景对话。 '),
      block('o3', '3．A．one\tB．two'),
      block('o4', '4．A．three\tB．four'),
      block('nextMarker', '【答案】'),
      block('nextKey', '3．A 4．B'),
    ];
    const consecutiveRefs = fastWordReferences(consecutive);
    expect(consecutiveRefs).toHaveLength(2);
    expect(projected(consecutive, consecutiveRefs[0].answer)).toBe('1．A 2．B');
    expect(projected(consecutive, consecutiveRefs[1].answer)).toContain('3．A 4．B');

    const ambiguousShared = [
      ...sources.slice(0, -1),
      block('shared', '【答案】1．A 2．B 3．A 4．B'),
    ];
    const ambiguousPreview = parseWordFast(ambiguousShared, 'english-table-ambiguous-key');
    expect(JSON.stringify(ambiguousPreview.questions[0].answer)).toContain('1．A 2．B 3．A 4．B');
    expect(
      ambiguousPreview.diagnostics.some((item) => item.code === 'word-import.uncertain-block'),
    ).toBe(true);
  });

  it('accounts for exact numbered cloze option prefixes while retaining unrelated residual prose', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('q', [1, 2]),
      block('o1', '1．A．one\tB．two'),
      block('o2', '2．A．three\tB．four'),
      block('a', '【答案】1．A 2．B'),
    ];
    const preview = parseWordFast(sources, 'english-cloze-prefix');
    expect(
      preview.unresolvedItems?.filter((item) => item.code === 'word-import.unassigned-range'),
    ).toEqual([]);
    const withProse = [
      ...sources.slice(0, 3),
      block('o2', '2．Unassigned explanation A．three\tB．four'),
      sources[4],
    ];
    const prosePreview = parseWordFast(withProse, 'english-cloze-prefix-prose');
    expect(
      JSON.stringify(prosePreview.questions).includes('Unassigned explanation') ||
        prosePreview.unresolvedItems?.some((item) => item.code === 'word-import.unassigned-range'),
    ).toBe(true);
  });

  it('diagnoses a numbered option row that does not belong to an existing cloze blank', () => {
    const sources = [
      block('h', '完形填空'),
      cloze('q', [1, 2]),
      block('o1', '1．A．one\tB．two'),
      block('o2', '2．A．three\tB．four'),
      block('orphan', '3．A．five\tB．six'),
      block('a', '【答案】1．A 2．B'),
    ];
    const preview = parseWordFast(sources, 'english-orphan-cloze-option');
    expect(
      preview.unresolvedItems?.some((item) =>
        item.sourceRanges.some((ref) => ref.blockId === 'orphan'),
      ) ||
        preview.diagnostics.some(
          (item) => item.code === 'word-import.uncertain-block' && item.blockId === 'orphan',
        ),
    ).toBe(true);
    expect(JSON.stringify(preview.questions)).toContain('five');
  });

  it('preserves a standalone punctuated cloze instruction as source material', () => {
    const sources = [
      block('h', '完形填空。'),
      cloze('q', [1, 2]),
      block('o1', '1．A．one\tB．two'),
      block('o2', '2．A．three\tB．four'),
      block('a', '【答案】1．A 2．B'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(projected(sources, refs[0].question)).toContain('完形填空。');
  });
});
