import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import { renderStaticDiagram } from '../../lib/reach-deck/diagram-renderer.js';
import { compileHtmlLayout, type HtmlLayoutAsset } from '../../lib/reach-deck/html-layout';

describe('transparent diagram Native integration', () => {
  it('retains the managed PNG and samples contrast through its transparent pixels', async () => {
    const rendered = await renderStaticDiagram({
      source:
        '<svg width="800" height="450" viewBox="0 0 800 450"><circle cx="650" cy="225" r="75" fill="#2563eb"/></svg>',
      width: 800,
      height: 450,
    });
    const diagram: HtmlLayoutAsset = {
      kind: 'image',
      assetId: 'diagram',
      resource: {
        id: 'transparent-diagram',
        objectKey: 'scoped/transparent-diagram.png',
        contentType: 'image/png',
        digest: `sha256:${createHash('sha256').update(rendered.bytes).digest('hex')}`,
      },
      dataUrl: `data:image/png;base64,${rendered.bytes.toString('base64')}`,
      alt: 'Blue node on a transparent canvas',
    };
    for (const background of ['#ffffff', '#111111']) {
      const compiled = await compileHtmlLayout({
        html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:${background}"><div id="diagram-slot" data-reach-asset="diagram" style="position:absolute;left:100px;top:100px;width:800px;height:450px;object-fit:contain"></div><p id="contrast-probe" style="position:absolute;left:140px;top:160px;width:400px;height:50px;margin:0;color:#111111;font:24px/40px Arial">Actual slide background</p></section></body></html>`,
        pageId: 'diagram-transparency',
        themeName: 'reach-classic',
        designContext: {
          schemaVersion: 'reach-deck-design-context/v1',
          libraryVersion: REFERENCE_LIBRARY_VERSION,
          librarySha256: REFERENCE_LIBRARY_SHA256,
          paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
          imageStyleReferenceIds: [],
          visualIntent: 'Test transparent media composition',
          resolvedColors: {
            background,
            surface: '#ffffff',
            ink: '#111111',
            muted: '#555555',
            accent: '#2563eb',
            success: '#006600',
            warning: '#663300',
          },
        },
        assets: [diagram],
      });
      expect(compiled.resources).toEqual([diagram.resource]);
      expect(compiled.pendingMedia).toEqual([]);
      expect(compiled.slide.elements).toContainEqual(
        expect.objectContaining({
          id: 'diagram-slot',
          type: 'image',
          resourceId: diagram.resource.id,
        }),
      );
      const lowContrast = compiled.diagnostics.filter((message) =>
        message.includes('CONTRAST_LOW'),
      );
      expect(lowContrast.length > 0).toBe(background === '#111111');
    }
  }, 60_000);
});
