import { Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import {
  REACH_DECK_SPEECH_BREAK_NODE_TYPE,
  REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
  REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
  canonicalizeReachDeckSpeechMarkupV1,
  serializeReachDeckNarrationSpeechDocument,
  serializeReachDeckNarrationMarkdown,
  parseReachDeckNarrationMarkdown,
  type ReachDeckSpeechMarkV1,
  type ReachDeckSpeechRichTextDefinition,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';

export const NARRATION_CLIPBOARD_MIME = 'application/x-reachany-narration-fragment';
export const NARRATION_CLIPBOARD_ATTRIBUTE = 'data-reach-narration-fragment';
const VERSION = 'reach-narration-fragment/v1';
const MAX_BYTES = 100_000;
const MAX_HTML_BYTES = MAX_BYTES * 12 + 1_024;
const MAX_NODES = 10_000;
const MAX_MARKS = 1_000;
const TYPES = ['break', 'soundEvent', 'sub', 'say-as', 'phoneme'] as const;
export const NARRATION_SSML_LIKE = /<\s*(?:break|soundEvent|sub|say-as|phoneme|speak)\b/u;
let idSequence = 0;

export function escapeNarrationXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error('Invalid narration clipboard fields.');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid narration clipboard object.');
  return value as Record<string, unknown>;
}

function bounded(value: string, maximum = MAX_BYTES) {
  if (value.length > maximum || new TextEncoder().encode(value).length > maximum)
    throw new Error('Narration clipboard exceeds byte limit.');
}

function freshId() {
  return `paste-${Date.now().toString(36)}-${++idSequence}`;
}

/** Validate every JSON field before creating ProseMirror nodes. Never accept foreign editor IDs. */
function validatedDocument(value: unknown): RichTextDocument {
  let nodes = 0;
  let marks = 0;
  const ids = new Map<string, string>();
  const definition = (raw: unknown) => {
    if (++marks > MAX_MARKS) throw new Error('Too many speech marks.');
    const input = record(raw);
    const fields: Record<string, string[]> = {
      break: ['durationMs'],
      soundEvent: ['src'],
      sub: ['alias'],
      'say-as': ['interpretAs'],
      phoneme: ['alphabet', 'ph'],
    };
    if (typeof input.type !== 'string' || !TYPES.includes(input.type as never))
      throw new Error('Unsupported speech mark.');
    exactKeys(input, ['id', 'type', ...fields[input.type]!]);
    if (typeof input.id !== 'string' || !input.id || input.id.length > 100)
      throw new Error('Invalid speech ID.');
    let id = ids.get(input.id);
    if (!id) {
      id = freshId();
      ids.set(input.id, id);
    }
    return { ...input, id };
  };
  const visit = (raw: unknown, depth: number): RichTextNode => {
    if (++nodes > MAX_NODES || depth > 4)
      throw new Error('Narration clipboard exceeds structure limit.');
    const node = record(raw);
    if (node.type === 'doc' || node.type === 'paragraph') {
      exactKeys(node, ['type'], ['content']);
      if (node.content !== undefined && !Array.isArray(node.content))
        throw new Error('Invalid content.');
      const content = (node.content as unknown[] | undefined)?.map((child) =>
        visit(child, depth + 1),
      );
      if (
        content?.some((child) =>
          node.type === 'doc'
            ? !['paragraph', 'blockMath'].includes(child.type)
            : ['doc', 'paragraph', 'blockMath'].includes(child.type),
        )
      )
        throw new Error('Invalid nesting.');
      return { type: node.type, ...(content === undefined ? {} : { content }) };
    }
    if (node.type === 'text') {
      exactKeys(node, ['type', 'text'], ['marks']);
      if (typeof node.text !== 'string' || !node.text) throw new Error('Invalid text.');
      if (node.marks === undefined) return { type: 'text', text: node.text };
      if (!Array.isArray(node.marks) || node.marks.length !== 1) throw new Error('Invalid marks.');
      const mark = record(node.marks[0]);
      exactKeys(mark, ['type', 'attrs']);
      if (mark.type !== REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE)
        throw new Error('Invalid mark type.');
      const attrs = record(mark.attrs);
      exactKeys(attrs, ['definition']);
      return {
        type: 'text',
        text: node.text,
        marks: [{ type: mark.type, attrs: { definition: definition(attrs.definition) } }],
      };
    }
    if (node.type === 'hardBreak') {
      exactKeys(node, ['type']);
      return { type: 'hardBreak' };
    }
    if (node.type === 'inlineMath' || node.type === 'blockMath') {
      exactKeys(node, ['type', 'attrs']);
      const attrs = record(node.attrs);
      exactKeys(attrs, ['latex']);
      if (typeof attrs.latex !== 'string') throw new Error('Invalid formula.');
      return { type: node.type, attrs: { latex: attrs.latex } };
    }
    if (
      node.type === REACH_DECK_SPEECH_BREAK_NODE_TYPE ||
      node.type === REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE
    ) {
      exactKeys(node, ['type', 'attrs']);
      const attrs = record(node.attrs);
      exactKeys(attrs, ['definition']);
      return { type: node.type, attrs: { definition: definition(attrs.definition) } };
    }
    throw new Error('Unsupported narration node.');
  };
  const doc = visit(value, 0);
  if (doc.type !== 'doc') throw new Error('Missing narration document.');
  // An explicit point selection has no spoken text. Pad only the validation copy, never the paste.
  const validation = structuredClone(doc) as RichTextDocument;
  if (!validation.content?.length) throw new Error('Empty fragment.');
  const first = validation.content[0]!;
  if (first.type === 'paragraph')
    first.content = [{ type: 'text', text: 'X' }, ...(first.content ?? [])];
  serializeReachDeckNarrationSpeechDocument(validation, { canonicalize: true });
  return doc as RichTextDocument;
}

function point(definition: ReachDeckSpeechRichTextDefinition): string {
  return definition.type === 'break'
    ? `<break time="${definition.durationMs}ms"/>`
    : definition.type === 'soundEvent'
      ? `<soundEvent src="${escapeNarrationXml(definition.src)}"/>`
      : '';
}
function span(text: string, definition: ReachDeckSpeechRichTextDefinition): string {
  const content = escapeNarrationXml(text);
  if (definition.type === 'sub')
    return `<sub alias="${escapeNarrationXml(definition.alias)}">${content}</sub>`;
  if (definition.type === 'say-as')
    return `<say-as interpret-as="${escapeNarrationXml(definition.interpretAs)}">${content}</say-as>`;
  if (definition.type === 'phoneme')
    return `<phoneme alphabet="${definition.alphabet}" ph="${escapeNarrationXml(definition.ph)}">${content}</phoneme>`;
  return content;
}

function plainText(doc: RichTextDocument): string {
  const marked = JSON.stringify(doc).includes('"definition"');
  const inline = (node: RichTextNode): string => {
    if (node.type === 'text') {
      const definition = node.marks?.[0]?.attrs?.definition as
        | ReachDeckSpeechRichTextDefinition
        | undefined;
      return definition
        ? span(node.text ?? '', definition)
        : marked
          ? escapeNarrationXml(node.text ?? '')
          : (node.text ?? '');
    }
    if (node.type === 'hardBreak') return marked ? '&#10;' : '\n';
    if (node.type === 'inlineMath') return `\\(${node.attrs?.latex as string}\\)`;
    return point(node.attrs?.definition as ReachDeckSpeechRichTextDefinition);
  };
  return (doc.content ?? [])
    .map((block) =>
      block.type === 'blockMath'
        ? `\\[${block.attrs?.latex as string}\\]`
        : (block.content ?? []).map(inline).join(''),
    )
    .join('\n\n');
}

/** PM selection boundaries determine point inclusion; semantic spans require complete coverage. */
export function writeNarrationClipboard(
  state: EditorState,
  clipboard: Pick<DataTransfer, 'setData'>,
): boolean {
  if (state.selection.empty) return false;
  try {
    return writePortableNarrationClipboard(state, clipboard);
  } catch {
    // Never turn a failed rich copy into an empty clipboard. This source-text projection is
    // independent of mark validation and includes formulas even when their draft is incomplete.
    const plain = state.doc.textBetween(
      state.selection.from,
      state.selection.to,
      '\n\n',
      (node) => {
        if (node.type.name === 'hardBreak') return '\n';
        if (node.type.name === 'inlineMath') return `\\(${String(node.attrs.latex ?? '')}\\)`;
        if (node.type.name === 'blockMath') return `\\[${String(node.attrs.latex ?? '')}\\]`;
        return '';
      },
    );
    if (plain.length === 0) throw new Error('The selection has no safe plain-text fallback.');
    clipboard.setData('text/plain', plain);
    try {
      clipboard.setData('text/html', '');
      clipboard.setData(NARRATION_CLIPBOARD_MIME, '');
    } catch {
      /* Plain text was successfully written. */
    }
    return true;
  }
}

function writePortableNarrationClipboard(
  state: EditorState,
  clipboard: Pick<DataTransfer, 'setData'>,
): boolean {
  const ranges = new Map<string, { from: number; to: number }>();
  state.doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (mark.type.name !== REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE) continue;
      const id = mark.attrs.definition.id as string;
      const old = ranges.get(id);
      ranges.set(id, { from: old?.from ?? pos, to: pos + node.nodeSize });
    }
  });
  const slice = state.selection.content();
  const clean = (node: ProseMirrorNode): RichTextNode => {
    const json = node.toJSON() as RichTextNode;
    if (node.isText) {
      const definition = json.marks?.[0]?.attrs?.definition as
        | ReachDeckSpeechRichTextDefinition
        | undefined;
      const range = definition ? ranges.get(definition.id) : undefined;
      if (range && (state.selection.from > range.from || state.selection.to < range.to))
        delete json.marks;
    }
    if (node.content.size) {
      const content: RichTextNode[] = [];
      node.forEach((child) => content.push(clean(child)));
      json.content = content;
    }
    // Shared text extensions add default paragraph attributes that are not narration content.
    if (node.type.name === 'paragraph' || node.type.name === 'hardBreak') delete json.attrs;
    if (node.type.name === 'inlineMath' || node.type.name === 'blockMath')
      json.attrs = { latex: node.attrs.latex };
    return json;
  };
  let content: RichTextNode[] = [];
  slice.content.forEach((node) => content.push(clean(node)));
  const inlineSelection = content.every((node) => !['paragraph', 'blockMath'].includes(node.type));
  if (inlineSelection) content = [{ type: 'paragraph', content }];
  const doc = validatedDocument({ type: 'doc', content });
  const payload = JSON.stringify({
    version: VERSION,
    doc,
    openStart: inlineSelection ? 1 : Math.min(slice.openStart, 1),
    openEnd: inlineSelection ? 1 : Math.min(slice.openEnd, 1),
  });
  bounded(payload);
  const plain = plainText(doc);
  clipboard.setData('text/plain', plain);
  clipboard.setData(
    'text/html',
    `<div ${NARRATION_CLIPBOARD_ATTRIBUTE}="${escapeNarrationXml(payload)}">${escapeNarrationXml(plain).replace(/\n/g, '<br>')}</div>`,
  );
  try {
    clipboard.setData(NARRATION_CLIPBOARD_MIME, payload);
  } catch {
    /* HTML is the portable transport. */
  }
  return true;
}

