// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { ReachDeckRichText } from '../src/ReachDeckRichText';

describe('ReachDeckRichText', () => {
  it('uses a uniform bilingual run family for native paragraph baselines without changing PPTX or mixed-font paragraphs', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const text = (value: string, family?: string) => ({
      type: 'text',
      text: value,
      ...(family ? { marks: [{ type: 'textStyle', attrs: { fontFamily: family } }] } : {}),
    });
    const content = [
      {
        type: 'paragraph',
        attrs: { fontSize: 27, lineHeightPx: 40 },
        content: [
          text('水循环', 'Source Han Sans VF'),
          { type: 'hardBreak' },
          text('Water cycle', 'Source Han Sans VF'),
        ],
      },
      { type: 'paragraph', content: [text('中文', 'Source Han Sans VF'), text('Latin', 'Inter')] },
      { type: 'paragraph', content: [text('中文', 'Source Han Sans VF'), text(' unspecified')] },
      { type: 'paragraph', content: [text('中文 Latin', 'Noto Sans')] },
      { type: 'paragraph', content: [text('中文 Latin', 'Noto Serif')] },
    ];
    act(() => root.render(<ReachDeckRichText document={{ type: 'doc', content }} />));
    const paragraphs = host.querySelectorAll<HTMLElement>('p');
    expect(paragraphs[0]?.style.fontFamily).toContain('Source Han Sans VF');
    expect(paragraphs[0]?.style.lineHeight).toBe('40px');
    expect(paragraphs[1]?.style.fontFamily).toBe('');
    expect(paragraphs[2]?.style.fontFamily).toBe('');
    for (const index of [3, 4]) {
      expect(paragraphs[index]?.style.fontFamily).toBe(
        paragraphs[index]?.querySelector<HTMLElement>('span')?.style.fontFamily,
      );
      expect(paragraphs[index]?.style.fontFamily).toContain(
        index === 3 ? 'Noto Sans SC' : 'Noto Serif SC',
      );
    }
    act(() =>
      root.render(<ReachDeckRichText document={{ type: 'doc', content }} pptxTextCompat />),
    );
    expect(host.querySelector<HTMLElement>('p')?.style.fontFamily).toBe('');
    act(() => root.unmount());
  });

  it('preserves explicit HTML inline line boxes without changing historical fixed paragraph leading', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: { fontSize: 18, lineHeightPx: 26.1 },
                content: [
                  {
                    type: 'text',
                    text: 'Divide both sides by t:',
                    marks: [{ type: 'textStyle', attrs: { fontSize: '18px', lineHeightPx: 26.1 } }],
                  },
                  { type: 'hardBreak' },
                  {
                    type: 'text',
                    text: 'v = d/t',
                    marks: [{ type: 'textStyle', attrs: { fontSize: '42px', lineHeightPx: 50.4 } }],
                  },
                ],
              },
              {
                type: 'paragraph',
                attrs: { fontSize: 18, lineHeightPx: 26.1 },
                content: [
                  {
                    type: 'text',
                    text: 'Historical run',
                    marks: [{ type: 'textStyle', attrs: { fontSize: '42px' } }],
                  },
                ],
              },
            ],
          }}
        />,
      ),
    );
    const paragraphs = host.querySelectorAll('p');
    expect(paragraphs[0]!.style.fontSize).toBe('18px');
    expect(paragraphs[0]!.style.lineHeight).toBe('26.1px');
    expect(
      Array.from(paragraphs[0]!.querySelectorAll('span')).find(
        (span) => span.textContent === 'v = d/t',
      )!.style.lineHeight,
    ).toBe('50.4px');
    expect(paragraphs[1]!.style.lineHeight).toBe('26.1px');
    expect(paragraphs[1]!.querySelector('span')!.style.lineHeight).toBe('');
    act(() => root.unmount());
  });
  it('keeps explicit paragraph baseline sizes separate from larger inline text and preserves legacy inference', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const content = [
      {
        type: 'text',
        text: 'Large inline',
        marks: [{ type: 'textStyle', attrs: { fontSize: '53.75px' } }],
      },
    ];
    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              { type: 'paragraph', attrs: { fontSize: 20, lineHeightPx: 65 }, content },
              { type: 'paragraph', attrs: { fontSize: 20, lineHeight: 1.5 } },
              { type: 'paragraph', attrs: { lineHeightPx: 65 }, content },
            ],
          }}
        />,
      ),
    );
    const paragraphs = host.querySelectorAll<HTMLElement>('p');
    expect(paragraphs[0]?.style.fontSize).toBe('20px');
    expect(paragraphs[0]?.style.lineHeight).toBe('65px');
    expect(paragraphs[0]?.querySelector<HTMLElement>('span')?.style.fontSize).toBe('53.75px');
    expect(paragraphs[1]?.style.fontSize).toBe('20px');
    expect(paragraphs[1]?.querySelector('br')).not.toBeNull();
    expect(paragraphs[2]?.style.fontSize).toBe('53.75px');
    act(() => root.unmount());
    host.remove();
  });
  it('applies paragraph default character spacing to text without an explicit run style', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: { defaultLetterSpacing: 3 },
                content: [
                  { type: 'text', text: 'Future text' },
                  { type: 'inlineMath', attrs: { latex: 'x^2' } },
                ],
              },
            ],
          }}
        />,
      ),
    );

    expect(host.querySelector<HTMLElement>('.text-element__paragraph')?.style.letterSpacing).toBe(
      '3px',
    );
    expect(
      host.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')?.style.letterSpacing,
    ).toBe('normal');
    act(() => root.unmount());
    host.remove();
  });

  it('applies an animation color override to marked text and inline/block formulas', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <ReachDeckRichText
          animationTextColor="#2563EB"
          document={{
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Animated',
                    marks: [{ type: 'textStyle', attrs: { color: '#FF0000' } }],
                  },
                  { type: 'inlineMath', attrs: { latex: 'x^2', color: '#00FF00' } },
                ],
              },
              { type: 'blockMath', attrs: { latex: 'y=1', color: '#00FF00' } },
            ],
          }}
        />,
      ),
    );
    expect(host.querySelector<HTMLElement>('span[style]')?.style.color).toBe('rgb(37, 99, 235)');
    for (const math of host.querySelectorAll<HTMLElement>('[data-mathlive-node]')) {
      expect(math.style.color).toBe('rgb(37, 99, 235)');
    }
    act(() => root.unmount());
    host.remove();
  });

  it('leaves formulas and ordinary paragraphs unpinned when defaultFontSize is omitted', () => {
    const host = document.createElement('div');
    host.style.fontSize = '36px';
    document.body.append(host);
    const root = createRoot(host);

    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: '继承' },
                  { type: 'inlineMath', attrs: { latex: 'x^2' } },
                ],
              },
              { type: 'blockMath', attrs: { latex: 'y=1' } },
            ],
          }}
        />,
      ),
    );

    expect(host.querySelector<HTMLElement>('.text-element__paragraph')?.style.fontSize).toBe('');
    expect(
      host.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')?.style.fontSize,
    ).toBe('');
    expect(
      host.querySelector<HTMLElement>('[data-mathlive-node="block-math"]')?.style.fontSize,
    ).toBe('');
    expect(host.style.fontSize).toBe('36px');

    act(() => root.unmount());
    host.remove();
  });

  it.each([64, 30, 24])(
    'applies explicit generated tier %ipx to inline and pure block math',
    (fontSize) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      act(() =>
        root.render(
          <ReachDeckRichText
            defaultFontSize={fontSize}
            document={{
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'inlineMath', attrs: { latex: 'x' } }],
                },
                { type: 'blockMath', attrs: { latex: 'y' } },
              ],
            }}
          />,
        ),
      );
      for (const math of host.querySelectorAll<HTMLElement>('[data-mathlive-node]')) {
        expect(math.style.fontSize).toBe(`${fontSize}px`);
      }
      act(() => root.unmount());
      host.remove();
    },
  );

  it('renders marks plus static inline and block formulas without editable controls', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() =>
      root.render(
        <ReachDeckRichText
          defaultFontSize={30}
          document={{
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', marks: [{ type: 'bold' }], text: '公式' },
                  {
                    type: 'inlineMath',
                    attrs: {
                      latex: 'x^2',
                      color: '#123456',
                      fontFamily: 'Source Han Sans VF',
                      fontSize: '30px',
                      lineHeightPx: 42,
                    },
                  },
                ],
              },
              { type: 'blockMath', attrs: { latex: 'y=x^2+1' } },
            ],
          }}
        />,
      ),
    );

    expect(host.textContent).toContain('公式');
    expect(host.querySelector('[data-mathlive-node="inline-math"] .katex')).not.toBeNull();
    expect(host.querySelector('[data-mathlive-node="block-math"] .katex-display')).not.toBeNull();
    expect(host.querySelector('math-field')).toBeNull();
    const inline = host.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]');
    const block = host.querySelector<HTMLElement>('[data-mathlive-node="block-math"]');
    expect(inline?.style.fontSize).toBe('30px');
    expect(inline?.style.lineHeight).toBe('42px');
    expect(inline?.style.fontFamily).toContain('Source Han Sans VF');
    expect(inline?.style.color).toBe('rgb(18, 52, 86)');
    expect(block?.style.fontSize).toBe('30px');

    act(() => root.unmount());
    host.remove();
  });

  it('keeps Markdown bold visually effective when inherited typography omits fontWeight', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    marks: [
                      { type: 'textStyle', attrs: { fontFamily: 'Montserrat', fontSize: '40px' } },
                      { type: 'bold' },
                    ],
                    text: '继承后的粗体',
                  },
                  {
                    type: 'text',
                    marks: [
                      {
                        type: 'textStyle',
                        attrs: { fontFamily: 'Montserrat', fontSize: '40px', fontWeight: 400 },
                      },
                    ],
                    text: '普通文字',
                  },
                ],
              },
            ],
          }}
        />,
      ),
    );

    const styled = [...host.querySelectorAll<HTMLElement>('span[style]')];
    expect(styled[0]?.style.fontWeight).toBe('700');
    expect(styled[0]?.style.fontSize).toBe('40px');
    expect(styled[1]?.style.fontWeight).toBe('400');

    act(() => root.unmount());
    host.remove();
  });

  it('renders answer lists and asset-backed images', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一步' }] }],
                  },
                ],
              },
              {
                type: 'image',
                attrs: {
                  alt: 'diagram',
                  objectKey: 'org/student-deck/diagram.png',
                  src: 'https://assets.example.test/diagram.png',
                },
              },
            ],
          }}
        />,
      ),
    );

    expect(host.querySelector('ul li')?.textContent).toContain('第一步');
    const image = host.querySelector<HTMLImageElement>('img[data-object-key]');
    expect(image?.src).toBe('https://assets.example.test/diagram.png');
    expect(image?.alt).toBe('diagram');

    act(() => root.unmount());
    host.remove();
  });

  it('renders headings and Word-pasted table structure in document-surface rich text', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() =>
      root.render(
        <ReachDeckRichText
          document={{
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 2 },
                content: [{ type: 'text', text: '小标题' }],
              },
              {
                type: 'table',
                content: [
                  {
                    type: 'tableRow',
                    content: [
                      {
                        type: 'tableHeader',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: '项目' }] }],
                      },
                      {
                        type: 'tableCell',
                        attrs: { colspan: 2 },
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: '取值' }] }],
                      },
                    ],
                  },
                ],
              },
            ],
          }}
        />,
      ),
    );

    expect(host.querySelector('h2')?.textContent).toBe('小标题');
    expect(host.querySelector('table tbody tr th')?.textContent).toBe('项目');
    const cell = host.querySelector<HTMLTableCellElement>('table tbody tr td');
    expect(cell?.textContent).toBe('取值');
    expect(cell?.colSpan).toBe(2);

    act(() => root.unmount());
    host.remove();
  });

  describe('inline images referenced only by objectKey', () => {
    const renderImage = (
      attrs: Record<string, unknown>,
      mediaUrlsByObjectKey?: Readonly<Record<string, string>>,
    ) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      act(() =>
        root.render(
          <ReachDeckRichText
            document={{ type: 'doc', content: [{ type: 'image', attrs }] }}
            {...(mediaUrlsByObjectKey === undefined ? {} : { mediaUrlsByObjectKey })}
          />,
        ),
      );
      return {
        host,
        cleanup: () => {
          act(() => root.unmount());
          host.remove();
        },
      };
    };

    it('resolves the display url from the objectKey map', () => {
      const { host, cleanup } = renderImage(
        { alt: '受力分析', objectKey: 'org/deck/quiz/forces.png' },
        { 'org/deck/quiz/forces.png': 'https://assets.example.test/forces.png?signature' },
      );

      const image = host.querySelector<HTMLImageElement>('img[data-object-key]');
      expect(image?.getAttribute('src')).toBe('https://assets.example.test/forces.png?signature');
      expect(image?.alt).toBe('受力分析');

      cleanup();
    });

    it('falls back to the alt-text placeholder when the key is unresolved', () => {
      const { host, cleanup } = renderImage(
        { alt: '受力分析', objectKey: 'org/deck/quiz/gone.png' },
        {},
      );

      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('[role="img"]')?.textContent).toBe('受力分析');

      cleanup();
    });

    it('prefers the freshly signed url over a stale src stored on the node', () => {
      const { host, cleanup } = renderImage(
        { objectKey: 'org/deck/answer.png', src: 'https://assets.example.test/expired.png' },
        { 'org/deck/answer.png': 'https://assets.example.test/fresh.png?signature' },
      );

      expect(host.querySelector<HTMLImageElement>('img')?.getAttribute('src')).toBe(
        'https://assets.example.test/fresh.png?signature',
      );

      cleanup();
    });
  });
});
