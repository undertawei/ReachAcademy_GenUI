import katex from 'katex';

import { toPortableLatex } from './latex-compat.js';

export type StaticMathOptions = {
  displayMode?: boolean;
  maxExpand?: number;
  maxSize?: number;
  throwOnError?: boolean;
};

/** Server-safe static formula markup shared by NodeViews and read-only players. */
export function renderMathToString(latex: string, options: StaticMathOptions = {}): string {
  return katex.renderToString(toPortableLatex(latex, { removeUnresolvedPlaceholders: true }), {
    displayMode: options.displayMode ?? false,
    output: 'htmlAndMathml',
    strict: 'ignore',
    throwOnError: options.throwOnError ?? false,
    ...(options.maxExpand === undefined ? {} : { maxExpand: options.maxExpand }),
    ...(options.maxSize === undefined ? {} : { maxSize: options.maxSize }),
  });
}

/** Stable text fallback used by search, scoring, layout heuristics, and accessible names. */
export function mathToPlainText(latex: unknown, displayMode = false): string {
  if (typeof latex !== 'string' || latex.trim().length === 0) return '';
  const value = toPortableLatex(latex, { removeUnresolvedPlaceholders: true }).trim();
  return displayMode ? `\\[${value}\\]` : `\\(${value}\\)`;
}
