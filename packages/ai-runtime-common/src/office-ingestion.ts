import ExcelJS from 'exceljs';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { parseFragment } from 'parse5';
import { posix } from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export interface PreparedOfficeImage {
  readonly data: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly description: string;
}

export type PreparedDocxBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: PreparedOfficeImage };

export interface PreparedDocx {
  readonly kind: 'docx';
  readonly blocks: readonly PreparedDocxBlock[];
  readonly warnings: readonly string[];
}

export interface PreparedXlsx {
  readonly kind: 'xlsx';
  readonly text: string;
  readonly visibleSheetCount: number;
  readonly cellCount: number;
}

export interface PreparedPresentationSlide {
  /** 1-based index among visible slides exposed to the model. */
  readonly slideNumber: number;
  /** Original 1-based position in the OOXML presentation, used by the renderer. */
  readonly sourceSlideNumber: number;
  readonly text: string;
  readonly blocks?: readonly PreparedDocxBlock[];
  readonly warnings?: readonly string[];
}

export interface PreparedPptx {
  readonly kind: 'pptx';
  readonly bytes: Uint8Array;
  readonly slides: readonly PreparedPresentationSlide[];
  readonly hiddenSlideCount: number;
}

export type PreparedOfficeDocument = PreparedDocx | PreparedXlsx | PreparedPptx;

export class OfficeIngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MIB = 1024 * 1024;
const ZIP_MAX_ENTRIES = 2_048;
const ZIP_MAX_ENTRY_BYTES = 32 * MIB;
const ZIP_MAX_EXPANDED_BYTES = 64 * MIB;
const ZIP_MAX_XML_BYTES = 8 * MIB;
const ZIP_MAX_COMPRESSION_RATIO = 100;
const XLSX_MAX_VISIBLE_CELLS = 50_000;
const OFFICE_IMAGE_MAX_BYTES = 15 * MIB;

const OFFICE_MIME_TYPES: Record<OfficeKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const OFFICE_EXTENSIONS: Record<OfficeKind, string> = {
  docx: '.docx',
  xlsx: '.xlsx',
  pptx: '.pptx',
};

