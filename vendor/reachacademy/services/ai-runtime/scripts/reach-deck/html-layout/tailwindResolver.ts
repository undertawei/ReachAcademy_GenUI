/// <reference path="./raw-css.d.ts" />
import tailwindTheme from 'tailwindcss/theme.css?raw';

const compilerPromise = import('tailwindcss').then(({ compile }) =>
  compile(`${tailwindTheme}\n@tailwind utilities;`),
);

const collectClassCandidates = (document: Document): string[] => {
  const candidates = new Set<string>();
  document.querySelectorAll<HTMLElement>('[class]').forEach((element) => {
    element.classList.forEach((candidate) => candidates.add(candidate));
  });
  return [...candidates];
};

export async function resolvePptSafeTailwind(source: string): Promise<string> {
  const document = new DOMParser().parseFromString(source, 'text/html');
  const candidates = collectClassCandidates(document);
  if (candidates.length === 0) return source;

  const compiler = await compilerPromise;
  const css = compiler.build(candidates);
  if (!css.trim()) return source;

  document.querySelectorAll('[data-html-deck-tailwind]').forEach((element) => element.remove());
  const style = document.createElement('style');
  style.setAttribute('data-html-deck-tailwind', '');
  style.textContent = css;
  document.head.append(style);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}
