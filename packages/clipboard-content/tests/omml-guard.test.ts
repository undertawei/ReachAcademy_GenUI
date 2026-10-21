import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wordpaste = vi.hoisted(() => ({
  ommlToLatex: vi.fn<(fragment: string) => string>(() => '\\frac{a}{b}'),
  transformPastedHTML: vi.fn(() => 'unsafe'),
}));

vi.mock('wordpaste', () => wordpaste);

import { transformOfficeClipboardHtml } from '../src/index.js';
import {
  CLIPBOARD_FORMULA_MAX_DEPTH,
  CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS,
  CLIPBOARD_FORMULA_MAX_NODES,
  CLIPBOARD_FORMULA_MAX_OUTPUT_CHARACTERS,
} from '../src/index.js';
import { inspectFormula } from '../src/formulas.js';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', name), 'utf8');
}

describe('guarded wordpaste usage', () => {
  beforeEach(() => {
    wordpaste.ommlToLatex.mockClear();
    wordpaste.transformPastedHTML.mockClear();
  });

  it('counts the synthetic OMML namespace wrapper exactly once', () => {
    expect(inspectFormula('<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>', 'omml')).toMatchObject({
      depth: 4,
      nodeCount: 4,
    });
  });

  it('calls only ommlToLatex for supported OMML', () => {
    transformOfficeClipboardHtml(fixture('omml-common.html'));
    expect(wordpaste.ommlToLatex).toHaveBeenCalledTimes(3);
    expect(wordpaste.ommlToLatex.mock.calls[0]?.[0]).toContain(
      'http://schemas.openxmlformats.org/officeDocument/2006/math',
    );
    expect(wordpaste.transformPastedHTML).not.toHaveBeenCalled();
  });

  it('normalizes explicit empty OMML delimiters before the upstream call', () => {
    const html =
      '<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body><m:oMath><m:d><m:dPr><m:begChr m:val=""/><m:endChr m:val=""/></m:dPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d></m:oMath></body></html>';
    transformOfficeClipboardHtml(html);
    expect(wordpaste.ommlToLatex).toHaveBeenCalledOnce();
    expect(wordpaste.ommlToLatex.mock.calls[0]?.[0]).toMatch(/begChr[^>]+(?:m:)?val="\."/);
    expect(wordpaste.ommlToLatex.mock.calls[0]?.[0]).toMatch(/endChr[^>]+(?:m:)?val="\."/);
  });

  it('restores a self-closing control property before its swallowed sibling', () => {
    const html =
      '<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body>' +
      '<m:oMath><m:rad><m:ctrlPr/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath>' +
      '</body></html>';
    transformOfficeClipboardHtml(html);

    expect(wordpaste.ommlToLatex).toHaveBeenCalledOnce();
    expect(wordpaste.ommlToLatex.mock.calls[0]?.[0]).toMatch(
      /<(?:m:)?ctrlPr\s*\/><(?:m:)?e><(?:m:)?r><(?:m:)?t>x<\/(?:m:)?t><\/(?:m:)?r><\/(?:m:)?e>/,
    );
  });

  it('does not convert formulas hidden in discarded active content', () => {
    const html =
      '<meta content="Word.Document"><iframe><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></iframe><p>safe</p>';
    const result = transformOfficeClipboardHtml(html);
    expect(result.kind).toBe('transformed');
    if (result.kind === 'transformed') expect(result.html).toContain('safe');
    expect(wordpaste.ommlToLatex).not.toHaveBeenCalled();
  });

  it('does not call wordpaste for rejected OMML', () => {
    const result = transformOfficeClipboardHtml(fixture('omml-rejected.html'));
    expect(result.kind).toBe('transformed');
    expect(wordpaste.ommlToLatex).not.toHaveBeenCalled();
    expect(wordpaste.transformPastedHTML).not.toHaveBeenCalled();
  });

  it.each([
    [
      'input',
      `<m:oMath><m:r><m:t>${'x'.repeat(CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS)}</m:t></m:r></m:oMath>`,
      'formula-input-limit',
    ],
    [
      'nodes',
      `<m:oMath>${'<m:r><m:t>x</m:t></m:r>'.repeat(CLIPBOARD_FORMULA_MAX_NODES)}</m:oMath>`,
      'formula-node-limit',
    ],
    [
      'depth',
      `<m:oMath>${'<m:e>'.repeat(CLIPBOARD_FORMULA_MAX_DEPTH)}<m:r><m:t>x</m:t></m:r>${'</m:e>'.repeat(CLIPBOARD_FORMULA_MAX_DEPTH)}</m:oMath>`,
      'formula-depth-limit',
    ],
  ])('rejects formula %s budget before calling upstream', (_name, formula, code) => {
    const result = transformOfficeClipboardHtml(
      `<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body><p>before${formula}after</p></body></html>`,
    );
    expect(result.kind).toBe('transformed');
    if (result.kind === 'transformed') {
      expect(result.html).toContain('before');
      expect(result.html).toContain('after');
      expect(result.diagnostics).toEqual([{ code, formulaSource: 'omml' }]);
    }
    expect(wordpaste.ommlToLatex).not.toHaveBeenCalled();
  });

  it('degrades empty, throwing, and oversized upstream results', () => {
    const html =
      '<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body><p>before<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>after</p></body></html>';
    const cases: Array<{ code: string; value: Error | string }> = [
      { code: 'omml-conversion-failed', value: '' },
      { code: 'omml-conversion-failed', value: new Error('conversion failed') },
      {
        code: 'formula-output-limit',
        value: 'x'.repeat(CLIPBOARD_FORMULA_MAX_OUTPUT_CHARACTERS + 1),
      },
    ];
    for (const item of cases) {
      wordpaste.ommlToLatex.mockReset();
      if (item.value instanceof Error)
        wordpaste.ommlToLatex.mockImplementationOnce(() => {
          throw item.value;
        });
      else wordpaste.ommlToLatex.mockReturnValueOnce(item.value);
      const result = transformOfficeClipboardHtml(html);
      expect(result.kind).toBe('transformed');
      if (result.kind === 'transformed') {
        expect(result.html).toContain('beforexafter');
        expect(result.diagnostics).toEqual([{ code: item.code, formulaSource: 'omml' }]);
      }
    }
  });

  it.each([
    ['empty equation array', '<m:eqArr/>'],
    ['group character', '<m:groupChr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr>'],
    ['phantom', '<m:phant><m:e><m:r><m:t>x</m:t></m:r></m:e></m:phant>'],
    ['box', '<m:box><m:e><m:r><m:t>x</m:t></m:r></m:e></m:box>'],
    ['border box', '<m:borderBox><m:e><m:r><m:t>x</m:t></m:r></m:e></m:borderBox>'],
    ['pre-script', '<m:sPre><m:e><m:r><m:t>x</m:t></m:r></m:e></m:sPre>'],
    [
      'delimiter separator',
      '<m:d><m:dPr><m:sepChr m:val=";"/></m:dPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d>',
    ],
    [
      'unsupported delimiter',
      '<m:d><m:dPr><m:begChr m:val="?"/></m:dPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d>',
    ],
    [
      'unsupported accent',
      '<m:acc><m:accPr><m:chr m:val="~"/></m:accPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc>',
    ],
    [
      'bottom bar',
      '<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:bar>',
    ],
    ['bar without properties', '<m:bar><m:e><m:r><m:t>x</m:t></m:r></m:e></m:bar>'],
    [
      'bar without an explicit position',
      '<m:bar><m:barPr/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:bar>',
    ],
    [
      'unsupported nary',
      '<m:nary><m:naryPr><m:chr m:val="⋂"/></m:naryPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary>',
    ],
  ])('rejects %s before calling the upstream converter', (_name, body) => {
    const html = `<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body><p>before<m:oMath>${body}</m:oMath>after</p></body></html>`;
    const result = transformOfficeClipboardHtml(html);
    expect(result.kind).toBe('transformed');
    if (result.kind === 'transformed') {
      expect(result.diagnostics).toEqual([{ code: 'unsupported-omml', formulaSource: 'omml' }]);
    }
    expect(wordpaste.ommlToLatex).not.toHaveBeenCalled();
  });

  it.each([
    ['URL', '\\url{https://example.invalid}'],
    ['HTML', '\\htmlStyle{color:red}{x}'],
    ['external resource', '\\includegraphics{https://example.invalid/x}'],
    ['macro definition', '\\newcommand{\\x}{bad}'],
    ['package loading', '\\usepackage{bad}'],
    ['TeX input', '\\input{/etc/passwd}'],
    ['literal URL', '\\text{https://example.invalid}'],
  ])('rejects unsafe %s output from upstream', (_name, latex) => {
    wordpaste.ommlToLatex.mockReturnValueOnce(latex);
    const result = transformOfficeClipboardHtml(
      '<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></body></html>',
    );
    expect(result.kind).toBe('transformed');
    if (result.kind === 'transformed') {
      expect(result.html).toContain('x');
      expect(result.html).not.toContain('data-latex');
      expect(result.diagnostics).toEqual([
        { code: 'unsafe-formula-output', formulaSource: 'omml' },
      ]);
    }
  });
});
