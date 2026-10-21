/** TipTap node names emitted by current Portal extensions plus retained legacy aliases. */
const MATH_NODE_TYPES = new Set([
  'math',
  'inlineMath',
  'blockMath',
  'mathInline',
  'mathBlock',
  'formula',
  'katex',
]);

/** Block nodes whose extracted prompt text should be separated by a newline. */
const BLOCK_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'bulletList',
  'orderedList',
  'taskItem',
  'taskList',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

/**
 * Converts persisted TipTap content into a stable semantic text representation.
 *
 * Text and plain-string legacy values are retained. Formula/media nodes produce safe
 * placeholders only when they carry meaningful persisted attributes; temporary URLs are never
 * copied into the result. Unknown and malformed nodes are traversed safely through `content`.
 */
export function tiptapToPlainText(node: unknown): string {
  return collectSemanticText(node)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when TipTap/legacy content contains text, a formula, media, or a Mermaid source. */
export function hasSemanticTiptapContent(node: unknown): boolean {
  return tiptapToPlainText(node).length > 0;
}

function collectSemanticText(node: unknown): string[] {
  if (typeof node === 'string') return node.trim().length > 0 ? [node] : [];
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => collectSemanticText(child));

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : undefined;

  if (type === 'text' && typeof record.text === 'string') {
    return record.text.trim().length > 0 ? [record.text] : [];
  }
  if (type === 'hardBreak') return ['\n'];

  if (type === 'quizBlank') {
    const attrs = readRecord(record.attrs);
    const blankIndex = attrs?.blankIndex;
    return typeof blankIndex === 'number' && Number.isSafeInteger(blankIndex) && blankIndex > 0
      ? [`____${blankIndex}____`]
      : [];
  }

  if (type !== undefined && MATH_NODE_TYPES.has(type)) {
    const attrs = readRecord(record.attrs);
    const latex = firstNonBlank(attrs?.latex, attrs?.formula, attrs?.value);
    if (latex === undefined) return [];
    const rendered = `$${latex}$`;
    return type === 'blockMath' || type === 'mathBlock' ? [rendered, '\n'] : [rendered];
  }

  if (type === 'image' || type === 'attachment') {
    const attrs = readRecord(record.attrs);
    const reference = firstNonBlank(
      attrs?.objectKey,
      attrs?.src,
      attrs?.downloadUrl,
      attrs?.dataUrl,
    );
    const label = firstNonBlank(attrs?.alt, attrs?.title, attrs?.name, attrs?.fileName);
    if (reference === undefined) return [];
    const kind = type === 'image' ? '图片' : '附件';
    return [`[${kind}${label === undefined ? '' : `：${label}`}]`];
  }

  if (type === 'mermaidDiagram') {
    const attrs = readRecord(record.attrs);
    const source = firstNonBlank(attrs?.source);
    return source === undefined ? [] : [`[图示：${source}]`];
  }

  const children = Array.isArray(record.content)
    ? record.content.flatMap((child) => collectSemanticText(child))
    : [];
  return type !== undefined && BLOCK_NODE_TYPES.has(type) ? [...children, '\n'] : children;
}

function firstNonBlank(...values: unknown[]): string | undefined {
  return values
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