export function readNarrationClipboard(
  clipboard: Pick<DataTransfer, 'getData'>,
  schema: Schema,
  allowed: readonly ReachDeckSpeechMarkV1['type'][],
): { slice: Slice; fallback: boolean } | undefined {
  let payload = '';
  try {
    payload = clipboard.getData(NARRATION_CLIPBOARD_MIME);
  } catch {
    /* Optional MIME. */
  }
  if (!payload) {
    const html = clipboard.getData('text/html');
    if (!html.includes(NARRATION_CLIPBOARD_ATTRIBUTE)) return undefined;
    // Both the JSON attribute and visible body may expand sixfold under XML escaping.
    bounded(html, MAX_HTML_BYTES);
    const document = new DOMParser().parseFromString(html, 'text/html');
    const carriers = document.querySelectorAll(`[${NARRATION_CLIPBOARD_ATTRIBUTE}]`);
    if (carriers.length !== 1) throw new Error('Ambiguous narration fragment.');
    payload = carriers[0]!.getAttribute(NARRATION_CLIPBOARD_ATTRIBUTE) ?? '';
  }
  bounded(payload);
  const parsed = record(JSON.parse(payload));
  exactKeys(parsed, ['version', 'doc', 'openStart', 'openEnd']);
  if (
    parsed.version !== VERSION ||
    ![0, 1].includes(parsed.openStart as number) ||
    ![0, 1].includes(parsed.openEnd as number)
  )
    throw new Error('Unsupported narration fragment.');
  const doc = validatedDocument(parsed.doc);
  let fallback = false;
  const filter = (node: RichTextNode): RichTextNode => {
    const def = (node.attrs?.definition ?? node.marks?.[0]?.attrs?.definition) as
      | ReachDeckSpeechRichTextDefinition
      | undefined;
    if (def && !allowed.includes(def.type)) {
      fallback = true;
      if (node.type !== 'text') return { type: 'text', text: point(def) };
      const { marks: _marks, ...rest } = node;
      return rest;
    }
    return { ...node, ...(node.content ? { content: node.content.map(filter) } : {}) };
  };
  const node = schema.nodeFromJSON(filter(doc));
  if (
    (parsed.openStart === 1 && node.firstChild?.type.name !== 'paragraph') ||
    (parsed.openEnd === 1 && node.lastChild?.type.name !== 'paragraph')
  )
    throw new Error('Invalid fragment edge.');
  return {
    slice: new Slice(node.content, parsed.openStart as number, parsed.openEnd as number),
    fallback,
  };
}

