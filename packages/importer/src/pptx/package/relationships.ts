import type { PptxDiagnostic } from '../diagnostics.js';
import { canonicalizePptxPartPath } from '../identity.js';
import type { PptxRelationshipIR } from '../ir.js';
import { resolvePptxParseLimits, type PptxParseLimits } from '../options.js';
import { parsePptxXml, type PptxXmlElement, type PptxXmlParseBudget } from './xml.js';

const RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
]);

export interface PptxRelationshipParseSuccess {
  ok: true;
  relationships: readonly PptxRelationshipIR[];
}

export interface PptxRelationshipParseFailure {
  ok: false;
  diagnostics: readonly PptxDiagnostic[];
}

export type PptxRelationshipParseResult =
  | PptxRelationshipParseSuccess
  | PptxRelationshipParseFailure;

export interface PptxRelationshipParseBudget {
  remainingRelationships: number;
}

export const getPptxRelationshipPartPath = (sourcePartPath: string): string => {
  if (sourcePartPath === '/') return '/_rels/.rels';
  const source = canonicalizePptxPartPath(sourcePartPath);
  const separator = source.lastIndexOf('/');
  const directory = source.slice(0, separator);
  const filename = source.slice(separator + 1);
  return `${directory}/_rels/${filename}.rels`;
};

const fatalRelationshipDiagnostic = (
  code: `pptx.relationship.${string}`,
  message: string,
  partPath: string,
  relationshipId?: string,
): PptxRelationshipParseFailure => ({
  ok: false,
  diagnostics: [
    {
      code,
      severity: 'fatal',
      feature: 'relationship',
      message,
      location: { partPath, ...(relationshipId ? { relationshipId } : {}) },
    },
  ],
});

const resolveInternalTarget = (sourcePartPath: string, target: string): string => {
  if (target.startsWith('/')) return canonicalizePptxPartPath(target);
  if (sourcePartPath === '/') return canonicalizePptxPartPath(`/${target}`);
  const source = canonicalizePptxPartPath(sourcePartPath);
  const directory = source.slice(0, source.lastIndexOf('/'));
  return canonicalizePptxPartPath(`${directory}/${target}`);
};

const requiredAttribute = (element: PptxXmlElement, name: string): string => {
  const value = element.attributes[name];
  if (!value) throw new Error(`Relationship is missing ${name}.`);
  return value;
};

export const parsePptxRelationships = (
  inputSourcePartPath: string,
  bytes: Uint8Array,
  limitOverrides: Partial<PptxParseLimits> = {},
  xmlBudget?: PptxXmlParseBudget,
  relationshipBudget?: PptxRelationshipParseBudget,
): PptxRelationshipParseResult => {
  const sourcePartPath =
    inputSourcePartPath === '/' ? '/' : canonicalizePptxPartPath(inputSourcePartPath);
  const relsPartPath = getPptxRelationshipPartPath(sourcePartPath);
  const limits = resolvePptxParseLimits(limitOverrides);
  const xmlResult = parsePptxXml(relsPartPath, bytes, limits, xmlBudget);
  if (!xmlResult.ok) return xmlResult;

  const { root } = xmlResult;
  if (root.name !== 'Relationships' || !RELATIONSHIP_NAMESPACES.has(root.attributes.xmlns ?? '')) {
    return fatalRelationshipDiagnostic(
      'pptx.relationship.invalid_root',
      'Relationship part has an invalid root element or namespace.',
      relsPartPath,
    );
  }
  if (root.children.length > limits.maxRelationships) {
    return fatalRelationshipDiagnostic(
      'pptx.relationship.limit_exceeded',
      'Relationship part exceeds maxRelationships.',
      relsPartPath,
    );
  }
  if (relationshipBudget) {
    relationshipBudget.remainingRelationships -= root.children.length;
    if (relationshipBudget.remainingRelationships < 0) {
      return fatalRelationshipDiagnostic(
        'pptx.relationship.total_limit_exceeded',
        'PPTX package exceeds maxTotalRelationships.',
        relsPartPath,
      );
    }
  }

  const relationships: PptxRelationshipIR[] = [];
  const ids = new Set<string>();
  for (const element of root.children) {
    if (element.name !== 'Relationship') {
      return fatalRelationshipDiagnostic(
        'pptx.relationship.unexpected_element',
        `Relationship part contains an unexpected element: ${element.name}`,
        relsPartPath,
      );
    }

    let id: string;
    let type: string;
    let target: string;
    try {
      id = requiredAttribute(element, 'Id');
      type = requiredAttribute(element, 'Type');
      target = requiredAttribute(element, 'Target');
    } catch (error) {
      return fatalRelationshipDiagnostic(
        'pptx.relationship.missing_attribute',
        error instanceof Error ? error.message : 'Relationship is missing a required attribute.',
        relsPartPath,
      );
    }

    if (ids.has(id)) {
      return fatalRelationshipDiagnostic(
        'pptx.relationship.duplicate_id',
        `Relationship ID is duplicated: ${id}`,
        relsPartPath,
        id,
      );
    }
    ids.add(id);

    const rawTargetMode = element.attributes.TargetMode;
    if (
      rawTargetMode !== undefined &&
      rawTargetMode !== 'Internal' &&
      rawTargetMode !== 'External'
    ) {
      return fatalRelationshipDiagnostic(
        'pptx.relationship.invalid_target_mode',
        `Relationship has an invalid TargetMode: ${rawTargetMode}`,
        relsPartPath,
        id,
      );
    }
    const targetMode = rawTargetMode === 'External' ? 'external' : 'internal';
    if (targetMode === 'internal') {
      try {
        target = resolveInternalTarget(sourcePartPath, target);
      } catch (error) {
        return fatalRelationshipDiagnostic(
          'pptx.relationship.unsafe_target',
          error instanceof Error ? error.message : 'Relationship target escapes the package root.',
          relsPartPath,
          id,
        );
      }
    }

    relationships.push({
      id,
      type,
      target,
      targetMode,
      source: { partPath: relsPartPath, relationshipId: id },
    });
  }

  return { ok: true, relationships };
};
