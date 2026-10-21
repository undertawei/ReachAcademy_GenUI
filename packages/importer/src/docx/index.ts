import type { RichTextDocument, RichTextMark, RichTextNode } from '@reachany/reach-deck-dsl';
import { readPptxPackage } from '../pptx/package/archive.js';
import { parsePptxXml, type PptxXmlElement } from '../pptx/package/xml.js';
import { parsePptxRelationships } from '../pptx/package/relationships.js';
import { parsePptxContentTypes } from '../pptx/package/content-types.js';
import { convertOmmlToLatex } from '../pptx/math/omml.js';
import { resolvePptxParseLimits, type PptxParseLimits } from '../pptx/options.js';
import { convertWordEqFieldToLatex } from './eq-field.js';

export { convertWordEqFieldToLatex } from './eq-field.js';

export interface DocxDiagnostic {
  code: string;
  severity: 'warning' | 'error' | 'fatal';
  message: string;
  blockId?: string;
  count?: number;
  blockIds?: string[];
}

export interface DocxBlock {
  id: string;
  kind: 'paragraph' | 'table';
  /** Rich text, with source media IDs awaiting a host-owned asset binding. */
  content: RichTextDocument;
  /** Plain text with U+FFFC for images/math; offsets refer to this exact string. */
  text: string;
  /** Raw Word numbering label, also prepended to content/text. */
  numbering?: string;
  numberingLevel?: number;
  numberingFormat?: string;
}

export interface DocxMedia {
  id: string;
  partPath: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
  needsConversion: boolean;
}

export interface DocxExtraction {
  sourceDigest: string;
  blocks: DocxBlock[];
  media: DocxMedia[];
  diagnostics: DocxDiagnostic[];
}

export type DocxMediaDescriptor = Omit<DocxMedia, 'bytes'>;

/** Rehydrate verified media from the immutable archive without repeating XML/formula preprocessing. */
export async function restoreDocxMedia(
  bytes: Uint8Array,
  descriptors: readonly DocxMediaDescriptor[],
): Promise<DocxMedia[]> {
  if (descriptors.length > 256) throw new Error('docx.media.limit_exceeded');
  const archive = await readPptxPackage(new Uint8Array(bytes), resolveDocxLimits());
  if (!archive.ok) throw new Error('docx.package.invalid_archive');
  const entries = new Map(archive.entries.map((entry) => [entry.partPath, entry]));
  let total = 0;
  return descriptors.map((descriptor) => {
    const entry = entries.get(descriptor.partPath);
    if (!entry || entry.digest !== `sha256:${descriptor.sha256}`)
      throw new Error('docx.media.checksum_mismatch');
    total += entry.bytes.byteLength;
    if (entry.bytes.byteLength > 20 * 1024 * 1024 || total > 60 * 1024 * 1024)
      throw new Error('docx.media.limit_exceeded');
    return { ...descriptor, bytes: entry.bytes };
  });
}

function resolveDocxLimits(overrides: Partial<PptxParseLimits> = {}): Readonly<PptxParseLimits> {
  return resolvePptxParseLimits({
    maxInputBytes: 25 * 1024 * 1024,
    maxEntryBytes: 32 * 1024 * 1024,
    maxExpandedBytes: 100 * 1024 * 1024,
    maxXmlTextBytes: 8 * 1024 * 1024,
    maxXmlNodes: 250_000,
    maxTotalXmlNodes: 500_000,
    maxMediaAssets: 256,
    maxMediaAssetBytes: 20 * 1024 * 1024,
    maxTotalMediaBytes: 60 * 1024 * 1024,
    ...overrides,
  });
}

export type DocxExtractResult =
  | { ok: true; document: DocxExtraction }
  | { ok: false; diagnostics: DocxDiagnostic[] };

const WORD = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const local = (node: PptxXmlElement): string => node.name.split(':').at(-1)!;
const child = (node: PptxXmlElement, name: string): PptxXmlElement | undefined =>
  node.children.find((item) => local(item) === name);
const attr = (node: PptxXmlElement | undefined, name: string): string | undefined =>
  node && Object.entries(node.attributes).find(([key]) => key.split(':').at(-1) === name)?.[1];
