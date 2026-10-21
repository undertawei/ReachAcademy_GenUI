import {
  hasBlockingPptxDiagnostics,
  hasFatalPptxDiagnostics,
  sortPptxDiagnostics,
  type PptxDiagnostic,
  type PptxDiagnosticFeature,
} from './diagnostics.js';
import type { PptxPackagePartIR, PptxPresentationIR, PptxUnknownNodeIR } from './ir.js';
import type { PptxSlideNodeIR } from './model/slide-node.js';
import type { PptxXmlElement } from './package/xml.js';

export type PptxCapabilityStatus = 'native' | 'conditional' | 'unsupported';

export interface PptxCapabilityEntry {
  feature: PptxDiagnosticFeature;
  status: PptxCapabilityStatus;
  reason?: string;
}

export interface PptxCapabilityReport {
  schemaVersion: 'pptx-capability-report/v1';
  entries: PptxCapabilityEntry[];
  diagnostics: PptxDiagnostic[];
  /**
   * Whether everything in the package reached the target model: no feature
   * unsupported and nothing dropped. False means the candidate is incomplete,
   * which the diagnostics itemize — it does not by itself refuse the import.
   */
  schemaRepresentable: boolean;
  /**
   * Whether the candidate can be applied. Only a package that could not be
   * read (a fatal diagnostic) or mapped at all is refused; a deck missing a
   * picture or a chart imports with that loss on record.
   */
  canApply: boolean;
}

export interface PptxCapabilityProfile {
  id: string;
  features: Readonly<Partial<Record<PptxDiagnosticFeature, PptxCapabilityStatus>>>;
}

export const REACH_DECK_V2_CAPABILITY_PROFILE: PptxCapabilityProfile = Object.freeze({
  id: 'reach-deck-v2/native-import/v1',
  // p:grpSp maps natively (nested group elements); its children are
  // inventoried individually so unsupported content still surfaces.
  // Slide-master/slide-layout parts map natively: placeholder inheritance
  // feeds slide shapes and non-placeholder decorations are materialized onto
  // every derived page, so the parts' presence no longer blocks. Unsupported
  // content inside a decoration still surfaces under its own feature.
  features: Object.freeze({
    group: 'native' as const,
    master: 'native' as const,
    layout: 'native' as const,
  }),
});

const compareFeature = (left: PptxCapabilityEntry, right: PptxCapabilityEntry): number =>
  left.feature < right.feature ? -1 : left.feature > right.feature ? 1 : 0;

export const createPptxCapabilityReport = (
  entries: readonly PptxCapabilityEntry[],
  diagnostics: readonly PptxDiagnostic[],
): PptxCapabilityReport => {
  const sortedEntries = [...entries].sort(compareFeature);
  const sortedDiagnostics = sortPptxDiagnostics(diagnostics);
  const hasUnsupportedFeature = sortedEntries.some((entry) => entry.status === 'unsupported');

  return {
    schemaVersion: 'pptx-capability-report/v1',
    entries: sortedEntries,
    diagnostics: sortedDiagnostics,
    schemaRepresentable: !hasUnsupportedFeature && !hasBlockingPptxDiagnostics(sortedDiagnostics),
    // A deck the teacher can still use is worth importing: refusing a whole
    // lesson because one picture would not decode helps nobody, and the losses
    // are itemized either way. `unsupported` entries are reserved for "there is
    // no candidate at all", so they still refuse.
    canApply: !hasUnsupportedFeature && !hasFatalPptxDiagnostics(sortedDiagnostics),
  };
};

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const findDescendant = (
  element: PptxXmlElement,
  expectedLocalName: string,
): PptxXmlElement | undefined => {
  for (const child of element.children) {
    if (localName(child.name) === expectedLocalName) return child;
    const nested = findDescendant(child, expectedLocalName);
    if (nested) return nested;
  }
  return undefined;
};

const featureForUnknownNode = (node: PptxSlideNodeIR): PptxDiagnosticFeature => {
  if (node.kind === 'shape') return 'shape';
  return featureForSlideElementName(localName(node.qualifiedName), node.xml);
};

