import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_FORMULA_READING_MAX_CHARACTERS,
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  parseReachDeckFormulaReadingsV1,
  planReachDeckSsmlChunks,
  projectReachDeckSpeechDocument,
  serializeReachDeckSpeechMarkupToSsml,
} from '../src/index.js';

const markdown = String.raw`比例可以写成\(\displaystyle \frac{AB}{A'B'}=k\)。再看\(x^{2}\)。`;
const first = { from: markdown.indexOf('\\('), to: markdown.indexOf('\\)') + 2 };
const second = { from: markdown.lastIndexOf('\\('), to: markdown.lastIndexOf('\\)') + 2 };

describe('formula readings', () => {
  it('speaks the reading while the formula stays one visible atomic unit', () => {
    const formulaReadings = [
      { ...second, reading: 'x的平方' },
      { ...first, reading: 'AB比A撇B撇等于k' },
    ];
    const projection = projectReachDeckSpeechDocument(markdown, undefined, { formulaReadings });
    expect(projection.alignmentTranscript).toBe('比例可以写成AB比A撇B撇等于k。再看x的平方。');
    expect(projection.visibleText).toContain(String.raw`\(\displaystyle \frac{AB}{A'B'}=k\)`);
    const formulaEntries = projection.alignmentMap.filter((entry) => entry.kind === 'formula');
    expect(formulaEntries).toEqual([
      expect.objectContaining({ markdownFrom: first.from, markdownTo: first.to, atomic: true }),
      expect.objectContaining({ markdownFrom: second.from, markdownTo: second.to, atomic: true }),
    ]);

    const ssml = serializeReachDeckSpeechMarkupToSsml(markdown, undefined, { formulaReadings });
    expect(ssml).toBe('<speak>比例可以写成AB比A撇B撇等于k。再看x的平方。</speak>');
    const chunks = planReachDeckSsmlChunks(markdown, undefined, undefined, { formulaReadings });
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(
      projection.alignmentTranscript,
    );
    expect(chunks.every((chunk) => !chunk.ssml.includes('\\'))).toBe(true);
  });

  it('keeps the source for formulas without a reading and teacher marks unchanged', () => {
    const speechMarkup = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [{ type: 'break' as const, at: 0, durationMs: 200 }],
    };
    const ssml = serializeReachDeckSpeechMarkupToSsml(markdown, speechMarkup, {
      formulaReadings: [{ ...first, reading: 'AB比A撇B撇等于k' }],
    });
    expect(ssml).toBe(
      String.raw`<speak><break time="200ms"/>比例可以写成AB比A撇B撇等于k。再看\(x^{2}\)。</speak>`,
    );
  });

  it('speaks a plain-text expression reading as one atomic unit with its visible source', () => {
    const plain = String.raw`偶函数满足 f(\-x)=f(x)，所以图像关于 y 轴对称。`;
    const expression = { from: plain.indexOf('f('), to: plain.indexOf('，') };
    const formulaReadings = [{ ...expression, reading: 'f负x等于f x' }];
    const projection = projectReachDeckSpeechDocument(plain, undefined, { formulaReadings });
    expect(projection.alignmentTranscript).toBe('偶函数满足 f负x等于f x，所以图像关于 y 轴对称。');
    expect(projection.alignmentMap.filter((entry) => entry.kind === 'formula')).toEqual([
      expect.objectContaining({
        markdownFrom: expression.from,
        markdownTo: expression.to,
        atomic: true,
      }),
    ]);
    expect(projection.visibleText).toContain('f(-x)=f(x)');
    const chunks = planReachDeckSsmlChunks(plain, undefined, undefined, { formulaReadings });
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(
      projection.alignmentTranscript,
    );
  });

  it('lets teacher speech marks win over an overlapping plain-text expression reading', () => {
    const plain = '已知 x∈D，求值。';
    const expression = { from: plain.indexOf('x'), to: plain.indexOf('，') };
    const speechMarkup = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [{ type: 'sub' as const, ...expression, alias: 'x属于大D' }],
    };
    const projection = projectReachDeckSpeechDocument(plain, speechMarkup, {
      formulaReadings: [{ ...expression, reading: 'x属于D' }],
    });
    expect(projection.alignmentTranscript).toBe('已知 x属于大D，求值。');
  });

  it.each([
    ['surrounding whitespace', [{ from: 2, to: 7, reading: 'x属于D' }]],
    ['a split Markdown escape', [{ from: 14, to: 18, reading: '负x属于D' }]],
    ['a line break', [{ from: 3, to: 18, reading: 'x属于D' }]],
    [
      'overlapping ranges',
      [
        { from: 3, to: 6, reading: 'x属于D' },
        { from: 5, to: 6, reading: 'D' },
      ],
    ],
  ])('rejects a plain-text expression range with %s', (_label, value) => {
    const plain = String.raw`已知 x∈D，求值。` + '\n' + String.raw`且 \-x∈D。`;
    expect(plain.slice(3, 6)).toBe('x∈D');
    expect(plain.slice(13, 15)).toBe(String.raw`\-`);
    expect(() => parseReachDeckFormulaReadingsV1(plain, value)).toThrowError(
      expect.objectContaining({ code: 'invalid-formula-reading' }),
    );
    expect(parseReachDeckFormulaReadingsV1(plain, [{ from: 3, to: 6, reading: 'x属于D' }])).toEqual(
      [{ from: 3, to: 6, reading: 'x属于D' }],
    );
  });

  it('sorts valid readings by source order', () => {
    expect(
      parseReachDeckFormulaReadingsV1(markdown, [
        { ...second, reading: 'x的平方' },
        { ...first, reading: 'k' },
      ]).map((reading) => reading.from),
    ).toEqual([first.from, second.from]);
  });

  it.each([
    ['not an array', {}],
    ['a partial formula range', [{ from: first.from + 2, to: first.to, reading: '读法' }]],
    ['a plain range of ordinary prose', [{ from: 0, to: 2, reading: '读法' }]],
    [
      'a repeated formula',
      [
        { ...first, reading: '一' },
        { ...first, reading: '二' },
      ],
    ],
    ['an unknown key', [{ ...first, reading: '读法', extra: true }]],
    ['an empty reading', [{ ...first, reading: '' }]],
    ['an untrimmed reading', [{ ...first, reading: ' 读法' }]],
    ['a multiline reading', [{ ...first, reading: '一\n二' }]],
    ['LaTeX in the reading', [{ ...first, reading: String.raw`\frac{a}{b}` }]],
    ['markup in the reading', [{ ...first, reading: '<break/>' }]],
    [
      'an overlong reading',
      [{ ...first, reading: '读'.repeat(REACH_DECK_FORMULA_READING_MAX_CHARACTERS + 1) }],
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => parseReachDeckFormulaReadingsV1(markdown, value)).toThrowError(
      expect.objectContaining({ code: 'invalid-formula-reading' }),
    );
  });
});