const OFFICE_MAIN_PARTS: Record<OfficeKind, { path: string; contentType: string }> = {
  docx: {
    path: 'word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  xlsx: {
    path: 'xl/workbook.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
  pptx: {
    path: 'ppt/presentation.xml',
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
};

export function officeKindForMetadata(
  contentType: string,
  extension: string,
): OfficeKind | undefined {
  const byMime = (Object.keys(OFFICE_MIME_TYPES) as OfficeKind[]).find(
    (kind) => OFFICE_MIME_TYPES[kind] === contentType,
  );
  const byExtension = (Object.keys(OFFICE_EXTENSIONS) as OfficeKind[]).find(
    (kind) => OFFICE_EXTENSIONS[kind] === extension,
  );
  if (byMime === undefined && byExtension === undefined) return undefined;
  if (byMime === undefined || byExtension === undefined || byMime !== byExtension) {
    throw new OfficeIngestionError('metadata_mismatch', 'Office MIME 与文件扩展名不匹配');
  }
  return byMime;
}

export async function prepareOfficeDocument(
  bytes: Uint8Array,
  kind: OfficeKind,
  options: { extractPresentationImages?: boolean } = {},
): Promise<PreparedOfficeDocument> {
  const mediaSizes = options.extractPresentationImages ? new Map<string, number>() : undefined;
  const entries = await preflightOoxml(bytes, kind, mediaSizes);
  if (kind === 'docx') return extractDocx(await removeHiddenDocxRuns(bytes, entries));
  if (kind === 'xlsx') return extractXlsx(bytes);
  return extractPptx(bytes, entries, options.extractPresentationImages === true, mediaSizes);
}

async function preflightOoxml(
  bytes: Uint8Array,
  kind: OfficeKind,
  mediaSizes?: Map<string, number>,
): Promise<ReadonlyMap<string, Buffer>> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new OfficeIngestionError('metadata_mismatch', 'Office 声明与 OOXML ZIP 文件签名不匹配');
  }
  const xmlEntries = new Map<string, Buffer>();
  let entryCount = 0;
  let declaredExpandedBytes = 0;
  let actualExpandedBytes = 0;
  await visitZipEntries(Buffer.from(bytes), async (zip, entry) => {
    entryCount += 1;
    if (entryCount > ZIP_MAX_ENTRIES) {
      throw new OfficeIngestionError('processing_budget_exceeded', 'OOXML ZIP 条目数量超过上限');
    }
    validateZipEntryName(entry.fileName);
    mediaSizes?.set(entry.fileName, entry.uncompressedSize);
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
      throw new OfficeIngestionError('unsupported_type', '不支持加密的 Office 文件');
    }
    if (entry.uncompressedSize > ZIP_MAX_ENTRY_BYTES) {
      throw new OfficeIngestionError(
        'processing_budget_exceeded',
        'OOXML ZIP 单条目展开大小超过上限',
      );
    }
    declaredExpandedBytes += entry.uncompressedSize;
    if (declaredExpandedBytes > ZIP_MAX_EXPANDED_BYTES) {
      throw new OfficeIngestionError('processing_budget_exceeded', 'OOXML ZIP 总展开大小超过上限');
    }
    if (
      entry.uncompressedSize > MIB &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > ZIP_MAX_COMPRESSION_RATIO
    ) {
      throw new OfficeIngestionError('processing_budget_exceeded', 'OOXML ZIP 压缩比超过安全上限');
    }
    const lowerName = entry.fileName.toLowerCase();
    if (lowerName.endsWith('vbaproject.bin') || lowerName.includes('/embeddings/')) {
      throw new OfficeIngestionError('unsupported_type', '不支持含宏或嵌入对象的 Office 文件');
    }
    if (entry.fileName.endsWith('/')) return;
    const isXml = lowerName.endsWith('.xml') || lowerName.endsWith('.rels');
    if (isXml && entry.uncompressedSize > ZIP_MAX_XML_BYTES) {
      throw new OfficeIngestionError('processing_budget_exceeded', 'OOXML XML 条目超过解析上限');
    }
    const expanded = await readZipEntry(zip, entry, {
      collect: isXml,
      maximumBytes: isXml ? ZIP_MAX_XML_BYTES : ZIP_MAX_ENTRY_BYTES,
      onBytes: (count) => {
        actualExpandedBytes += count;
        if (actualExpandedBytes > ZIP_MAX_EXPANDED_BYTES) {
          throw new OfficeIngestionError(
            'processing_budget_exceeded',
            'OOXML ZIP 实际总展开大小超过上限',
          );
        }
      },
    });
    if (
      expanded.bytes > MIB &&
      entry.compressedSize > 0 &&
      expanded.bytes / entry.compressedSize > ZIP_MAX_COMPRESSION_RATIO
    ) {
      throw new OfficeIngestionError(
        'processing_budget_exceeded',
        'OOXML ZIP 实际压缩比超过安全上限',
      );
    }
    if (isXml) {
      const xml = expanded.contents;
      if (xml === undefined) {
        throw new OfficeIngestionError('corrupt_or_binary', 'OOXML XML 条目无法读取');
      }
      if (XMLValidator.validate(xml.toString('utf8')) !== true) {
        throw new OfficeIngestionError('corrupt_or_binary', 'OOXML 包含损坏的 XML 部件');
      }
      xmlEntries.set(entry.fileName, xml);
    }
  });

  const contentTypes = xmlEntries.get('[Content_Types].xml')?.toString('utf8');
  const mainPart = OFFICE_MAIN_PARTS[kind];
  const contentTypeDocument =
    contentTypes === undefined
      ? undefined
      : (new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(
          contentTypes,
        ) as UnknownRecord);
  const overrides = asArray(nested(contentTypeDocument, ['Types', 'Override']));
  const exactMainPart = overrides.some((value) => {
    const override = asRecord(value);
    return (
      override?.['@_PartName'] === `/${mainPart.path}` &&
      override?.['@_ContentType'] === mainPart.contentType
    );
  });
  const hasAnotherOfficeMainPart = overrides.some((value) => {
    const contentType = asRecord(value)?.['@_ContentType'];
    return (
      typeof contentType === 'string' &&
      contentType !== mainPart.contentType &&
      Object.values(OFFICE_MAIN_PARTS).some((candidate) => candidate.contentType === contentType)
    );
  });
  if (!xmlEntries.has(mainPart.path) || !exactMainPart || hasAnotherOfficeMainPart) {
    throw new OfficeIngestionError(
      'metadata_mismatch',
      'OOXML 包结构与声明的 Office 文档类型不匹配',
    );
  }
  if (/macroEnabled|vbaProject/i.test(contentTypes ?? '')) {
    throw new OfficeIngestionError('unsupported_type', '不支持启用宏的 Office 文件');
  }
  return xmlEntries;
}

