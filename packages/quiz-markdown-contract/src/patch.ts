import {
  QUIZ_INLINE_MATH_CLOSE,
  QUIZ_INLINE_MATH_OPEN,
  QUIZ_MARKDOWN_LIMITS,
} from './constants.js';
import {
  validateQuizMarkdown,
  type QuizMarkdownDiagnostic,
  type QuizMarkdownValidation,
} from './validate.js';

export interface QuizMarkdownPatchOperation {
  readonly oldText: string;
  readonly newText: string;
  /** One-based occurrence. Omit only when oldText occurs exactly once. */
  readonly occurrence?: number;
}

export type QuizMarkdownPatchResult =
  | {
      readonly ok: true;
      readonly markdown: string;
      readonly validation: QuizMarkdownValidation;
      readonly changedCharacters: number;
    }
  | { readonly ok: false; readonly error: string };

interface ResolvedOperation {
  readonly start: number;
  readonly end: number;
  readonly operation: QuizMarkdownPatchOperation;
}

/** Apply one model-proposed exact patch batch while preserving visible and protected content. */
export function applyQuizMarkdownPatch(
  markdown: string,
  operations: readonly QuizMarkdownPatchOperation[],
): QuizMarkdownPatchResult {
  if (operations.length < 1 || operations.length > QUIZ_MARKDOWN_LIMITS.maxPatchOperations) {
    return {
      ok: false,
      error: `patch 操作数必须为 1-${QUIZ_MARKDOWN_LIMITS.maxPatchOperations}`,
    };
  }

  const resolved: ResolvedOperation[] = [];
  let changedCharacters = 0;
  for (const operation of operations) {
    if (operation.oldText.length === 0) return { ok: false, error: 'oldText 不得为空' };
    if (
      operation.oldText.length > QUIZ_MARKDOWN_LIMITS.maxPatchTextLength ||
      operation.newText.length > QUIZ_MARKDOWN_LIMITS.maxPatchTextLength
    ) {
      return {
        ok: false,
        error: `单项 oldText/newText 不得超过 ${QUIZ_MARKDOWN_LIMITS.maxPatchTextLength} 字符`,
      };
    }
    const starts = findOccurrences(markdown, operation.oldText);
    const occurrence = operation.occurrence;
    let start: number;
    if (occurrence === undefined) {
      if (starts.length !== 1) {
        return {
          ok: false,
          error: `oldText 必须唯一；当前匹配 ${starts.length} 次，请提供 occurrence`,
        };
      }
      start = starts[0]!;
    } else {
      if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > starts.length) {
        return { ok: false, error: `occurrence ${String(occurrence)} 不在有效匹配范围内` };
      }
      start = starts[occurrence - 1]!;
    }
    resolved.push({ start, end: start + operation.oldText.length, operation });
    changedCharacters += changedCharacterCount(operation.oldText, operation.newText);
  }
  if (changedCharacters > QUIZ_MARKDOWN_LIMITS.maxPatchChangedCharacters) {
    return {
      ok: false,
      error: `累计 diff 超过 ${QUIZ_MARKDOWN_LIMITS.maxPatchChangedCharacters} 字符上限`,
    };
  }

  const ordered = [...resolved].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      return { ok: false, error: 'patch 操作目标范围不得重叠' };
    }
  }

  let patched = markdown;
  for (const entry of [...ordered].reverse()) {
    patched = patched.slice(0, entry.start) + entry.operation.newText + patched.slice(entry.end);
  }
  const protectionError = compareProtectedContent(markdown, patched);
  if (protectionError !== undefined) return { ok: false, error: protectionError };
  if (visibleSemanticProjection(markdown) !== visibleSemanticProjection(patched)) {
    return {
      ok: false,
      error: 'patch 只能修复 Markdown 定界符，不得改写可见自然语言、公式或代码正文',
    };
  }

  return {
    ok: true,
    markdown: patched,
    validation: validateQuizMarkdown(patched),
    changedCharacters,
  };
}

