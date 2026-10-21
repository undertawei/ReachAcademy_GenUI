import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compileHtmlLayout, type HtmlLayoutAsset } from '../../lib/reach-deck/html-layout';

const asset = async (): Promise<HtmlLayoutAsset> => {
  const bytes = await sharp({
    create: { width: 20, height: 10, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  return {
    kind: 'image',
    assetId: 'photo',
    resource: {
      id: 'original-photo',
      objectKey: 'scoped/photo.png',
      contentType: 'image/png',
      digest: 'sha256:fixture',
      origin: {
        schemaVersion: 'reach-deck-media-origin/v1',
        route: 'reference-image',
        provider: 'doubao',
        title: 'Trusted reference photograph',
        sourceUrl: 'https://example.org/photograph',
      },
    },
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    alt: 'Required reference photograph',
  };
};

const input = (body: string, assets: HtmlLayoutAsset[]) => ({
  html: `<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px;background:white">${body}</section></body></html>`,
  assets,
  pageId: 'required-asset-integrity',
  themeName: 'reach-classic',
});
const slot =
  '<div id="photo" data-reach-asset="photo" style="position:absolute;left:50px;top:50px;width:400px;height:200px;object-fit:contain"></div>';

describe('HTML layout required asset integrity', () => {
  it('rejects a required image nested inside a rasterized figure before it loses provenance', async () => {
    await expect(
      compileHtmlLayout(
        input(
          `<figure style="position:absolute;left:0;top:0;width:600px;height:400px;margin:0">${slot}</figure>`,
          [await asset()],
        ),
      ),
    ).rejects.toThrow('Asset slots must be empty slide-level elements.');
  }, 60_000);

  it('rejects a referenced but uncompiled invisible image even when other visible content compiles', async () => {
    await expect(
      compileHtmlLayout(
        input(
          `${slot.replace('object-fit:contain', 'object-fit:contain;visibility:hidden')}<p style="position:absolute;left:50px;top:400px;font-size:32px">Visible teaching text</p>`,
          [await asset()],
        ),
      ),
    ).rejects.toThrow('A required HTML asset is invisible or was not compiled.');
  }, 60_000);

  it('preserves the resource identity and provenance of a compiled managed image', async () => {
    const photo = await asset();
    const result = await compileHtmlLayout(input(slot, [photo]));
    expect(result.resources).toEqual([photo.kind === 'image' ? photo.resource : undefined]);
    expect(result.pendingMedia).toEqual([]);
    expect(result.slide.elements).toContainEqual(
      expect.objectContaining({ id: 'photo', type: 'image', resourceId: 'original-photo' }),
    );
    expect(result.assetBindings).toEqual([
      { assetId: 'photo', elementId: 'photo', binding: 'image-element' },
    ]);
  }, 60_000);

  it('binds managed images after normalization resolves conflicting sanitized IDs', async () => {
    const result = await compileHtmlLayout(
      input(
        '<div id="photo-slot" style="position:absolute;left:600px;top:50px;width:40px;height:40px;background:blue"></div>' +
          slot.replace('id="photo"', 'id="photo slot"'),
        [await asset()],
      ),
    );
    expect(result.elementIdMap['photo slot']).toBe('photo-slot-2');
    expect(result.assetBindings).toEqual([
      { assetId: 'photo', elementId: 'photo-slot-2', binding: 'image-element' },
    ]);
    expect(result.slide.elements).toContainEqual(
      expect.objectContaining({ id: 'photo-slot-2', type: 'image', resourceId: 'original-photo' }),
    );
  }, 60_000);

  it('compiles a fallback as a static image despite a mask and stale animation receipt', async () => {
    const photo = await asset();
    if (photo.kind !== 'image') throw new Error('Expected an image asset.');
    const result = await compileHtmlLayout(
      input(
        slot.replace(
          'data-reach-asset="photo"',
          'data-reach-asset="photo" data-reach-asset-mask="unknown-mask"',
        ),
        [
          {
            ...photo,
            isPlaceholder: true,
            codeAnimation: { sourceDigest: 'a'.repeat(64), frameCount: 2 },
          },
        ],
      ),
    );
    expect(result.assetBindings).toEqual([
      { assetId: 'photo', elementId: 'photo', binding: 'image-element' },
    ]);
    expect(result.slide.elements[0]).toMatchObject({
      type: 'image',
      resourceId: photo.resource.id,
    });
    expect(result.pendingMedia).toEqual([]);
  }, 60_000);
});
