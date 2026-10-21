import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 读取共享样式入口及其按组拆分的全部样式文件（src/styles.css + src/styles/*.css）。 */
export function readSharedStyles(): string {
  const entry = fileURLToPath(new URL('../src/styles.css', import.meta.url));
  const directory = fileURLToPath(new URL('../src/styles/', import.meta.url));
  const parts = readdirSync(directory)
    .filter((name) => name.endsWith('.css'))
    .sort()
    .map((name) => readFileSync(`${directory}${name}`, 'utf8'));
  return [readFileSync(entry, 'utf8'), ...parts].join('\n');
}

/** 读取单个分组样式文件，例如 readGroupStyles('button')。 */
export function readGroupStyles(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/styles/${name}.css`, import.meta.url)), 'utf8');
}
