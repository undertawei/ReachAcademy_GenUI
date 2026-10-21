import {
  parseReachDeckNarrationMarkdown,
  serializeReachDeckNarrationMarkdown,
} from './narrationMarkdown.js';
import type { RichTextDocument, RichTextMark, RichTextNode } from './richText.js';
import {
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  canonicalizeReachDeckSpeechMarkupV1,
  parseReachDeckSpeechMarkupV1,
  type ReachDeckPointSpeechMarkV1,
  type ReachDeckSpanSpeechMarkV1,
  type ReachDeckSpeechMarkV1,
  type ReachDeckSpeechMarkupV1,
} from './speechMarkup.js';

export const REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE = 'reachDeckSpeechMark';
export const REACH_DECK_SPEECH_BREAK_NODE_TYPE = 'reachDeckSpeechBreak';
export const REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE = 'reachDeckSpeechSoundEvent';

export type ReachDeckSpeechRichTextDefinition =
  | ({ id: string } & Omit<Extract<ReachDeckPointSpeechMarkV1, { type: 'break' }>, 'at'>)
  | ({ id: string } & Omit<Extract<ReachDeckPointSpeechMarkV1, { type: 'soundEvent' }>, 'at'>)
  | ({ id: string } & Omit<Extract<ReachDeckSpanSpeechMarkV1, { type: 'sub' }>, 'from' | 'to'>)
  | ({ id: string } & Omit<Extract<ReachDeckSpanSpeechMarkV1, { type: 'say-as' }>, 'from' | 'to'>)
  | ({ id: string } & Omit<Extract<ReachDeckSpanSpeechMarkV1, { type: 'phoneme' }>, 'from' | 'to'>);

export interface ReachDeckNarrationSpeechDocumentValue {
  markdown: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
}

/** Normalize editor-only empty paragraphs while retaining a map of UTF-16 boundaries. */
export function canonicalizeReachDeckNarrationMarkdownOffsets(markdown: string): {
  markdown: string;
  offsets: number[];
} {
  const canonical = serializeReachDeckNarrationMarkdown(parseReachDeckNarrationMarkdown(markdown));
  const offsets = [0];
  let at = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === canonical[at]) at += 1;
    else if (markdown[index] !== '\n' && markdown[index] !== '\r') {
      unsupported('Narration normalization must only remove redundant line breaks.');
    }
    offsets.push(at);
  }
  if (at !== canonical.length) unsupported('Narration normalization changed visible text.');
  return { markdown: canonical, offsets };
}

/**
 * Load persisted Markdown ranges into editor-local marks. The opaque id exists only so
 * ProseMirror can preserve one annotation across ordinary position mapping and history.
 */
export function parseReachDeckNarrationSpeechDocument(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): RichTextDocument {
  const doc = parseReachDeckNarrationMarkdown(markdown);
  const canonicalMarkdown = serializeReachDeckNarrationMarkdown(doc);
  if (speechMarkup === undefined) return doc;
  const parsed = parseReachDeckSpeechMarkupV1(speechMarkup, canonicalMarkdown);
  const spans = parsed.marks.filter(
    (mark): mark is ReachDeckSpanSpeechMarkV1 =>
      mark.type !== 'break' && mark.type !== 'soundEvent',
  );
  const points = parsed.marks.filter(
    (mark): mark is ReachDeckPointSpeechMarkV1 =>
      mark.type === 'break' || mark.type === 'soundEvent',
  );
  const representedPoints = new Set<ReachDeckPointSpeechMarkV1>();
  const blocks = doc.content ?? [];
  const decorated: RichTextNode[] = [];
  let markdownAt = 0;

  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) markdownAt += 2;
    if (block.type === 'blockMath') {
      markdownAt += serializeSingleBlock(block).length;
      decorated.push(block);
      return;
    }
    if (block.type !== 'paragraph') unsupported('Narration document contains an invalid block.');
    const content: RichTextNode[] = [];
    for (const inline of block.content ?? []) {
      const source = serializeSingleInline(inline);
      const from = markdownAt;
      const to = from + source.length;
      if (inline.type === 'text') {
        const intersecting = spans.filter(
          (candidate) => candidate.from < to && from < candidate.to,
        );
        if (intersecting.some((candidate) => candidate.from < from || candidate.to > to)) {
          unsupported('A speech span cannot cross rich-text nodes.');
        }
        appendPointsInsideText(
          content,
          inline,
          source,
          points,
          representedPoints,
          from,
          to,
          intersecting,
        );
      } else {
        appendPointsAt(content, points, representedPoints, from, blockIndex);
        content.push(inline);
      }
      markdownAt = to;
    }
    appendPointsAt(content, points, representedPoints, markdownAt, blockIndex);
    decorated.push({ type: 'paragraph', ...(content.length === 0 ? {} : { content }) });
  });

  if (blocks.length === 0 && points.length > 0) {
    unsupported('Speech point marks require a narration paragraph.');
  }
  if (representedPoints.size !== points.length) {
    unsupported('A speech point mark cannot be represented inside a paragraph separator.');
  }
  return { type: 'doc', ...(decorated.length === 0 ? {} : { content: decorated }) };
}

