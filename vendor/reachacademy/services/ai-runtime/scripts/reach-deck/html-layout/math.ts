import { renderMathToString } from '@reachany/tiptap-mathlive/static';

export const HTML_MATH_SELECTOR = '[data-reach-math-latex]';
export const HTML_MATH_CSS =
  '[data-reach-math-latex] { letter-spacing:normal; box-sizing:border-box; max-width:100%; position:relative; } [data-reach-math-latex][data-reach-math-display="false"] { display:inline-flex; margin-inline:0.08em; vertical-align:-0.12em; } [data-reach-math-latex][data-reach-math-display="true"] { display:block; margin-block:0.6rem; text-align:center; } [data-reach-math-latex] > .katex-display { margin:0; }';
export type HtmlMathPart =
  | { type: 'text'; text: string }
  | { type: 'math'; latex: string; display: boolean; source: string };

/** Familiar TeX delimiters only: a single dollar remains ordinary currency. */
export function splitHtmlMath(text: string): HtmlMathPart[] {
  const parts: HtmlMathPart[] = [];
  const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > 0 && text[index - 1] === '\\') continue;
    if (index > offset) parts.push({ type: 'text', text: text.slice(offset, index) });
    parts.push({
      type: 'math',
      latex: (match[1] ?? match[2] ?? match[3] ?? '').trim(),
      display: match[1] === undefined,
      source: match[0],
    });
    offset = index + match[0].length;
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
  return parts;
}

function safeFormula(latex: string): boolean {
  if (
    !latex ||
    latex.length > 2048 ||
    /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|html\w*|href|url|includegraphics|require)\b/.test(
      latex,
    )
  )
    return false;
  let depth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    if (latex[index] === '\\') {
      index += 1;
      continue;
    }
    if (latex[index] === '{' && ++depth > 32) return false;
    if (latex[index] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Call after sanitization and before font loading or any geometry measurement. */
export function prepareHtmlMath(document: Document): string[] {
  const diagnostics: string[] = [];
  const root = document.querySelector('#slide, [data-deck-slide]') ?? document.body;
  const walker = document.createTreeWalker(root, 4);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let count = 0;
  let remainingNodes = Math.max(0, 1900 - document.querySelectorAll('*').length);
  for (const text of nodes) {
    const parent = text.parentElement;
    if (!parent || parent.closest(`style, script, pre, code, svg, math, ${HTML_MATH_SELECTOR}`))
      continue;
    const parts = splitHtmlMath(text.data);
    if (!parts.some((part) => part.type === 'math')) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'text') {
        fragment.append(document.createTextNode(part.text));
        continue;
      }
      count += 1;
      let markup: string | undefined;
      if (!parent.closest('table') && count <= 80 && safeFormula(part.latex)) {
        try {
          const rendered = renderMathToString(part.latex, {
            displayMode: part.display,
            maxExpand: 100,
            maxSize: 10,
            throwOnError: true,
          });
          if (!rendered.includes('katex-error')) markup = rendered;
        } catch {
          /* Keep the source readable on renderer failure. */
        }
      }
      if (!markup) {
        diagnostics.push(
          `MATH_TEXT_FALLBACK ${parent.id || parent.tagName.toLowerCase()}: formula retained as LaTeX text (unsupported context, invalid syntax, or complexity limit).`,
        );
        fragment.append(document.createTextNode(part.source));
        continue;
      }
      const span = document.createElement('span');
      span.dataset.reachMathLatex = part.latex;
      span.dataset.reachMathDisplay = String(part.display);
      span.setAttribute('aria-label', part.latex);
      span.innerHTML = markup;
      const nodeCost = span.querySelectorAll('*').length + 1;
      if (nodeCost > remainingNodes) {
        diagnostics.push(
          `MATH_TEXT_FALLBACK ${parent.id || parent.tagName.toLowerCase()}: formula retained as LaTeX text (rendered node budget).`,
        );
        fragment.append(document.createTextNode(part.source));
        continue;
      }
      remainingNodes -= nodeCost;
      fragment.append(span);
    }
    text.replaceWith(fragment);
  }
  return diagnostics.slice(0, 100);
}
