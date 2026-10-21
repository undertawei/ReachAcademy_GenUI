import { normalizeReachDeckNarrationMarkdown } from '@reachany/reach-deck-dsl';

const LITERAL_CONTROL_ESCAPE_PATTERN = /\\u(?:000[0-9a-f]|001[0-9a-f]|007f)/iu;
const FORMULA_DELIMITER_PATTERN = /\\+[()[\]]/gu;

export class GeneratedMarkdownFormulaError extends Error {
  readonly code = 'malformed-formula' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GeneratedMarkdownFormulaError';
  }
}

/**
 * Fresh structured output must not carry decoded controls or their literal Unicode-escape
 * spellings. The latter produced the observed `\\u00028` / `\\u0008(` pseudo delimiters after a
 * provider returned JSON-valid but semantically corrupt strings.
 */
export function assertGeneratedMarkdownRawSafe(markdown: string): void {
  for (const character of markdown) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      codePoint === 0x7f
    ) {
      throw new GeneratedMarkdownFormulaError(
        'Generated Markdown contains a forbidden C0 or DEL control character.',
      );
    }
  }
  if (LITERAL_CONTROL_ESCAPE_PATTERN.test(markdown)) {
    throw new GeneratedMarkdownFormulaError(
      'Generated Markdown contains a literal Unicode escape for a forbidden control character.',
    );
  }
}

/**
 * Canonicalize formula delimiters only at fresh AI-model-output boundaries.
 *
 * Structured JSON providers sometimes return one extra decoded backslash on either outer
 * delimiter. The downstream parsers then match the inner `\(...\)` / `\[...\]` pair, leaving the
 * first slash as text and the final slash inside LaTeX. A complete pair may use one or two slashes
 * independently at each edge; both spellings become the canonical single-slash pair.
 *
 * This deliberately does not collapse backslashes generally. Runs of three or more, incomplete
 * pairs, unrelated escapes, and formula bodies are left byte-for-byte unchanged for the owning
 * parser to handle or reject.
 */
export function canonicalizeGeneratedMathDelimiters(markdown: string): string {
  return canonicalizeDelimiterPair(canonicalizeDelimiterPair(markdown, '[', ']', true), '(', ')');
}

/**
 * Reject malformed backslash-delimited formulas before the shared parser can downgrade them to
 * visible text. Dollar syntax is intentionally left to the owning parser: it is valid slide math,
 * while Quiz treats dollar signs as literal currency.
 */
export function assertGeneratedFormulaStructure(markdown: string): void {
  let active: { kind: 'inline' | 'display'; bodyStart: number } | undefined;

  for (const match of markdown.matchAll(FORMULA_DELIMITER_PATTERN)) {
    const token = match[0];
    const index = match.index;
    // Inside LaTeX, `\\[2ex]` is a row break with spacing, not a display-math delimiter.
    if (active !== undefined && token.length > 2) continue;
    if (token.length !== 2) malformed('Formula delimiters must contain exactly one backslash.');
    const delimiter = token[1]!;

    if (delimiter === '(' || delimiter === '[') {
      if (active !== undefined) malformed('Generated formulas must not be nested.');
      if (delimiter === '[' && !occupiesOwnLine(markdown, index, token.length)) {
        malformed('Display formula delimiters must occupy their own lines.');
      }
      active = { kind: delimiter === '(' ? 'inline' : 'display', bodyStart: index + token.length };
      continue;
    }

    const closingKind = delimiter === ')' ? 'inline' : 'display';
    if (active === undefined || active.kind !== closingKind) {
      malformed('Generated formula delimiters are unmatched or out of order.');
    }
    if (closingKind === 'display' && !occupiesOwnLine(markdown, index, token.length)) {
      malformed('Display formula delimiters must occupy their own lines.');
    }
    const body = markdown.slice(active.bodyStart, index);
    if (body.trim().length === 0 || (closingKind === 'inline' && /[\r\n]/u.test(body))) {
      malformed('Generated formulas must be non-empty and inline formulas must stay on one line.');
    }
    active = undefined;
  }

  if (active !== undefined) malformed('Generated formula delimiters are not closed.');
}

/** The strict sequence used only by slide/quiz fresh-model-output adapters. */
export function normalizeFreshGeneratedMarkdown(markdown: string): string {
  assertGeneratedMarkdownRawSafe(markdown);
  const canonical = canonicalizeGeneratedFormulaLayout(
    canonicalizeGeneratedMathDelimiters(markdown),
  );
  assertGeneratedFormulaStructure(canonical);
  return canonical;
}

