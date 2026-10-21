import { createHash } from 'node:crypto';
import { resolveReachDeckRuntimeAsset } from './runtime-assets';
import { Script, createContext } from 'node:vm';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

export const MOLECULE_DIAGRAM_RENDERER_VERSION = 'smiles-drawer-2.4.1/svg-v1' as const;
const SVG_NS = 'http://www.w3.org/2000/svg';
let trustedBundle: Promise<string> | undefined;

function loadTrustedBundle(): Promise<string> {
  return (trustedBundle ??= build({
    stdin: {
      contents:
        'import SmilesDrawer from "smiles-drawer"; globalThis.TrustedSmilesDrawer = SmilesDrawer;',
      resolveDir: resolveReachDeckRuntimeAsset('smiles-drawer').replace(/[\\/][^\\/]+$/, ''),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  })
    .then((result) => result.outputFiles[0]!.text)
    .catch((error) => {
      trustedBundle = undefined;
      throw error;
    }));
}

export interface MoleculeDiagramInput {
  smiles: string;
  title?: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

/** Executes a fixed, installed chemistry engine; model input is data, never JavaScript. */
export async function renderMoleculeDiagramSvg(input: MoleculeDiagramInput): Promise<{
  svg: string;
  engine: 'smiles-drawer';
  rendererVersion: typeof MOLECULE_DIAGRAM_RENDERER_VERSION;
  sourceDigest: string;
}> {
  input.signal?.throwIfAborted();
  const smiles = input.smiles?.trim();
  const title = input.title?.trim();
  const width = input.width ?? 960;
  const height = input.height ?? 640;
  if (!smiles || smiles.length > 512 || !/^[A-Za-z0-9@+\-\[\]()=#.$%:/\\*]+$/.test(smiles))
    throw new Error(
      'Molecule diagram requires bounded molecular SMILES, without reactions or markup.',
    );
  // The drawing library tolerates unclosed ring labels. Reject these before depiction.
  const ringCounts = new Map<string, number>();
  const outsideAtoms = smiles.replace(/\[[^\]]*\]/g, '');
  for (const match of outsideAtoms.matchAll(/%\d{2}|\d/g))
    ringCounts.set(match[0], (ringCounts.get(match[0]) ?? 0) + 1);
  if ([...ringCounts.values()].some((count) => count % 2 !== 0))
    throw new Error('Molecule diagram contains an unclosed ring.');
  if (title && (title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)))
    throw new Error('Molecule diagram title is invalid.');
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 320 ||
    height < 240 ||
    width > 1920 ||
    height > 1080 ||
    width * height > 2_073_600
  )
    throw new Error('Molecule diagram dimensions exceed the render budget.');
  const bundle = await loadTrustedBundle();
  input.signal?.throwIfAborted();
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: false,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  try {
    const document = window.document;
    const molecule = document.createElementNS(SVG_NS, 'svg');
    document.body.append(molecule);
    const context = createContext(
      {
        window,
        document,
        molecule,
        smiles,
        width,
        height: height - (title ? 64 : 0),
        SVGSVGElement: window.SVGSVGElement,
        SVGElement: window.SVGElement,
        HTMLElement: window.HTMLElement,
        HTMLCanvasElement: window.HTMLCanvasElement,
        HTMLImageElement: window.HTMLImageElement,
        console: { log() {}, warn() {}, error() {}, debug() {} },
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
    // Random SVG IDs are internal only. A fixed PRNG makes the serialized asset stable.
    const script = new Script(`
      let seed = 17;
      Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      ${bundle}
      const tree = TrustedSmilesDrawer.Parser.parse(smiles);
      const drawer = new TrustedSmilesDrawer.SvgDrawer({ width, height, padding: 24 });
      drawer.draw(tree, molecule, 'light');
      if (drawer.preprocessor.graph.vertices.length > 128) throw new Error('Molecule atom budget exceeded.');
    `);
    script.runInContext(context, { timeout: 3000, breakOnSigint: false });
    input.signal?.throwIfAborted();
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('xmlns', SVG_NS);
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    root.setAttribute('role', 'img');
    const accessibleTitle = document.createElementNS(SVG_NS, 'title');
    accessibleTitle.textContent = title ?? 'Molecular structure';
    root.append(accessibleTitle);
    const background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', String(width));
    background.setAttribute('height', String(height));
    background.setAttribute('fill', '#ffffff');
    root.append(background);
    if (title) {
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(width / 2));
      label.setAttribute('y', '42');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-family', 'sans-serif');
      label.setAttribute('font-size', '28');
      label.setAttribute('fill', '#0f172a');
      label.textContent = title;
      root.append(label);
    }
    molecule.setAttribute('x', '0');
    molecule.setAttribute('y', title ? '64' : '0');
    molecule.setAttribute('width', String(width));
    molecule.setAttribute('height', String(height - (title ? 64 : 0)));
    root.append(molecule);
    if (
      root.querySelector('script,foreignObject,image,iframe,animate,set') ||
      root.querySelectorAll('*').length > 4096
    )
      throw new Error('Molecule engine emitted unsupported SVG.');
    for (const element of root.querySelectorAll('*'))
      for (const attribute of element.attributes) {
        if (
          /^on/i.test(attribute.name) ||
          (/href$/i.test(attribute.name) && !attribute.value?.startsWith('#'))
        )
          throw new Error('Molecule engine emitted an external SVG reference.');
      }
    const svg = root.outerHTML;
    if (Buffer.byteLength(svg) > 512 * 1024)
      throw new Error('Molecule SVG exceeds the byte budget.');
    return {
      svg,
      engine: 'smiles-drawer',
      rendererVersion: MOLECULE_DIAGRAM_RENDERER_VERSION,
      sourceDigest: createHash('sha256')
        .update(
          JSON.stringify({
            smiles,
            title,
            width,
            height,
            rendererVersion: MOLECULE_DIAGRAM_RENDERER_VERSION,
          }),
        )
        .digest('hex'),
    };
  } finally {
    await window.close();
  }
}