interface DocxHiddenProperties {
  vanish?: boolean;
  webHidden?: boolean;
}

interface DocxStyleVisibility {
  basedOn?: string;
  properties: DocxHiddenProperties;
}

async function removeHiddenDocxRuns(
  bytes: Uint8Array,
  entries: ReadonlyMap<string, Buffer>,
): Promise<Uint8Array> {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false });
  const document = parser.parse(requiredXml(entries, 'word/document.xml')) as OrderedXmlNode[];
  const stylesXml = entries.get('word/styles.xml')?.toString('utf8');
  const styles = stylesXml === undefined ? [] : (parser.parse(stylesXml) as OrderedXmlNode[]);
  const visibility = collectDocxStyleVisibility(styles);
  let removedRuns = 0;
  const sanitized = sanitizeDocxNodes(document, undefined, visibility, () => {
    removedRuns += 1;
  });
  if (removedRuns === 0) return bytes;

  const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false });
  const zip = await JSZip.loadAsync(bytes);
  zip.file('word/document.xml', builder.build(sanitized));
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

function collectDocxStyleVisibility(nodes: readonly OrderedXmlNode[]): {
  defaults: DocxHiddenProperties;
  styles: ReadonlyMap<string, DocxStyleVisibility>;
} {
  const styles = new Map<string, DocxStyleVisibility>();
  let defaults: DocxHiddenProperties = {};
  visitOrderedXml(nodes, (name, children, attributes) => {
    if (localXmlName(name) === 'docDefaults') {
      const runDefaults = findDescendantElement(children, 'rPrDefault');
      const runProperties =
        runDefaults === undefined ? undefined : findDirectElement(runDefaults.children, 'rPr');
      defaults = hiddenProperties(runProperties?.children ?? []);
      return;
    }
    if (localXmlName(name) !== 'style') return;
    const styleId = attributeValue(attributes, 'styleId');
    if (styleId === undefined) return;
    const basedOn = findDirectElement(children, 'basedOn');
    const runProperties = findDirectElement(children, 'rPr');
    styles.set(styleId, {
      basedOn: basedOn === undefined ? undefined : attributeValue(basedOn.attributes, 'val'),
      properties: hiddenProperties(runProperties?.children ?? []),
    });
  });
  return { defaults, styles };
}

function sanitizeDocxNodes(
  nodes: readonly OrderedXmlNode[],
  paragraphStyleId: string | undefined,
  visibility: {
    defaults: DocxHiddenProperties;
    styles: ReadonlyMap<string, DocxStyleVisibility>;
  },
  onHiddenRun: () => void,
): OrderedXmlNode[] {
  const result: OrderedXmlNode[] = [];
  for (const node of nodes) {
    const element = orderedXmlElement(node);
    if (element === undefined) {
      result.push(node);
      continue;
    }
    const localName = localXmlName(element.name);
    if (localName === 'r') {
      const runProperties = findDirectElement(element.children, 'rPr');
      const direct = hiddenProperties(runProperties?.children ?? []);
      const runStyle =
        runProperties === undefined
          ? undefined
          : findDirectElement(runProperties.children, 'rStyle');
      const runStyleId =
        runStyle === undefined ? undefined : attributeValue(runStyle.attributes, 'val');
      const hidden = (['vanish', 'webHidden'] as const).some(
        (property) =>
          direct[property] ??
          resolveDocxStyleProperty(runStyleId, property, visibility.styles) ??
          resolveDocxStyleProperty(paragraphStyleId, property, visibility.styles) ??
          visibility.defaults[property] ??
          false,
      );
      if (hidden) {
        onHiddenRun();
        continue;
      }
    }
    const nextParagraphStyleId =
      localName === 'p' ? paragraphStyleForNode(element.children) : paragraphStyleId;
    result.push({
      ...node,
      [element.name]: sanitizeDocxNodes(
        element.children,
        nextParagraphStyleId,
        visibility,
        onHiddenRun,
      ),
    });
  }
  return result;
}