/** Last-resort local downgrade: quote math delimiters so normalization cannot reactivate them. */
export function escapeUnpairedQuizMarkdown(
  markdown: string,
  diagnostics: readonly QuizMarkdownDiagnostic[],
): { markdown: string; validation: QuizMarkdownValidation } {
  let escaped = markdown;
  const repairable = diagnostics
    .filter((entry) => entry.severity === 'repairable' && entry.start < entry.end)
    .sort((left, right) => right.start - left.start);
  for (const entry of repairable) {
    const token = escaped.slice(entry.start, entry.end);
    let replacement =
      entry.code === 'invalid-inline-math-content'
        ? renderLiteralInlineMathDelimiters(token)
        : entry.code.includes('math') && /^\\[()[\]]$/.test(token)
          ? `\`${token}\``
          : escapeDelimiter(token);
    // Adjacent backticks otherwise form one longer CommonMark fence and swallow existing code.
    if (replacement.startsWith('`') && escaped[entry.start - 1] === '`')
      replacement = ' ' + replacement;
    if (replacement.endsWith('`') && escaped[entry.end] === '`') replacement += ' ';
    escaped = escaped.slice(0, entry.start) + replacement + escaped.slice(entry.end);
  }
  return { markdown: escaped, validation: validateQuizMarkdown(escaped) };
}

function compareProtectedContent(before: string, after: string): string | undefined {
  const protectedExtractors: Array<[string, (value: string) => string[]]> = [
    ['图片引用', extractMarkdownImages],
    ['链接目标', extractLinkTargets],
    ['OSS objectKey', extractOssUris],
    ['URL', extractUrls],
  ];
  for (const [label, extractor] of protectedExtractors) {
    if (!sameArray(extractor(before), extractor(after))) return `patch 不得修改${label}`;
  }
  return undefined;
}

function visibleSemanticProjection(value: string): string {
  return value
    .replace(/<\/?span(?: data-feedback-color="(?:accent|success|warning|danger|muted)")?>/g, '')
    .replace(/```|~~|\*\*|\\\(|\\\)|\\\[|\\\]|`/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function extractMarkdownImages(value: string): string[] {
  return [...value.matchAll(/!\[[^\]]*\]\([^)]+\)/g)].map((match) => match[0]);
}

function extractLinkTargets(value: string): string[] {
  return [...value.matchAll(/(^|[^!])\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
    (match) => match[2]!,
  );
}

function extractOssUris(value: string): string[] {
  return [...value.matchAll(/reachany-oss:\/\/[A-Za-z0-9._/-]+/g)].map((match) => match[0]);
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s)>]+/g)].map((match) => match[0]);
}

function findOccurrences(value: string, search: string): number[] {
  const starts: number[] = [];
  let from = 0;
  while (from <= value.length - search.length) {
    const start = value.indexOf(search, from);
    if (start < 0) break;
    starts.push(start);
    from = start + search.length;
  }
  return starts;
}

function changedCharacterCount(before: string, after: string): number {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return before.length - prefix - suffix + (after.length - prefix - suffix);
}

function escapeDelimiter(token: string): string {
  if (token.startsWith('\\')) return '\\' + token;
  return [...token].map((character) => '\\' + character).join('');
}

function renderLiteralInlineMathDelimiters(token: string): string {
  if (!token.startsWith(QUIZ_INLINE_MATH_OPEN) || !token.endsWith(QUIZ_INLINE_MATH_CLOSE)) {
    return escapeDelimiter(token);
  }
  const body = token.slice(QUIZ_INLINE_MATH_OPEN.length, -QUIZ_INLINE_MATH_CLOSE.length);
  return `\`${QUIZ_INLINE_MATH_OPEN}\`${body}\`${QUIZ_INLINE_MATH_CLOSE}\``;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
