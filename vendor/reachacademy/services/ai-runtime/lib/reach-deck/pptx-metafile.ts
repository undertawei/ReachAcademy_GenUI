/**
 * Vector-art conversion for PPTX import.
 *
 * PowerPoint stores legacy equations and clip art as Windows metafiles and
 * modern icons as SVG parts, and the native element model can carry neither.
 * Both end at the same rasterizer: metafiles are converted to SVG first, SVG
 * parts go straight in.
 *
 * The metafile tools live in the AI Runtime base image (`libwmf-bin`,
 * `emf2svg`); when they are absent this module reports that the asset cannot be
 * converted, and the mapper keeps reporting the loss as before. Rasterizing is
 * pure WebAssembly, so the SVG path works everywhere.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import type { PptxBinaryAsset } from '@reachany/importer/pptx';

import { resolveReachDeckRuntimeAsset } from './runtime-assets.js';

const execFileAsync = promisify(execFile);

/** Metafile content types PowerPoint writes, by the tool that reads them. */
const METAFILE_CONVERTERS: Readonly<Record<string, 'wmf' | 'emf'>> = {
  'image/x-wmf': 'wmf',
  'image/wmf': 'wmf',
  'application/x-msmetafile': 'wmf',
  'image/x-emf': 'emf',
  'image/emf': 'emf',
  'image/x-emf-plus': 'emf',
};

/** A metafile is vector art, so the rasterized copy is sized to the stage. */
const METAFILE_RASTER_SCALE = 3;
const MAX_METAFILE_RASTER_EDGE = 4096;

/**
 * An SVG part states its own size, which for an icon is the ~24px box it was
 * drawn in — rasterizing that at face value would show every teacher a blurry
 * icon the moment they enlarged it. Scale the shorter drawings up to this edge
 * and leave anything already larger alone.
 */
const SVG_RASTER_TARGET_EDGE = 1024;
const MAX_SVG_BYTES = 4 * 1024 * 1024;

const SVG_CONTENT_TYPES = new Set(['image/svg+xml']);

export const isReachDeckPptxSvg = (contentType: string): boolean =>
  SVG_CONTENT_TYPES.has(contentType.toLowerCase().split(';', 1)[0]!.trim());

/** Conversion runs in the request path, so a wedged tool must not hold it. */
const CONVERTER_TIMEOUT_MS = 20_000;
const MAX_METAFILE_BYTES = 16 * 1024 * 1024;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * URW substitutes for the fonts metafiles name. `Standard Symbols PS` keeps
 * Adobe Symbol's 8-bit encoding, which is what makes `abg` render as `αβγ`
 * rather than as Latin letters — a Unicode math font would silently get this
 * wrong.
 */
const METAFILE_FONT_FILES: Readonly<Record<string, string>> = {
  'Nimbus Roman': 'NimbusRoman-Regular.otf',
  'Nimbus Roman Bold': 'NimbusRoman-Bold.otf',
  'Nimbus Roman Italic': 'NimbusRoman-Italic.otf',
  'Nimbus Sans': 'NimbusSans-Regular.otf',
  'Standard Symbols PS': 'StandardSymbolsPS.otf',
};

const DEFAULT_METAFILE_FONT_DIRECTORY = '/usr/share/fonts/opentype/urw-base35';

export const isReachDeckPptxMetafile = (contentType: string): boolean =>
  contentType.toLowerCase() in METAFILE_CONVERTERS;

type ResvgModule = typeof import('@resvg/resvg-wasm');

let resvgInitialization: Promise<void> | undefined;

const loadResvg = (): ResvgModule => {
  const require = createRequire(import.meta.url);
  return require('@resvg/resvg-wasm') as ResvgModule;
};

const ensureResvg = async (): Promise<void> => {
  resvgInitialization ??= (async () => {
    const moduleEntry = resolveReachDeckRuntimeAsset('resvg-wasm');
    const bytes = await readFile(path.join(path.dirname(moduleEntry), 'index_bg.wasm'));
    try {
      await loadResvg().initWasm(bytes);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Already initialized')) throw error;
    }
  })();
  await resvgInitialization;
};

const fontBuffersByDirectory = new Map<string, Promise<Uint8Array[]>>();

const loadMetafileFonts = (directory: string): Promise<Uint8Array[]> => {
  const cached = fontBuffersByDirectory.get(directory);
  if (cached !== undefined) return cached;
  const loading = (async () => {
    const loaded: Uint8Array[] = [];
    for (const file of Object.values(METAFILE_FONT_FILES)) {
      try {
        loaded.push(Uint8Array.from(await readFile(path.join(directory, file))));
      } catch {
        // A missing substitute costs those glyphs, not the whole picture.
      }
    }
    return loaded;
  })();
  fontBuffersByDirectory.set(directory, loading);
  return loading;
};

/**
 * libwmf writes the SVG root without a default namespace, which every
 * conforming renderer rejects. Everything else about its output is fine.
 */
export function ensureSvgNamespace(svg: string): string {
  if (svg.includes(SVG_NAMESPACE)) return svg;
  return svg.replace(/<svg\b/, `<svg xmlns="${SVG_NAMESPACE}"`);
}

export interface ReachDeckPptxMetafileRaster {
  bytes: Uint8Array;
  contentType: 'image/png';
}

/**
 * Convert a metafile asset to a raster the native model can carry, or undefined
 * when the tools are missing or the metafile cannot be read. `stagePoints` is
 * the size the picture occupies on the slide, so the raster is sized to what it
 * will actually render at rather than to the metafile's own coordinate space.
 */
