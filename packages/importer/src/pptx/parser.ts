import type { PptxDiagnostic, PptxDiagnosticFeature } from './diagnostics.js';
import { createPptxSourceDigest, createStablePptxId } from './identity.js';
import {
  PPTX_IR_SCHEMA_VERSION,
  type PptxBinaryAsset,
  type PptxPackagePartIR,
  type PptxPackagePartKind,
  type PptxPackageSidecar,
  type PptxParseFailure,
  type PptxParseResult,
  type PptxRelationshipIR,
  type PptxNotesSlideIR,
  type PptxSlideIR,
  type PptxSlideLayoutIR,
  type PptxSlideMasterIR,
  type PptxThemeIR,
  type PptxUnknownNodeIR,
} from './ir.js';
import { resolvePptxParseLimits, type PptxParseLimits } from './options.js';
import { projectPptxSlideNode, type PptxSlideNodeIR } from './model/slide-node.js';
import { readPptxPackage, type PptxPackageEntry } from './package/archive.js';
import {
  parsePptxContentTypes,
  resolvePptxPartContentType,
  type PptxContentTypes,
} from './package/content-types.js';
import {
  getPptxRelationshipPartPath,
  parsePptxRelationships,
  type PptxRelationshipParseBudget,
} from './package/relationships.js';
import { canonicalPptxXmlFragment, parsePptxXml, type PptxXmlElement } from './package/xml.js';
import type { PptxXmlParseBudget } from './package/xml.js';
import { expandPptxMarkupCompatibility } from './package/mce.js';
import { parsePptxThemeStyle } from './style/theme.js';

const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const SLIDE_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slide',
]);
const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const PRESENTATION_CONTENT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.ms-powerpoint.presentation.main+xml',
]);
const SLIDE_CONTENT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  'application/vnd.ms-powerpoint.slide+xml',
]);
const SLIDE_LAYOUT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slideLayout',
]);
const NOTES_SLIDE_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide',
]);
const SLIDE_MASTER_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slideMaster',
]);
const THEME_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/theme',
]);
const NOTES_MASTER_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/notesMaster',
]);
const OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const RELATIONSHIP_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

export interface PptxParseOptions {
  limits?: Partial<PptxParseLimits>;
}

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const childByLocalName = (
  element: PptxXmlElement,
  expectedLocalName: string,
): PptxXmlElement | undefined =>
  element.children.find(
    (child) =>
      localName(child.name) === expectedLocalName && child.namespaceUri === element.namespaceUri,
  );

const fatal = (
  code: `pptx.${string}`,
  feature: PptxDiagnosticFeature,
  message: string,
  partPath: string,
): PptxParseResult => ({
  ok: false,
  diagnostics: [{ code, severity: 'fatal', feature, message, location: { partPath } }],
});

const findEntry = (
  entries: ReadonlyMap<string, PptxPackageEntry>,
  partPath: string,
): PptxPackageEntry | undefined => entries.get(partPath.toLowerCase());

const requireEntry = (
  entries: ReadonlyMap<string, PptxPackageEntry>,
  partPath: string,
  code: `pptx.${string}`,
  feature: PptxDiagnosticFeature,
): PptxPackageEntry | PptxParseResult =>
  findEntry(entries, partPath) ??
  fatal(code, feature, `Required PPTX part is missing: ${partPath}`, partPath);

const isFailure = (value: PptxPackageEntry | PptxParseResult): value is PptxParseResult =>
  'ok' in value;

