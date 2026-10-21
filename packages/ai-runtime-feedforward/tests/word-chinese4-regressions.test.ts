import { describe, expect, it } from 'vitest';
import diagramLegacy from './fixtures/word-chinese4-diagram-legacy.json';
import choiceLegacy from './fixtures/word-chinese4-choice-legacy.json';
import boundaryLegacy from './fixtures/word-chinese4-boundary-legacy.json';
import deferredLegacy from './fixtures/word-chinese4-deferred-diagram-legacy.json';
import {
  fastWordReferences,
  findWordBlankMarkers,
  parseWordFast,
  sourceText,
  type WordQuestionReference,
  type WordSourceBlock,
} from '../src/word-import/index.js';

const b = (id: string, text: string): WordSourceBlock => ({
  id,
  content: [{ type: 'text', text }],
});
const image = (id: string): WordSourceBlock => ({
  id,
  content: [{ type: 'image', attrs: { sourceMediaId: id } }],
});
const text = (sources: WordSourceBlock[], ranges: WordQuestionReference['answer']) =>
  ranges
    .map((r) => sourceText(sources.find((s) => s.id === r.blockId)!.content).slice(r.start, r.end))
    .join('')
    .trim();
const previous = () => [
  b('old', '1．解释这个词语。'),
  b('old-key', '【答案】山中很安静。'),
  b('old-analysis', '【详解】本题考查词语理解。'),
];
const reading = (heading: string, labels = [6, 7]) => [
  b('heading', heading),
  b('title', '山里的小鸟'),
  b('material', '①小鸟住在山里，每天在清晨唱歌。它们为山林带来了快乐。'),
  b('first', `${labels[0]}．小鸟住在哪里？`),
  b('second', `${labels[1]}．小鸟什么时候唱歌？`),
  b('key', `【答案】${labels[0]}．山里    ${labels[1]}．清晨`),
  b('analysis', `【详解】${labels[0]}．本题考查提取信息。`),
  b('last-analysis', `${labels[1]}．本题考查提取信息。`),
];
const owners = (sources: WordSourceBlock[], id: string) => {
  const result: Array<{ path: string; field: string }> = [];
  const visit = (q: WordQuestionReference, path: string) => {
    for (const field of ['question', 'answer', 'analysis'] as const)
      if (q[field].some((r) => r.blockId === id)) result.push({ path, field });
    q.children.forEach((child, i) => visit(child, `${path}/${i + 1}`));
  };
  fastWordReferences(sources).forEach((q, i) => visit(q, `${i + 1}`));
  return result;
};