function paragraphStyleForNode(nodes: readonly OrderedXmlNode[]): string | undefined {
  const paragraphProperties = findDirectElement(nodes, 'pPr');
  const paragraphStyle =
    paragraphProperties === undefined
      ? undefined
      : findDirectElement(paragraphProperties.children, 'pStyle');
  return paragraphStyle === undefined
    ? undefined
    : attributeValue(paragraphStyle.attributes, 'val');
}

function hiddenProperties(nodes: readonly OrderedXmlNode[]): DocxHiddenProperties {
  const result: DocxHiddenProperties = {};
  for (const property of ['vanish', 'webHidden'] as const) {
    const element = findDirectElement(nodes, property);
    if (element !== undefined) {
      const value = attributeValue(element.attributes, 'val');
      result[property] = value === undefined ? true : !isFalseOoxmlBoolean(value);
    }
  }
  return result;
}

function resolveDocxStyleProperty(
  styleId: string | undefined,
  property: keyof DocxHiddenProperties,
  styles: ReadonlyMap<string, DocxStyleVisibility>,
  visited: ReadonlySet<string> = new Set(),
): boolean | undefined {
  if (styleId === undefined || visited.has(styleId)) return undefined;
  const style = styles.get(styleId);
  if (style === undefined) return undefined;
  if (style.properties[property] !== undefined) return style.properties[property];
  const nextVisited = new Set(visited);
  nextVisited.add(styleId);
  return resolveDocxStyleProperty(style.basedOn, property, styles, nextVisited);
}

interface OrderedXmlNode extends Record<string, unknown> {
  ':@'?: Record<string, unknown>;
}

function orderedXmlElement(
  node: OrderedXmlNode,
): { name: string; children: OrderedXmlNode[]; attributes?: Record<string, unknown> } | undefined {
  const entry = Object.entries(node).find(([name, value]) => name !== ':@' && Array.isArray(value));
  if (entry === undefined) return undefined;
  return {
    name: entry[0],
    children: entry[1] as OrderedXmlNode[],
    attributes: node[':@'],
  };
}

function findDirectElement(
  nodes: readonly OrderedXmlNode[],
  localName: string,
): ReturnType<typeof orderedXmlElement> {
  for (const node of nodes) {
    const element = orderedXmlElement(node);
    if (element !== undefined && localXmlName(element.name) === localName) return element;
  }
  return undefined;
}

function findDescendantElement(
  nodes: readonly OrderedXmlNode[],
  localName: string,
): ReturnType<typeof orderedXmlElement> {
  for (const node of nodes) {
    const element = orderedXmlElement(node);
    if (element === undefined) continue;
    if (localXmlName(element.name) === localName) return element;
    const nestedElement = findDescendantElement(element.children, localName);
    if (nestedElement !== undefined) return nestedElement;
  }
  return undefined;
}

function visitOrderedXml(
  nodes: readonly OrderedXmlNode[],
  visitor: (
    name: string,
    children: readonly OrderedXmlNode[],
    attributes?: Record<string, unknown>,
  ) => void,
): void {
  for (const node of nodes) {
    const element = orderedXmlElement(node);
    if (element === undefined) continue;
    visitor(element.name, element.children, element.attributes);
    visitOrderedXml(element.children, visitor);
  }
}

function localXmlName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

function attributeValue(
  attributes: Record<string, unknown> | undefined,
  localName: string,
): string | undefined {
  if (attributes === undefined) return undefined;
  for (const [name, value] of Object.entries(attributes)) {
    const normalizedName = name.startsWith('@_') ? name.slice(2) : name;
    if (
      localXmlName(normalizedName) === localName &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    ) {
      return String(value);
    }
  }
  return undefined;
}