/** Parse one flat SSML token. XML is never inserted as DOM or executed. */
export function narrationSsmlNodes(
  source: string,
  schema: Schema,
  allowed: readonly ReachDeckSpeechMarkV1['type'][],
): { nodes: ProseMirrorNode[]; converted: number; fallback: boolean } {
  bounded(source);
  // A root wrapper adds no fragment settings. Root attributes deliberately remain literal.
  source = source.replace(/^<speak\s*>([\s\S]*)<\/speak\s*>$/u, '$1');
  const nodes: ProseMirrorNode[] = [];
  let converted = 0;
  let fallback = false;
  let offset = 0;
  const append = (text: string, formulas = false) => {
    if (!text) return;
    if (formulas && text.includes('\n')) {
      text.split('\n').forEach((line, index) => {
        if (index > 0) nodes.push(schema.nodes.hardBreak!.create());
        append(line, formulas);
      });
      return;
    }
    if (formulas && text.includes('\\(')) {
      try {
        const parsed = parseReachDeckNarrationMarkdown(text);
        if (parsed.content?.length === 1 && parsed.content[0]?.type === 'paragraph') {
          for (const child of parsed.content[0].content ?? [])
            nodes.push(schema.nodeFromJSON(child));
          return;
        }
      } catch {
        /* Malformed external formulas remain visible text. */
      }
    }
    nodes.push(schema.text(text));
  };
  // Scan tags once, grouping outer pairs so nested supported tags cannot escape their wrapper.
  // Unlike a lazy paired-tag regexp this remains linear for thousands of unmatched openings.
  const candidates = scanSsmlCandidates(source);
  if (candidates === undefined)
    return { nodes: [schema.text(source)], converted: 0, fallback: true };
  for (const match of candidates) {
    const before = source.slice(offset, match.index);
    if (/<\/?[A-Za-z]/u.test(before)) fallback = true;
    append(decodeXmlText(before), true);
    offset = match.index + match.text.length;
    try {
      const token = match.text.replace(/^<break\s+(\d{1,5})ms\s*\/>$/u, '<break time="$1ms"/>');
      if (/<[^>]*[<]/u.test(token)) throw new Error('Nested tag.');
      const document = new DOMParser().parseFromString(`<root>${token}</root>`, 'application/xml');
      if (document.querySelector('parsererror') || document.documentElement.childNodes.length !== 1)
        throw new Error('Malformed SSML.');
      const element = document.documentElement.firstElementChild;
      if (!element || element.children.length > 0) throw new Error('Nested SSML.');
      const type = element.tagName as ReachDeckSpeechMarkV1['type'];
      if (!allowed.includes(type)) throw new Error('Disallowed speech mark.');
      const attrs = Object.fromEntries(
        Array.from(element.attributes).map((attr) => [attr.name, attr.value]),
      );
      const content = element.textContent ?? '';
      let mark: ReachDeckSpeechMarkV1;
      if (type === 'break') {
        exactKeys(attrs, ['time']);
        if (content || !/^\d+(?:\.\d{1,3})?(?:ms|s)$/u.test(attrs.time!))
          throw new Error('Invalid pause.');
        mark = {
          type,
          at: 0,
          durationMs: Number.parseFloat(attrs.time!) * (attrs.time!.endsWith('ms') ? 1 : 1000),
        };
      } else if (type === 'soundEvent') {
        exactKeys(attrs, ['src']);
        if (content) throw new Error('Invalid sound.');
        mark = { type, at: 0, src: attrs.src! };
      } else {
        const markdown = serializeReachDeckNarrationMarkdown({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }],
        });
        const range = { from: 0, to: markdown.length };
        if (type === 'sub') {
          exactKeys(attrs, ['alias']);
          mark = { type, ...range, alias: attrs.alias! };
        } else if (type === 'say-as') {
          exactKeys(attrs, ['interpret-as']);
          mark = { type, ...range, interpretAs: attrs['interpret-as'] as never };
        } else {
          exactKeys(attrs, ['alphabet', 'ph']);
          mark = { type: 'phoneme', ...range, alphabet: attrs.alphabet as never, ph: attrs.ph! };
        }
      }
      const markdown = content
        ? serializeReachDeckNarrationMarkdown({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }],
          })
        : 'X';
      canonicalizeReachDeckSpeechMarkupV1(
        { schemaVersion: 'reach-deck-speech-marks/v1', marks: [mark] },
        markdown,
      );
      const {
        at: _at,
        from: _from,
        to: _to,
        ...attributes
      } = mark as ReachDeckSpeechMarkV1 & { at?: number; from?: number; to?: number };
      const definition = { ...attributes, id: freshId() };
      if (type === 'break' || type === 'soundEvent')
        nodes.push(
          schema.nodes[
            type === 'break'
              ? REACH_DECK_SPEECH_BREAK_NODE_TYPE
              : REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE
          ]!.create({ definition }),
        );
      else
        nodes.push(
          schema.text(content, [
            schema.marks[REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE]!.create({ definition }),
          ]),
        );
      converted += 1;
    } catch {
      append(match.text);
      fallback = true;
    }
  }
  const rest = source.slice(offset);
  append(decodeXmlText(rest), true);
  if (NARRATION_SSML_LIKE.test(rest) || /<\/?[A-Za-z]/u.test(rest)) fallback = true;
  return { nodes, converted, fallback };
}

