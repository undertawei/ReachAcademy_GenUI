import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CLIPBOARD_HTML_MAX_CHARACTERS,
  CLIPBOARD_MAX_NODES,
  CLIPBOARD_MAX_PARAGRAPHS,
  CLIPBOARD_MAX_TEXT_CHARACTERS,
  ClipboardBudgetError,
  serializeClipboardDocument,
  transformOfficeClipboardHtml,
  type ClipboardDocument,
} from '../src/index.js';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', name), 'utf8');
}

function transformed(html: string, tableMode?: 'flatten' | 'preserve'): string {
  const result = transformOfficeClipboardHtml(html, { tableMode });
  expect(result.kind).toBe('transformed');
  return result.kind === 'transformed' ? result.html : '';
}

describe('Office clipboard detection', () => {
  it('does not let a public ProseMirror slice marker bypass external conversion', () => {
    const externalSlice = transformOfficeClipboardHtml(fixture('data-pm-slice.html'));
    expect(externalSlice).toMatchObject({ kind: 'transformed', source: 'mathml' });
    if (externalSlice.kind === 'transformed') {
      expect(externalSlice.html).toContain('data-latex="x"');
      expect(externalSlice.html).not.toMatch(/data-(?:object-key|pm-slice|quiz-blank)/);
    }
    expect(
      transformOfficeClipboardHtml(
        '<meta content="Word.Document"><p data-pm-slice="0 0 []">Office text</p>',
      ),
    ).toMatchObject({ kind: 'transformed' });
  });

  it('bypasses ordinary external HTML', () => {
    expect(transformOfficeClipboardHtml('<p><strong>ordinary</strong></p>')).toEqual({
      kind: 'not-applicable',
    });
  });

  it('recognizes Office metadata, OMML, and standalone MathML', () => {
    expect(transformOfficeClipboardHtml(fixture('word-basic.html')).kind).toBe('transformed');
    expect(transformOfficeClipboardHtml(fixture('omml-common.html')).kind).toBe('transformed');
    const mathml = transformOfficeClipboardHtml(fixture('mathml.html'));
    expect(mathml.kind).toBe('transformed');
    if (mathml.kind === 'transformed') expect(mathml.source).toBe('mathml');
  });
});