const descendants = (node: PptxXmlElement, name: string): PptxXmlElement[] =>
  node.children.flatMap((item) => [
    ...(local(item) === name ? [item] : []),
    ...descendants(item, name),
  ]);
const nodeText = (node: RichTextNode): string => {
  if (node.type === 'text') return node.text ?? '';
  if (
    node.type === 'image' ||
    node.type === 'inlineMath' ||
    node.type === 'blockMath' ||
    node.type === 'docxUnavailable'
  )
    return '\uFFFC';
  if (node.type === 'hardBreak') return '\n';
  const separator = ['doc', 'table', 'tableRow', 'tableCell'].includes(node.type) ? '\n' : '';
  return (node.content ?? []).map(nodeText).join(separator);
};
const textNode = (text: string, marks: RichTextMark[] = []): RichTextNode => ({
  type: 'text',
  text,
  ...(marks.length ? { marks } : {}),
});

function toRoman(value: number): string | undefined {
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  const numerals: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let remaining = value;
  let result = '';
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

/** Proofreading/bookmark markers carry no math content, but Word may insert them inside OMML. */
function cleanMathAnnotations(node: PptxXmlElement): PptxXmlElement {
  const omitted = (item: PptxXmlElement): boolean =>
    WORD.has(item.namespaceUri ?? '') &&
    ['proofErr', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd'].includes(
      local(item),
    );
  const children = node.children.filter((item) => !omitted(item)).map(cleanMathAnnotations);
  const mapped = new Map(
    node.children.filter((item) => !omitted(item)).map((item, index) => [item, children[index]!]),
  );
  return {
    ...node,
    children,
    content: node.content.flatMap<string | PptxXmlElement>((item) =>
      typeof item === 'string' ? [item] : mapped.has(item) ? [mapped.get(item)!] : [],
    ),
  };
}

/** Pure bounded DOCX extraction. No network, object upload, or question/answer inference. */
export async function extractDocx(
  bytes: Uint8Array,
  options: { limits?: Partial<PptxParseLimits>; maxDiagnostics?: number } = {},
): Promise<DocxExtractResult> {
  const limits = resolveDocxLimits(options.limits);
  // Node Buffer overrides slice(), unlike Uint8Array; zip.js needs the native semantics.
  const archive = await readPptxPackage(new Uint8Array(bytes), limits);
  if (!archive.ok)
    return {
      ok: false,
      diagnostics: archive.diagnostics.map((d) => ({
        code: d.code.replace(/^pptx\./, 'docx.'),
        severity: 'fatal',
        message: d.message.replaceAll('PPTX', 'DOCX'),
      })),
    };
  const entries = new Map(archive.entries.map((entry) => [entry.partPath, entry]));
  const diagnostics: DocxDiagnostic[] = [];
  const maxDiagnostics = options.maxDiagnostics ?? 128;
  if (!Number.isSafeInteger(maxDiagnostics) || maxDiagnostics < 2 || maxDiagnostics > 512)
    return {
      ok: false,
      diagnostics: [
        {
          code: 'docx.diagnostics.invalid_limit',
          severity: 'fatal',
          message: 'Diagnostic limit must be between 2 and 512.',
        },
      ],
    };
  const fail = (code: string, message: string): DocxExtractResult => ({
    ok: false,
    diagnostics: [...diagnostics, { code, severity: 'fatal', message }],
  });
  const budget = { remainingNodes: limits.maxTotalXmlNodes };
  const typesPart = entries.get('/[Content_Types].xml');
  const rootRels = entries.get('/_rels/.rels');
  if (!typesPart || !rootRels)
    return fail('docx.package.missing_parts', 'DOCX package metadata is missing.');
  const types = parsePptxContentTypes(typesPart.bytes, limits, budget);
  const rootRelationships = parsePptxRelationships('/', rootRels.bytes, limits, budget);
  if (!types.ok || !rootRelationships.ok)
    return fail('docx.package.invalid_metadata', 'DOCX package metadata is invalid.');
  const mains = rootRelationships.relationships.filter((rel) => /\/officeDocument$/.test(rel.type));
  const main = mains[0];
  if (mains.length !== 1 || !main || main.targetMode !== 'internal')
    return fail('docx.package.invalid_main', 'DOCX requires one internal main document.');
  if (
    types.contentTypes.overrides[main.target] !==
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  )
    return fail('docx.package.invalid_type', 'Only non-macro DOCX documents are supported.');
  const mainPart = entries.get(main.target);
  if (!mainPart) return fail('docx.package.missing_main', 'DOCX main document is missing.');
  const parsed = parsePptxXml(main.target, mainPart.bytes, limits, budget);
  if (!parsed.ok)
    return fail('docx.xml.invalid_document', 'DOCX document XML is invalid or exceeds limits.');
  if (local(parsed.root) !== 'document' || !WORD.has(parsed.root.namespaceUri ?? ''))
    return fail('docx.xml.invalid_root', 'DOCX main document namespace is invalid.');
  const body = child(parsed.root, 'body');
  if (!body) return fail('docx.xml.missing_body', 'DOCX body is missing.');
  const relationshipPath = main.target.replace(/\/([^/]+)$/, '/_rels/$1.rels');
  const relBytes = entries.get(relationshipPath)?.bytes;
  const parsedRels = relBytes
    ? parsePptxRelationships(main.target, relBytes, limits, budget)
    : undefined;
  if (parsedRels && !parsedRels.ok)
    return fail('docx.relationship.invalid', 'DOCX document relationships are invalid.');
  const rels = new Map(parsedRels?.ok ? parsedRels.relationships.map((rel) => [rel.id, rel]) : []);
  const media: DocxMedia[] = [];
  let totalMedia = 0;
  let blockNumber = 0;
  let currentBlock: string | undefined;
  const diagnosticByCode = new Map<string, DocxDiagnostic>();
  const warn = (code: string, message: string): void => {
    const existing = diagnosticByCode.get(code);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      if (
        currentBlock &&
        !(existing.blockIds ?? []).includes(currentBlock) &&
        (existing.blockIds?.length ?? 0) < 5
      )
        (existing.blockIds ??= []).push(currentBlock);
      return;
    }
    if (diagnostics.length >= maxDiagnostics - 1) {
      const truncated = diagnostics.find((item) => item.code === 'docx.diagnostics.truncated');
      if (truncated) truncated.count = (truncated.count ?? 1) + 1;
      else
        diagnostics.push({
          code: 'docx.diagnostics.truncated',
          severity: 'error',
          message: 'Additional diagnostics were omitted; review the source document.',
          count: 1,
        });
      return;
    }
    const diagnostic: DocxDiagnostic = {
      code,
      severity: 'warning',
      message,
      ...(currentBlock ? { blockId: currentBlock, blockIds: [currentBlock] } : {}),
    };
    diagnostics.push(diagnostic);
    diagnosticByCode.set(code, diagnostic);
  };
  const unavailable = (code: string): RichTextNode[] => {
    const diagnostic = diagnosticByCode.get(code);
    if (diagnostic) diagnostic.severity = 'error';
    return [{ type: 'docxUnavailable', attrs: { reason: code } }];
  };
  const mediaByPart = new Map<string, DocxMedia>();
  const image = (relationshipId: string | undefined, alt: string): RichTextNode[] => {
    const rel = relationshipId ? rels.get(relationshipId) : undefined;
    if (!rel || rel.targetMode !== 'internal' || !/\/image$/.test(rel.type)) {
      warn('docx.image.unavailable', 'An image relationship is missing, external, or unsupported.');
      return unavailable('docx.image.unavailable');
    }
    const entry = entries.get(rel.target);
    if (!entry) {
      warn('docx.image.missing_part', 'An embedded image part is missing.');
      return unavailable('docx.image.missing_part');
    }
    let asset = mediaByPart.get(rel.target);
    if (!asset) {
      const extension = rel.target.split('.').at(-1)!.toLowerCase();
      const mime =
        types.contentTypes.overrides[rel.target] ?? types.contentTypes.defaults[extension] ?? '';
      const raster = [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/tiff',
      ].includes(mime);
      const metafile = ['emf', 'wmf'].includes(extension) && /^image\//.test(mime);
      if (!raster && !metafile) {
        warn('docx.image.unsupported_type', 'An embedded image format is unsupported.');
        return unavailable('docx.image.unsupported_type');
      }
      totalMedia += entry.byteLength;
      if (
        media.length >= limits.maxMediaAssets ||
        entry.byteLength > limits.maxMediaAssetBytes ||
        totalMedia > limits.maxTotalMediaBytes
      ) {
        throw new Error('docx.media.limit_exceeded');
      }
      asset = {
        id: `media-${media.length + 1}`,
        partPath: rel.target,
        contentType: mime,
        bytes: entry.bytes,
        sha256: entry.digest.replace(/^sha256:/, ''),
        needsConversion:
          metafile || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime),
      };
      media.push(asset);
      mediaByPart.set(rel.target, asset);
    }
    return [{ type: 'image', attrs: { sourceMediaId: asset.id, alt } }];
  };

  // Resolve explicit numbering (including restart overrides) without a Word renderer.
  const levels = new Map<string, PptxXmlElement>();
  const numAbstract = new Map<string, string>();
  const starts = new Map<string, number>();
  const counters = new Map<string, number>();
  const numberingRel = [...rels.values()].find((rel) => /\/numbering$/.test(rel.type));
  if (numberingRel) {
    const part =
      numberingRel.targetMode === 'internal' ? entries.get(numberingRel.target) : undefined;
    const result = part ? parsePptxXml(part.partPath, part.bytes, limits, budget) : undefined;
    if (!result?.ok) return fail('docx.numbering.invalid', 'DOCX numbering is missing or invalid.');
    for (const abstract of result.root.children.filter((n) => local(n) === 'abstractNum')) {
      for (const lvl of abstract.children.filter((n) => local(n) === 'lvl'))
        levels.set(`${attr(abstract, 'abstractNumId')}:${attr(lvl, 'ilvl')}`, lvl);
    }
    for (const num of result.root.children.filter((n) => local(n) === 'num')) {
      const numId = attr(num, 'numId')!;
      numAbstract.set(numId, attr(child(num, 'abstractNumId'), 'val') ?? '');
      for (const override of num.children.filter((n) => local(n) === 'lvlOverride')) {
        const level = attr(override, 'ilvl') ?? '0';
        const full = child(override, 'lvl');
        if (full) levels.set(`num-${numId}:${level}`, full);
        const start = Number(attr(child(override, 'startOverride'), 'val'));
        if (Number.isSafeInteger(start) && start >= 0) starts.set(`${numId}:${level}`, start);
      }
    }
  }
  const numbering = (p: PptxXmlElement): { label: string; format: string } | undefined => {
    const properties = child(p, 'pPr');
    const numPr = properties && child(properties, 'numPr');
    if (!numPr) {
      if (properties && child(properties, 'pStyle'))
        warn(
          'docx.style.inherited_numbering',
          'Style-inherited numbering is not resolved; verify paragraph labels.',
        );
      return undefined;
    }
    const numId = attr(child(numPr, 'numId'), 'val') ?? '';
    if (numId === '0') return undefined;
    const ilvl = attr(child(numPr, 'ilvl'), 'val') ?? '0';
    const lvl =
      levels.get(`num-${numId}:${ilvl}`) ?? levels.get(`${numAbstract.get(numId)}:${ilvl}`);
    if (!lvl) {
      warn('docx.numbering.unsupported', 'Paragraph numbering could not be resolved.');
      return undefined;
    }
    const key = `${numId}:${ilvl}`;
    const start = starts.get(key) ?? Number(attr(child(lvl, 'start'), 'val') ?? 1);
    if (!Number.isSafeInteger(start) || start < 0 || start > 1_000_000) {
      warn('docx.numbering.invalid_start', 'Numbering start is outside the supported range.');
      return undefined;
    }
    const next = (counters.get(key) ?? start - 1) + 1;
    counters.set(key, next);
    for (let level = Number(ilvl) + 1; level <= 8; level++) counters.delete(`${numId}:${level}`);
    const format = (value: number, fmt: string): string => {
      if (fmt === 'decimal' || fmt === 'decimalZero')
        return fmt === 'decimalZero' ? String(value).padStart(2, '0') : String(value);
      if (fmt === 'lowerLetter' || fmt === 'upperLetter') {
        let result = '';
        let remaining = value;
        while (remaining > 0 && result.length < 8) {
          remaining--;
          result = String.fromCharCode(65 + (remaining % 26)) + result;
          remaining = Math.floor(remaining / 26);
        }
        return fmt === 'lowerLetter' ? result.toLowerCase() : result;
      }
      if (fmt === 'lowerRoman' || fmt === 'upperRoman') {
        const result = toRoman(value);
        if (result) return fmt === 'lowerRoman' ? result.toLowerCase() : result;
      }
      warn('docx.numbering.unsupported_format', 'A numbering format was retained as decimal.');
      return String(value);
    };
    return {
      label: (attr(child(lvl, 'lvlText'), 'val') ?? '%1.').replace(
        /%([1-9])/g,
        (_, digit: string) => {
          const level = String(Number(digit) - 1);
          const definition =
            levels.get(`num-${numId}:${level}`) ?? levels.get(`${numAbstract.get(numId)}:${level}`);
          return format(
            counters.get(`${numId}:${level}`) ?? 1,
            attr(definition && child(definition, 'numFmt'), 'val') ?? 'decimal',
          );
        },
      ),
      format: attr(child(lvl, 'numFmt'), 'val') ?? 'decimal',
    };
  };
  const runMarks = (r: PptxXmlElement): RichTextMark[] => {
    const properties = child(r, 'rPr');
    if (!properties) return [];
    const marks: RichTextMark[] = [];
    for (const [word, type] of [
      ['b', 'bold'],
      ['i', 'italic'],
      ['u', 'underline'],
      ['strike', 'strike'],
    ] as const) {
      const property = child(properties, word);
      if (property && !['0', 'false', 'off', 'none'].includes(attr(property, 'val') ?? ''))
        marks.push({ type });
    }
    const vert = attr(child(properties, 'vertAlign'), 'val');
    if (vert === 'superscript' || vert === 'subscript') marks.push({ type: vert });
    const color = attr(child(properties, 'color'), 'val');
    if (color && /^[a-f0-9]{6}$/i.test(color))
      marks.push({ type: 'textStyle', attrs: { color: `#${color}` } });
    if (child(properties, 'rStyle'))
      warn('docx.style.inherited_marks', 'Style-inherited character formatting requires review.');
    return marks;
  };
  const inline = (element: PptxXmlElement, marks: RichTextMark[] = []): RichTextNode[] => {
    const name = local(element);
    if (name === 't') return element.text ? [textNode(element.text, marks)] : [];
    if (name === 'tab') return [textNode('\t', marks)];
    if (name === 'br' || name === 'cr') return [{ type: 'hardBreak' }];
    if (name === 'noBreakHyphen') return [textNode('\u2011', marks)];
    if (name === 'softHyphen') return [textNode('\u00ad', marks)];
    if (name === 'r') return element.children.flatMap((n) => inline(n, runMarks(element)));
    if (name === 'fldSimple') {
      const fieldCode = attr(element, 'instr') ?? '';
      const converted = convertWordEqFieldToLatex(fieldCode);
      if (converted)
        return [
          {
            type: converted.display ? 'blockMath' : 'inlineMath',
            attrs: { latex: converted.latex },
          },
        ];
      warn(
        /^\s*eq(?:\s|\\|$)/i.test(fieldCode)
          ? 'docx.field.eq_unsupported'
          : 'docx.field.cached_only',
        /^\s*eq(?:\s|\\|$)/i.test(fieldCode)
          ? 'A legacy Word EQ field cannot be converted; its cached display text was retained.'
          : 'A Word field uses its cached display text.',
      );
      return element.children.flatMap((n) => inline(n, marks));
    }
    if (name === 'oMath' || name === 'oMathPara') {
      const math = convertOmmlToLatex(cleanMathAnnotations(element));
      if (!math) {
        warn('docx.math.unsupported', 'A formula cannot be converted; correction is required.');
        return unavailable('docx.math.unsupported');
      }
      return [{ type: math.display ? 'blockMath' : 'inlineMath', attrs: { latex: math.latex } }];
    }
    if (name === 'drawing') {
      const blips = descendants(element, 'blip');
      if (!blips.length) {
        warn('docx.drawing.unsupported', 'A non-image drawing cannot be imported.');
        return unavailable('docx.drawing.unsupported');
      }
      const description = descendants(element, 'docPr')[0];
      return blips.flatMap((blip) =>
        image(attr(blip, 'embed') ?? attr(blip, 'link'), attr(description, 'descr') ?? ''),
      );
    }
    if (name === 'pict') {
      const previews = descendants(element, 'imagedata');
      if (!previews.length) {
        warn('docx.drawing.unsupported', 'A VML drawing has no image fallback.');
        return unavailable('docx.drawing.unsupported');
      }
      return previews.flatMap((preview) =>
        image(attr(preview, 'id'), attr(preview, 'title') ?? ''),
      );
    }
    if (name === 'object') {
      const preview = descendants(element, 'imagedata')[0];
      if (!preview) {
        warn('docx.ole.missing_preview', 'An embedded object has no preview image.');
        return unavailable('docx.ole.missing_preview');
      }
      warn('docx.ole.preview_only', 'An embedded object is represented by its preview image only.');
      return image(attr(preview, 'id'), '');
    }
    if (name === 'AlternateContent') {
      const choice = child(element, 'Choice');
      const fallback = child(element, 'Fallback');
      const supported =
        choice && (descendants(choice, 'drawing').length || descendants(choice, 'oMath').length);
      const selected = supported ? choice : fallback;
      if (!selected) {
        warn('docx.compatibility.unsupported', 'Alternate content has no supported fallback.');
        return unavailable('docx.compatibility.unsupported');
      }
      return selected.children.flatMap((n) => inline(n, marks));
    }
    if (name === 'del' || name === 'moveFrom') {
      warn('docx.revision.omitted', 'Deleted or moved-from revision content was omitted.');
      return [];
    }
    if (name === 'instrText' || name === 'fldChar') {
      if (name === 'instrText')
        warn('docx.field.cached_only', 'A Word field uses its cached display text.');
      return [];
    }
    if (name === 'footnoteReference' || name === 'endnoteReference' || name === 'sym') {
      warn('docx.inline.unsupported', 'A footnote, endnote, or symbol requires correction.');
      return unavailable('docx.inline.unsupported');
    }
    if (
      name.endsWith('Pr') ||
      [
        'bookmarkStart',
        'bookmarkEnd',
        'proofErr',
        'lastRenderedPageBreak',
        'sectPr',
        'commentRangeStart',
        'commentRangeEnd',
        'commentReference',
      ].includes(name)
    )
      return [];
    if (
      element.children.length === 0 &&
      !['hyperlink', 'smartTag', 'sdtContent', 'ins', 'moveTo'].includes(name)
    )
      warn('docx.inline.unsupported', 'An unsupported inline element was omitted.');
    return element.children.flatMap((n) => inline(n, marks));
  };
  const fieldCharType = (element: PptxXmlElement): string | undefined => {
    const fieldChar =
      (local(element) === 'fldChar' ? element : undefined) ?? descendants(element, 'fldChar')[0];
    return attr(fieldChar, 'fldCharType');
  };
  const inlineSequence = (elements: readonly PptxXmlElement[]): RichTextNode[] => {
    const result: RichTextNode[] = [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]!;
      if (fieldCharType(element) !== 'begin') {
        result.push(...inline(element));
        continue;
      }
      let depth = 1;
      let separator = -1;
      let end = -1;
      for (let cursor = index + 1; cursor < elements.length; cursor++) {
        const type = fieldCharType(elements[cursor]!);
        if (type === 'begin') depth++;
        else if (type === 'end' && --depth === 0) {
          end = cursor;
          break;
        } else if (type === 'separate' && depth === 1 && separator < 0) separator = cursor;
      }
      if (end < 0) {
        warn('docx.field.malformed', 'A Word field is missing its closing marker.');
        result.push(...inline(element));
        continue;
      }
      const instructionEnd = separator < 0 ? end : separator;
      const fieldCode = elements
        .slice(index + 1, instructionEnd)
        .flatMap((node) => descendants(node, 'instrText'))
        .map((node) => node.text)
        .join('');
      const cached = separator < 0 ? [] : elements.slice(separator + 1, end);
      const converted = convertWordEqFieldToLatex(fieldCode);
      if (converted) {
        result.push({
          type: converted.display ? 'blockMath' : 'inlineMath',
          attrs: { latex: converted.latex },
        });
      } else {
        const isEq = /^\s*eq(?:\s|\\|$)/i.test(fieldCode);
        warn(
          isEq ? 'docx.field.eq_unsupported' : 'docx.field.cached_only',
          isEq
            ? 'A legacy Word EQ field cannot be converted; its cached display text was retained.'
            : 'A Word field uses its cached display text.',
        );
        if (cached.length) result.push(...inlineSequence(cached));
        else if (isEq) result.push(...unavailable('docx.field.eq_unsupported'));
      }
      index = end;
    }
    return result;
  };
  const paragraph = (
    p: PptxXmlElement,
  ): { node: RichTextNode; label?: string; format?: string } => {
    const numbered = numbering(p);
    const label = numbered?.label;
    const content = inlineSequence(p.children);
    if (label) content.unshift(textNode(`${label} `));
    return {
      node: { type: 'paragraph', content },
      ...(label ? { label, format: numbered.format } : {}),
    };
  };
  const table = (t: PptxXmlElement): RichTextNode => ({
    type: 'table',
    content: t.children
      .filter((n) => local(n) === 'tr')
      .map((row) => ({
        type: 'tableRow',
        content: row.children
          .filter((n) => local(n) === 'tc')
          .map((cell) => {
            const properties = child(cell, 'tcPr');
            const span = Number(attr(properties && child(properties, 'gridSpan'), 'val') ?? 1);
            if (properties && child(properties, 'vMerge'))
              warn(
                'docx.table.vertical_merge',
                'Vertically merged cells are retained separately for correction.',
              );
            return {
              type: 'tableCell',
              attrs: { colspan: Number.isSafeInteger(span) && span > 0 && span <= 100 ? span : 1 },
              content: cell.children.flatMap((n) =>
                local(n) === 'p' ? [paragraph(n).node] : local(n) === 'tbl' ? [table(n)] : [],
              ),
            };
          }),
      })),
  });
  const blocks: DocxBlock[] = [];
  const visit = (node: PptxXmlElement): void => {
    const name = local(node);
    if (name === 'p' || name === 'tbl') {
      currentBlock = `block-${++blockNumber}`;
      const p = name === 'p' ? paragraph(node) : undefined;
      const properties = child(node, 'pPr');
      const numProperties = properties && child(properties, 'numPr');
      const numberingLevel = Number(
        attr(numProperties && child(numProperties, 'ilvl'), 'val') ?? 0,
      );
      const content: RichTextDocument = { type: 'doc', content: [p?.node ?? table(node)] };
      blocks.push({
        id: currentBlock,
        kind: name === 'p' ? 'paragraph' : 'table',
        content,
        text: nodeText(content),
        ...(p?.label ? { numbering: p.label } : {}),
        ...(p?.format ? { numberingFormat: p.format } : {}),
        ...(p?.label &&
        Number.isInteger(numberingLevel) &&
        numberingLevel >= 0 &&
        numberingLevel <= 8
          ? { numberingLevel }
          : {}),
      });
    } else if (name === 'sdt' || name === 'sdtContent' || name === 'customXml')
      node.children.forEach(visit);
    else if (name !== 'sectPr' && name !== 'sdtPr') {
      currentBlock = undefined;
      warn('docx.block.unsupported', 'A document block was not imported.');
    }
  };
  try {
    body.children.forEach(visit);
  } catch (error) {
    if (error instanceof Error && error.message === 'docx.media.limit_exceeded')
      return fail(error.message, 'DOCX media exceeds configured limits.');
    throw error;
  }
  return { ok: true, document: { sourceDigest: archive.sourceDigest, blocks, media, diagnostics } };
}
