const MATHLIVE_ONLY_COMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\capitalDifferentialD(?![A-Za-z])/g, '\\mathrm{D}'],
  [/\\differentialD(?![A-Za-z])/g, '\\mathrm{d}'],
  [/\\imaginaryI(?![A-Za-z])/g, '\\mathrm{i}'],
  [/\\imaginaryJ(?![A-Za-z])/g, '\\mathrm{j}'],
  [/\\exponentialE(?![A-Za-z])/g, '\\mathrm{e}'],
  [/\\doubleprime(?![A-Za-z])/g, '\\prime\\prime'],
  [/\\questeq(?![A-Za-z])/g, '\\stackrel{?}{=}'],
  [/\\Colon(?![A-Za-z])/g, '\\mathrel{::}'],
  [/\\slash(?![A-Za-z])/g, '/'],
  [/\\twoheadrightarrowtail(?![A-Za-z])/g, '\\twoheadrightarrow'],
];

const GLUED_DIFFERENTIAL_SHORTCUT = /\\differentialD([xyt])(?![A-Za-z])/g;

export const DISABLED_MATHLIVE_INLINE_SHORTCUTS = [
  'ii',
  'jj',
  'ee',
  'dx',
  'dy',
  'dt',
  "''",
  '?=',
  '::',
  '//',
  '>->>',
] as const;

export type PortableLatexOptions = {
  removeUnresolvedPlaceholders?: boolean;
};

/** Convert MathLive-only aliases into portable LaTeX understood by the shared KaTeX renderer. */
export function toPortableLatex(latex: string, options: PortableLatexOptions = {}): string {
  let portable = latex.replace(GLUED_DIFFERENTIAL_SHORTCUT, '\\mathrm{d}$1');
  for (const [pattern, replacement] of MATHLIVE_ONLY_COMMANDS) {
    portable = portable.replace(pattern, replacement);
  }
  if (options.removeUnresolvedPlaceholders) {
    portable = portable.replace(/\\placeholder(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
  }
  return portable;
}
