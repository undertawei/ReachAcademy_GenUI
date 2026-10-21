import type { PptxDiagnostic } from './diagnostics.js';
import type { PptxSourceDigest } from './identity.js';
import type { PptxXmlElement } from './package/xml.js';
import type { PptxSlideNodeIR } from './model/slide-node.js';
import type { PptxThemeStyleIR } from './style/theme.js';

export const PPTX_IR_SCHEMA_VERSION = 'pptx-presentation-ir/v1' as const;

export interface PptxSourceLocation {
  partPath: string;
  nodePath?: string;
  relationshipId?: string;
}

export interface PptxUnknownNodeIR {
  kind: 'unknown';
  id: string;
  qualifiedName: string;
  namespaceUri?: string;
  attributes: Readonly<Record<string, string>>;
  relationshipIds: readonly string[];
  canonicalFragmentDigest: PptxSourceDigest;
  xml: PptxXmlElement;
  source: PptxSourceLocation;
}

export interface PptxRelationshipIR {
  id: string;
  type: string;
  target: string;
  targetMode: 'internal' | 'external';
  source: PptxSourceLocation;
}

export type PptxPackagePartKind =
  | 'presentation'
  | 'slide'
  | 'slide-layout'
  | 'slide-master'
  | 'theme'
  | 'notes-slide'
  | 'notes-master'
  | 'handout-master'
  | 'chart'
  | 'diagram'
  | 'table'
  | 'comments'
  | 'media'
  | 'embedding'
  | 'relationship'
  | 'xml'
  | 'binary'
  | 'unknown';

export interface PptxPackagePartIR {
  path: string;
  contentType: string;
  kind: PptxPackagePartKind;
  byteLength: number;
  digest: PptxSourceDigest;
  relationships: readonly PptxRelationshipIR[];
  /**
   * Parsed XML is retained for every XML part with mc:AlternateContent already
   * resolved to the elected branch; exact package bytes are returned as sidecars.
   */
  xml?: PptxXmlElement;
}

export interface PptxSlideSizeIR {
  widthEmu: number;
  heightEmu: number;
}

export interface PptxThemeIR {
  id: string;
  partPath: string;
  name?: string;
  style: PptxThemeStyleIR;
  xml: PptxXmlElement;
  source: PptxSourceLocation;
}

export interface PptxSlideMasterIR {
  id: string;
  partPath: string;
  themePartPath: string;
  layoutPartPaths: readonly string[];
  xml: PptxXmlElement;
  source: PptxSourceLocation;
}

export interface PptxSlideLayoutIR {
  id: string;
  partPath: string;
  masterPartPath: string;
  name?: string;
  layoutType?: string;
  matchingName?: string;
  xml: PptxXmlElement;
  source: PptxSourceLocation;
}

export interface PptxNotesSlideIR {
  id: string;
  partPath: string;
  slidePartPath?: string;
  masterPartPath?: string;
  xml: PptxXmlElement;
  source: PptxSourceLocation;
}

export interface PptxSlideIR {
  id: string;
  relationshipId: string;
  partPath: string;
  order: number;
  layoutPartPath?: string;
  notesPartPath?: string;
  nodes: readonly PptxSlideNodeIR[];
}

export interface PptxPresentationIR {
  schemaVersion: typeof PPTX_IR_SCHEMA_VERSION;
  /** False until every fidelity-relevant OOXML part and node is semantically inventoried. */
  inventoryComplete: boolean;
  sourceDigest: PptxSourceDigest;
  presentationPartPath: string;
  slideSize: PptxSlideSizeIR;
  /** Relationships from package root and every discovered OPC source part. */
  relationships: readonly PptxRelationshipIR[];
  parts: readonly PptxPackagePartIR[];
  themes: readonly PptxThemeIR[];
  masters: readonly PptxSlideMasterIR[];
  layouts: readonly PptxSlideLayoutIR[];
  notes: readonly PptxNotesSlideIR[];
  slides: readonly PptxSlideIR[];
}

export interface PptxBinaryAsset {
  partPath: string;
  contentType: string;
  byteLength: number;
  digest: PptxSourceDigest;
  bytes: Uint8Array;
}

/** Exact bytes for every OPC package entry, including XML, relationships and embeddings. */
export interface PptxPackageSidecar {
  partPath: string;
  contentType: string;
  byteLength: number;
  digest: PptxSourceDigest;
  bytes: Uint8Array;
}

export interface PptxParseSuccess {
  ok: true;
  ir: PptxPresentationIR;
  sidecars: readonly PptxPackageSidecar[];
  assets: readonly PptxBinaryAsset[];
  diagnostics: readonly PptxDiagnostic[];
}

export interface PptxParseFailure {
  ok: false;
  diagnostics: readonly PptxDiagnostic[];
}

export type PptxParseResult = PptxParseSuccess | PptxParseFailure;