/** Serialize editor-local annotations into canonical Markdown ranges. */
export function serializeReachDeckNarrationSpeechDocument(
  document: RichTextDocument,
  options: { canonicalize?: boolean } = {},
): ReachDeckNarrationSpeechDocumentValue {
  const stripped = stripSpeechDecorations(document);
  const sourceMarkdown = serializeReachDeckNarrationMarkdown(stripped);
  const normalized = options.canonicalize
    ? canonicalizeReachDeckNarrationMarkdownOffsets(sourceMarkdown)
    : undefined;
  const markdown = normalized?.markdown ?? sourceMarkdown;
  const marks: ReachDeckSpeechMarkV1[] = [];
  const spansById = new Map<
    string,
    { definition: ReachDeckSpeechRichTextDefinition; from: number; to: number }
  >();
  const usedPointIds = new Set<string>();
  let markdownAt = 0;

  (document.content ?? []).forEach((block, blockIndex) => {
    if (blockIndex > 0) markdownAt += 2;
    if (block.type === 'blockMath') {
      markdownAt += serializeSingleBlock(block).length;
      return;
    }
    for (const inline of block.content ?? []) {
      if (isSpeechPointNodeType(inline.type)) {
        const definition = readSpeechDefinition(inline.attrs?.definition, 'speech point');
        if (!isSpeechPointDefinition(definition)) {
          unsupported('Speech point node has invalid attributes.');
        }
        if (
          (inline.type === REACH_DECK_SPEECH_BREAK_NODE_TYPE && definition.type !== 'break') ||
          (inline.type === REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE &&
            definition.type !== 'soundEvent')
        ) {
          unsupported('Speech point node type does not match its attributes.');
        }
        if (usedPointIds.has(definition.id)) unsupported('Speech point ids must be unique.');
        usedPointIds.add(definition.id);
        const { id: _id, ...attributes } = definition;
        marks.push({ ...attributes, at: markdownAt } as ReachDeckPointSpeechMarkV1);
        continue;
      }
      const source = serializeSingleInline(stripSpeechMarks(inline));
      if (inline.type === 'text') {
        const speechMarks = (inline.marks ?? []).filter(
          (mark) => mark.type === REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
        );
        if (speechMarks.length > 1) unsupported('Narration text has overlapping speech marks.');
        if (speechMarks.length === 1) {
          const definition = readSpeechDefinition(speechMarks[0]!.attrs?.definition, 'speech span');
          if (isSpeechPointDefinition(definition)) {
            unsupported('Speech text mark has invalid attributes.');
          }
          const existing = spansById.get(definition.id);
          if (existing === undefined) {
            spansById.set(definition.id, {
              definition,
              from: markdownAt,
              to: markdownAt + source.length,
            });
          } else {
            if (
              existing.to !== markdownAt ||
              JSON.stringify(existing.definition) !== JSON.stringify(definition)
            ) {
              unsupported('One speech span must remain contiguous with stable attributes.');
            }
            existing.to += source.length;
          }
        }
      }
      markdownAt += source.length;
    }
  });

  for (const { definition, from, to } of spansById.values()) {
    const { id: _id, ...attributes } = definition;
    marks.push({ ...attributes, from, to } as ReachDeckSpanSpeechMarkV1);
  }
  if (marks.length === 0) return { markdown };
  const canonicalMarks =
    normalized === undefined
      ? marks
      : marks.map((mark) =>
          mark.type === 'break' || mark.type === 'soundEvent'
            ? { ...mark, at: normalized.offsets[mark.at]! }
            : { ...mark, from: normalized.offsets[mark.from]!, to: normalized.offsets[mark.to]! },
        );
  const speechMarkup = canonicalizeReachDeckSpeechMarkupV1(
    { schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION, marks: canonicalMarks },
    markdown,
  );
  return { markdown, speechMarkup };
}