describe('Chinese reading source evidence and completed boundaries', () => {
  it.each(diagramLegacy.cases)('preserves exact c383 diagram output for $heading', (legacy) => {
    const sources = [
      ...previous(),
      b('heading', legacy.heading),
      image('diagram'),
      b('first', '2．小鸟住在哪里？'),
      b('second', '3．小鸟什么时候唱歌？'),
      b('key', '【答案】2．山里    3．清晨'),
      b('analysis', '【详解】2．本题考查提取信息。'),
      b('last-analysis', '3．本题考查提取信息。'),
    ];
    expect(fastWordReferences(sources)).toEqual(legacy.references);
    expect(JSON.parse(JSON.stringify(parseWordFast(sources, 'legacy-diagram-command')))).toEqual(
      legacy.preview,
    );
  });

  it.each(['no-adjacent-media', 'incomplete-key', 'analysis-directive'])(
    'keeps diagram-like analysis with unproved source structure: %s',
    (kind) => {
      const sources = [
        ...previous(),
        b('heading', '根据下图，完成练习。'),
        image('diagram'),
        b('first', '2．小鸟住在哪里？'),
        b('second', '3．小鸟什么时候唱歌？'),
        b('key', '【答案】2．山里    3．清晨'),
      ];
      if (kind === 'no-adjacent-media')
        sources.splice(4, 0, b('continuation', '说明原答案中的小鸟路线。'));
      if (kind === 'incomplete-key') sources[7] = b('key', '【答案】2．山里');
      if (kind === 'analysis-directive')
        sources[3] = b('heading', '根据下图可知，原答案正确，完成练习。');
      expect(owners(sources, 'heading')).toEqual([{ path: '1', field: 'analysis' }]);
    },
  );

  it.each(['partial-nested-key', 'unnumbered-nested-key', 'blank-leaf-key'])(
    'requires every answer-only predecessor leaf to have a resolved key: %s',
    (kind) => {
      const sources = [
        b('old', '1．解释下列词语。'),
        b('s1', '(1)解释第一个词语。'),
        b('s2', '(2)解释第二个词语。'),
        b(
          'old-key',
          kind === 'partial-nested-key'
            ? '【答案】(1)安静。'
            : kind === 'blank-leaf-key'
              ? '【答案】(1)安静。  (2)     '
              : '【答案】安静。快乐。',
        ),
        b('heading', '根据下图，完成练习。'),
        image('diagram'),
        b('q2', '2．小鸟住在哪里？'),
        b('q3', '3．小鸟什么时候唱歌？'),
        b('key', '【答案】2．山里    3．清晨'),
      ];
      expect(owners(sources, 'heading')).toHaveLength(1);
      expect(owners(sources, 'heading')[0].field).toBe('answer');
      expect(owners(sources, 'heading')[0].path).toMatch(/^1\//);
      expect(owners(sources, 'diagram')).toEqual(owners(sources, 'heading'));
    },
  );

  it.each(['wrong-count', 'unknown-labels', 'two-space-only'])(
    'rejects unproved deferred blank answers before a diagram: %s',
    (kind) => {
      const sources = [
        b('old', '1．根据诗句内容填空。'),
        b('s1', '(1)作者是____。'),
        b('s2', '(2)采用了____。'),
        b(
          'old-key',
          kind === 'wrong-count'
            ? '【答案】无法匹配的整段答案。'
            : kind === 'unknown-labels'
              ? '【答案】(7)白居易     (8)比喻'
              : '【答案】白居易  比喻',
        ),
        b('heading', '根据下图，完成练习。'),
        image('diagram'),
        b('q2', '2．小鸟住在哪里？'),
        b('q3', '3．小鸟什么时候唱歌？'),
        b('key', '【答案】2．山里    3．清晨'),
      ];
      expect(owners(sources, 'heading')).toEqual([{ path: '1', field: 'answer' }]);
      expect(owners(sources, 'diagram')).toEqual([{ path: '1', field: 'answer' }]);
    },
  );

  it('requires complete deferred answers in every descendant branch', () => {
    const legacy = deferredLegacy.cases.find((item) => item.id.endsWith('descendant'))!;
    const sources = legacy.sources.map((item) =>
      item.id === 'old-key' ? b('old-key', '【答案】(1)只有一个答案') : item,
    ) as WordSourceBlock[];
    expect(owners(sources, 'heading')).toEqual([{ path: '1/2', field: 'answer' }]);
    expect(owners(sources, 'diagram')).toEqual([{ path: '1/2', field: 'answer' }]);
  });

  it.each([
    '阅读与理解',
    '阅读类文，完成练习。',
    '课内外对比阅读。（14）',
    '课外阅读。',
    '快乐阅读。',
    '阅读实践。',
    '阅读理解。',
    '古文阅读。',
    '读短文，回答下面的问题。',
    '读下面的片段，回答后面的问题。',
    '读神话故事《山里的小鸟》，完成练习。',
    '读诗歌，回答问题。',
    '阅读短文，完成第小题。',
  ])('groups source tasks with a complete key: %s', (heading) => {
    const sources = [...previous(), ...reading(heading)];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].children.map((q) => q.sourceLabel)).toEqual(['6', '7']);
    expect(text(sources, refs[1].children[0].answer)).toBe('山里');
    expect(text(sources, refs[1].children[1].answer)).toBe('清晨');
    expect(owners(sources, 'old-analysis')).toEqual([{ path: '1', field: 'analysis' }]);
    expect(owners(sources, 'heading')).toEqual([{ path: '2', field: 'question' }]);
    expect(owners(sources, 'material')).toEqual([{ path: '2', field: 'question' }]);
  });

  it('starts a title-only reading only at its title after a completed group', () => {
    const first = reading('阅读与理解', [2, 3]);
    const next = reading('谁的歌声最美', [4, 5]).filter((s) => s.id !== 'title');
    next.forEach((s) => (s.id = `next-${s.id}`));
    const sources = [...first, ...next];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[0].children.map((q) => q.sourceLabel)).toEqual(['2', '3']);
    expect(refs[1].children.map((q) => q.sourceLabel)).toEqual(['4', '5']);
    expect(owners(sources, 'last-analysis')).toEqual([{ path: '1/2', field: 'analysis' }]);
    expect(owners(sources, 'next-heading')).toEqual([{ path: '2', field: 'question' }]);
  });

  it('retains a real material blank on the parent without an answerless material leaf', () => {
    const sources = reading('选文一：小鸟在____歌唱。');
    sources.splice(2, 0, b('second-material', '选文二：山林里响起了快乐的歌声。'));
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].questionType).toBe('short_answer');
    expect(refs[0].blanks).toBeUndefined();
    expect(refs[0].children.map((q) => q.sourceLabel)).toEqual(['6', '7']);
    expect(text(sources, refs[0].question)).toContain('____');
  });

  it('starts shared image material at the image, preserving separately keyed image answers', () => {
    const sources = [
      ...previous(),
      image('material-image'),
      b('q5', '5．修改图中小文的话。'),
      b('q6', '6．补充图中小语的话。'),
      {
        id: 'key',
        content: [
          { type: 'text' as const, text: '【答案】5．' },
          ...image('answer-image').content,
          { type: 'text' as const, text: '    6．讲解主题' },
        ],
      },
      b('analysis', '【详解】5．关联词使用不当。'),
      b('analysis6', '6．应先确定讲解主题。'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].children.map((q) => q.sourceLabel)).toEqual(['5', '6']);
    expect(owners(sources, 'material-image')).toEqual([{ path: '2', field: 'question' }]);
    expect(text(sources, refs[1].children[0].answer)).toBe('\uFFFC');
    expect(text(sources, refs[1].children[1].answer)).toBe('讲解主题');
    expect(owners(sources, 'old-analysis')).toEqual([{ path: '1', field: 'analysis' }]);
  });

  it.each(['missing', 'partial', 'duplicate', 'jumped'])(
    'does not prove a new group with %s keys/tasks',
    (kind) => {
      const next = reading('山里的小鸟').filter((s) => s.id !== 'title');
      if (kind === 'missing')
        next.splice(
          next.findIndex((s) => s.id === 'key'),
          1,
        );
      if (kind === 'partial')
        next.find((s) => s.id === 'key')!.content = b('', '【答案】6．山里').content;
      if (kind === 'duplicate')
        next.find((s) => s.id === 'key')!.content = b('', '【答案】6．山里    6．清晨').content;
      if (kind === 'jumped')
        next.find((s) => s.id === 'second')!.content = b('', '8．小鸟什么时候唱歌？').content;
      const sources = [...previous(), ...next];
      expect(owners(sources, 'heading')).toEqual([{ path: '1', field: 'analysis' }]);
    },
  );

  it('does not start at an explanation even with later image material and complete keys', () => {
    const sources = [
      ...previous(),
      b('explanation', '文中画线句子描写山林的美丽，可结合关键词体会。'),
      b('example', '示例：我感受到了山林的美丽。'),
      image('material-image'),
      ...reading('山里的小鸟').filter((s) => s.id !== 'title'),
    ];
    expect(owners(sources, 'explanation')).toEqual([{ path: '1', field: 'analysis' }]);
    expect(owners(sources, 'example')).toEqual([{ path: '1', field: 'analysis' }]);
  });

  it('does not infer unmarked title material from an unanswered predecessor', () => {
    const sources = [
      b('old', '1．解释这个词语。'),
      ...reading('山里的小鸟').filter((s) => s.id !== 'title'),
    ];
    expect(owners(sources, 'heading')).toEqual([{ path: '1', field: 'question' }]);
  });

  it('proves keys continuing across multiple paragraphs and keeps each continuation with its owner', () => {
    const sources = reading('阅读与理解', [6, 7]);
    sources.splice(
      5,
      1,
      b('key', '【答案】6．山里    7．天亮时，老 人走出家门，'),
      b('key-continuation', '欣赏清晨的歌声。'),
    );
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].children.map((q) => q.sourceLabel)).toEqual(['6', '7']);
    expect(text(sources, refs[0].children[1].answer)).toBe(
      '天亮时，老 人走出家门，欣赏清晨的歌声。',
    );
    expect(owners(sources, 'key-continuation')).toEqual([{ path: '1/2', field: 'answer' }]);
  });

  it('keeps task-internal selection labels and circled analysis inside their original task', () => {
    const sources = reading('阅读与理解', [6, 7]);
    sources.splice(
      4,
      0,
      b('selection-one', '选文一：________________。'),
      b('selection-two', '选文二：________________。'),
    );
    sources.push(b('circle-analysis', '①从原文可知小鸟生活在山里。'));
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(owners(sources, 'selection-one')).toEqual([{ path: '1/1', field: 'question' }]);
    expect(owners(sources, 'selection-two')).toEqual([{ path: '1/1', field: 'question' }]);
    expect(owners(sources, 'circle-analysis')).toEqual([{ path: '1/2', field: 'analysis' }]);
  });
});