async function extractDocx(bytes: Uint8Array): Promise<PreparedDocx> {
  const images: PreparedOfficeImage[] = [];
  const warnings: string[] = [];
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const data = Buffer.from(await image.read('base64'), 'base64');
        if (data.byteLength === 0 || data.byteLength > OFFICE_IMAGE_MAX_BYTES) {
          warnings.push('image_size_unsupported');
          return { src: 'office-image:unsupported' };
        }
        const mimeType = detectOfficeImageMime(data);
        if (mimeType === undefined) {
          warnings.push(`unsupported_image_type:${image.contentType || 'unknown'}`);
          return { src: 'office-image:unsupported' };
        }
        if (normalizeOfficeImageMime(image.contentType) !== mimeType)
          warnings.push('image_mime_corrected');
        const index = images.length;
        images.push({
          data: data.toString('base64'),
          mimeType,
          description: `DOCX 内嵌图片 ${index + 1}`,
        });
        return { src: `office-image:${index}` };
      }),
    },
  );
  for (const message of result.messages) warnings.push(message.type);
  const blocks = htmlToDocxBlocks(result.value, images);
  if (blocks.length === 0) {
    throw new OfficeIngestionError('no_extractable_content', 'DOCX 没有可读取的正文或图片');
  }
  return { kind: 'docx', blocks, warnings: [...new Set(warnings)] };
}

function htmlToDocxBlocks(
  html: string,
  images: readonly PreparedOfficeImage[],
): PreparedDocxBlock[] {
  const fragment = parseFragment(html) as HtmlNode;
  const blocks: PreparedDocxBlock[] = [];
  let pendingText = '';
  const appendText = (value: string) => {
    pendingText += value;
  };
  const flushText = () => {
    const text = pendingText
      .replace(/[\t\r ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
    pendingText = '';
    if (text.length > 0) blocks.push({ type: 'text', text });
  };
  const walk = (node: HtmlNode): void => {
    if (node.nodeName === '#text') {
      appendText(node.value ?? '');
      return;
    }
    const tag = node.tagName?.toLowerCase();
    if (tag === 'img') {
      flushText();
      const src = node.attrs?.find((attribute) => attribute.name === 'src')?.value ?? '';
      const match = /^office-image:(\d+)$/.exec(src);
      const image = match === null ? undefined : images[Number(match[1])];
      if (image !== undefined) blocks.push({ type: 'image', image });
      return;
    }
    const isBlock = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr'].includes(tag ?? '');
    const isCell = tag === 'td' || tag === 'th';
    if (isBlock) flushText();
    for (const child of node.childNodes ?? []) walk(child);
    if (isCell) appendText(' | ');
    if (tag === 'br') appendText('\n');
    if (isBlock) flushText();
  };
  for (const child of fragment.childNodes ?? []) walk(child);
  flushText();
  return blocks;
}

interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

async function extractXlsx(bytes: Uint8Array): Promise<PreparedXlsx> {
  const workbook = new ExcelJS.Workbook();
  const workbookBytes = Uint8Array.from(bytes);
  await workbook.xlsx.load(workbookBytes.buffer);
  const lines: string[] = [];
  let visibleSheetCount = 0;
  let cellCount = 0;
  for (const worksheet of workbook.worksheets) {
    if (worksheet.state !== 'visible') continue;
    visibleSheetCount += 1;
    lines.push(`[工作表 ${visibleSheetCount}: ${worksheet.name}]`);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      if (row.hidden) return;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (worksheet.getColumn(cell.col).hidden) return;
        const formula = cell.formula;
        const displayValue = cell.text;
        if (formula === undefined && displayValue.length === 0) return;
        cellCount += 1;
        if (cellCount > XLSX_MAX_VISIBLE_CELLS) {
          throw new OfficeIngestionError(
            'processing_budget_exceeded',
            'XLSX 可见非空单元格数量超过上限',
          );
        }
        lines.push(
          `${cell.address}: ${displayValue}${formula === undefined ? '' : ` [formula=${formula}]`}`,
        );
      });
    });
  }
  if (visibleSheetCount === 0 || cellCount === 0) {
    throw new OfficeIngestionError('no_extractable_content', 'XLSX 没有可读取的可见非空单元格');
  }
  return { kind: 'xlsx', text: lines.join('\n'), visibleSheetCount, cellCount };
}

