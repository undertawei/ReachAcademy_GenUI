import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderMoleculeDiagramSvg } from '../../lib/reach-deck/molecule-diagram';
import { renderStaticDiagram } from '../../lib/reach-deck/diagram-renderer';

describe('trusted static molecule diagram', () => {
  it('rasterizes scaled SVG atom labels with Chinese titles in the real browser', async () => {
    for (const [smiles, title] of [
      ['CCO', '乙醇的分子结构'],
      ['c1ccccc1', '苯的芳香环结构'],
    ]) {
      const result = await renderMoleculeDiagramSvg({ smiles: smiles!, title: title! });
      const rendered = await renderStaticDiagram({ source: result.svg, width: 960, height: 640 });
      const metadata = await sharp(rendered.bytes).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(960);
      expect(metadata.height).toBe(640);
      expect(rendered.bytes.byteLength).toBeGreaterThan(10000);
    }
  }, 60000);
  it('renders ethanol and aromatic ring with actual chemical bonds deterministically', async () => {
    for (const smiles of ['CCO', 'c1ccccc1']) {
      const first = await renderMoleculeDiagramSvg({ smiles, title: 'Structure' });
      const second = await renderMoleculeDiagramSvg({ smiles, title: 'Structure' });
      expect(first.svg).toBe(second.svg);
      expect(first.sourceDigest).toBe(second.sourceDigest);
      expect(first.svg).toMatch(/<(?:line|path|polygon)\b/);
      expect(first.svg).toContain('width="960"');
      expect(first.svg).not.toMatch(/<script|<foreignObject|href="https?:/);
      expect(first.engine).toBe('smiles-drawer');
    }
  });
  it('escapes labels and rejects invalid chemistry, markup and unbounded input', async () => {
    const result = await renderMoleculeDiagramSvg({ smiles: 'CCO', title: '<bad&label>' });
    expect(result.svg).toContain('&lt;bad&amp;label&gt;');
    for (const smiles of ['C1CC', '<script>bad</script>', 'C'.repeat(513), 'CCO>>CC=O'])
      await expect(renderMoleculeDiagramSvg({ smiles })).rejects.toThrow();
    await expect(renderMoleculeDiagramSvg({ smiles: 'CCO', width: 9999 })).rejects.toThrow();
  });
  it('propagates cancellation before loading the engine', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      renderMoleculeDiagramSvg({ smiles: 'CCO', signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
});