describe('Chinese task hierarchy and original answer ownership', () => {
  it.each([...boundaryLegacy.cases, ...deferredLegacy.cases])(
    'preserves exact c383 guarded output for $id',
    (legacy) => {
      const sources = legacy.sources as WordSourceBlock[];
      expect(fastWordReferences(sources)).toEqual(legacy.references);
      expect(JSON.parse(JSON.stringify(parseWordFast(sources, legacy.id)))).toEqual(legacy.preview);
      if (legacy.id.endsWith('prelude-loss'))
        expect(owners(sources, 'prelude')).toEqual([
          { path: legacy.id.startsWith('reused') ? '2' : '1', field: 'analysis' },
        ]);
      if (legacy.id.startsWith('answered-only-diagram-command')) {
        expect(owners(sources, 'heading')).toEqual([{ path: '2', field: 'question' }]);
        expect(owners(sources, 'diagram')).toEqual([{ path: '2', field: 'question' }]);
      }
      if (legacy.id === 'answered-only-command-no-image')
        expect(owners(sources, 'heading')).toEqual([{ path: '1', field: 'answer' }]);
    },
  );

  it.each(choiceLegacy.cases)('preserves exact c383 local $label choice semantics', (legacy) => {
    const sources = [
      b('q', `1．（${legacy.label}）下面正确的是(    )、(    )。`),
      b('pool', 'A．安静    B．快乐    C．勇敢    D．明亮'),
      b('key', '【答案】A    D'),
    ];
    expect(fastWordReferences(sources)).toEqual(legacy.references);
    expect(JSON.parse(JSON.stringify(parseWordFast(sources, 'legacy-local-choice')))).toEqual(
      legacy.preview,
    );
  });

  it('ends the proved reading range before an independent numbered poem', () => {
    const sources = [
      ...reading('阅读与理解', [21, 22]),
      b('poem', '23．阅读短诗，完成练习。'),
      b('poem-title', '霜花'),
      b('poem-body', '九月的霜花，开到我鬓边来。'),
      b('sub1', '(1)诗中的“你”指的是______。'),
      b('sub2', '(2)判断下列说法的正误。'),
      b('circle1', '①作者喜爱霜花。(     )'),
      b('circle2', '②霜花是在夏天出现的。(     )'),
      b('poem-key', '【答案】(1)霜花'),
      b('poem-key2', '(2)     √     ×'),
      b('poem-analysis', '【详解】(1)本题考查短诗理解。'),
      b('poem-analysis2', '(2)①短诗表达喜爱。②描写的是秋天。'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(2);
    expect(refs[1].sourceLabel).toBe('23');
    expect(refs[1].children.map((q) => q.sourceLabel)).toEqual(['1', '2']);
    expect(text(sources, refs[1].children[0].answer)).toBe('霜花');
    expect(refs[1].children[1].children.map((q) => text(sources, q.answer))).toEqual(['√', '×']);
    expect(owners(sources, 'poem-title')).toEqual([{ path: '2', field: 'question' }]);
  });

  it('routes a bracket sibling after a nested reading answer instead of the last grandchild', () => {
    const sources = [
      b('heading', '阅读与理解'),
      b('material', '①小鸟飞到山里，每天和朋友快乐地生活。'),
      b('q21', '21．小鸟生活在哪里？'),
      b('q22', '22．完成下面练习。'),
      b('sub1', '（1）补充图中所缺内容。'),
      image('diagram'),
      b('sub2', '（2）小鸟“____”，表现出它的____，也说明它很____。'),
      b('key', '【答案】21．山里    22．（1）①兴冲冲  ②很快乐'),
      b('key2', '（2）飞  勇敢  善良'),
      b('analysis', '【详解】21．本题考查提取信息。'),
      b('analysis22', '22．本题考查理解。'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    const q22 = refs[0].children[1];
    expect(q22.children.map((q) => q.sourceLabel)).toEqual(['1', '2']);
    expect(text(sources, q22.children[0].answer)).toBe('①兴冲冲  ②很快乐');
    expect(text(sources, q22.children[1].answer)).toBe('飞  勇敢  善良');
    expect(q22.children[1].blanks?.map((blank) => text(sources, blank.answer))).toEqual([
      '飞',
      '勇敢',
      '善良',
    ]);
  });

  it('retains a prefilled example with actual task blanks and exact unnumbered answers', () => {
    const sources = [
      b('q18', '18．照样子，简单概括。'),
      b('example', '（1）为祖国贡献力量。'),
      b('sub2', '（2）因为____而放弃____。'),
      b('sub3', '（3）________________。'),
      b('sub4', '（4）拒绝________________。'),
      b('key', '【答案】     护照问题     留学     回国     邀请'),
      b('analysis', '【详解】（1）这是给出的例子。'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs).toHaveLength(1);
    expect(refs[0].children).toEqual([]);
    expect(refs[0].blanks?.map((blank) => text(sources, blank.answer))).toEqual([
      '护照问题',
      '留学',
      '回国',
      '邀请',
    ]);
    expect(text(sources, refs[0].question)).toContain('为祖国贡献力量');
  });

  it('preserves real bracket tasks when each has an explicit source answer', () => {
    const sources = [
      b('q', '18．照样子，简单概括。'),
      b('s1', '（1）为祖国贡献力量。'),
      b('s2', '（2）因为____而放弃____。'),
      b('key', '【答案】（1）正确。  （2）护照问题     留学'),
    ];
    expect(fastWordReferences(sources)[0].children.map((q) => q.sourceLabel)).toEqual(['1', '2']);
  });

  it('preserves a source leftover number only inside a proved reordering task', () => {
    const sources = [
      b('q3', '3．(     )最后回家。'),
      b('line2', '(     )走到公园。'),
      b('line3', '(     )出门。'),
      b('leftover', '16．请按顺序重新排列以上句子，把序号填在（   ）里。'),
      b('key', '【答案】     ③     ②     ①'),
      b('analysis', '【详解】应按游览顺序排列。'),
      b('q4', '4．下面说法正确的是（   ）'),
      b('options', 'A．认真观察。 B．随意讲解。'),
      b('key4', '【答案】A'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs.map((q) => q.sourceLabel)).toEqual(['3', '4']);
    expect(text(sources, refs[0].question)).toContain('16．请按顺序');
    expect(refs[0].blanks).toHaveLength(3);
    expect(refs[0].blanks?.map((blank) => text(sources, blank.answer))).toEqual(['③', '②', '①']);
  });

  it('retains real skipped main question labels and section restarts', () => {
    const sources = [
      b('q3', '3．解释词语。'),
      b('a3', '【答案】安静。'),
      b('q16', '16．请按顺序重新排列以下句子。'),
      b('a16', '【答案】①②③'),
      b('section', '二、现代文阅读'),
      b('q1', '1．解释词语。'),
      b('a1', '【答案】平静。'),
    ];
    expect(fastWordReferences(sources).map((q) => q.sourceLabel)).toEqual(['3', '16', '1']);
  });

  it('retains one clue task and routes a complete combined key to independent consecutive tasks', () => {
    const sources = [
      b('q9', '9．根据线索，写出对应的诗句。'),
      b('clues', '（1）诗句出自《暮江吟》；（2）景物有弯月、露珠。'),
      b('q10', '10．诗中描写了____。'),
      b('key', '【答案】9．露似真珠月似弓。    10．新月东升'),
      b('analysis', '【详解】9．这两个线索指向同一句诗。'),
      b('analysis10', '10．由原诗可知景物是新月。'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs.map((q) => q.sourceLabel)).toEqual(['9', '10']);
    expect(refs[0].children).toEqual([]);
    expect(text(sources, refs[0].answer)).toBe('露似真珠月似弓。');
    expect(text(sources, refs[1].answer)).toBe('新月东升');
    expect(owners(sources, 'clues')).toEqual([{ path: '1', field: 'question' }]);
  });

  it('retains an ambiguous bare key on its current task after numbering restarts', () => {
    const sources = [
      ...previous(),
      b('section', '二、现代文阅读'),
      b('q1', '1．解释词语。'),
      b('q2', '2．解释词语。'),
      b('key', '【答案】1．愉快。    2．安静。'),
    ];
    const diagnostics: Parameters<typeof fastWordReferences>[1] = [];
    const refs = fastWordReferences(sources, diagnostics);
    expect(refs.map((q) => text(sources, q.answer))).toEqual([
      '山中很安静。',
      '',
      '1．愉快。    2．安静。',
    ]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'word-import.check-question-boundary', blockId: 'key' }),
    );
  });

  it('attaches a proved adjacent command prelude to the next real task stem', () => {
    const sources = [
      b('old', '8．解释诗中的词语。'),
      b('old-key', '【答案】可爱。'),
      b('old-analysis', '【详解】本题考查诗词理解。'),
      b('prelude', '秋天藏在诗句里。按要求完成练习。'),
      b('q9', '9．根据线索，写出对应的诗句。'),
      b('clues', '（1）诗句出自《暮江吟》；（2）景物有弯月、露珠。'),
      b('q10', '10．诗中描写了____。'),
      b('key', '【答案】9．露似真珠月似弓。    10．新月东升'),
      b('analysis', '【详解】9．这两个线索指向同一句诗。'),
      b('analysis10', '10．由原诗可知景物是新月。'),
    ];
    const refs = fastWordReferences(sources);
    expect(refs.map((q) => q.sourceLabel)).toEqual(['8', '9', '10']);
    expect(owners(sources, 'prelude')).toEqual([{ path: '2', field: 'question' }]);
    expect(owners(sources, 'old-analysis')).toEqual([{ path: '1', field: 'analysis' }]);
    expect(text(sources, refs[1].question)).toContain('秋天藏在诗句里。按要求完成练习。');
    expect(text(sources, refs[0].analysis)).not.toContain('秋天藏在诗句里');
  });

  it.each(['incomplete-key', 'intervening-prose', 'unanswered', 'analysis-prefix', 'skipped-task'])(
    'keeps an unproved command prelude in its original field: %s',
    (kind) => {
      const sources = [
        b('old', '8．解释诗中的词语。'),
        b('old-key', '【答案】可爱。'),
        b('old-analysis', '【详解】本题考查诗词理解。'),
        b('prelude', '秋天藏在诗句里。按要求完成练习。'),
        b('q9', '9．根据线索，写出对应的诗句。'),
        b('q10', '10．诗中描写了____。'),
        b('key', '【答案】9．露似真珠月似弓。    10．新月东升'),
      ];
      if (kind === 'incomplete-key') sources[6] = b('key', '【答案】9．露似真珠月似弓。');
      if (kind === 'intervening-prose')
        sources.splice(4, 0, b('continuation', '这两句诗表现了宁静的秋夜。'));
      if (kind === 'unanswered') sources.splice(1, 2);
      if (kind === 'analysis-prefix')
        sources[3] = b('prelude', '示例：秋天藏在诗句里。按要求完成练习。');
      if (kind === 'skipped-task') sources[4] = b('q9', '11．根据线索，写出对应的诗句。');
      expect(owners(sources, 'prelude')).toEqual([
        { path: '1', field: kind === 'unanswered' ? 'question' : 'analysis' },
      ]);
    },
  );

  it('preserves a whole unkeyed poetry fill task when source answers exceed its slots', () => {
    const sources = [
      b('q', '12．根据诗句内容填空。'),
      b('s1', '（1）诗人是____，表达了____的心情。'),
      b('s2', '（2）用了____的修辞，将____比作____。'),
      b('key', '【答案】     白居易     喜爱     白居易     比喻     露珠     珍珠'),
      b('analysis', '【详解】（1）本题考查古诗。'),
    ];
    const diagnostics: any[] = [];
    const refs = fastWordReferences(sources, diagnostics);
    expect(refs[0].children).toEqual([]);
    expect(refs[0].questionType).toBe('short_answer');
    expect(refs[0].blanks).toBeUndefined();
    expect(text(sources, refs[0].question)).toContain('（1）');
    expect(text(sources, refs[0].question)).toContain('（2）');
    expect(text(sources, refs[0].answer)).toBe(
      '白居易     喜爱     白居易     比喻     露珠     珍珠',
    );
    expect(diagnostics.some((d) => d.code === 'word-import.uncertain-block')).toBe(true);
  });

  it('preserves keyed poetry children despite differing counts and preserves ordinary matching slots', () => {
    const sources = [
      b('q', '12．根据诗句内容填空。'),
      b('s1', '（1）诗人是____。'),
      b('s2', '（2）用了____的修辞，将____比作____。'),
      b('key', '【答案】（1）白居易     诗人    （2）比喻     露珠     珍珠'),
    ];
    expect(fastWordReferences(sources)[0].children.map((q) => q.sourceLabel)).toEqual(['1', '2']);
    sources[3] = b('key', '【答案】     白居易     比喻     露珠     珍珠');
    const refs = fastWordReferences(sources);
    expect(refs[0].children.map((q) => q.sourceLabel)).toEqual(['1', '2']);
    expect(refs[0].children.every((q) => q.answer.length)).toBe(true);
  });

  it('uses a shared pool for two independent choice blanks with exactly matching source letters', () => {
    const sources = [
      b('q', '23．阅读短诗，完成练习。'),
      b('material', '九月的霜花开到我鬓边来。'),
      b('s1', '(1)“零落”的意思是(     )。“素艳”的意思是(     )。'),
      b('pool', 'A．稀疏    B．生长    C．艳丽    D．素净美丽'),
      b('key', '【答案】(1)     A     D'),
    ];
    const refs = fastWordReferences(sources);
    const child = refs[0].children[0];
    expect(child.questionType).toBe('fill_with_candidates');
    expect(child.options?.map((o) => o.sourceLabel)).toEqual(['A', 'B', 'C', 'D']);
    expect(child.blanks?.map((blank) => text(sources, blank.answer))).toEqual(['A', 'D']);
    const preview = parseWordFast(sources, 'two-independent-choice-blanks');
    expect(preview.questions[0].sub_problems?.[0].has_answer).toBe(true);
  });

  it.each(['一、单项选择题', '一、多项选择题'])(
    'preserves explicit choice section semantics: %s',
    (heading) => {
      const sources = [
        b('heading', heading),
        b('q', '1．下面正确的是(    )、(    )。'),
        b('pool', 'A．安静 B．快乐 C．勇敢 D．明亮'),
        b('key', '【答案】A D'),
      ];
      expect(fastWordReferences(sources)[0].questionType).toBe(
        heading.includes('多项') ? 'multiple_choice' : 'single_choice',
      );
    },
  );

  it('keeps numbered choices for remote material slots as a whole answered task', () => {
    const sources = [
      b('heading', '快乐阅读。'),
      b('material', '①小鸟（1）____，小狗（2）____，大家（3）____，妹妹（4）____。'),
      b('q11', '11．体会人物的心情，选择恰当的词语填在文中横线上。'),
      b('pool', 'A．万分着急    B．惊慌害怕    C．激动不已    D．心中暗喜'),
      b('q12', '12．写出故事的主要内容。'),
      b('key', '【答案】11．（1）D  （2）C  （3）A  （4）B    12．小鸟和朋友快乐地生活。'),
    ];
    const refs = fastWordReferences(sources);
    const q11 = refs[0].children[0];
    expect(q11.questionType).toBe('short_answer');
    expect(q11.blanks).toBeUndefined();
    expect(q11.children).toEqual([]);
    expect(q11.options).toBeUndefined();
    expect(text(sources, q11.answer)).toBe('（1）D  （2）C  （3）A  （4）B');
    expect(text(sources, q11.question)).toContain('A．万分着急');
    expect(text(sources, q11.question)).toContain('D．心中暗喜');
    const preview = parseWordFast(sources, 'material-owned-choice-slots');
    const output = preview.questions[0].sub_problems![0];
    expect(output.question_type).toBe('short_answer');
    expect(output.has_answer).toBe(true);
    expect(Array.isArray(output.answer)).toBe(false);
    expect(preview.diagnostics.some((d) => d.code === 'word-import.invalid-answer-reference')).toBe(
      false,
    );
    expect(owners(sources, 'pool')).toEqual([{ path: '1/1', field: 'question' }]);
  });

  it('restores remote-slot pool text before its later stem continuation', () => {
    const sources = [
      b('heading', '快乐阅读。'),
      b('material', '①小鸟（1）____，小狗（2）____，大家（3）____，妹妹（4）____。'),
      b('q11', '11．选择恰当的词语填在文中横线上。'),
      b('pool', 'A．万分着急    B．惊慌害怕    C．激动不已    D．心中暗喜'),
      b('continuation', '注意结合故事中的人物心情。'),
      b('q12', '12．写出故事的主要内容。'),
      b('key', '【答案】11．（1）D  （2）C  （3）A  （4）B    12．小鸟和朋友快乐地生活。'),
    ];
    const question = fastWordReferences(sources)[0].children[0];
    expect(question.questionType).toBe('short_answer');
    expect(question.question.map((ref) => ref.blockId)).toEqual(['q11', 'pool', 'continuation']);
    const previewText = JSON.stringify(
      parseWordFast(sources, 'remote-slot-continuation').questions[0].sub_problems![0].question,
    );
    expect(previewText.indexOf('A．万分着急')).toBeLessThan(previewText.indexOf('注意结合故事'));
    expect(text(sources, question.answer)).toBe('（1）D  （2）C  （3）A  （4）B');
  });

  it.each([
    'ordinary',
    'missing-material-slot',
    'wrong-key-label',
    'missing-key',
    'explicit-single',
    'explicit-single-long',
    'explicit-multiple-long',
  ])('retains ordinary choice behavior without full remote-slot proof: %s', (kind) => {
    const sources = [
      b('heading', '快乐阅读。'),
      b('material', '①小鸟（1）____，小狗（2）____，大家（3）____，妹妹（4）____。'),
      b('q11', '11．选择恰当的词语填在文中横线上。'),
      b('pool', 'A．万分着急    B．惊慌害怕    C．激动不已    D．心中暗喜'),
      b('q12', '12．写出故事的主要内容。'),
      b('key', '【答案】11．（1）D  （2）C  （3）A  （4）B    12．小鸟和朋友快乐地生活。'),
    ];
    if (kind === 'ordinary') {
      sources[2] = b('q11', '11．下列词语正确的一项是（   ）');
      sources[5] = b('key', '【答案】11．A    12．小鸟和朋友快乐地生活。');
    }
    if (kind === 'missing-material-slot')
      sources[1] = b('material', '①小鸟（1）____，小狗（2）____，大家（3）____，妹妹开心地走了。');
    if (kind === 'wrong-key-label')
      sources[5] = b(
        'key',
        '【答案】11．（1）D  （2）C  （3）A  （5）B    12．小鸟和朋友快乐地生活。',
      );
    if (kind === 'missing-key')
      sources[5] = b('key', '【答案】11．（1）D  （2）C  （3）A    12．小鸟和朋友快乐地生活。');
    if (kind === 'explicit-single')
      sources[2] = b('q11', '11．（单选）选择恰当的词语填在文中横线上。');
    if (kind === 'explicit-single-long')
      sources[2] = b('q11', '11．（单项选择）选择恰当的词语填在文中横线上。');
    if (kind === 'explicit-multiple-long')
      sources[2] = b('q11', '11．（多项选择）选择恰当的词语填在文中横线上。');
    const refs = fastWordReferences(sources);
    expect(refs[0].children[0].questionType).toBe('single_choice');
    expect(refs[0].children[0].options).toHaveLength(4);
  });
});

describe('Quoted draw-line tools retain text without generating interactive blanks', () => {
  it.each([
    '用“_____”在文中画出描写小鸟的句子。',
    '选文画“______”的句子表达了怎样的感情？',
    '用"_____"画出小鸟的动作。',
  ])('does not make a quoted line tool a blank: %s', (value) => {
    const sources = [b('q', `26．${value}`), b('key', '【答案】表达了对小鸟的喜爱。')];
    expect(findWordBlankMarkers(sources[0])).toEqual([]);
    expect(fastWordReferences(sources)[0].questionType).toBe('short_answer');
    expect(text(sources, fastWordReferences(sources)[0].question)).toContain('_____');
  });

  it('excludes a quoted space-only drawing tool carrying underline marks', () => {
    const source: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '用“' },
        { type: 'text', text: '      ', marks: [{ type: 'underline' }] },
        { type: 'text', text: '”画出描写小鸟的句子。' },
      ],
    };
    expect(findWordBlankMarkers(source)).toEqual([]);
  });

  it('recognizes a quoted line tool across separate style runs while retaining a real blank', () => {
    const source: WordSourceBlock = {
      id: 'q',
      content: [
        { type: 'text', text: '用“' },
        { type: 'text', text: '_____', marks: [{ type: 'underline' }] },
        { type: 'text', text: '”画出句子，并补充词语：____。' },
      ],
    };
    const markers = findWordBlankMarkers(source);
    expect(markers).toHaveLength(1);
    expect(sourceText(source.content).slice(markers[0].start, markers[0].end)).toBe('____');
  });

  it.each([
    '补充诗句：“____，万里长征人未还。”',
    '把“小鸟____”这句话补充完整。',
    '句子写了小鸟的____，表达了作者的____。',
    '用“_____”在文中画出句子，作者的感情是____。',
  ])('retains actual quoted or ordinary blanks: %s', (value) => {
    expect(findWordBlankMarkers(b('q', value))).toHaveLength(value.includes('句子写了') ? 2 : 1);
  });
});