type PptxImageCacheEntry =
  | PreparedOfficeImage
  | 'pptx_image_reference_unavailable'
  | 'pptx_image_type_unsupported';

async function extractPptx(
  bytes: Uint8Array,
  entries: ReadonlyMap<string, Buffer>,
  extractImages: boolean,
  mediaSizes: ReadonlyMap<string, number> | undefined,
): Promise<PreparedPptx> {
  const zip = extractImages ? await JSZip.loadAsync(bytes) : undefined;
  const imageCache = new Map<string, PptxImageCacheEntry>();
  const imageBudget = { bytes: 0 };
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const orderedParser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    trimValues: false,
  });
  const presentation = parser.parse(requiredXml(entries, 'ppt/presentation.xml')) as UnknownRecord;
  const relationships = parser.parse(
    requiredXml(entries, 'ppt/_rels/presentation.xml.rels'),
  ) as UnknownRecord;
  const relationMap = relationshipTargets(relationships);
  const slideIds = asArray(nested(presentation, ['p:presentation', 'p:sldIdLst', 'p:sldId']));
  const slides: PreparedPresentationSlide[] = [];
  let hiddenSlideCount = 0;
  for (const [sourceIndex, rawSlideId] of slideIds.entries()) {
    const slideId = asRecord(rawSlideId);
    const relationshipId = slideId?.['@_r:id'];
    if (typeof relationshipId !== 'string') continue;
    const target = relationMap.get(relationshipId);
    if (target === undefined) continue;
    const slidePath = normalizeRelationshipTarget('ppt', target);
    const slideXml = requiredXml(entries, slidePath);
    const parsedSlide = parser.parse(slideXml) as UnknownRecord;
    const slideRoot = asRecord(parsedSlide['p:sld']);
    if (isFalseOoxmlBoolean(slideRoot?.['@_show'])) {
      hiddenSlideCount += 1;
      continue;
    }
    const orderedSlide = orderedParser.parse(slideXml) as OrderedXmlNode[];
    if (!zip) {
      slides.push({
        slideNumber: slides.length + 1,
        sourceSlideNumber: sourceIndex + 1,
        text: collectOrderedSlideText(orderedSlide),
      });
      continue;
    }
    const slideRelationshipsXml = entries
      .get(posix.join(posix.dirname(slidePath), '_rels', posix.basename(slidePath) + '.rels'))
      ?.toString('utf8');
    const imageRelations = new Map<string, string>();
    if (slideRelationshipsXml) {
      const document = parser.parse(slideRelationshipsXml) as UnknownRecord;
      for (const item of asArray(nested(document, ['Relationships', 'Relationship']))) {
        const relation = asRecord(item);
        if (
          typeof relation?.['@_Type'] === 'string' &&
          relation['@_Type'].endsWith('/image') &&
          relation['@_TargetMode'] !== 'External' &&
          typeof relation['@_Id'] === 'string' &&
          typeof relation['@_Target'] === 'string'
        )
          imageRelations.set(relation['@_Id'], relation['@_Target']);
      }
    }
    const { blocks, warnings } = await extractPptxSlideBlocks(
      orderedSlide,
      imageRelations,
      posix.dirname(slidePath),
      zip,
      imageCache,
      mediaSizes!,
      imageBudget,
    );
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    slides.push({
      slideNumber: slides.length + 1,
      sourceSlideNumber: sourceIndex + 1,
      text,
      blocks,
      warnings,
    });
  }
  if (slides.length === 0) {
    throw new OfficeIngestionError('no_extractable_content', 'PPTX 没有可读取的可见幻灯片');
  }
  return { kind: 'pptx', bytes, slides, hiddenSlideCount };
}