const featureForSlideElementName = (
  elementLocalName: string,
  xml: PptxXmlElement,
): PptxDiagnosticFeature => {
  switch (elementLocalName) {
    case 'sp':
      return 'shape';
    case 'pic':
      return 'image';
    case 'cxnSp':
      return 'connector';
    case 'grpSp':
      return 'group';
    case 'graphicFrame': {
      const graphicData = findDescendant(xml, 'graphicData');
      const uri = graphicData?.attributes.uri ?? '';
      if (/table/i.test(uri)) return 'table';
      if (/chart/i.test(uri)) return 'chart';
      if (/(?:diagram|drawingml\/2006\/diagram)/i.test(uri)) return 'diagram';
      return 'unknown-ooxml';
    }
    default:
      // Includes residual mc:AlternateContent: the parser already expands any
      // node with an understood mc:Choice or an mc:Fallback, so only truly
      // unrepresentable alternate content still reaches this inventory.
      return 'unknown-ooxml';
  }
};

/** Non-drawable p:grpSp children the group mapper consumes structurally. */
const GROUP_STRUCTURAL_CHILDREN = new Set(['nvGrpSpPr', 'grpSpPr', 'extLst']);

const unsupportedReason =
  'Exact package bytes are retained, but this content is not yet mapped to a native editable Reach Deck element.';

const featureForPart = (part: PptxPackagePartIR): PptxDiagnosticFeature | undefined => {
  switch (part.kind) {
    case 'theme':
      return 'theme';
    case 'slide-master':
      return 'master';
    case 'slide-layout':
      return 'layout';
    case 'notes-slide':
    case 'notes-master':
      return 'notes';
    case 'chart':
      return 'chart';
    case 'diagram':
      return 'diagram';
    case 'embedding':
      return 'unknown-ooxml';
    default:
      return undefined;
  }
};

export const analyzePptxCapabilities = (
  ir: PptxPresentationIR,
  profile: PptxCapabilityProfile = REACH_DECK_V2_CAPABILITY_PROFILE,
): PptxCapabilityReport => {
  const features = new Map<PptxDiagnosticFeature, PptxCapabilityEntry>();
  const presentationStatus = profile.features.presentation ?? 'unsupported';
  features.set('presentation', {
    feature: 'presentation',
    status: presentationStatus,
    ...(presentationStatus === 'unsupported'
      ? { reason: 'A native Reach Deck mapper is not implemented for this capability profile.' }
      : {}),
  });
  const diagnostics: PptxDiagnostic[] = [];
  if (!ir.inventoryComplete) {
    diagnostics.push({
      code: 'pptx.inventory.incomplete',
      severity: 'error',
      feature: 'unknown-ooxml',
      message:
        'Capability inventory is incomplete; native mapping remains blocked until all relevant OOXML parts are inventoried.',
      location: { partPath: ir.presentationPartPath },
    });
  }
  if (presentationStatus === 'unsupported') {
    diagnostics.push({
      code: 'pptx.feature.unsupported',
      severity: 'error',
      feature: 'presentation',
      message: `Presentation mapping is not supported by capability profile ${profile.id}.`,
      location: { partPath: ir.presentationPartPath },
    });
  }

  for (const relationship of ir.relationships) {
    if (relationship.targetMode !== 'external') continue;
    const status = profile.features.relationship ?? 'unsupported';
    if (!features.has('relationship')) {
      features.set('relationship', {
        feature: 'relationship',
        status,
        ...(status === 'unsupported' ? { reason: unsupportedReason } : {}),
      });
    }
    if (status === 'unsupported') {
      diagnostics.push({
        code: 'pptx.relationship.external_unsupported',
        severity: 'error',
        feature: 'relationship',
        message: `External relationship is not supported by capability profile ${profile.id}.`,
        location: relationship.source,
        details: { target: relationship.target, type: relationship.type },
      });
    }
  }

  for (const part of ir.parts) {
    const feature = featureForPart(part);
    if (!feature) continue;
    const status = profile.features[feature] ?? 'unsupported';
    if (!features.has(feature)) {
      features.set(feature, {
        feature,
        status,
        ...(status === 'unsupported' ? { reason: unsupportedReason } : {}),
      });
    }
    if (status === 'unsupported') {
      diagnostics.push({
        code: 'pptx.feature.unsupported',
        severity: 'error',
        feature,
        message: `${part.kind} part is not supported by capability profile ${profile.id}.`,
        location: { partPath: part.path },
      });
    }
  }

  for (const slide of ir.slides) {
    for (const node of slide.nodes) {
      if (node.kind === 'unknown' && localName(node.qualifiedName) === 'grpSp') {
        analyzeGroupNode(node, slide.id, profile, features, diagnostics);
        continue;
      }
      const feature = featureForUnknownNode(node);
      const nodeLabel = node.kind === 'shape' ? 'p:sp' : node.qualifiedName;
      const status = profile.features[feature] ?? 'unsupported';
      if (!features.has(feature)) {
        features.set(feature, {
          feature,
          status,
          ...(status === 'unsupported' ? { reason: unsupportedReason } : {}),
        });
      }
      if (status === 'unsupported') {
        diagnostics.push({
          code: 'pptx.feature.unsupported',
          severity: 'error',
          feature,
          message: `${nodeLabel} is not supported by capability profile ${profile.id}.`,
          location: {
            partPath: node.source.partPath,
            slideId: slide.id,
            ...(node.source.nodePath ? { nodePath: node.source.nodePath } : {}),
            ...(node.source.relationshipId ? { relationshipId: node.source.relationshipId } : {}),
          },
        });
      }
    }
  }

  const report = createPptxCapabilityReport([...features.values()], diagnostics);
  return ir.inventoryComplete ? report : { ...report, schemaRepresentable: false, canApply: false };
};

