import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { prepareOfficeDocument } from '@reachany/ai-runtime-common/office-ingestion';
import { buildDocxFixture, buildPptxFixture } from './office-fixtures.js';
describe('shared Office original image extraction', () => {
  it('preserves explicit line breaks and literal text tabs without inserting tab-stop definitions', async () => {
    const zip = await JSZip.loadAsync(await buildPptxFixture());
    const original = await zip.file('ppt/slides/slide1.xml')!.async('string');
    zip.file(
      'ppt/slides/slide1.xml',
      original.replace(
        '<a:r><a:t>第一页标题</a:t></a:r>',
        '<a:pPr><a:tabLst><a:tab pos="914400" algn="l"/></a:tabLst></a:pPr><a:r><a:t>First</a:t></a:r><a:br/><a:r><a:t>Second\tColumn</a:t></a:r>',
      ),
    );
    const prepared = await prepareOfficeDocument(
      await zip.generateAsync({ type: 'uint8array' }),
      'pptx',
      { extractPresentationImages: true },
    );
    if (prepared.kind !== 'pptx') throw new Error('unexpected result');
    expect(prepared.slides[0]?.text).toBe('First\nSecond\tColumn');
  });
  it.each(['missing', 'unsupported'] as const)(
    'keeps %s image diagnostics consistent across repeated references on different slides',
    async (failure) => {
      const zip = await JSZip.loadAsync(await buildPptxFixture());
      for (const slide of [1, 2]) {
        const path = `ppt/slides/slide${slide}.xml`;
        const original = await zip.file(path)!.async('string');
        zip.file(
          path,
          original
            .replace(' show="0"', '')
            .replace(
              '</p:spTree>',
              '<p:pic><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rImage"/></p:blipFill></p:pic></p:spTree>',
            ),
        );
        zip.file(
          `ppt/slides/_rels/slide${slide}.xml.rels`,
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/shared.png"/></Relationships>',
        );
      }
      if (failure === 'unsupported') zip.file('ppt/media/shared.png', 'Unsupported image bytes');
      const prepared = await prepareOfficeDocument(
        await zip.generateAsync({ type: 'uint8array' }),
        'pptx',
        { extractPresentationImages: true },
      );
      if (prepared.kind !== 'pptx') throw new Error('unexpected result');
      expect(prepared.slides).toHaveLength(2);
      const diagnostic =
        failure === 'missing' ? 'pptx_image_reference_unavailable' : 'pptx_image_type_unsupported';
      expect(prepared.slides.map((slide) => slide.warnings)).toEqual([[diagnostic], [diagnostic]]);
    },
  );
  it.each(['/ppt/media/used.png', '../../../outside.png'])(
    'normalizes only referenced image targets and validates used target %s',
    async (target) => {
      const zip = await JSZip.loadAsync(await buildPptxFixture());
      const original = await zip.file('ppt/slides/slide1.xml')!.async('string');
      zip.file(
        'ppt/slides/slide1.xml',
        original.replace(
          '</p:spTree>',
          '<p:pic><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rImage"/></p:blipFill></p:pic></p:spTree>',
        ),
      );
      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/><Relationship Id="rUnused" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../invalid-unused.png"/></Relationships>`,
      );
      zip.file(
        'ppt/media/used.png',
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      );
      const result = prepareOfficeDocument(
        await zip.generateAsync({ type: 'uint8array' }),
        'pptx',
        { extractPresentationImages: true },
      );
      if (target.startsWith('../')) {
        await expect(result).rejects.toMatchObject({ code: 'corrupt_or_binary' });
        return;
      }
      const prepared = await result;
      if (prepared.kind !== 'pptx') throw new Error('unexpected result');
      expect(prepared.slides[0]?.blocks).toHaveLength(2);
      expect(prepared.slides[0]?.blocks?.[1]).toMatchObject({
        type: 'image',
        image: { mimeType: 'image/png' },
      });
    },
  );
  it('keeps Feedforward text indexing unchanged and joins split runs for opt-in material extraction', async () => {
    const zip = await JSZip.loadAsync(await buildPptxFixture());
    const original = await zip.file('ppt/slides/slide1.xml')!.async('string');
    zip.file(
      'ppt/slides/slide1.xml',
      original.replace(
        '<a:r><a:t>第一页标题</a:t></a:r>',
        '<a:r><a:t>光合</a:t></a:r><a:r><a:t>作用</a:t></a:r><a:r><a:t> Photo</a:t></a:r><a:r><a:t>synthesis</a:t></a:r>',
      ),
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const indexed = await prepareOfficeDocument(bytes, 'pptx');
    const materials = await prepareOfficeDocument(bytes, 'pptx', {
      extractPresentationImages: true,
    });
    if (indexed.kind !== 'pptx' || materials.kind !== 'pptx') throw new Error('unexpected result');
    expect(indexed.slides[0]?.blocks).toBeUndefined();
    expect(indexed.slides[0]?.text).toBe('光合 作用 Photo synthesis');
    expect(materials.slides[0]?.text).toBe('光合作用 Photosynthesis');
  });
  it('uses actual WebP bytes in a JPEG-declared DOCX and keeps text/image order', async () => {
    const zip = await JSZip.loadAsync(await buildDocxFixture());
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    zip.file(
      '[Content_Types].xml',
      contentTypes.replace(
        'Extension="png" ContentType="image/png"',
        'Extension="png" ContentType="image/jpeg"',
      ),
    );
    const webp = Buffer.from('RIFF1234WEBPVP8 test');
    zip.file('word/media/diagram.png', webp);
    const prepared = await prepareOfficeDocument(
      await zip.generateAsync({ type: 'uint8array' }),
      'docx',
    );
    expect(prepared.kind).toBe('docx');
    if (prepared.kind !== 'docx') return;
    expect(prepared.blocks.at(-1)).toMatchObject({
      type: 'image',
      image: { mimeType: 'image/webp', data: webp.toString('base64') },
    });
    expect(prepared.blocks[0]).toMatchObject({ type: 'text', text: '第一段正文' });
    expect(prepared.warnings).toContain('image_mime_corrected');
  });
  it('extracts only image relationships used by visible presentation slides, ignoring orphan and hidden images', async () => {
    const zip = await JSZip.loadAsync(await buildPptxFixture());
    const original = await zip.file('ppt/slides/slide1.xml')!.async('string');
    zip.file(
      'ppt/slides/slide1.xml',
      original.replace(
        '</p:spTree>',
        '<p:pic><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rImage"/></p:blipFill></p:pic><p:pic><p:nvPicPr><p:cNvPr id="2" name="hidden" hidden="1"/></p:nvPicPr><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rOrphan"/></p:blipFill></p:pic><p:sp><p:nvSpPr><p:cNvPr id="3" name="hidden text" hidden="true"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Hidden shape text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>',
      ),
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/used.png"/><Relationship Id="rOrphan" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/orphan.png"/></Relationships>',
    );
    zip.file(
      'ppt/media/used.png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
    zip.file(
      'ppt/media/orphan.png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]),
    );
    const hiddenSlide = await zip.file('ppt/slides/slide2.xml')!.async('string');
    zip.file(
      'ppt/slides/slide2.xml',
      hiddenSlide.replace(
        '</p:spTree>',
        '<p:pic><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rHidden"/></p:blipFill></p:pic></p:spTree>',
      ),
    );
    zip.file(
      'ppt/slides/_rels/slide2.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rHidden" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/orphan.png"/></Relationships>',
    );
    const prepared = await prepareOfficeDocument(
      await zip.generateAsync({ type: 'uint8array' }),
      'pptx',
      { extractPresentationImages: true },
    );
    expect(prepared.kind).toBe('pptx');
    if (prepared.kind !== 'pptx') return;
    expect(prepared.slides).toHaveLength(1);
    expect(prepared.slides[0]!.blocks).toEqual([
      { type: 'text', text: '第一页标题' },
      {
        type: 'image',
        image: expect.objectContaining({
          mimeType: 'image/png',
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64'),
        }),
      },
    ]);
  });
});