/**
 * Remove Markdown-style backslash escapes of ASCII punctuation (the CommonMark escapable set)
 * that a model added to fresh narration prose, e.g. `y=2x\+1` → `y=2x+1`.
 *
 * Only prose outside `\(...\)` / `\[...\]` is touched: the delimiters and every formula body are
 * copied byte-for-byte, as are unmatched delimiters (left for the validator) and `\\` (an escaped
 * literal backslash; unescaping it would change the meaning of the next character). When the
 * unescaped text would no longer be valid narration Markdown (e.g. `\*\*` → `**`, or `\- ` at a
 * line start becoming a list), the input is returned unchanged so the owning parser decides.
 *
 * Note the narration dialect canonically re-escapes a few of these characters (`+ - * _ < > # ! |
 * ~` and backtick), so persisted Markdown still spells `+` as `\+`; this removes only the model's
 * own escapes, and makes escapes the dialect does not accept (e.g. `\=`, `\.`) harmless.
 */
export function stripGeneratedNarrationPunctuationEscapes(markdown: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < markdown.length) {
    const character = markdown[cursor]!;
    const next = markdown[cursor + 1];
    if (character !== '\\' || next === undefined) {
      result += character;
      cursor += 1;
      continue;
    }
    if (next === '(' || next === '[') {
      const close = markdown.indexOf(next === '(' ? '\\)' : '\\]', cursor + 2);
      const end = close < 0 ? markdown.length : close + 2;
      result += markdown.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (next === '\\' || next === ')' || next === ']') {
      result += character + next;
    } else {
      result += COMMONMARK_ESCAPABLE_PUNCTUATION.has(next) ? next : character + next;
    }
    cursor += 2;
  }
  if (result === markdown) return markdown;
  try {
    normalizeReachDeckNarrationMarkdown(result);
    return result;
  } catch {
    return markdown;
  }
}

const COMMONMARK_ESCAPABLE_PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

/**
 * Repair formula layout whose intent is unambiguous, before strict validation:
 * a complete display pair written mid-line is moved onto standalone lines, and a line break
 * inside a complete inline pair becomes a space (LaTeX treats it as whitespace anyway).
 * Unclosed, nested, mismatched or empty formulas are left for the validator to reject.
 */
export function canonicalizeGeneratedFormulaLayout(markdown: string): string {
  const display = markdown.replace(
    /[ \t]*(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\][ \t]*/gu,
    (match: string, body: string, offset: number, source: string) => {
      if (/(?<!\\)\\[[(]/u.test(body) || !body.trim()) return match;
      const before = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset);
      const afterEnd = source.indexOf('\n', offset + match.length);
      const after = source.slice(offset + match.length, afterEnd < 0 ? source.length : afterEnd);
      const lead = before.trim() ? '\n' : '';
      const trail = after.trim() ? '\n' : '';
      return `${lead}\\[\n${body.trim()}\n\\]${trail}`;
    },
  );
  return display.replace(
    /(?<!\\)\\\(([^\n]*?\n[\s\S]*?)(?<!\\)\\\)/gu,
    (match: string, body: string) =>
      /\n[ \t]*\n/u.test(body) || /(?<!\\)\\[[(\]]/u.test(body)
        ? match
        : `\\(${body.replace(/[ \t]*\r?\n[ \t]*/gu, ' ')}\\)`,
  );
}

function occupiesOwnLine(markdown: string, index: number, length: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1;
  const nextLine = markdown.indexOf('\n', index + length);
  const lineEnd = nextLine < 0 ? markdown.length : nextLine;
  return markdown.slice(lineStart, lineEnd).trim() === markdown.slice(index, index + length);
}

function malformed(message: string): never {
  throw new GeneratedMarkdownFormulaError(message);
}

function canonicalizeDelimiterPair(
  source: string,
  open: '(' | '[',
  close: ')' | ']',
  multiline = false,
): string {
  const body = multiline ? '[\\s\\S]*?' : '[^\\n]*?';
  const pattern = new RegExp(
    `(?<!\\\\)\\\\{1,2}\\${open}(${body})(?<!\\\\)\\\\{1,2}\\${close}`,
    'gu',
  );
  return source.replace(pattern, (_match, latex: string) => `\\${open}${latex}\\${close}`);
}
