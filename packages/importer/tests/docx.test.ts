import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { extractDocx, restoreDocxMedia } from '../src/docx/index.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = (body: string): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const rel = (id: string, type: string, target: string, external = false): string =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
const p = (body: string): string => `<w:p>${body}</w:p>`;
const t = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

async function fixture(
  body: string,
  extra: Record<string, string> = {},
  relationships = '',
): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="wmf" ContentType="image/x-wmf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': packageRels(rel('main', 'officeDocument', 'word/document.xml')),
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>`,
    'word/_rels/document.xml.rels': packageRels(relationships),
    ...extra,
  };
  for (const [name, value] of Object.entries(entries))
    await writer.add(name, new TextReader(value));
  return writer.close();
}

describe('DOCX extraction', () => {
  it('restores cached media without trusting a changed archive or media checksum', async () => {
    const bytes = await fixture(
      p('<w:r><w:drawing><a:blip r:embed="i"/></w:drawing></w:r>'),
      { 'word/media/a.png': 'synthetic image' },
      rel('i', 'image', 'media/a.png'),
    );
    const extracted = await extractDocx(bytes);
    if (!extracted.ok) throw new Error('fixture extraction failed');
    const descriptors = extracted.document.media.map(
      ({ bytes: _bytes, ...descriptor }) => descriptor,
    );
    expect(await restoreDocxMedia(bytes, descriptors)).toEqual(extracted.document.media);
    await expect(
      restoreDocxMedia(bytes, [{ ...descriptors[0]!, sha256: '0'.repeat(64) }]),
    ).rejects.toThrow('checksum_mismatch');
    await expect(
      restoreDocxMedia(bytes, [{ ...descriptors[0]!, partPath: '/missing.png' }]),
    ).rejects.toThrow('checksum_mismatch');
  });
  it('accepts Node Buffers and strips nonsemantic Word proofreading from OMML', async () => {
    const bytes = await fixture(
      p(
        '<m:oMath><m:r><m:t>x</m:t></m:r><w:proofErr w:type="spellStart"/><m:r><m:t>+1</m:t></m:r></m:oMath>',
      ),
    );
    const result = await extractDocx(Buffer.from(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.diagnostics).toEqual([]);
    expect(result.document.blocks[0]?.content.content?.[0]?.content?.[0]).toEqual({
      type: 'inlineMath',
      attrs: { latex: 'x+1' },
    });
  });
  it('retains a nonempty circular-arc OMML formula as native math in DOCX', async () => {
    const result = await extractDocx(
      await fixture(
        p(
          t('Arc ') +
            '<m:oMath><m:acc><m:accPr><m:chr m:val="\u2322"/></m:accPr><m:e><m:r><m:t>AB</m:t></m:r></m:e></m:acc></m:oMath>' +
            t(' length.'),
        ),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks[0]?.text).toBe('Arc \uFFFC length.');
    expect(result.document.blocks[0]?.content.content?.[0]?.content).toEqual([
      { type: 'text', text: 'Arc ' },
      { type: 'inlineMath', attrs: { latex: '\\overset{\\frown}{AB}' } },
      { type: 'text', text: ' length.' },
    ]);
    expect(result.document.diagnostics).toEqual([]);
  });
  it('preserves ordered rich content and underlined blank runs without inventing answers', async () => {
    const bytes = await fixture(
      p(
        t('A &amp; B ') +
          '<w:r><w:rPr><w:b/><w:u/></w:rPr><w:t xml:space="preserve">   7   </w:t></w:r>' +
          '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>' +
          '<w:r><w:drawing><a:blip r:embed="i"/></w:drawing></w:r>' +
          t(' tail'),
      ),
      { 'word/media/a.png': 'synthetic image bytes' },
      rel('i', 'image', 'media/a.png'),
    );
    const result = await extractDocx(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks[0]?.text).toBe('A & B    7   \uFFFC\uFFFC tail');
    expect(result.document.blocks[0]?.content.content?.[0]?.content).toEqual([
      { type: 'text', text: 'A & B ' },
      { type: 'text', text: '   7   ', marks: [{ type: 'bold' }, { type: 'underline' }] },
      { type: 'inlineMath', attrs: { latex: 'x' } },
      { type: 'image', attrs: { sourceMediaId: 'media-1', alt: '' } },
      { type: 'text', text: ' tail' },
    ]);
    expect(result.document.media[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.document.diagnostics).toEqual([]);
    expect(await extractDocx(bytes)).toEqual(result);
  });

  it('keeps table/paragraph order and reports unsupported vertical merges', async () => {
    const result = await extractDocx(
      await fixture(
        p(t('before')) +
          '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr>' +
          p(t('cell')) +
          '</w:tc></w:tr></w:tbl>' +
          p(t('after')),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['paragraph', 'before'],
      ['table', 'cell'],
      ['paragraph', 'after'],
    ]);
    expect(
      result.document.blocks[1]?.content.content?.[0]?.content?.[0]?.content?.[0]?.attrs,
    ).toEqual({ colspan: 2 });
    expect(result.document.diagnostics[0]?.code).toBe('docx.table.vertical_merge');
  });

  it('resolves numbering start overrides, increments and resets subordinate levels', async () => {
    const numbered = (level: number): string =>
      p(
        `<w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="2"/></w:numPr></w:pPr>${t('item')}`,
      );
    const result = await extractDocx(
      await fixture(
        numbered(0) + numbered(1) + numbered(0) + numbered(1),
        {
          'word/numbering.xml': `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num></w:numbering>`,
        },
        rel('n', 'numbering', 'numbering.xml'),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks.map((b) => b.text)).toEqual([
      '5. item',
      '5.a) item',
      '6. item',
      '6.a) item',
    ]);
    expect(result.document.blocks.map((b) => b.numberingFormat)).toEqual([
      'decimal',
      'lowerLetter',
      'decimal',
      'lowerLetter',
    ]);
  });

  it('renders upper and lower Roman Word numbering without decimal fallback', async () => {
    const numbered = (numId: number): string =>
      p(
        `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${t('item')}`,
      );
    const result = await extractDocx(
      await fixture(
        numbered(1) + numbered(2),
        {
          'word/numbering.xml': `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="4"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="9"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`,
        },
        rel('n', 'numbering', 'numbering.xml'),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks.map((block) => block.text)).toEqual(['IV. item', 'ix) item']);
    expect(result.document.blocks.map((block) => block.numberingFormat)).toEqual([
      'upperRoman',
      'lowerRoman',
    ]);
    expect(result.document.diagnostics.map((item) => item.code)).not.toContain(
      'docx.numbering.unsupported_format',
    );
  });

  it('converts complex EQ fields across instruction runs and discards stale cached text', async () => {
    const result = await extractDocx(
      await fixture(
        p(
          t('before ') +
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
            '<w:r><w:instrText xml:space="preserve"> EQ \\f(1,</w:instrText></w:r>' +
            '<w:r><w:instrText>2)</w:instrText></w:r>' +
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
            t('stale cache') +
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
            t(' after'),
        ),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks[0]?.text).toBe('before \uFFFC after');
    expect(result.document.blocks[0]?.content.content?.[0]?.content).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'inlineMath', attrs: { latex: '\\frac{1}{2}' } },
      { type: 'text', text: ' after' },
    ]);
    expect(result.document.diagnostics).toEqual([]);
  });

  it('supports simple EQ fields and retains cached text when EQ syntax is invalid', async () => {
    const result = await extractDocx(
      await fixture(
        p('<w:fldSimple w:instr=" EQ \\a \\co2(A,B,C,D)">' + t('matrix cache') + '</w:fldSimple>') +
          p(
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
              '<w:r><w:instrText> EQ \\f(1)</w:instrText></w:r>' +
              '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
              t('visible cache') +
              '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
          ),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks[0]?.text).toBe('\uFFFC');
    expect(result.document.blocks[0]?.content.content?.[0]?.content?.[0]).toEqual({
      type: 'blockMath',
      attrs: { latex: '\\begin{matrix}A & B \\\\ C & D\\end{matrix}' },
    });
    expect(result.document.blocks[1]?.text).toBe('visible cache');
    expect(result.document.diagnostics[0]).toMatchObject({
      code: 'docx.field.eq_unsupported',
      blockId: 'block-2',
    });
  });

  it('retains non-EQ cached fields and exposes invalid EQ fields without a cache', async () => {
    const result = await extractDocx(
      await fixture(
        p('<w:fldSimple w:instr=" PAGE ">' + t('7') + '</w:fldSimple>') +
          p(
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
              '<w:r><w:instrText> EQ \\f(1)</w:instrText></w:r>' +
              '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
          ),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks.map((block) => block.text)).toEqual(['7', '\uFFFC']);
    expect(result.document.blocks[1]?.content.content?.[0]?.content?.[0]).toEqual({
      type: 'docxUnavailable',
      attrs: { reason: 'docx.field.eq_unsupported' },
    });
    expect(result.document.diagnostics.map((item) => [item.code, item.severity])).toEqual([
      ['docx.field.cached_only', 'warning'],
      ['docx.field.eq_unsupported', 'error'],
    ]);
  });

  it('selects one AlternateContent fallback, deduplicates media and retains OLE preview diagnostics', async () => {
    const image = '<w:pict><v:imagedata r:id="i"/></w:pict>';
    const result = await extractDocx(
      await fixture(
        p(
          `<mc:AlternateContent><mc:Choice Requires="unknown"><x:unsupported xmlns:x="urn:unknown"/></mc:Choice><mc:Fallback>${image}</mc:Fallback></mc:AlternateContent><w:object>${image}</w:object>`,
        ),
        { 'word/media/a.wmf': 'synthetic metafile' },
        rel('i', 'image', 'media/a.wmf'),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.media).toHaveLength(1);
    expect(result.document.media[0]?.needsConversion).toBe(true);
    expect(result.document.blocks[0]?.text).toBe('\uFFFC\uFFFC');
    expect(result.document.diagnostics.map((d) => d.code)).toContain('docx.ole.preview_only');
  });

  it('never fetches external relationships and diagnoses missing images and unsupported math', async () => {
    const result = await extractDocx(
      await fixture(
        p(
          '<w:drawing><a:blip r:link="external"/></w:drawing><w:drawing><a:blip r:embed="missing"/></w:drawing><m:oMath><m:unsupported/></m:oMath>',
        ),
        {},
        rel('external', 'image', 'https://example.invalid/private.png', true),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.media).toEqual([]);
    expect(result.document.diagnostics.map((d) => d.code)).toEqual([
      'docx.image.unavailable',
      'docx.math.unsupported',
    ]);
    expect(result.document.diagnostics[0]).toMatchObject({
      count: 2,
      blockId: 'block-1',
      severity: 'error',
    });
    expect(result.document.blocks[0]?.text).toBe('\uFFFC\uFFFC\uFFFC');
    expect(result.document.blocks[0]?.content.content?.[0]?.content?.[0]).toEqual({
      type: 'docxUnavailable',
      attrs: { reason: 'docx.image.unavailable' },
    });
  });

  it('distinguishes absent OLE previews and pins in/out-of-block diagnostic locations', async () => {
    const result = await extractDocx(
      await fixture('<w:unsupported/>' + p('<w:object/>') + '<w:unsupported/>'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.document.diagnostics.find((item) => item.code === 'docx.block.unsupported'),
    ).not.toHaveProperty('blockId');
    expect(
      result.document.diagnostics.find((item) => item.code === 'docx.ole.missing_preview'),
    ).toMatchObject({ severity: 'error', blockId: 'block-1' });
    expect(result.document.diagnostics.some((item) => item.code === 'docx.ole.preview_only')).toBe(
      false,
    );
  });

  it('aggregates style warnings and bounds diagnostics with explicit truncation', async () => {
    const styled = p('<w:pPr><w:pStyle w:val="Body"/></w:pPr>' + t('text'));
    const result = await extractDocx(await fixture(styled.repeat(100)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.diagnostics).toHaveLength(1);
    expect(result.document.diagnostics[0]).toMatchObject({ count: 100 });
    expect(result.document.diagnostics[0]?.blockIds).toHaveLength(5);
    const capped = await extractDocx(await fixture(styled + p('<w:object/><w:sym/>')), {
      maxDiagnostics: 2,
    });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.document.diagnostics).toHaveLength(2);
    expect(capped.document.diagnostics[1]?.code).toBe('docx.diagnostics.truncated');
  });

  it('preserves multi-cell table text and keeps inserted but omits deleted revisions', async () => {
    const result = await extractDocx(
      await fixture(
        '<w:tbl><w:tr><w:tc>' +
          p(t('left')) +
          '</w:tc><w:tc>' +
          p(t('right')) +
          '</w:tc></w:tr></w:tbl>' +
          p('<w:del>' + t('old') + '</w:del><w:ins>' + t('new') + '</w:ins>'),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks.map((block) => block.text)).toEqual(['left\nright', 'new']);
    expect(result.document.diagnostics[0]).toMatchObject({
      code: 'docx.revision.omitted',
      blockId: 'block-2',
    });
    expect(result.document.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects non-DOCX packages, DTD and excessive aggregate media', async () => {
    const invalidType = await extractDocx(
      await fixture('', {
        '[Content_Types].xml':
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      }),
    );
    expect(invalidType.ok).toBe(false);
    const dtd = await extractDocx(
      await fixture('', { 'word/document.xml': '<!DOCTYPE x [<!ENTITY x "bad">]><x/>' }),
    );
    expect(dtd.ok).toBe(false);
    const large = await extractDocx(
      await fixture(
        p('<w:drawing><a:blip r:embed="i"/></w:drawing>'),
        { 'word/media/a.png': '1234567890' },
        rel('i', 'image', 'media/a.png'),
      ),
      { limits: { maxMediaAssetBytes: 5 } },
    );
    expect(large.ok).toBe(false);
    if (!large.ok) expect(large.diagnostics.at(-1)?.code).toBe('docx.media.limit_exceeded');
  });
});
