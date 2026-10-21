import { describe, expect, it } from 'vitest';
import {
  findWordBlankMarkers,
  sourceText,
  type WordSourceBlock,
} from '../src/word-import/contracts.js';

const highlighted = (value: string, rest = ''): WordSourceBlock => ({
  id: 'value',
  content: [
    { type: 'text', text: value, marks: [{ type: 'underline' }] },
    { type: 'text', text: rest },
  ],
});

describe('Math source blank markers', () => {
  it.each(['123456', '3.05', '1,234', '9．75'])('keeps highlighted numeric data: %s', (value) => {
    const block = highlighted(value);
    expect(findWordBlankMarkers(block)).toEqual([]);
    expect(sourceText(block.content)).toBe(value);
    expect(block.content[0].marks).toEqual([{ type: 'underline' }]);
  });

  it('uses the complete stem and ancestor hints for highlighted small values', () => {
    const block = highlighted('36', '平方厘米，读作（  ）。');
    expect(findWordBlankMarkers(block, 0, undefined, '读出下面各数')).toEqual([
      { blockId: 'value', start: 10, end: 12 },
    ]);
    expect(findWordBlankMarkers(highlighted('12'), 0, undefined, '横线上的数是已知数据')).toEqual(
      [],
    );
  });

  it('preserves old numbered English cloze and padded labels', () => {
    expect(findWordBlankMarkers(highlighted('11', ' then choose'))[0].sourceLabel).toBe('11');
    expect(findWordBlankMarkers(highlighted('    12    '))[0].sourceLabel).toBe('12');
    expect(
      findWordBlankMarkers(
        highlighted('    12    ', ' then choose'),
        0,
        undefined,
        '将下列句子改写成正确形式',
      )[0].sourceLabel,
    ).toBe('12');
    expect(
      findWordBlankMarkers(highlighted('    12    '), 0, undefined, '横线上的数')[0].sourceLabel,
    ).toBe('12');
  });

  it.each([
    ['123', '456'],
    ['3', '.', '05'],
  ])('recognizes numeric data across Word style runs: %j', (...parts) => {
    const block: WordSourceBlock = {
      id: 'split',
      content: parts.map((text, index) => ({
        type: 'text',
        text,
        marks: text === '.' ? [] : [{ type: 'underline' }, ...(index ? [{ type: 'bold' }] : [])],
      })),
    };
    expect(findWordBlankMarkers(block)).toEqual([]);
    expect(sourceText(block.content)).toBe(parts.join(''));
  });

  it.each(['()', '（ ）', '(  )', '（\u00a0\u00a0）'])(
    'recognizes empty math placeholders: %s',
    (value) => {
      const block: WordSourceBlock = {
        id: 'blank',
        content: [{ type: 'text', text: `x=${value}` }],
      };
      const [marker] = findWordBlankMarkers(block);
      expect(marker).toBeDefined();
      expect(marker.end! - marker.start!).toBeGreaterThan(0);
      expect(
        findWordBlankMarkers({
          id: 'citation',
          content: [{ type: 'text', text: 'x=(2) and (AB)' }],
        }),
      ).toEqual([]);
    },
  );
});