async function extractPptxSlideBlocks(
  nodes: readonly OrderedXmlNode[],
  imageRelations: ReadonlyMap<string, string>,
  slideDirectory: string,
  zip: JSZip,
  imageCache: Map<string, PptxImageCacheEntry>,
  mediaSizes: ReadonlyMap<string, number>,
  imageBudget: { bytes: number },
): Promise<{ blocks: PreparedDocxBlock[]; warnings: string[] }> {
  const blocks: PreparedDocxBlock[] = [];
  const warnings: string[] = [];
  let pendingText = '';
  const flush = () => {
    const text = pendingText.replace(/[ \r]+/g, ' ').trim();
    if (text) blocks.push({ type: 'text', text });
    pendingText = '';
  };
  const walk = async (items: readonly OrderedXmlNode[]): Promise<void> => {
    for (const node of items) {
      const element = orderedXmlElement(node);
      if (!element) continue;
      const name = localXmlName(element.name);
      if (['sp', 'pic', 'grpSp', 'graphicFrame'].includes(name)) {
        const nonVisual = element.children
          .map(orderedXmlElement)
          .find(
            (child) =>
              child &&
              ['nvSpPr', 'nvPicPr', 'nvGrpSpPr', 'nvGraphicFramePr'].includes(
                localXmlName(child.name),
              ),
          );
        const hidden = nonVisual && findDescendantElement(nonVisual.children, 'cNvPr');
        if (['1', 'true'].includes(attributeValue(hidden?.attributes, 'hidden') ?? '')) continue;
      }
      if (name === 'AlternateContent') {
        const selected =
          findDirectElement(element.children, 'Fallback') ??
          findDirectElement(element.children, 'Choice');
        if (selected) await walk(selected.children);
        continue;
      }
      if (name === 't') {
        pendingText += collectTextNodes(element.children);
        continue;
      }
      if (name === 'br') {
        pendingText += '\n';
        continue;
      }
      if (name === 'blip') {
        flush();
        const relationTarget = imageRelations.get(
          attributeValue(element.attributes, 'embed') ?? '',
        );
        if (!relationTarget) {
          warnings.push('pptx_image_reference_unavailable');
          continue;
        }
        const target = normalizeRelationshipTarget(slideDirectory, relationTarget);
        if (!imageCache.has(target)) {
          if ((mediaSizes.get(target) ?? 0) > OFFICE_IMAGE_MAX_BYTES)
            throw new OfficeIngestionError(
              'processing_budget_exceeded',
              'PPTX 内嵌图片超过解析上限',
            );
          const file = zip.file(target);
          if (!file) {
            warnings.push('pptx_image_reference_unavailable');
            imageCache.set(target, 'pptx_image_reference_unavailable');
            continue;
          }
          const data = await file.async('uint8array');
          const mimeType = detectOfficeImageMime(data);
          if (!mimeType) {
            warnings.push('pptx_image_type_unsupported');
            imageCache.set(target, 'pptx_image_type_unsupported');
            continue;
          }
          if (!data.byteLength || data.byteLength > OFFICE_IMAGE_MAX_BYTES)
            throw new OfficeIngestionError(
              'processing_budget_exceeded',
              'PPTX 内嵌图片超过解析上限',
            );
          imageBudget.bytes += data.byteLength;
          if (imageBudget.bytes > ZIP_MAX_EXPANDED_BYTES)
            throw new OfficeIngestionError(
              'processing_budget_exceeded',
              'PPTX 图片总大小超过解析上限',
            );
          imageCache.set(target, {
            data: Buffer.from(data).toString('base64'),
            mimeType,
            description: 'PPTX 内嵌图片',
          });
        }
        const image = imageCache.get(target);
        if (typeof image === 'string') warnings.push(image);
        else if (image) blocks.push({ type: 'image', image });
        continue;
      }
      if (
        name === 'graphicData' &&
        /(?:chart|diagram)/i.test(attributeValue(element.attributes, 'uri') ?? '')
      )
        warnings.push('pptx_vector_diagram_text_only');
      await walk(element.children);
      if (name === 'p') flush();
    }
  };
  await walk(nodes);
  flush();
  return { blocks, warnings: [...new Set(warnings)] };
}

function isFalseOoxmlBoolean(value: unknown): boolean {
  return value === false || value === 0 || value === '0' || value === 'false';
}