describe('Office HTML normalization', () => {
  it('retains bounded paragraphs, list structure, marks, alignment, and safe typography', () => {
    const html = transformed(fixture('word-basic.html'));
    expect(html).toContain('<p style="text-align: center">');
    expect(html).toContain(
      '<strong><em><span style="color: #123456; font-family: Arial; font-size: 12pt">Styled text</span></em></strong>',
    );
    expect(html).toMatch(/<u>\s*underlined\s*<\/u>/);
    expect(html).toContain('<ol>');
    expect(html).toMatch(/<ol><li><p>\s*First\s*<\/p><\/li><li><p>\s*Second/);
    expect(html).not.toContain('mso-');
  });

  it('keeps ordered Word lists from hidden and revealed supportLists conditionals', () => {
    const html = transformed(fixture('word-list-conditional.html'));

    expect(html).toMatch(
      /<ol><li><p>\s*First item\s*<\/p><\/li><li><p>\s*Second item\s*<\/p><\/li><\/ol>/,
    );
    expect(html).not.toMatch(/supportLists|mso-list|1\.\s*First|2\.\s*Second/);
  });

  it('preserves heading levels while normalizing Office paragraphs', () => {
    const html = transformed(
      '<meta content="Word.Document"><h2 style="text-align: right">Title</h2>',
    );

    expect(html).toBe('<h2 style="text-align: right">Title</h2>');
  });

  it('preserves mso-tab-count with bounded non-collapsing spacing', () => {
    const twoTabs = transformed(
      '<meta content="Word.Document"><p>before<span style="mso-tab-count: 2"> </span>after</p>',
    );
    const boundedTabs = transformed(
      '<meta content="Word.Document"><p>before<span style="mso-tab-count: 99">&nbsp;</span>after</p>',
    );

    expect(twoTabs).toBe(`<p>before${'\u00a0'.repeat(8)}after</p>`);
    expect(boundedTabs).toBe(`<p>before${'\u00a0'.repeat(128)}after</p>`);
  });

  it('exposes only positive equation conditionals and drops Word document metadata', () => {
    const html = transformed(fixture('word-head-metadata.html'));

    expect(html).toContain('before');
    expect(html).toContain('data-latex="\\frac{a}{b}"');
    expect(html).toContain('after');
    expect(html).not.toMatch(
      /private|metadata|fallback|documentproperties|worddocument|smarttag|<xml|<meta|<title|<v:/i,
    );
  });

  it('drops aria-hidden inline and structured branches from visible output', () => {
    const html = transformed(
      '<meta content="Word.Document"><p>before<span aria-hidden="true">inline duplicate</span>after</p>' +
        '<ol><li>visible item</li><li aria-hidden="true">hidden item</li></ol>' +
        '<table><tr><td>visible cell</td><td aria-hidden="true">hidden cell</td></tr>' +
        '<tr aria-hidden="true"><td>hidden row</td></tr></table>',
    );

    expect(html).toContain('beforeafter');
    expect(html).toContain('visible item');
    expect(html).toContain('visible cell');
    expect(html).not.toMatch(/duplicate|hidden item|hidden cell|hidden row/);
  });

  it('preserves a bounded table or flattens each row with non-collapsing cell separators', () => {
    const preserved = transformed(fixture('table.html'), 'preserve');
    expect(preserved).toContain('<table><tbody><tr>');
    expect(preserved).toContain('<th colspan="100" rowspan="2">');
    expect(preserved).toContain('Nested A');
    expect(preserved).toContain('Nested B');
    expect(preserved).not.toContain('<table><tbody><tr><td><p>Nested A');
    expect(preserved).not.toContain('onclick');

    const flattened = transformed(fixture('table.html'), 'flatten');
    expect(flattened).not.toContain('<table');
    expect(flattened).toContain(`Heading${'\u00a0\u00a0'} One`);
    expect(flattened).toContain(`Nested A${'\u00a0\u00a0'}Nested B`);
    expect(flattened).toContain('<p>Two</p>');
  });

  it('keeps only visible image alt text and never serializes an image source', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const html = transformed(fixture('image-alt.html'));
    expect(html).toContain('Before A &quot;diagram&quot; &lt;one&gt; after');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('data:image');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('places escaped image markers only in visible content and reports remaining images', () => {
    const imagePlaceholder = vi.fn().mockReturnValueOnce('<upload>').mockReturnValue(undefined);
    const onUnavailableImage = vi.fn();
    const result = transformOfficeClipboardHtml(
      '<meta content="Word.Document"><xml><img src="file:///metadata.png"></xml>' +
        '<p>before<!--[if !msEquation]><img src="file:///fallback.png"><![endif]-->' +
        '<!--[if !vml]><img src="file:///image.png"><![endif]-->after' +
        '<img src="file:///extra.png" alt="extra"></p>',
      { imagePlaceholder, onUnavailableImage },
    );

    expect(result).toMatchObject({
      kind: 'transformed',
      html: '<p>before&lt;upload&gt;afterextra</p>',
    });
    expect(imagePlaceholder).toHaveBeenCalledTimes(2);
    expect(onUnavailableImage).toHaveBeenCalledTimes(1);
  });

  it('drops active content, arbitrary attributes, links, URLs, and unsafe CSS', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const html = transformed(fixture('malicious.html'));
    expect(html).toContain('safe');
    expect(html).toContain('link');
    expect(html).toContain('styled');
    expect(html).toContain('visible image');
    expect(html).not.toMatch(/script|iframe|object|onload|onclick|href|src=|url\s*\(/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('formula conversion', () => {
  it('converts supported OMML and a verified top bar into guarded math markup', () => {
    const result = transformOfficeClipboardHtml(fixture('omml-common.html'));
    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') return;
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toContain('data-latex="\\frac{a}{b}"');
    expect(result.html).toContain('data-latex="\\left[ x \\right]"');
    expect(result.html).toContain('data-latex="\\overline{y}"');
  });

  it('converts Word equation arrays with an invisible closing delimiter', () => {
    const result = transformOfficeClipboardHtml(fixture('omml-equation-array.html'));
    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') return;
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toContain(
      'data-latex="\\left\\{ \\begin{aligned}a+4=0 \\\\ 2-2a\\neq 0\\end{aligned} \\right."',
    );
  });

  it('keeps double-digit equation array placeholders distinct', () => {
    const arrays = Array.from(
      { length: 12 },
      (_, index) => `<m:eqArr><m:e><m:r><m:t>x=${index}</m:t></m:r></m:e></m:eqArr>`,
    ).join('');
    const result = transformOfficeClipboardHtml(
      `<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body><m:oMath>${arrays}</m:oMath></body></html>`,
    );
    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') return;
    expect(result.diagnostics).toEqual([]);
    for (let index = 0; index < 12; index += 1) {
      expect(result.html).toContain(`\\begin{aligned}x=${index}\\end{aligned}`);
    }
    expect(result.html).not.toContain('ReachEquationArrayToken');
  });

  it('restores self-closing radical siblings without losing an explicit degree', () => {
    const result = transformOfficeClipboardHtml(fixture('omml-radicals.html'));
    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') return;
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toContain('data-latex="\\sqrt{x}"');
    expect(result.html).toContain('data-latex="\\sqrt[3]{y}"');
    expect(result.html).toContain('data-latex="\\sqrt{z}"');
    expect(result.html).not.toContain('data-latex="\\sqrt[4]{z}"');
    expect(result.html).toContain('data-latex="\\text{m}"');
    expect(result.html).toContain('data-latex="\\text{单位}"');
  });

  it('converts bounded MathML tokens, scripts, roots, fences, and matrices', () => {
    const result = transformOfficeClipboardHtml(fixture('mathml.html'));
    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') return;
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toContain('data-latex="{x}_{1}^{2}+\\frac{1}{\\sqrt{y}}+\\sqrt[3]{z}"');
    expect(result.html).toContain('data-type="block-math"');
    expect(result.html).toContain('\\begin{matrix}');
  });

  it('leaves ordinary KaTeX HTML on the host editor path', () => {
    const result = transformOfficeClipboardHtml(fixture('katex-semantics.html'));
    expect(result).toEqual({ kind: 'not-applicable' });
  });

  it('leaves MathJax assistive markup on the host editor path', () => {
    const result = transformOfficeClipboardHtml(
      '<h2>Heading</h2><mjx-container class="MathJax"><mjx-assistive-mml>' +
        '<math><mi>x</mi></math></mjx-assistive-mml></mjx-container>',
    );

    expect(result).toEqual({ kind: 'not-applicable' });
  });

  it('uses only the primary MathML presentation branch and ignores annotations', () => {
    const html = transformed(
      '<math><semantics><msup><mi>x</mi><mn>2</mn></msup>' +
        '<annotation encoding="application/x-tex">\\frac{forged}{annotation}</annotation>' +
        '<annotation encoding="text/plain">duplicate annotation</annotation></semantics></math>',
    );

    expect(html).toContain('data-latex="{x}^{2}"');
    expect(html).not.toMatch(/forged|annotation|duplicate/);
  });

  it('only extracts formula elements from the parsed DOM, not attributes or comments', () => {
    const html = transformed(
      '<meta content="Word.Document"><p data-note="<math><mi>attribute</mi></math>">safe</p>' +
        '<!-- <math><mi>comment</mi></math> --><p>after</p>',
    );

    expect(html).toBe('<p>safe</p><p>after</p>');
    expect(html).not.toMatch(/attribute|comment|data-note/);
  });

  it('keeps fallback text when a parsed formula cannot be converted', () => {
    const html = transformed(
      '<meta content="Word.Document"><p>before<math><unsupported>fallback</unsupported></math>after</p>',
    );

    expect(html).toContain('beforefallbackafter');
    expect(html).not.toContain('data-latex');
  });

  it('does not charge discarded metadata subtrees against the visible DOM budget', () => {
    const metadata = `<xml>${'<private>hidden</private>'.repeat(CLIPBOARD_MAX_NODES)}</xml>`;
    expect(transformed(`<meta content="Word.Document">${metadata}<p>visible</p>`)).toBe(
      '<p>visible</p>',
    );
  });

  it('unwraps a Word equation conditional while dropping its raster fallback', () => {
    const html = [
      '<meta content="Word.Document">',
      '<p>before',
      '<!--[if gte msEquation 12]><math><mfrac><mi>a</mi><mi>b</mi></mfrac></math><![endif]-->',
      '<!--[if !msEquation]><img src="file:///tmp/equation.png" alt="duplicate"><![endif]-->',
      'after</p>',
    ].join('');
    const result = transformed(html);
    expect(result).toContain('before');
    expect(result).toContain('data-latex="\\frac{a}{b}"');
    expect(result).toContain('after');
    expect(result).not.toContain('duplicate');
    expect(result).not.toContain('<img');
  });

  it('reports only visible images after filtering Office equation fallback and metadata', () => {
    let unavailableImages = 0;
    const options = {
      onUnavailableImage: () => {
        unavailableImages += 1;
      },
    };
    const equation =
      '<meta content="Word.Document"><p>' +
      '<!--[if gte msEquation 12]><math><mfrac><mi>a</mi><mi>b</mi></mfrac></math><![endif]-->' +
      '<!--[if !msEquation]><img src="file:///fallback.png"><![endif]-->' +
      '<![if !msEquation]><img src="file:///revealed-fallback.png"><![endif]></p>' +
      '<xml><img src="file:///metadata.png"></xml><span aria-hidden="true"><img src="file:///hidden.png"></span>';
    const result = transformOfficeClipboardHtml(equation, options);
    expect(result.kind).toBe('transformed');
    expect(unavailableImages).toBe(0);
    transformOfficeClipboardHtml(
      equation + '<p><img src="file:///diagram.png" alt="diagram"></p>',
      options,
    );
    expect(unavailableImages).toBe(1);
  });

  it.each([
    '<!--[if !vml]><img src="file:///diagram.png"><![endif]-->',
    '<![if !vml]><img src="file:///diagram.png"><![endif]>',
  ])('reports real Word pictures in !vml branches: %s', (picture) => {
    let unavailable = false;
    const result = transformOfficeClipboardHtml(
      '<meta content="Word.Document"><p>before' + picture + 'after</p>',
      {
        onUnavailableImage: () => {
          unavailable = true;
        },
      },
    );
    expect(result.kind).toBe('transformed');
    if (result.kind === 'transformed') expect(result.html).toBe('<p>beforeafter</p>');
    expect(unavailable).toBe(true);
    unavailable = false;
    transformOfficeClipboardHtml('<p>before' + picture + 'after</p>', {
      onUnavailableImage: () => {
        unavailable = true;
      },
    });
    expect(unavailable).toBe(true);
    unavailable = false;
    transformOfficeClipboardHtml(
      '<meta content="Word.Document"><span aria-hidden="true">' +
        picture +
        '</span><xml>' +
        picture +
        '</xml><p>keep</p>',
      {
        onUnavailableImage: () => {
          unavailable = true;
        },
      },
    );
    expect(unavailable).toBe(false);
  });

  it.each([
    ['<!--[if !msEquation]>', '<![endif]-->', '<!--[if !vml]>', '<![endif]-->'],
    ['<!--[if !msEquation]>', '<![endif]-->', '<![if !vml]>', '<![endif]>'],
    ['<![if !msEquation]>', '<![endif]>', '<!--[if !vml]>', '<![endif]-->'],
    ['<![if !msEquation]>', '<![endif]>', '<![if !vml]>', '<![endif]>'],
  ])(
    'does not report !vml pictures within a discarded equation fallback: %s / %s / %s / %s',
    (outerStart, outerEnd, innerStart, innerEnd) => {
      let unavailable = false;
      const result = transformOfficeClipboardHtml(
        '<meta content="Word.Document"><p>keep' +
          outerStart +
          innerStart +
          '<img src="file:///equation.png">' +
          innerEnd +
          outerEnd +
          '</p>',
        {
          onUnavailableImage: () => {
            unavailable = true;
          },
        },
      );
      expect(result.kind).toBe('transformed');
      if (result.kind === 'transformed') expect(result.html).toBe('<p>keep</p>');
      expect(unavailable).toBe(false);
    },
  );

  it('degrades only an unsupported formula and reports a diagnostic', () => {
    const diagnosticSpy = vi.fn();
    const result = transformOfficeClipboardHtml(fixture('omml-rejected.html'), {
      onDiagnostic: diagnosticSpy,
    });
    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') return;
    expect(result.html).toContain('before');
    expect(result.html).toContain('sinx');
    expect(result.html).toContain('after');
    expect(result.html).not.toContain('data-latex');
    expect(result.diagnostics).toEqual([{ code: 'unsupported-omml', formulaSource: 'omml' }]);
    expect(diagnosticSpy).toHaveBeenCalledOnce();
  });

  it('projects caller-owned IR independently from the Office parser', () => {
    const document: ClipboardDocument = {
      blocks: [
        {
          kind: 'table',
          rows: [
            {
              cells: [
                {
                  blocks: [{ content: [{ kind: 'text', text: 'cell' }], kind: 'paragraph' }],
                  colspan: 1,
                  header: false,
                  rowspan: 1,
                },
              ],
            },
          ],
        },
      ],
      kind: 'document',
    };
    expect(serializeClipboardDocument(document, { tableMode: 'preserve' })).toContain('<table>');
    expect(serializeClipboardDocument(document, { tableMode: 'flatten' })).not.toContain('<table>');
  });
});

describe('bounded processing', () => {
  it('rejects an oversized raw HTML payload', () => {
    const value = `<meta content="Word.Document"><p>${'x'.repeat(CLIPBOARD_HTML_MAX_CHARACTERS)}</p>`;
    expect(() => transformOfficeClipboardHtml(value)).toThrowError(ClipboardBudgetError);
    expect(() => transformOfficeClipboardHtml(value)).toThrow('html budget');
  });

  it('rejects a DOM deeper than the shared limit', () => {
    expect(() => transformOfficeClipboardHtml(fixture('deep.html'))).toThrow('depth budget');
  });

  it('rejects a document that expands past the node budget', () => {
    const seed = fixture('oversized-seed.html');
    const value = seed.replace('<p>repeat-me</p>', '<p>x</p>'.repeat(CLIPBOARD_MAX_NODES));
    expect(() => transformOfficeClipboardHtml(value)).toThrow('nodes budget');
  });

  it('rejects visible text past the shared text budget', () => {
    const value = `<meta content="Word.Document"><p>${'x'.repeat(CLIPBOARD_MAX_TEXT_CHARACTERS + 1)}</p>`;
    expect(() => transformOfficeClipboardHtml(value)).toThrow('text budget');
  });

  it('rejects paragraph expansion past the shared paragraph budget', () => {
    const value = `<meta content="Word.Document">${'<p></p>'.repeat(CLIPBOARD_MAX_PARAGRAPHS + 1)}`;
    expect(() => transformOfficeClipboardHtml(value)).toThrow('paragraphs budget');
  });

  it('serializes only the fixed semantic IR even if callers construct unsafe style values', () => {
    const document: ClipboardDocument = {
      blocks: [
        {
          content: [
            {
              kind: 'text',
              marks: {
                textStyle: {
                  color: 'red; background: url(https://example.invalid)',
                  fontFamily: 'Arial" onmouseover="alert(1)',
                },
              },
              text: '<safe>',
            },
          ],
          kind: 'paragraph',
        },
      ],
      kind: 'document',
    };
    expect(serializeClipboardDocument(document)).toBe('<p>&lt;safe&gt;</p>');
  });
});