export function reachDeckSpeechRichTextDefinition(
  mark: ReachDeckSpeechMarkV1,
  id: string,
): ReachDeckSpeechRichTextDefinition {
  const normalizedId = id.trim();
  if (!normalizedId || normalizedId.length > 100) unsupported('Speech mark id is invalid.');
  if (mark.type === 'break')
    return { id: normalizedId, type: 'break', durationMs: mark.durationMs };
  if (mark.type === 'soundEvent') {
    return { id: normalizedId, type: 'soundEvent', src: mark.src };
  }
  if (mark.type === 'sub') return { id: normalizedId, type: 'sub', alias: mark.alias };
  if (mark.type === 'say-as') {
    return { id: normalizedId, type: 'say-as', interpretAs: mark.interpretAs };
  }
  return { id: normalizedId, type: 'phoneme', alphabet: mark.alphabet, ph: mark.ph };
}

function stripSpeechDecorations(document: RichTextDocument): RichTextDocument {
  return {
    type: 'doc',
    ...(document.content === undefined
      ? {}
      : {
          content: document.content.map((block) => {
            if (block.type !== 'paragraph') return stripSpeechMarks(block);
            const content = (block.content ?? [])
              .filter((inline) => !isSpeechPointNodeType(inline.type))
              .map(stripSpeechMarks);
            return {
              ...stripSpeechMarks(block),
              ...(content.length === 0 ? { content: undefined } : { content }),
            };
          }),
        }),
  };
}

function stripSpeechMarks(node: RichTextNode): RichTextNode {
  const marks = (node.marks ?? []).filter(
    (mark) => mark.type !== REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
  );
  const { marks: _marks, ...rest } = node;
  return { ...rest, ...(marks.length === 0 ? {} : { marks }) };
}

function appendPointsInsideText(
  target: RichTextNode[],
  textNode: RichTextNode,
  source: string,
  points: readonly ReachDeckPointSpeechMarkV1[],
  representedPoints: Set<ReachDeckPointSpeechMarkV1>,
  markdownFrom: number,
  markdownTo: number,
  spans: readonly ReachDeckSpanSpeechMarkV1[],
): void {
  if (typeof textNode.text !== 'string') unsupported('Narration text node is invalid.');
  const cutOffsets = new Set<number>([markdownFrom, markdownTo]);
  for (const mark of points) {
    if (mark.at >= markdownFrom && mark.at <= markdownTo) cutOffsets.add(mark.at);
  }
  for (const span of spans) {
    cutOffsets.add(span.from);
    cutOffsets.add(span.to);
  }
  const ordered = [...cutOffsets].sort((left, right) => left - right);
  for (let index = 0; index < ordered.length; index += 1) {
    const at = ordered[index]!;
    for (const mark of points.filter((candidate) => candidate.at === at)) {
      if (representedPoints.has(mark)) continue;
      representedPoints.add(mark);
      target.push(speechPointNode(mark));
    }
    const next = ordered[index + 1];
    if (next === undefined || next === at) continue;
    const visibleFrom = visibleOffsetAt(source, at - markdownFrom);
    const visibleTo = visibleOffsetAt(source, next - markdownFrom);
    const text = textNode.text.slice(visibleFrom, visibleTo);
    if (text.length === 0) continue;
    const selected = spans.find((span) => at >= span.from && next <= span.to);
    target.push({
      type: 'text',
      text,
      ...(selected !== undefined
        ? {
            marks: [
              {
                type: REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
                attrs: {
                  definition: reachDeckSpeechRichTextDefinition(
                    selected,
                    `speech-span-${selected.from}-${selected.to}`,
                  ),
                },
              },
            ],
          }
        : {}),
    });
  }
}