export async function convertReachDeckPptxMetafile(
  asset: PptxBinaryAsset,
  options: { fontDirectory?: string } = {},
): Promise<ReachDeckPptxMetafileRaster | undefined> {
  const kind = METAFILE_CONVERTERS[asset.contentType.toLowerCase()];
  if (kind === undefined || asset.byteLength === 0 || asset.byteLength > MAX_METAFILE_BYTES) {
    return undefined;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'reach-deck-metafile-'));
  try {
    const input = path.join(directory, `source.${kind}`);
    const output = path.join(directory, 'converted.svg');
    await writeFile(input, asset.bytes);
    const [command, commandArguments] =
      kind === 'wmf'
        ? (['wmf2svg', ['-o', output, input]] as const)
        : (['emf2svg-conv', ['-p', '-i', input, '-o', output]] as const);
    try {
      await execFileAsync(command, [...commandArguments], { timeout: CONVERTER_TIMEOUT_MS });
    } catch {
      // Missing tool, malformed metafile or timeout: all mean "keep reporting
      // this picture as lost" rather than shipping a blank image.
      return undefined;
    }
    const svg = ensureSvgNamespace(await readFile(output, 'utf8'));
    return await rasterizeReachDeckMetafileSvg(svg, options.fontDirectory);
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Rasterize a converted metafile SVG at the stage scale, with the URW font
 * substitutes and nothing from the host, so the same deck converts identically
 * wherever it is imported.
 */
export async function rasterizeReachDeckMetafileSvg(
  svg: string,
  fontDirectory = process.env.AI_RUNTIME_METAFILE_FONT_DIR?.trim() ||
    DEFAULT_METAFILE_FONT_DIRECTORY,
): Promise<ReachDeckPptxMetafileRaster | undefined> {
  return renderSvgToPng(svg, METAFILE_RASTER_SCALE, fontDirectory);
}

/**
 * Convert an SVG package part to a raster the native model can carry.
 *
 * A picture whose `a:blip` carries only the Office 2016 SVG extension has no
 * raster fallback in the package, so this is the only way its art reaches the
 * deck at all.
 */
export async function convertReachDeckPptxSvg(
  asset: PptxBinaryAsset,
  options: { fontDirectory?: string } = {},
): Promise<ReachDeckPptxMetafileRaster | undefined> {
  if (!isReachDeckPptxSvg(asset.contentType)) return undefined;
  if (asset.byteLength === 0 || asset.byteLength > MAX_SVG_BYTES) return undefined;
  let svg: string;
  try {
    svg = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
  } catch {
    return undefined;
  }
  const intrinsic = await measureSvg(svg, options.fontDirectory);
  if (intrinsic === undefined) return undefined;
  const longestEdge = Math.max(intrinsic.width, intrinsic.height);
  // Upscale small drawings toward the target edge, downscale anything that
  // would otherwise exceed the raster ceiling, leave the middle alone.
  const scale = Math.min(
    MAX_METAFILE_RASTER_EDGE / longestEdge,
    Math.max(1, SVG_RASTER_TARGET_EDGE / longestEdge),
  );
  return renderSvgToPng(svg, scale, options.fontDirectory);
}

/** The size the SVG asks to be drawn at, or undefined when it cannot be read. */
async function measureSvg(
  svg: string,
  fontDirectory?: string,
): Promise<{ width: number; height: number } | undefined> {
  const renderer = await createSvgRenderer(svg, { mode: 'original' }, fontDirectory);
  if (renderer === undefined) return undefined;
  if (renderer.width <= 0 || renderer.height <= 0) return undefined;
  return { width: renderer.width, height: renderer.height };
}

async function renderSvgToPng(
  svg: string,
  scale: number,
  fontDirectory?: string,
): Promise<ReachDeckPptxMetafileRaster | undefined> {
  const renderer = await createSvgRenderer(svg, { mode: 'zoom', value: scale }, fontDirectory);
  if (renderer === undefined) return undefined;
  if (
    renderer.width > MAX_METAFILE_RASTER_EDGE ||
    renderer.height > MAX_METAFILE_RASTER_EDGE ||
    renderer.width <= 0 ||
    renderer.height <= 0
  ) {
    return undefined;
  }
  const png = renderer.render().asPng();
  if (png.byteLength === 0) return undefined;
  return {
    bytes: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
    contentType: 'image/png',
  };
}

async function createSvgRenderer(
  svg: string,
  fitTo: { mode: 'original' } | { mode: 'zoom'; value: number },
  fontDirectory = process.env.AI_RUNTIME_METAFILE_FONT_DIR?.trim() ||
    DEFAULT_METAFILE_FONT_DIRECTORY,
): Promise<InstanceType<ResvgModule['Resvg']> | undefined> {
  await ensureResvg();
  const { Resvg } = loadResvg();
  const fonts = await loadMetafileFonts(fontDirectory);
  try {
    return new Resvg(svg, {
      fitTo,
      font: {
        fontBuffers: fonts,
        // Never the host's fonts: the same deck has to convert identically
        // wherever it is imported.
        loadSystemFonts: false,
        defaultFontFamily: 'Nimbus Roman',
        serifFamily: 'Nimbus Roman',
        sansSerifFamily: 'Nimbus Sans',
      },
    });
  } catch {
    // Malformed markup is a picture that cannot be converted, not an import
    // failure — the mapper reports the loss.
    return undefined;
  }
}