/**
 * A p:grpSp maps natively, so it no longer blocks as an opaque unknown node.
 * Its drawable descendants are inventoried individually (single linear walk)
 * so unsupported content nested in groups still surfaces per-feature.
 */
const analyzeGroupNode = (
  node: PptxUnknownNodeIR,
  slideId: string,
  profile: PptxCapabilityProfile,
  features: Map<PptxDiagnosticFeature, PptxCapabilityEntry>,
  diagnostics: PptxDiagnostic[],
): void => {
  const groupStatus = profile.features.group ?? 'unsupported';
  if (!features.has('group')) {
    features.set('group', {
      feature: 'group',
      status: groupStatus,
      ...(groupStatus === 'unsupported' ? { reason: unsupportedReason } : {}),
    });
  }
  if (groupStatus === 'unsupported') {
    diagnostics.push({
      code: 'pptx.feature.unsupported',
      severity: 'error',
      feature: 'group',
      message: `${node.qualifiedName} is not supported by capability profile ${profile.id}.`,
      location: {
        partPath: node.source.partPath,
        slideId,
        ...(node.source.nodePath ? { nodePath: node.source.nodePath } : {}),
      },
    });
    return;
  }
  const walk = (element: PptxXmlElement, path: string): void => {
    const occurrences = new Map<string, number>();
    for (const child of element.children) {
      const childLocalName = localName(child.name);
      if (GROUP_STRUCTURAL_CHILDREN.has(childLocalName)) continue;
      const occurrence = (occurrences.get(child.name) ?? 0) + 1;
      occurrences.set(child.name, occurrence);
      const childPath = `${path}/${child.name}[${occurrence}]`;
      if (childLocalName === 'grpSp') {
        walk(child, childPath);
        continue;
      }
      const feature = featureForSlideElementName(childLocalName, child);
      const status = profile.features[feature] ?? 'unsupported';
      if (!features.has(feature)) {
        features.set(feature, {
          feature,
          status,
          ...(status === 'unsupported' ? { reason: unsupportedReason } : {}),
        });
      }
      if (status === 'unsupported') {
        diagnostics.push({
          code: 'pptx.feature.unsupported',
          severity: 'error',
          feature,
          message: `${child.name} is not supported by capability profile ${profile.id}.`,
          location: { partPath: node.source.partPath, slideId, nodePath: childPath },
        });
      }
    }
  };
  walk(node.xml, node.source.nodePath ?? `/${node.qualifiedName}[1]`);
};
