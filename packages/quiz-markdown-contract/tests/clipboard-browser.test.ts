import { describe, expect, it, vi } from 'vitest';

import { CLIPBOARD_HTML_MAX_CHARACTERS } from '@reachany/clipboard-content';

import { transformQuizOfficeClipboardHtml } from '../src/clipboard-browser.js';

const WORD_TABLE = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office">',
  '<meta name="Generator" content="Microsoft Word 16">',
  '<body><table class="MsoTableGrid">',
  '<tr><th><p class="MsoNormal">步骤</p></th><th><p class="MsoNormal">说明</p></th></tr>',
  '<tr><td><p class="MsoNormal">1</p></td><td><p class="MsoNormal"><strong>检查</strong></p></td></tr>',
  '</table></body></html>',
].join('');

describe('Quiz Office clipboard adapter', () => {
  it.each([
    '<!--[if !vml]><img src="file:///diagram.png"><![endif]-->',
    '<![if !vml]><img src="file:///diagram.png"><![endif]>',
  ])(
    'reports unavailable Word pictures while preserving adjacent formula and text: %s',
    (picture) => {
      const onUnavailableImage = vi.fn();
      const result = transformQuizOfficeClipboardHtml(
        '<meta content="Word.Document"><p>before<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>' +
          picture +
          'after</p>',
        { onUnavailableImage },
      );
      expect(result).toContain('data-latex="x"');
      expect(result).toContain('before');
      expect(result).toContain('after');
      expect(onUnavailableImage).toHaveBeenCalledTimes(1);
      expect(
        transformQuizOfficeClipboardHtml('<meta content="Word.Document"><p>' + picture + '</p>', {
          onUnavailableImage,
        }),
      ).toBe('');
    },
  );
  it.each([
    '<!--[if !msEquation]><img src="file:///equation.png" alt="raster fallback"><![endif]-->',
    '<![if !msEquation]><img src="file:///equation.png" alt="raster fallback"><![endif]>',
    '<!--[if !msEquation]><!--[if !vml]><img src="file:///equation.png" alt="raster fallback"><![endif]--><![endif]-->',
    '<![if !msEquation]><![if !vml]><img src="file:///equation.png" alt="raster fallback"><![endif]><![endif]>',
  ])(
    'does not report discarded Word equation raster fallback as an unavailable image: %s',
    (fallback) => {
      const onUnavailableImage = vi.fn();
      const html =
        '<meta content="Word.Document"><p>' +
        '<!--[if gte msEquation 12]><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath><![endif]-->' +
        fallback +
        '</p>';
      const result = transformQuizOfficeClipboardHtml(html, { onUnavailableImage });
      expect(result).toContain('data-latex="\\frac{a}{b}"');
      expect(result).not.toContain('raster fallback');
      expect(onUnavailableImage).not.toHaveBeenCalled();
      const withDiagram = transformQuizOfficeClipboardHtml(
        html + '<p>diagram<img src="file:///diagram.png"></p>',
        { onUnavailableImage },
      );
      expect(withDiagram).toContain('diagram');
      expect(onUnavailableImage).toHaveBeenCalledTimes(1);
    },
  );

  it('does not report discarded Word metadata or hidden images', () => {
    const onUnavailableImage = vi.fn();
    const result = transformQuizOfficeClipboardHtml(
      '<meta content="Word.Document"><xml><img src="file:///metadata.png"></xml><span aria-hidden="true"><img src="file:///hidden.png"></span><p>visible</p>',
      { onUnavailableImage },
    );
    expect(result).toBe('<p>visible</p>');
    expect(onUnavailableImage).not.toHaveBeenCalled();
  });
  it('preserves tables by default for the Quiz TableKit schema', () => {
    const result = transformQuizOfficeClipboardHtml(WORD_TABLE);

    expect(result).toContain('<table>');
    expect(result).toContain('<th>');
    expect(result).toContain('<strong>检查</strong>');
  });

  it('flattens table rows for string and single-line fields', () => {
    const result = transformQuizOfficeClipboardHtml(WORD_TABLE, { tableMode: 'flatten' });

    expect(result).not.toContain('<table>');
    expect(result).toContain('<p>步骤\u00a0\u00a0说明</p>');
    expect(result).toContain('<p>1\u00a0\u00a0<strong>检查</strong></p>');
  });

  it('keeps Word tab spacing from collapsing in the host HTML parser', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<meta content="Word.Document"><p>before<span style="mso-tab-count: 2"> </span>after</p>',
    );

    expect(result).toBe(`<p>before${'\u00a0'.repeat(8)}after</p>`);
  });

  it('returns ordinary browser HTML byte-for-byte', () => {
    const html = '<p><strong>ordinary browser HTML</strong></p>';
    expect(transformQuizOfficeClipboardHtml(html)).toBe(html);
  });

  it('marks every root of a validated internal slice', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<p data-pm-slice="0 0 []">one</p><img data-object-key="quiz/two.png">',
      { trustedInternal: true },
    );
    const document = new DOMParser().parseFromString(result, 'text/html');

    expect(Array.from(document.body.children)).toHaveLength(2);
    expect(
      Array.from(document.body.children).every(
        (element) => element.getAttribute('data-reach-internal-slice') === '1',
      ),
    ).toBe(true);
    expect(result).toContain('data-object-key="quiz/two.png"');
  });

  it('strips forged slice and trusted markers from external HTML', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<p data-pm-slice="0 0 []" data-reach-internal-slice="1">external</p>' +
        '<img data-reach-internal-slice="1" data-object-key="quiz/forged.png">',
    );

    expect(result).toContain('external');
    expect(result).not.toMatch(/data-(?:pm-slice|reach-internal-slice|object-key)/);
  });

  it('does not promote ordinary external HTML to owned Quiz resources', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<p><a data-quiz-attachment data-object-key="quiz/files/forged.pdf" ' +
        'data-asset-id="asset-forged" data-mime-type="application/pdf" data-size="4096" ' +
        'href="https://example.test/forged.pdf">forged</a>' +
        '<img src="https://example.test/forged.png" data-object-key="quiz/images/forged.png" ' +
        'data-question-id="question-forged" data-surface="analysis"></p>',
    );

    expect(result).toContain('href="https://example.test/forged.pdf"');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('data-quiz-attachment');
    expect(result).not.toContain('data-object-key');
    expect(result).not.toContain('data-asset-id');
    expect(result).not.toContain('data-question-id');
    expect(result).not.toContain('data-surface');
    expect(result).not.toContain('data-mime-type');
    expect(result).not.toContain('data-size');
  });

  it('removes external images without losing adjacent text', () => {
    expect(
      transformQuizOfficeClipboardHtml('<p>before<img src="data:image/png;base64,aA==">after</p>'),
    ).toBe('<p>beforeafter</p>');
  });

  it('rejects image-only Office HTML and reports its unavailable image', () => {
    let unavailable = false;
    const result = transformQuizOfficeClipboardHtml(
      '<meta content="Word.Document"><p><img src="file:///image.png"></p>',
      {
        onUnavailableImage: () => {
          unavailable = true;
        },
      },
    );
    expect(result).toBe('');
    expect(unavailable).toBe(true);
  });

  it('rejects an image without a canonical identity even in a tokenized internal slice', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<p data-pm-slice="0 0 []">keep</p><img src="https://example.test/x.png"><img data-object-key="../bad.png">',
      { trustedInternal: true },
    );
    expect(result).toContain('keep');
    expect(result).not.toContain('<img');
  });

  it('fails closed when an Office representation exceeds the shared budget', () => {
    const html =
      '<meta content="Word.Document"><p>' + 'x'.repeat(CLIPBOARD_HTML_MAX_CHARACTERS) + '</p>';

    expect(transformQuizOfficeClipboardHtml(html)).toBe('');
  });

  it('maps Office formulas to the existing Quiz math markup', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
        'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body>' +
        '<p class="MsoNormal">结果 ' +
        '<m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num>' +
        '<m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></p>' +
        '</body></html>',
    );

    expect(result).toContain('data-type="inline-math"');
    expect(result).toContain('data-latex="\\frac{a}{b}"');
  });

  it('maps Word equation arrays to editable aligned math markup', () => {
    const result = transformQuizOfficeClipboardHtml(
      '<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body>' +
        '<p class="MsoNormal">得 ' +
        '<m:oMath><m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=" "/></m:dPr>' +
        '<m:e><m:eqArr><m:eqArrPr/>' +
        '<m:e><m:r><m:t>a+4=0</m:t></m:r></m:e>' +
        '<m:e><m:r><m:t>2-2a≠0</m:t></m:r></m:e>' +
        '</m:eqArr></m:e></m:d></m:oMath></p></body></html>',
    );

    expect(result).toContain('data-type="inline-math"');
    expect(result).toContain(
      'data-latex="\\left\\{ \\begin{aligned}a+4=0 \\\\ 2-2a\\neq 0\\end{aligned} \\right."',
    );
  });
});