function scanSsmlCandidates(source: string): Array<{ index: number; text: string }> | undefined {
  const result: Array<{ index: number; text: string }> = [];
  let start = -1;
  let depth = 0;
  let count = 0;
  let previousEnd = 0;
  for (const match of source.matchAll(/<[^<>]*>/gu)) {
    if (++count > MAX_MARKS * 4) return undefined;
    // An unfinished tag opening must not expose an inner token, while literal comparisons
    // such as "1 < 2" are ordinary narration and do not disable later valid speech marks.
    if (/<\/?\s*[A-Za-z!?]/u.test(source.slice(previousEnd, match.index))) return undefined;
    previousEnd = match.index + match[0].length;
    const token = match[0];
    if (!/^<\/?\s*[A-Za-z]/u.test(token)) continue;
    const closing = /^<\//u.test(token);
    const selfClosing = /\/\s*>$/u.test(token);
    if (depth === 0) {
      if (closing) continue;
      start = match.index;
      if (!selfClosing) {
        depth = 1;
        continue;
      }
    } else {
      if (closing) depth -= 1;
      else if (!selfClosing) depth += 1;
      if (depth !== 0) continue;
    }
    result.push({ index: start, text: source.slice(start, match.index + token.length) });
    if (result.length > MAX_MARKS) return undefined;
    start = -1;
  }
  // An unmatched outer tag, including all its nested tokens, remains literal.
  return result;
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#10);/gu,
    (entity) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#10;': '\n' })[
        entity
      ]!,
  );
}