const positiveInteger = (value: string | undefined): number | undefined => {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const relationshipIdAttribute = (element: PptxXmlElement): string | undefined =>
  Object.entries(element.attributes).find(([name]) => {
    const separator = name.indexOf(':');
    if (separator < 1 || localName(name) !== 'id') return false;
    const prefix = name.slice(0, separator);
    return OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACES.has(element.namespaces?.[prefix] ?? '');
  })?.[1];

const namespaceForQualifiedName = (
  namespaceRoot: PptxXmlElement,
  qualifiedName: string,
): string | undefined => {
  const separator = qualifiedName.indexOf(':');
  const prefix = separator < 0 ? '' : qualifiedName.slice(0, separator);
  return (
    namespaceRoot.namespaces?.[prefix] ??
    (prefix === '' ? namespaceRoot.attributes.xmlns : namespaceRoot.attributes[`xmlns:${prefix}`])
  );
};

const isXmlContentType = (contentType: string): boolean =>
  contentType === 'application/xml' || contentType.endsWith('+xml') || contentType === 'text/xml';

const kindForContentType = (contentType: string, partPath: string): PptxPackagePartKind => {
  if (contentType === RELATIONSHIP_CONTENT_TYPE) return 'relationship';
  if (/^image\//.test(contentType) || /^audio\//.test(contentType) || /^video\//.test(contentType))
    return 'media';
  // OPC core properties ("...-package.core-properties+xml") must not match the
  // embedding heuristic below just because the token "package" appears.
  if (/core-properties\+xml$/i.test(contentType)) return 'xml';
  if (/oleObject|package|embedding/i.test(contentType) || /\/embeddings\//i.test(partPath))
    return 'embedding';
  if (/presentation\.main\+xml$/i.test(contentType)) return 'presentation';
  if (/\.slide\+xml$/i.test(contentType)) return 'slide';
  if (/slideLayout\+xml$/i.test(contentType)) return 'slide-layout';
  if (/slideMaster\+xml$/i.test(contentType)) return 'slide-master';
  if (/theme\+xml$/i.test(contentType)) return 'theme';
  if (/notesSlide\+xml$/i.test(contentType)) return 'notes-slide';
  if (/notesMaster\+xml$/i.test(contentType)) return 'notes-master';
  if (/handoutMaster\+xml$/i.test(contentType)) return 'handout-master';
  if (/chart(?!ColorStyle|Style)\+xml$/i.test(contentType)) return 'chart';
  if (/diagram|drawingml\.diagram/i.test(contentType)) return 'diagram';
  if (/table/i.test(contentType)) return 'table';
  if (/comment/i.test(contentType)) return 'comments';
  if (isXmlContentType(contentType)) return 'xml';
  return 'binary';
};

const RELATIONSHIP_ATTRIBUTE = /^(?:r:)?(?:embed|link|id)$/;

/** Single-pass relationship-id harvest; replaces regexing a JSON dump. */
const collectRelationshipIds = (element: PptxXmlElement, into: Set<string>): void => {
  for (const [attributeName, value] of Object.entries(element.attributes)) {
    if (RELATIONSHIP_ATTRIBUTE.test(attributeName)) into.add(value);
  }
  for (const child of element.children) collectRelationshipIds(child, into);
};

const unknownSlideNodes = (
  slidePartPath: string,
  slideRoot: PptxXmlElement,
): readonly PptxUnknownNodeIR[] | undefined => {
  const commonSlideData = childByLocalName(slideRoot, 'cSld');
  const shapeTree = commonSlideData && childByLocalName(commonSlideData, 'spTree');
  if (!shapeTree) return undefined;

  const occurrences = new Map<string, number>();
  const nodes: PptxUnknownNodeIR[] = [];
  for (const element of shapeTree.children) {
    const elementLocalName = localName(element.name);
    if (elementLocalName === 'nvGrpSpPr' || elementLocalName === 'grpSpPr') continue;
    const occurrence = (occurrences.get(element.name) ?? 0) + 1;
    occurrences.set(element.name, occurrence);
    const nodePath = `/${slideRoot.name}/${commonSlideData!.name}/${shapeTree.name}/${element.name}[${occurrence}]`;
    // JSON.stringify(element) 会沿 children/content 双引用把每层子树序列化两遍，
    // 深嵌套 grpSp 时指数爆炸（真实课件 13 层 700 节点即撑爆 V8 字符串上限）。
    const canonicalBytes = new TextEncoder().encode(canonicalPptxXmlFragment(element));
    const relationshipIdSet = new Set<string>();
    collectRelationshipIds(element, relationshipIdSet);
    const relationshipIds = [...relationshipIdSet].sort();

    nodes.push({
      kind: 'unknown',
      id: createStablePptxId('node', [slidePartPath, nodePath]),
      qualifiedName: element.name,
      ...(namespaceForQualifiedName(slideRoot, element.name)
        ? { namespaceUri: namespaceForQualifiedName(slideRoot, element.name) }
        : {}),
      attributes: element.attributes,
      relationshipIds,
      canonicalFragmentDigest: createPptxSourceDigest(canonicalBytes),
      xml: element,
      source: { partPath: slidePartPath, nodePath },
    });
  }
  return nodes;
};

const projectSlideNodes = (
  nodes: readonly PptxUnknownNodeIR[],
): { ok: true; nodes: readonly PptxSlideNodeIR[] } | PptxParseFailure => {
  const projected: PptxSlideNodeIR[] = [];
  for (const node of nodes) {
    const result = projectPptxSlideNode(node);
    if (!result.ok) return result;
    projected.push(result.node);
  }
  return { ok: true, nodes: projected };
};

const parseRelationshipsForSource = (
  sourcePartPath: string,
  entries: ReadonlyMap<string, PptxPackageEntry>,
  limits: Partial<PptxParseLimits>,
  xmlBudget: PptxXmlParseBudget,
  relationshipBudget: PptxRelationshipParseBudget,
): readonly PptxRelationshipIR[] | PptxParseResult => {
  const relsPath = getPptxRelationshipPartPath(sourcePartPath);
  const relsEntry = findEntry(entries, relsPath);
  if (!relsEntry) return [];
  const result = parsePptxRelationships(
    sourcePartPath,
    relsEntry.bytes,
    limits,
    xmlBudget,
    relationshipBudget,
  );
  return result.ok ? result.relationships : { ok: false, diagnostics: result.diagnostics };
};

const packageParts = (
  entries: readonly PptxPackageEntry[],
  contentTypes: PptxContentTypes,
  relationshipsBySource: ReadonlyMap<string, readonly PptxRelationshipIR[]>,
  xmlRoots: ReadonlyMap<string, PptxXmlElement>,
): PptxPackagePartIR[] =>
  entries
    .filter((entry) => entry.partPath !== '/[Content_Types].xml')
    .map((entry) => ({
      path: entry.partPath,
      contentType: resolvePptxPartContentType(contentTypes, entry.partPath)!,
      kind: kindForContentType(
        resolvePptxPartContentType(contentTypes, entry.partPath)!,
        entry.partPath,
      ),
      byteLength: entry.byteLength,
      digest: entry.digest,
      relationships: relationshipsBySource.get(entry.partPath) ?? [],
      ...(xmlRoots.get(entry.partPath) ? { xml: xmlRoots.get(entry.partPath) } : {}),
    }));

const internalRelationshipTargets = (
  part: PptxPackagePartIR,
  relationshipTypes: ReadonlySet<string>,
): string[] =>
  part.relationships
    .filter(
      (relationship) =>
        relationship.targetMode === 'internal' && relationshipTypes.has(relationship.type),
    )
    .map((relationship) => relationship.target)
    .sort();

const hasExpectedRoot = (
  part: PptxPackagePartIR,
  expectedLocalName: string,
  namespaces: ReadonlySet<string>,
): boolean =>
  part.xml !== undefined &&
  localName(part.xml.name) === expectedLocalName &&
  namespaces.has(namespaceForQualifiedName(part.xml, part.xml.name) ?? '');

const binaryAssets = (
  entries: readonly PptxPackageEntry[],
  contentTypes: PptxContentTypes,
): PptxBinaryAsset[] =>
  entries.flatMap((entry) => {
    const contentType = resolvePptxPartContentType(contentTypes, entry.partPath);
    if (!contentType || !/^(?:image|audio|video)\//.test(contentType)) return [];
    return [
      {
        partPath: entry.partPath,
        contentType,
        byteLength: entry.byteLength,
        digest: entry.digest,
        bytes: entry.bytes,
      },
    ];
  });

const packageSidecars = (
  entries: readonly PptxPackageEntry[],
  contentTypes: PptxContentTypes,
): PptxPackageSidecar[] =>
  entries.map((entry) => ({
    partPath: entry.partPath,
    contentType:
      entry.partPath === '/[Content_Types].xml'
        ? 'application/xml'
        : resolvePptxPartContentType(contentTypes, entry.partPath)!,
    byteLength: entry.byteLength,
    digest: entry.digest,
    bytes: entry.bytes,
  }));

export const parsePptx = async (
  input: Uint8Array,
  options: PptxParseOptions = {},
): Promise<PptxParseResult> => {
  const limits = resolvePptxParseLimits(options.limits);
  // Non-fatal advisories (e.g. MCE fallback selection) surfaced with the IR.
  const diagnostics: PptxDiagnostic[] = [];
  const xmlBudget: PptxXmlParseBudget = { remainingNodes: limits.maxTotalXmlNodes };
  const relationshipBudget: PptxRelationshipParseBudget = {
    remainingRelationships: limits.maxTotalRelationships,
  };
  const packageResult = await readPptxPackage(input, limits);
  if (!packageResult.ok) return packageResult;
  const entries = new Map(
    packageResult.entries.map((entry) => [entry.partPath.toLowerCase(), entry] as const),
  );

  const contentTypesEntry = requireEntry(
    entries,
    '/[Content_Types].xml',
    'pptx.package.missing_content_types',
    'package',
  );
  if (isFailure(contentTypesEntry)) return contentTypesEntry;
  const contentTypesResult = parsePptxContentTypes(contentTypesEntry.bytes, limits, xmlBudget);
  if (!contentTypesResult.ok) return contentTypesResult;
  let mediaCount = 0;
  let totalMediaBytes = 0;
  for (const entry of packageResult.entries) {
    if (entry.partPath === '/[Content_Types].xml') continue;
    const contentType = resolvePptxPartContentType(contentTypesResult.contentTypes, entry.partPath);
    if (!contentType) {
      return fatal(
        'pptx.content_types.unresolved_part',
        'package',
        `PPTX part has no declared content type: ${entry.partPath}`,
        entry.partPath,
      );
    }
    if (/^(?:image|audio|video)\//.test(contentType)) {
      mediaCount += 1;
      totalMediaBytes += entry.byteLength;
      if (entry.byteLength > limits.maxMediaAssetBytes) {
        return fatal(
          'pptx.package.media_too_large',
          'package',
          `PPTX media part exceeds maxMediaAssetBytes: ${entry.partPath}`,
          entry.partPath,
        );
      }
    }
  }
  if (mediaCount > limits.maxMediaAssets) {
    return fatal(
      'pptx.package.too_many_media_assets',
      'package',
      'PPTX package exceeds maxMediaAssets.',
      '/[Content_Types].xml',
    );
  }
  if (totalMediaBytes > limits.maxTotalMediaBytes) {
    return fatal(
      'pptx.package.total_media_size_exceeded',
      'package',
      'PPTX package exceeds maxTotalMediaBytes.',
      '/[Content_Types].xml',
    );
  }

  const rootRelsEntry = requireEntry(
    entries,
    '/_rels/.rels',
    'pptx.package.missing_root_relationships',
    'relationship',
  );
  if (isFailure(rootRelsEntry)) return rootRelsEntry;
  const rootRelsResult = parsePptxRelationships(
    '/',
    rootRelsEntry.bytes,
    limits,
    xmlBudget,
    relationshipBudget,
  );
  if (!rootRelsResult.ok) return rootRelsResult;
  const officeDocumentRelationships = rootRelsResult.relationships.filter(
    (relationship) =>
      relationship.targetMode === 'internal' &&
      OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type),
  );
  if (officeDocumentRelationships.length !== 1) {
    return fatal(
      'pptx.presentation.invalid_office_document_relationship',
      'presentation',
      'PPTX package must contain exactly one internal officeDocument relationship.',
      '/_rels/.rels',
    );
  }
  const presentationPartPath = officeDocumentRelationships[0]!.target;
  const presentationEntry = requireEntry(
    entries,
    presentationPartPath,
    'pptx.presentation.missing_part',
    'presentation',
  );
  if (isFailure(presentationEntry)) return presentationEntry;
  const presentationContentType = resolvePptxPartContentType(
    contentTypesResult.contentTypes,
    presentationPartPath,
  );
  if (!presentationContentType || !PRESENTATION_CONTENT_TYPES.has(presentationContentType)) {
    return fatal(
      'pptx.presentation.invalid_content_type',
      'presentation',
      'Presentation part has an invalid content type.',
      presentationPartPath,
    );
  }

  const presentationXml = parsePptxXml(
    presentationPartPath,
    presentationEntry.bytes,
    limits,
    xmlBudget,
  );
  if (!presentationXml.ok) return presentationXml;
  // Resolve ECMA-376 Part 3 mc:AlternateContent before any projection so the
  // whole pipeline only ever sees the branch this consumer actually elects.
  const presentationExpansion = expandPptxMarkupCompatibility(
    presentationXml.root,
    presentationPartPath,
  );
  diagnostics.push(...presentationExpansion.diagnostics);
  const presentationRoot = presentationExpansion.root;
  const xmlRoots = new Map<string, PptxXmlElement>([[presentationPartPath, presentationRoot]]);
  if (
    localName(presentationRoot.name) !== 'presentation' ||
    !PRESENTATION_NAMESPACES.has(
      namespaceForQualifiedName(presentationRoot, presentationRoot.name) ?? '',
    )
  ) {
    return fatal(
      'pptx.presentation.invalid_root',
      'presentation',
      'Presentation part has an invalid root element.',
      presentationPartPath,
    );
  }
  const slideSizeElement = childByLocalName(presentationRoot, 'sldSz');
  const widthEmu = positiveInteger(slideSizeElement?.attributes.cx);
  const heightEmu = positiveInteger(slideSizeElement?.attributes.cy);
  if (!widthEmu || !heightEmu) {
    return fatal(
      'pptx.presentation.missing_slide_size',
      'presentation',
      'Presentation must declare positive finite slide dimensions.',
      presentationPartPath,
    );
  }

  const presentationRelationships = parseRelationshipsForSource(
    presentationPartPath,
    entries,
    limits,
    xmlBudget,
    relationshipBudget,
  );
  if ('ok' in presentationRelationships) return presentationRelationships;
  const presentationRelationshipById = new Map(
    presentationRelationships.map((relationship) => [relationship.id, relationship] as const),
  );
  const slideIdList = childByLocalName(presentationRoot, 'sldIdLst');
  const slides: PptxSlideIR[] = [];
  for (const [index, slideIdElement] of (slideIdList?.children ?? []).entries()) {
    if (localName(slideIdElement.name) !== 'sldId') {
      return fatal(
        'pptx.presentation.unexpected_slide_list_element',
        'presentation',
        `Slide list contains an unexpected element: ${slideIdElement.name}`,
        presentationPartPath,
      );
    }
    const id = slideIdElement.attributes.id;
    const relationshipId = relationshipIdAttribute(slideIdElement);
    if (!id || !relationshipId) {
      return fatal(
        'pptx.presentation.invalid_slide_reference',
        'presentation',
        'Slide list entry is missing id or relationship id.',
        presentationPartPath,
      );
    }
    const relationship = presentationRelationshipById.get(relationshipId);
    if (
      !relationship ||
      relationship.targetMode !== 'internal' ||
      !SLIDE_RELATIONSHIP_TYPES.has(relationship.type)
    ) {
      return fatal(
        'pptx.presentation.invalid_slide_relationship',
        'relationship',
        `Slide relationship is missing or has the wrong type: ${relationshipId}`,
        presentationPartPath,
      );
    }
    const slideEntry = requireEntry(
      entries,
      relationship.target,
      'pptx.presentation.missing_slide_part',
      'presentation',
    );
    if (isFailure(slideEntry)) return slideEntry;
    const slideContentType = resolvePptxPartContentType(
      contentTypesResult.contentTypes,
      relationship.target,
    );
    if (!slideContentType || !SLIDE_CONTENT_TYPES.has(slideContentType)) {
      return fatal(
        'pptx.presentation.invalid_slide_content_type',
        'presentation',
        'Slide part has an invalid content type.',
        relationship.target,
      );
    }
    const slideXml = parsePptxXml(relationship.target, slideEntry.bytes, limits, xmlBudget);
    if (!slideXml.ok) return slideXml;
    const slideExpansion = expandPptxMarkupCompatibility(slideXml.root, relationship.target);
    diagnostics.push(...slideExpansion.diagnostics);
    const slideRoot = slideExpansion.root;
    xmlRoots.set(relationship.target, slideRoot);
    if (
      localName(slideRoot.name) !== 'sld' ||
      !PRESENTATION_NAMESPACES.has(namespaceForQualifiedName(slideRoot, slideRoot.name) ?? '')
    ) {
      return fatal(
        'pptx.presentation.invalid_slide_root',
        'presentation',
        'Slide part has an invalid root element.',
        relationship.target,
      );
    }
    const sourceNodes = unknownSlideNodes(relationship.target, slideRoot);
    if (!sourceNodes) {
      return fatal(
        'pptx.presentation.invalid_slide_structure',
        'presentation',
        'Slide part must contain p:cSld/p:spTree.',
        relationship.target,
      );
    }
    const projectedNodes = projectSlideNodes(sourceNodes);
    if (!projectedNodes.ok) return projectedNodes;
    slides.push({
      id,
      relationshipId,
      partPath: relationship.target,
      order: index + 1,
      nodes: projectedNodes.nodes,
    });
  }

  const relationshipsBySource = new Map<string, readonly PptxRelationshipIR[]>([
    ['/', rootRelsResult.relationships],
    [presentationPartPath, presentationRelationships],
  ]);
  const consumedRelationshipParts = new Set<string>([
    getPptxRelationshipPartPath('/'),
    getPptxRelationshipPartPath(presentationPartPath),
  ]);
  for (const entry of packageResult.entries) {
    if (entry.partPath === '/[Content_Types].xml') continue;
    const contentType = resolvePptxPartContentType(
      contentTypesResult.contentTypes,
      entry.partPath,
    )!;
    if (kindForContentType(contentType, entry.partPath) === 'relationship') continue;

    const relationshipPartPath = getPptxRelationshipPartPath(entry.partPath);
    if (!findEntry(entries, relationshipPartPath)) continue;
    consumedRelationshipParts.add(relationshipPartPath);
    if (relationshipsBySource.has(entry.partPath)) continue;
    const sourceRelationships = parseRelationshipsForSource(
      entry.partPath,
      entries,
      limits,
      xmlBudget,
      relationshipBudget,
    );
    if ('ok' in sourceRelationships) return sourceRelationships;
    relationshipsBySource.set(entry.partPath, sourceRelationships);
  }

  for (const entry of packageResult.entries) {
    const contentType = resolvePptxPartContentType(contentTypesResult.contentTypes, entry.partPath);
    if (
      contentType === RELATIONSHIP_CONTENT_TYPE &&
      !consumedRelationshipParts.has(entry.partPath)
    ) {
      return fatal(
        'pptx.relationship.orphan_part',
        'relationship',
        `Relationship part has no package source: ${entry.partPath}`,
        entry.partPath,
      );
    }
  }

  for (const relationships of relationshipsBySource.values()) {
    for (const relationship of relationships) {
      if (relationship.targetMode === 'internal' && !findEntry(entries, relationship.target)) {
        return fatal(
          'pptx.relationship.missing_target',
          'relationship',
          `Internal relationship target is missing: ${relationship.target}`,
          relationship.source.partPath,
        );
      }
    }
  }

  for (const entry of packageResult.entries) {
    if (entry.partPath === '/[Content_Types].xml' || xmlRoots.has(entry.partPath)) continue;
    const contentType = resolvePptxPartContentType(
      contentTypesResult.contentTypes,
      entry.partPath,
    )!;
    if (!isXmlContentType(contentType) || contentType === RELATIONSHIP_CONTENT_TYPE) continue;
    // `image/svg+xml` is media, not package markup: it travels to the media
    // resolver as bytes. Parsing it here would spend the XML budget on every
    // icon and let one malformed one condemn the whole package.
    if (kindForContentType(contentType, entry.partPath) === 'media') continue;
    const xmlResult = parsePptxXml(entry.partPath, entry.bytes, limits, xmlBudget);
    if (!xmlResult.ok) return xmlResult;
    const expansion = expandPptxMarkupCompatibility(xmlResult.root, entry.partPath);
    diagnostics.push(...expansion.diagnostics);
    xmlRoots.set(entry.partPath, expansion.root);
  }

  const enrichedSlides = slides.map((slide) => {
    const relationships = relationshipsBySource.get(slide.partPath) ?? [];
    const layoutPartPath = relationships.find(
      (relationship) =>
        relationship.targetMode === 'internal' &&
        SLIDE_LAYOUT_RELATIONSHIP_TYPES.has(relationship.type),
    )?.target;
    const notesPartPath = relationships.find(
      (relationship) =>
        relationship.targetMode === 'internal' &&
        NOTES_SLIDE_RELATIONSHIP_TYPES.has(relationship.type),
    )?.target;
    return {
      ...slide,
      ...(layoutPartPath ? { layoutPartPath } : {}),
      ...(notesPartPath ? { notesPartPath } : {}),
    };
  });

  const relationships = [...relationshipsBySource.values()]
    .flat()
    .sort((left, right) =>
      left.source.partPath !== right.source.partPath
        ? left.source.partPath < right.source.partPath
          ? -1
          : 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );
  const parts = packageParts(
    packageResult.entries,
    contentTypesResult.contentTypes,
    relationshipsBySource,
    xmlRoots,
  );
  const themes: PptxThemeIR[] = [];
  const masters: PptxSlideMasterIR[] = [];
  const layouts: PptxSlideLayoutIR[] = [];
  const notes: PptxNotesSlideIR[] = [];
  for (const part of parts) {
    if (part.kind === 'theme') {
      if (!hasExpectedRoot(part, 'theme', DRAWING_NAMESPACES)) {
        return fatal(
          'pptx.theme.invalid_root',
          'theme',
          'Theme part has an invalid root element or namespace.',
          part.path,
        );
      }
      const styleResult = parsePptxThemeStyle(part.xml!, part.path);
      if (!styleResult.ok) return styleResult;
      themes.push({
        id: createStablePptxId('theme', [part.path]),
        partPath: part.path,
        ...(part.xml!.attributes.name ? { name: part.xml!.attributes.name } : {}),
        style: styleResult.style,
        xml: part.xml!,
        source: { partPath: part.path },
      });
      continue;
    }
    if (part.kind === 'slide-master') {
      if (!hasExpectedRoot(part, 'sldMaster', PRESENTATION_NAMESPACES)) {
        return fatal(
          'pptx.master.invalid_root',
          'master',
          'Slide master part has an invalid root element or namespace.',
          part.path,
        );
      }
      const themePartPaths = internalRelationshipTargets(part, THEME_RELATIONSHIP_TYPES);
      if (themePartPaths.length !== 1) {
        return fatal(
          'pptx.master.invalid_theme_relationship',
          'master',
          'Slide master must reference exactly one internal theme.',
          part.path,
        );
      }
      masters.push({
        id: createStablePptxId('master', [part.path]),
        partPath: part.path,
        themePartPath: themePartPaths[0]!,
        layoutPartPaths: internalRelationshipTargets(part, SLIDE_LAYOUT_RELATIONSHIP_TYPES),
        xml: part.xml!,
        source: { partPath: part.path },
      });
      continue;
    }
    if (part.kind === 'slide-layout') {
      if (!hasExpectedRoot(part, 'sldLayout', PRESENTATION_NAMESPACES)) {
        return fatal(
          'pptx.layout.invalid_root',
          'layout',
          'Slide layout part has an invalid root element or namespace.',
          part.path,
        );
      }
      const masterPartPaths = internalRelationshipTargets(part, SLIDE_MASTER_RELATIONSHIP_TYPES);
      if (masterPartPaths.length !== 1) {
        return fatal(
          'pptx.layout.invalid_master_relationship',
          'layout',
          'Slide layout must reference exactly one internal slide master.',
          part.path,
        );
      }
      const commonSlideData = childByLocalName(part.xml!, 'cSld');
      layouts.push({
        id: createStablePptxId('layout', [part.path]),
        partPath: part.path,
        masterPartPath: masterPartPaths[0]!,
        ...(commonSlideData?.attributes.name ? { name: commonSlideData.attributes.name } : {}),
        ...(part.xml!.attributes.type ? { layoutType: part.xml!.attributes.type } : {}),
        ...(part.xml!.attributes.matchingName
          ? { matchingName: part.xml!.attributes.matchingName }
          : {}),
        xml: part.xml!,
        source: { partPath: part.path },
      });
      continue;
    }
    if (part.kind === 'notes-slide') {
      if (!hasExpectedRoot(part, 'notes', PRESENTATION_NAMESPACES)) {
        return fatal(
          'pptx.notes.invalid_root',
          'notes',
          'Notes slide part has an invalid root element or namespace.',
          part.path,
        );
      }
      const slidePartPaths = internalRelationshipTargets(part, SLIDE_RELATIONSHIP_TYPES);
      const masterPartPaths = internalRelationshipTargets(part, NOTES_MASTER_RELATIONSHIP_TYPES);
      if (slidePartPaths.length > 1 || masterPartPaths.length > 1) {
        return fatal(
          'pptx.notes.invalid_relationships',
          'notes',
          'Notes slide contains ambiguous slide or notes-master relationships.',
          part.path,
        );
      }
      notes.push({
        id: createStablePptxId('notes', [part.path]),
        partPath: part.path,
        ...(slidePartPaths[0] ? { slidePartPath: slidePartPaths[0] } : {}),
        ...(masterPartPaths[0] ? { masterPartPath: masterPartPaths[0] } : {}),
        xml: part.xml!,
        source: { partPath: part.path },
      });
    }
  }

  return {
    ok: true,
    ir: {
      schemaVersion: PPTX_IR_SCHEMA_VERSION,
      inventoryComplete: false,
      sourceDigest: packageResult.sourceDigest,
      presentationPartPath,
      slideSize: { widthEmu, heightEmu },
      relationships,
      parts,
      themes,
      masters,
      layouts,
      notes,
      slides: enrichedSlides,
    },
    sidecars: packageSidecars(packageResult.entries, contentTypesResult.contentTypes),
    assets: binaryAssets(packageResult.entries, contentTypesResult.contentTypes),
    diagnostics,
  };
};
