import { access, readFile } from 'node:fs/promises';
import { resolveReachDeckRuntimeAsset } from '../runtime-assets';
import path from 'node:path';
import { create, type Font } from 'fontkit';
import type { HtmlLayoutFontRun } from './types';

const directory = path.join(path.dirname(resolveReachDeckRuntimeAsset('player-styles')), 'fonts');
const fonts = new Map<string, Promise<Font>>();
let catalog: Promise<{ families: Array<{ family: string; source: string }> }> | undefined;
let mathCss: Promise<string> | undefined;

/** Embed trusted KaTeX assets because the compiler browser has networking disabled. */
export function loadHtmlMathStyles(): Promise<string> {
  return (mathCss ??= (async () => {
    const cssPath = resolveReachDeckRuntimeAsset('katex-css');
    let css = await readFile(cssPath, 'utf8');
    const faces = css.match(/@font-face\s*\{[^}]+\}/g) ?? [];
    for (const face of faces) {
      const filename = /url\(fonts\/([A-Za-z0-9_-]+\.woff2)\)/.exec(face)?.[1];
      if (!filename) throw new Error('Invalid bundled KaTeX font declaration.');
      const bytes = await readFile(path.join(path.dirname(cssPath), 'fonts', filename));
      css = css.replace(
        face,
        face.replace(
          /src:[^;}]+/,
          `src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2")`,
        ),
      );
    }
    return css;
  })());
}
const loadCatalog = (): NonNullable<typeof catalog> =>
  (catalog ??= readFile(path.join(directory, 'manifest.json'), 'utf8').then(JSON.parse));

/**
 * 源字体目录：部署镜像不含 player/fonts/sources（.dockerignore 排除），
 * 由基础镜像提供并经 AI_RUNTIME_OFFICE_FONT_DIR 指向；显式目录具有权威性，
 * 未设置时才回落到仓库内路径（本机开发）。
 */
export function resolveHtmlLayoutFontSourceDirectory(
  explicitDirectory = process.env.AI_RUNTIME_OFFICE_FONT_DIR?.trim(),
): string {
  return explicitDirectory === undefined || explicitDirectory.length === 0
    ? path.join(directory, 'sources')
    : path.resolve(explicitDirectory);
}

/**
 * Worker 启动预检：确认字体清单里每个源字体都可读。
 *
 * 设计动机：缺字体时 slide 页会在模型调用之后才于排版阶段失败，既浪费 token
 * 又要到教师生成时才暴露；放在消费者注册前可让发布直接卡住、旧 Pod 继续服务。
 */
export async function verifyHtmlLayoutFontSources(explicitDirectory?: string): Promise<void> {
  const root = resolveHtmlLayoutFontSourceDirectory(explicitDirectory);
  const { families } = await loadCatalog();
  await Promise.all(families.map((entry) => access(path.join(root, entry.source))));
}

export async function loadHtmlLayoutFonts(text: string): Promise<string> {
  const css = await readFile(path.join(directory, 'fonts.css'), 'utf8');
  const points = [...new Set(Array.from(text, (char) => char.codePointAt(0)!))];
  const faces = (css.match(/@font-face\s*\{[^}]+\}/g) ?? []).filter((face) => {
    const ranges = /unicode-range:\s*([^;]+)/.exec(face)?.[1];
    if (!ranges) return true;
    return ranges.split(',').some((range) => {
      const [start, end = start] = range.trim().replace(/^U\+/i, '').split('-');
      return points.some((point) => point >= parseInt(start!, 16) && point <= parseInt(end!, 16));
    });
  });
  return (
    await Promise.all(
      faces.map(async (face) => {
        const name = /url\("\.\/([^"/]+\.woff2)"\)/.exec(face)?.[1];
        if (!name) throw new Error('Invalid bundled font declaration.');
        const bytes = await readFile(path.join(directory, name));
        return face.replace(
          `url("./${name}")`,
          `url("data:font/woff2;base64,${bytes.toString('base64')}")`,
        );
      }),
    )
  ).join('\n');
}

async function fontFor(family: string): Promise<Font | undefined> {
  const entry = (await loadCatalog()).families.find((item) => item.family === family);
  if (!entry) return undefined;
  let font = fonts.get(family);
  if (!font) {
    font = readFile(path.join(resolveHtmlLayoutFontSourceDirectory(), entry.source)).then(
      (bytes) => {
        const loaded = create(bytes);
        if (!('hasGlyphForCodePoint' in loaded)) throw new Error('Expected a single font face.');
        return loaded;
      },
    );
    fonts.set(family, font);
  }
  return font;
}

export async function resolveHtmlLayoutFontRuns(
  runs: HtmlLayoutFontRun[],
  defaultFamily: string,
): Promise<string[]> {
  const aliases: Record<string, string> = {
    Arial: 'Liberation Sans',
    Helvetica: 'Liberation Sans',
    'Times New Roman': 'Liberation Serif',
    'Microsoft YaHei': 'Source Han Sans VF',
    'Noto Sans SC': 'Source Han Sans VF',
    'sans-serif': defaultFamily,
    serif: 'Source Han Serif SC',
  };
  return Promise.all(
    runs.map(async (run) => {
      const requested = run.family
        .split(',')[0]!
        .trim()
        .replace(/^["']|["']$/g, '');
      for (const family of [
        ...new Set([aliases[requested] ?? requested, defaultFamily, 'Source Han Sans VF']),
      ]) {
        const font = await fontFor(family);
        if (
          font &&
          Array.from(run.text).every(
            (char) => /\s/u.test(char) || font.hasGlyphForCodePoint(char.codePointAt(0)!),
          )
        )
          return family;
      }
      // 没有任何候选字体覆盖整段文字（如下标数字 ₁₂ 不在思源黑体里）时退回思源黑体：
      // 个别字符显示不出来可以接受，不能因此让整页生成失败。
      return 'Source Han Sans VF';
    }),
  );
}
