import { describe, expect, it } from 'vitest';
import { evaluateWordImportDiagnostics } from '../src/word-import/validation.js';
import { WORD_IMPORT_DIAGNOSTIC_REGISTRY } from '../src/word-import/diagnostics.js';
import {
  resolveWordQuestions,
  parseWordFast,
  parseWordSmartResponse,
  fastWordReferences,
  type WordQuestionReference,
  type WordSourceBlock,
} from '../src/word-import/index.js';
const block = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const ref = (blockId: string) => ({ blockId });
const question = (id: string): WordQuestionReference => ({
  questionType: 'short_answer',
  question: [ref(id)],
  answer: [],
  analysis: [],
  children: [],
});
const recover = (blocks: WordSourceBlock[], refs: WordQuestionReference[]) =>
  resolveWordQuestions(blocks, refs, 'recovery', {
    allowPartialRoots: true,
    omitUnverifiedPoints: true,
  });
const choice = (): { blocks: WordSourceBlock[]; q: WordQuestionReference } => ({
  blocks: [
    block('q', 'Question'),
    block('a', 'A、Z'),
    block('o1', 'First'),
    block('o2', 'Second'),
    block('p', '0.5'),
  ],
  q: {
    ...question('q'),
    questionType: 'single_choice',
    answer: [ref('a')],
    points: 0.5,
    pointsSource: ref('p'),
    options: [
      { sourceLabel: 'A', label: [ref('o1')] },
      { sourceLabel: 'B', label: [ref('o2')] },
    ],
  },
});
describe('field recovery without silent root loss', () => {
  it('accounts for bracketed field markers without hiding adjacent source content', () => {
    const blocks = [
      block('q', '1. Explain'),
      block('a', '【答案】Answer'),
      block('d', '【详解】Explanation'),
    ];
    const result = parseWordFast(blocks, 'markers');
    expect(result.unresolvedItems).toEqual([]);
    const extra = recover(
      [block('q', '【答案】Unassigned source')],
      [{ ...question('q'), question: [{ blockId: 'q', start: 0, end: 4 }] }],
    );
    expect(extra.sourceExcerpts?.some((e) => e.text === 'Unassigned source')).toBe(true);
  });
  it('keeps unresolved reasons as pending evidence that never gates the append', () => {
    const result = recover(
      [block('q', 'Original source')],
      [{ ...question('q'), questionType: 'unknown' as WordQuestionReference['questionType'] }],
    );
    const pending = evaluateWordImportDiagnostics([], result.fieldDiagnostics!);
    expect(pending.history.every((h) => h.status === 'pending')).toBe(true);
    expect(pending.diagnostics.some((d) => d.blocksApply)).toBe(false);
  });
  it('makes fast boundary observations acknowledgeable and deduplicates excerpts', () => {
    const result = parseWordFast(
      [block('q', '1. Question'), block('orphan', '2. Next'), block('x', '(3) Child')],
      'review',
    );
    for (const d of result.fieldDiagnostics!)
      if (WORD_IMPORT_DIAGNOSTIC_REGISTRY[d.code].clearance === 'review') {
        expect(d.target.kind).toBe('unresolved');
        expect(
          result.unresolvedItems!.some(
            (i) => d.target.kind === 'unresolved' && i.id === d.target.itemId,
          ),
        ).toBe(true);
      }
    const ranges = result.sourceExcerpts!.map((e) => JSON.stringify(e.range));
    expect(new Set(ranges).size).toBe(ranges.length);
  });
  it('checks omitted smart source before metadata large enough to truncate', () => {
    const blocks = Array.from({ length: 1100 }, (_, i) => block(`q${i}`, 'Source'));
    const refs = blocks.map((b) => question(b.id));
    const output = { complete: true, questions: refs, unassignedBlockIds: [] };
    expect(() =>
      parseWordSmartResponse(
        JSON.stringify(output),
        [...blocks, block('lost', 'Omitted')],
        'large',
      ),
    ).toThrow('unaccounted-source');
  });
  it('preserves valid fields, private stable option IDs and exact answer source', () => {
    const { blocks, q } = choice(),
      result = recover(blocks, [q]);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].answer).toEqual([]);
    expect(result.questions[0].points).toBe(0.5);
    expect(result.fieldDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'word-import.invalid-answer-reference',
        target: { kind: 'field', questionId: result.questions[0].id, field: { kind: 'answer' } },
        sourceRanges: [ref('a')],
        blocksApply: true,
      }),
    );
    expect(result.questions[0].options?.[0]).toHaveProperty('wordImportItemId');
    expect(result.sourceExcerpts).toContainEqual(expect.objectContaining({ text: 'A、Z' }));
    expect(recover(blocks, [q])).toEqual(result);
  });
  it.each([0, 1, 2])('retains all other roots when root %i has unsupported type', (index) => {
    const blocks = [
      block('q0', 'First question'),
      block('q1', 'Middle question'),
      block('q2', 'Last question'),
    ];
    const refs = blocks.map((b) => question(b.id));
    refs[index].questionType = 'unsupported' as WordQuestionReference['questionType'];
    const result = recover(blocks, refs);
    expect(result.questions).toHaveLength(2);
    expect(result.unresolvedItems?.filter((i) => i.kind === 'question')).toHaveLength(1);
    expect(result.unresolvedItems?.find((i) => i.kind === 'question')?.sourceRanges).toEqual([
      ref(`q${index}`),
    ]);
  });
  it('isolates an unsupported child and retains parent and both siblings', () => {
    const blocks = ['root', 'first', 'bad', 'last', 'bad-analysis'].map((id) =>
      block(id, `Synthetic ${id}`),
    );
    const root = question('root');
    root.children = [
      question('first'),
      {
        ...question('bad'),
        questionType: 'unknown' as WordQuestionReference['questionType'],
        analysis: [ref('bad-analysis')],
      },
      question('last'),
    ];
    const result = recover(blocks, [root]);
    expect(result.questions[0].sub_problems).toHaveLength(2);
    expect(result.unresolvedItems?.find((i) => i.kind === 'question')).toMatchObject({
      parentQuestionId: result.questions[0].id,
      sourceRanges: [ref('bad'), ref('bad-analysis')],
    });
    const smart = parseWordSmartResponse(
      JSON.stringify({ complete: true, questions: [root], unassignedBlockIds: [] }),
      blocks,
      'smart',
    );
    expect(smart.questions[0].sub_problems).toHaveLength(2);
  });
  it('preserves duplicate source labels for explicit correction rather than hiding ambiguity', () => {
    const { blocks, q } = choice();
    q.options![1].sourceLabel = 'A';
    q.answer = [];
    const result = recover(blocks, [q]);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].options?.map((o) => o.value)).toEqual(['A', 'A']);
    expect(result.fieldDiagnostics?.some((d) => d.code === 'word-import.invalid-options')).toBe(
      true,
    );
  });
  it('retains empty option, unsupported analysis and omitted unverifiable score', () => {
    const { blocks, q } = choice();
    q.answer = [];
    q.points = 9;
    q.options![1].label = [];
    blocks.push({ id: 'bad', content: [{ type: 'unsupported' }] });
    q.analysis = [ref('bad')];
    const result = recover(blocks, [q]);
    expect(result.questions[0].points).toBeUndefined();
    expect(result.fieldDiagnostics?.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'word-import.unsourced-points',
        'word-import.empty-option',
        'word-import.invalid-rich-text',
      ]),
    );
  });
  it('shares post-semantic diagnostics between fast and smart parsing', () => {
    const blocks = [
      block('q', '1. Question'),
      block('o', 'A. First B. Second'),
      block('a', '【答案】Z'),
    ];
    const fast = parseWordFast(blocks, 'same'),
      smart = parseWordSmartResponse(
        JSON.stringify({
          complete: true,
          questions: fastWordReferences(blocks),
          unassignedBlockIds: [],
        }),
        blocks,
        'same',
      );
    expect(smart.questions).toEqual(fast.questions);
    expect(smart.fieldDiagnostics?.filter((d) => d.blocksApply)).toEqual(
      fast.fieldDiagnostics?.filter((d) => d.blocksApply),
    );
  });
  it('reports substantive unused ranges rather than treating a partly used block as fully covered', () => {
    const result = recover(
      [block('q', 'Question omitted material')],
      [{ ...question('q'), question: [{ blockId: 'q', start: 0, end: 8 }] }],
    );
    expect(result.unresolvedItems).toContainEqual(
      expect.objectContaining({
        kind: 'unassigned',
        sourceRanges: [{ blockId: 'q', start: 8, end: 25 }],
      }),
    );
  });
});
describe('blank-specific recovery', () => {
  const setup = (type: 'cloze' | 'fill_with_candidates') => {
    const blocks = [
      block('q', 'Fill __ here'),
      block('a', 'A、B'),
      block('o1', 'First'),
      block('o2', 'Second'),
    ];
    const pool = [
      { sourceLabel: 'A', label: [ref('o1')] },
      { sourceLabel: 'B', label: [ref('o2')] },
    ];
    const q: WordQuestionReference = {
      ...question('q'),
      questionType: type,
      blanks: [
        {
          marker: { blockId: 'q', start: 5, end: 7 },
          answer: [ref('a')],
          ...(type === 'cloze' ? { candidates: pool } : {}),
        },
      ],
      ...(type === 'fill_with_candidates' ? { options: pool, candidatePoolRepeatable: false } : {}),
    };
    return { blocks, q };
  };
  it('retains shared-pool blank but clears multi-answer with a blank-scoped blocker', () => {
    const { blocks, q } = setup('fill_with_candidates'),
      result = recover(blocks, [q]);
    expect(result.questions[0].blanks?.[0].answer).toEqual([]);
    expect(result.questions[0].has_answer).toBe(false);
    expect(result.fieldDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'word-import.blank-answer-count',
        target: {
          kind: 'field',
          questionId: result.questions[0].id,
          field: { kind: 'blanks', blankId: result.questions[0].blanks![0].id, part: 'answer' },
        },
        sourceRanges: [ref('a')],
      }),
    );
  });
  it('permits cloze multiple answers and recovers invalid cloze reference', () => {
    const { blocks, q } = setup('cloze');
    expect(recover(blocks, [q]).questions[0].blanks?.[0].answer).toEqual(['A', 'B']);
    blocks[1] = block('a', 'Z');
    const result = recover(blocks, [q]);
    expect(result.questions[0].blanks?.[0].answer).toEqual([]);
    expect(result.fieldDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'word-import.invalid-answer-reference',
        target: expect.objectContaining({ field: expect.objectContaining({ kind: 'blanks' }) }),
      }),
    );
  });
  it('preserves ambiguous blank source as unresolved while siblings survive', () => {
    const { blocks, q } = setup('cloze');
    q.blanks![0].marker = { blockId: 'q', start: 0, end: 2 };
    blocks.push(block('sibling', 'Other question'));
    const result = recover(blocks, [q, question('sibling')]);
    expect(result.questions).toHaveLength(1);
    expect(
      result.unresolvedItems
        ?.find((i) => i.kind === 'question')
        ?.sourceRanges.map((r) => r.blockId),
    ).toEqual(expect.arrayContaining(['q', 'a', 'o1', 'o2']));
  });
});
describe('protocol/source failures remain fatal in recovery mode', () => {
  it.each(['unknown', 'range', 'malformed', 'extra', 'envelope'])(
    '%s is never swallowed by semantic recovery',
    (kind) => {
      const { blocks, q } = choice();
      if (kind === 'unknown') q.answer = [ref('fabricated')];
      if (kind === 'range') q.analysis = [{ blockId: 'q', start: 0, end: 999 }];
      if (kind === 'malformed')
        q.options![0].label = [
          { url: 'https://example.invalid' } as unknown as ReturnType<typeof ref>,
        ];
      if (kind === 'extra') Object.assign(q, { inventedText: 'Fabricated question' });
      if (kind === 'envelope') q.answer = 'A' as unknown as ReturnType<typeof ref>[];
      expect(() => recover(blocks, [q])).toThrow();
    },
  );
  it('smart coverage rejects truly omitted blocks even with a recovered unresolved child', () => {
    const root = question('q');
    root.children = [
      {
        ...question('child'),
        questionType: 'unsupported' as WordQuestionReference['questionType'],
      },
    ];
    expect(() =>
      parseWordSmartResponse(
        JSON.stringify({ complete: true, questions: [root], unassignedBlockIds: [] }),
        [
          block('q', 'Root material'),
          block('child', 'Child material'),
          block('lost', 'Another omitted question'),
        ],
        'smart',
      ),
    ).toThrow('unaccounted-source');
  });
});
it.each(['答案：', '参考答案：', '答案:', '【答案】'])(
  'ignores structural colon labels and section headings but retains adjacent prose (%s)',
  (label) => {
    const blocks = [
      block('h', '一、单项选择题'),
      block('q', '1. 下列哪个正确？（2分）'),
      block('o1', 'A. 甲'),
      block('o2', 'B. 乙'),
      block('a', label + 'A'),
      block('x', '解析：因为甲。'),
    ];
    const fast = parseWordFast(blocks, 'labels');
    expect(fast.questions).toHaveLength(1);
    expect(fast.unresolvedItems).toEqual([]);
    const references = fastWordReferences(blocks);
    const smart = parseWordSmartResponse(
      JSON.stringify({ complete: true, questions: references, unassignedBlockIds: ['h'] }),
      blocks,
      'labels',
    );
    expect(smart.unresolvedItems).toEqual([]);
    const extra = recover(
      [
        block('q', 'Question'),
        block('free', '一、单项选择题后面的说明必须核对'),
        block('colon', '答案：额外说明'),
      ],
      [question('q')],
    );
    expect(extra.unresolvedItems?.map((item) => item.sourceRanges[0].blockId)).toEqual([
      'free',
      'colon',
    ]);
  },
);
it('does not require acknowledgement of a smart-declared school header', () => {
  const blocks = [block('h', '学校：____ 姓名：____ 班级：____'), block('q', 'Explain')];
  const result = parseWordSmartResponse(
    JSON.stringify({ complete: true, questions: [question('q')], unassignedBlockIds: ['h'] }),
    blocks,
    'header',
  );
  expect(result.unresolvedItems).toEqual([]);
  expect(result.fieldDiagnostics?.some((d) => d.code === 'word-import.uncertain-block')).toBe(
    false,
  );
});
it('retains one source-backed unexpected-blanks reason for a non-fill question', () => {
  const result = recover(
    [block('q', 'Question __')],
    [{ ...question('q'), blanks: [{ marker: { blockId: 'q', start: 9, end: 11 }, answer: [] }] }],
  );
  const reasons = result.fieldDiagnostics?.filter(
    (d) => d.code === 'word-import.unexpected-blanks',
  );
  expect(reasons).toHaveLength(1);
  expect(reasons![0].sourceRanges).toEqual([{ blockId: 'q', start: 9, end: 11 }]);
});
