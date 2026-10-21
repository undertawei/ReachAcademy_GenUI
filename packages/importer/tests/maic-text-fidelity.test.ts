import { describe, expect, it } from 'vitest';

import { maicCssColor, maicLinearGradient } from '../src/maic/style.js';
import { maicTextFrame } from '../src/maic/text.js';

describe('MAIC text fidelity', () => {
  it('retains both explicit and shorthand text gradients, including the CSS default direction', () => {
    const frame = maicTextFrame(
      '<p><span style="background: linear-gradient(rgb(255, 138, 128) 0%, rgb(255, 23, 68) 100%) text; color: transparent">scene</span><span style="background: linear-gradient(135deg, #E4B846 6%, #A44032 88%); background-clip: text; color: transparent">title</span></p>',
    );
    const runs = frame.doc.content![0]!.content!;
    expect(runs[0]!.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({
        color: '#00000000',
        textGradient: {
          angle: 180,
          stops: [
            { offset: 0, color: '#FF8A80' },
            { offset: 1, color: '#FF1744' },
          ],
        },
      }),
    });
    expect(runs[1]!.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({
        textGradient: {
          angle: 135,
          stops: [
            { offset: 0.06, color: '#E4B846' },
            { offset: 0.88, color: '#A44032' },
          ],
        },
      }),
    });
  });

  it('preserves source pre-wrap whitespace, scaled padding, paragraph spacing and run formatting', () => {
    const frame = maicTextFrame(
      '<div style="padding: 4px 8px"><p><strong><span style="font-size: 40px; letter-spacing: -2px">A  B\nC</span></strong></p><p style="line-height: 50px">second<br>line</p><p style="margin-top: 12px">third</p></div>',
      { type: 'text', wordSpace: 3, vertical: true },
      1.5,
    );
    expect(frame).toMatchObject({
      margins: { top: 6, right: 12, bottom: 6, left: 12 },
      wrap: true,
      orientation: 'vertical',
    });
    const paragraphs = frame.doc.content!;
    expect(paragraphs[0]!.attrs?.spaceBefore).toBe(0);
    expect(paragraphs[1]!.attrs).toMatchObject({ spaceBefore: 7.5, lineHeightPx: 75 });
    expect(paragraphs[2]!.attrs?.spaceBefore).toBe(18);
    expect(paragraphs[0]!.content![0]).toMatchObject({
      text: 'A  B\nC',
      marks: [
        { type: 'bold' },
        { type: 'textStyle', attrs: { fontSize: '60px', letterSpacing: -3 } },
      ],
    });
    expect(paragraphs[1]!.content![0]!.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({ letterSpacing: 4.5 }),
    });
    expect(paragraphs[1]!.content![1]).toEqual({ type: 'hardBreak' });
    expect(maicTextFrame('<p>a</p><p>b</p>').doc.content![1]!.attrs?.spaceBefore).toBe(0);
  });

  it('never imports executable markup, image nodes, links, arbitrary CSS or non-finite sizes', () => {
    const huge = '9'.repeat(400);
    const frame = maicTextFrame(
      `<script>secret</script><style>hidden</style><iframe>hidden</iframe><svg><text>hidden</text></svg><p><a href="javascript:alert(1)" onclick="alert(2)">safe</a><img src="https://example.com/track"><span style="color: rgb(999, 0, 0); font-size: ${huge}px; letter-spacing: ${huge}px; background: url(https://example.com/track)">visible</span></p>`,
    );
    const json = JSON.stringify(frame);
    expect(json).not.toMatch(/secret|hidden|javascript|onclick|https|Infinity/);
    expect(frame.doc.content![0]!.content!.map((node) => node.text).join('')).toBe('safevisible');
    expect(frame.doc.content![0]!.content![1]!.marks).toEqual([
      { type: 'textStyle', attrs: { fontFamily: 'Source Han Sans VF' } },
    ]);
  });

  it('handles deeply nested source HTML without recursive traversal', () => {
    const frame = maicTextFrame(
      '<p>' + '<b>'.repeat(12000) + 'kept' + '</b>'.repeat(12000) + '</p>',
    );
    expect(frame.doc.content![0]!.content![0]!.text).toBe('kept');
    expect(
      frame.doc.content![0]!.content![0]!.marks!.filter((mark) => mark.type === 'bold'),
    ).toHaveLength(1);
  });

  it('rejects malformed colors and unsafe or unsupported gradient values', () => {
    for (const value of [
      '#12345',
      '#1234567',
      'rgb(999, 0, 0)',
      'rgba(0,0,0,2)',
      'red; background: url(x)',
    ])
      expect(maicCssColor(value)).toBeUndefined();
    expect(maicCssColor('#1234')).toBe('#11223344');
    expect(maicCssColor('rgba(164, 64, 50, 0.5)')).toBe('#A4403280');
    expect(maicLinearGradient('linear-gradient(45deg, url(x) 0%, #ffffff 100%)')).toBeUndefined();
    expect(
      maicLinearGradient(`linear-gradient(${'9'.repeat(400)}deg, #000000 0%, #ffffff 100%)`),
    ).toBeUndefined();
  });
});