function appendPointsAt(
  target: RichTextNode[],
  points: readonly ReachDeckPointSpeechMarkV1[],
  representedPoints: Set<ReachDeckPointSpeechMarkV1>,
  at: number,
  blockIndex: number,
): void {
  for (const mark of points.filter((candidate) => candidate.at === at)) {
    if (representedPoints.has(mark)) continue;
    representedPoints.add(mark);
    target.push(speechPointNode(mark, blockIndex));
  }
}

function speechPointNode(mark: ReachDeckPointSpeechMarkV1, salt = 0): RichTextNode {
  return {
    type:
      mark.type === 'break'
        ? REACH_DECK_SPEECH_BREAK_NODE_TYPE
        : REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
    attrs: {
      definition: reachDeckSpeechRichTextDefinition(mark, `speech-${mark.type}-${mark.at}-${salt}`),
    },
  };
}

function visibleOffsetAt(source: string, relativeMarkdownOffset: number): number {
  if (relativeMarkdownOffset < 0 || relativeMarkdownOffset > source.length) {
    unsupported('Speech range is outside narration text.');
  }
  let markdownAt = 0;
  let visibleAt = 0;
  while (markdownAt < relativeMarkdownOffset) {
    if (source[markdownAt] === '\\') {
      if (markdownAt + 1 >= relativeMarkdownOffset) {
        unsupported('Speech range splits a Markdown escape.');
      }
      markdownAt += 2;
      visibleAt += 1;
      continue;
    }
    const width = source.codePointAt(markdownAt)! > 0xffff ? 2 : 1;
    if (markdownAt + width > relativeMarkdownOffset) {
      unsupported('Speech range splits a Unicode scalar.');
    }
    markdownAt += width;
    visibleAt += width;
  }
  return visibleAt;
}

function readSpeechDefinition(value: unknown, label: string): ReachDeckSpeechRichTextDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    unsupported(`${label} definition is invalid.`);
  }
  const definition = value as Record<string, unknown>;
  const id = typeof definition.id === 'string' ? definition.id.trim() : '';
  if (!id || id.length > 100) unsupported(`${label} id is invalid.`);
  if (definition.type === 'break') {
    exactDefinitionKeys(definition, ['id', 'type', 'durationMs'], label);
    return reachDeckSpeechRichTextDefinition(
      { type: 'break', at: 0, durationMs: definition.durationMs as number },
      id,
    );
  }
  if (definition.type === 'soundEvent') {
    exactDefinitionKeys(definition, ['id', 'type', 'src'], label);
    return { id, type: 'soundEvent', src: definition.src as string };
  }
  if (definition.type === 'sub') {
    exactDefinitionKeys(definition, ['id', 'type', 'alias'], label);
    return { id, type: 'sub', alias: definition.alias as string };
  }
  if (definition.type === 'say-as') {
    exactDefinitionKeys(definition, ['id', 'type', 'interpretAs'], label);
    return { id, type: 'say-as', interpretAs: definition.interpretAs as never };
  }
  if (definition.type === 'phoneme') {
    exactDefinitionKeys(definition, ['id', 'type', 'alphabet', 'ph'], label);
    return {
      id,
      type: 'phoneme',
      alphabet: definition.alphabet as never,
      ph: definition.ph as string,
    };
  }
  unsupported(`${label} type is invalid.`);
}

function isSpeechPointDefinition(
  definition: ReachDeckSpeechRichTextDefinition,
): definition is Extract<ReachDeckSpeechRichTextDefinition, { type: 'break' | 'soundEvent' }> {
  return definition.type === 'break' || definition.type === 'soundEvent';
}

function isSpeechPointNodeType(type: string): boolean {
  return (
    type === REACH_DECK_SPEECH_BREAK_NODE_TYPE || type === REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE
  );
}

function exactDefinitionKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    unsupported(`${label} attributes are invalid.`);
  }
}

function serializeSingleInline(node: RichTextNode): string {
  return serializeReachDeckNarrationMarkdown({
    type: 'doc',
    content: [{ type: 'paragraph', content: [node] }],
  });
}

function serializeSingleBlock(node: RichTextNode): string {
  return serializeReachDeckNarrationMarkdown({ type: 'doc', content: [node] });
}

function unsupported(message: string): never {
  throw new Error(message);
}