function relationshipTargets(document: UnknownRecord): Map<string, string> {
  const relationships = asArray(nested(document, ['Relationships', 'Relationship']));
  const result = new Map<string, string>();
  for (const item of relationships) {
    const relationship = asRecord(item);
    const id = relationship?.['@_Id'];
    const target = relationship?.['@_Target'];
    const mode = relationship?.['@_TargetMode'];
    if (typeof id === 'string' && typeof target === 'string' && mode !== 'External') {
      result.set(id, target);
    }
  }
  return result;
}

function normalizeRelationshipTarget(baseDirectory: string, target: string): string {
  const normalized = posix.normalize(
    target.startsWith('/') ? target.slice(1) : posix.join(baseDirectory, target),
  );
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /[\\\u0000]/.test(normalized)
  ) {
    throw new OfficeIngestionError('corrupt_or_binary', 'OOXML 关系目标越出包路径');
  }
  return normalized;
}

function collectOrderedSlideText(value: unknown): string {
  const texts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = asRecord(node);
    if (record === undefined) return;
    for (const [key, child] of Object.entries(record)) {
      if (key === 'a:t') {
        const text = collectTextNodes(child).trim();
        if (text.length > 0) texts.push(text);
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectTextNodes(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(collectTextNodes).join('');
  const record = asRecord(value);
  if (record === undefined) return '';
  return Object.entries(record)
    .filter(([key]) => key === '#text' || !key.startsWith(':@'))
    .map(([, child]) => collectTextNodes(child))
    .join('');
}

function requiredXml(entries: ReadonlyMap<string, Buffer>, path: string): string {
  const entry = entries.get(path);
  if (entry === undefined) {
    throw new OfficeIngestionError('corrupt_or_binary', `OOXML 缺少必需部件 ${path}`);
  }
  return entry.toString('utf8');
}

function validateZipEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    posix.normalize(name).startsWith('../')
  ) {
    throw new OfficeIngestionError('corrupt_or_binary', 'OOXML ZIP 含不安全条目路径');
  }
}

function visitZipEntries(
  bytes: Buffer,
  visitor: (zip: ZipFile, entry: Entry) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        reject(new OfficeIngestionError('corrupt_or_binary', 'OOXML ZIP 目录损坏或无法读取'));
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        visitor(zip, entry).then(() => zip.readEntry(), fail);
      });
      zip.readEntry();
    });
  });
}

function readZipEntry(
  zip: ZipFile,
  entry: Entry,
  options: {
    collect: boolean;
    maximumBytes: number;
    onBytes: (count: number) => void;
  },
): Promise<{ contents?: Buffer; bytes: number }> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(new OfficeIngestionError('corrupt_or_binary', 'OOXML ZIP 条目无法读取'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (streamError: unknown) => {
        if (settled) return;
        settled = true;
        reject(
          streamError instanceof OfficeIngestionError
            ? streamError
            : new OfficeIngestionError(
                'corrupt_or_binary',
                'OOXML ZIP 条目声明大小与实际内容不匹配',
              ),
        );
      };
      stream.on('data', (chunk: Buffer) => {
        try {
          bytes += chunk.byteLength;
          if (bytes > options.maximumBytes) {
            throw new OfficeIngestionError(
              'processing_budget_exceeded',
              options.collect
                ? 'OOXML XML 条目超过解析上限'
                : 'OOXML ZIP 单条目实际展开大小超过上限',
            );
          }
          options.onBytes(chunk.byteLength);
          if (options.collect) chunks.push(chunk);
        } catch (streamError) {
          stream.destroy(streamError as Error);
        }
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ contents: options.collect ? Buffer.concat(chunks) : undefined, bytes });
      });
    });
  });
}

function normalizeOfficeImageMime(value: string): PreparedOfficeImage['mimeType'] | undefined {
  const normalized = value.toLowerCase();
  if (normalized === 'image/png') return normalized;
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/webp') return normalized;
  return undefined;
}

function detectOfficeImageMime(bytes: Uint8Array): PreparedOfficeImage['mimeType'] | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (value, index) => bytes[index] === value,
  );
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
  return png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : undefined;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function nested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = asRecord(current)?.[key];
  return current;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
