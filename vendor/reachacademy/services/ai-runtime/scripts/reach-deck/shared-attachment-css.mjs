import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** 独立浏览器工具不经过应用 CSS 打包，需要显式打包共享附件样式与品牌 token。 */
export async function loadSharedAttachmentCss() {
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const result = await build({
    stdin: {
      contents: `@import ${JSON.stringify(path.join(repositoryRoot, 'packages/brand/styles/variables.css'))};\n@import ${JSON.stringify(path.join(repositoryRoot, 'packages/ui/src/styles.css'))};`,
      loader: 'css',
      resolveDir: repositoryRoot,
    },
    bundle: true,
    write: false,
  });
  return result.outputFiles[0].text;
}
