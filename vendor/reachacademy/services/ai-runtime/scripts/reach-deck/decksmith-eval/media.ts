import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type { DecksmithReplayMediaFile } from '../../../tests/reach-deck/decksmith-replay/fixture-loader.js';

/**
 * 评测用的示意图（只在第②/③层使用，不改第①层夹具）。
 *
 * 数据源：本文件内联的 SVG，按需用 sharp 栅格化为 PNG。
 * 核心逻辑：
 * 1. 回放夹具里的图片是 2×2 PNG，满足第①层的校验和需求，但低于生产归一化的 16 px 下限，
 *    真实的视觉输入与参考图编辑链路会直接拒绝；
 * 2. 评测把同名图片替换为内容对得上 alt 的合成示意图（英文标签，避免依赖本机中文字体），
 *    并同步改写评测输入文档里的资源 digest，保持"文档 digest = 授权返回的 checksum = 下载字节"一致；
 * 3. 图片编辑桩返回一张同尺寸的"已编辑"示意图。
 */

const WIDTH = 768;
const HEIGHT = 512;

const SVG: Readonly<Record<string, string>> = {
  'hero.png': scene(`
    <rect x="70" y="80" width="170" height="210" rx="24" fill="#d9e7f5" stroke="#345" stroke-width="6"/>
    <text x="155" y="330" font-size="30" text-anchor="middle">kettle</text>
    <circle cx="540" cy="180" r="100" fill="#f3f3f3" stroke="#345" stroke-width="6"/>
    <path d="M540 180 L540 90 M540 180 L620 220 M540 180 L460 220" stroke="#345" stroke-width="10"/>
    <text x="540" y="330" font-size="30" text-anchor="middle">fan</text>
    <rect x="60" y="380" width="150" height="70" rx="10" fill="#f6d27a" stroke="#345" stroke-width="6"/>
    <rect x="210" y="400" width="16" height="30" fill="#345"/>
    <text x="300" y="430" font-size="28">AA dry cell</text>`),
  'battery-dry.png': scene(`
    <rect x="220" y="170" width="300" height="150" rx="18" fill="#f6d27a" stroke="#345" stroke-width="8"/>
    <rect x="520" y="215" width="30" height="60" fill="#345"/>
    <text x="384" y="400" font-size="34" text-anchor="middle">AA dry cell 1.5V</text>`),
  'battery-rechargeable.png': scene(`
    <rect x="240" y="120" width="290" height="260" rx="22" fill="#9fd3a8" stroke="#345" stroke-width="8"/>
    <text x="384" y="270" font-size="40" text-anchor="middle">Li-ion</text>
    <text x="384" y="440" font-size="34" text-anchor="middle">lithium battery pack</text>`),
  'edited-hero.png': scene(`
    <rect x="70" y="80" width="170" height="210" rx="24" fill="#d9e7f5" stroke="#345" stroke-width="6"/>
    <circle cx="540" cy="180" r="100" fill="#f3f3f3" stroke="#345" stroke-width="6"/>
    <rect x="60" y="380" width="150" height="70" rx="10" fill="#9fd3a8" stroke="#345" stroke-width="6"/>
    <path d="M120 390 L100 420 L130 420 L110 445" stroke="#345" stroke-width="6" fill="none"/>
    <text x="300" y="430" font-size="28">rechargeable (charging)</text>`),
};

function scene(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g font-family="Helvetica, Arial, sans-serif" fill="#223">${body}</g></svg>`;
}

const rendered = new Map<string, Promise<DecksmithReplayMediaFile>>();

/** 按夹具文件名取评测示意图；没有对应示意图时返回 undefined（保留夹具原字节）。 */
export function evalMediaFile(name: string): Promise<DecksmithReplayMediaFile> | undefined {
  const svg = SVG[name];
  if (svg === undefined) return undefined;
  let file = rendered.get(name);
  if (file === undefined) {
    file = sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      .toBuffer()
      .then((bytes) => ({
        bytes,
        contentType: 'image/png',
        width: WIDTH,
        height: HEIGHT,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }));
    rendered.set(name, file);
  }
  return file;
}

/**
 * 把基线媒体换成评测示意图，并改写文档资源 digest（就地修改传入的评测文档副本）。
 * 返回替换后的媒体表（objectKey → 文件）。
 */
export async function applyEvalMediaOverlay(
  document: { resources: { media: { objectKey: string; digest?: string }[] } },
  baseline: ReadonlyMap<string, DecksmithReplayMediaFile>,
): Promise<Map<string, DecksmithReplayMediaFile>> {
  const media = new Map(baseline);
  for (const resource of document.resources.media) {
    if (!media.has(resource.objectKey)) continue;
    const overlay = evalMediaFile(
      resource.objectKey.slice(resource.objectKey.lastIndexOf('/') + 1),
    );
    if (overlay === undefined) continue;
    const file = await overlay;
    media.set(resource.objectKey, file);
    resource.digest = `sha256:${file.sha256}`;
  }
  return media;
}
