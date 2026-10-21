import type { PptxDiagnostic } from '../diagnostics.js';
import { canonicalizePptxPartPath } from '../identity.js';
import type { PptxParseLimits } from '../options.js';
import { parsePptxXml, type PptxXmlParseBudget } from './xml.js';

const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';

export interface PptxContentTypes {
  defaults: Readonly<Record<string, string>>;
  overrides: Readonly<Record<string, string>>;
}

export type PptxContentTypesResult =
  | { ok: true; contentTypes: PptxContentTypes }
  | { ok: false; diagnostics: readonly PptxDiagnostic[] };

const failure = (
  code: `pptx.content_types.${string}`,
  message: string,
): PptxContentTypesResult => ({
  ok: false,
  diagnostics: [
    {
      code,
      severity: 'fatal',
      feature: 'package',
      message,
      location: { partPath: '/[Content_Types].xml' },
    },
  ],
});

export const parsePptxContentTypes = (
  bytes: Uint8Array,
  limits: Partial<PptxParseLimits> = {},
  xmlBudget?: PptxXmlParseBudget,
): PptxContentTypesResult => {
  const xmlResult = parsePptxXml('/[Content_Types].xml', bytes, limits, xmlBudget);
  if (!xmlResult.ok) return xmlResult;
  const { root } = xmlResult;
  if (root.name !== 'Types' || root.attributes.xmlns !== CONTENT_TYPES_NAMESPACE) {
    return failure('pptx.content_types.invalid_root', 'Content types part has an invalid root.');
  }

  const defaults: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  for (const child of root.children) {
    const contentType = child.attributes.ContentType;
    if (!contentType) {
      return failure(
        'pptx.content_types.missing_attribute',
        `${child.name} is missing ContentType.`,
      );
    }
    if (child.name === 'Default') {
      const extension = child.attributes.Extension?.toLowerCase();
      if (!extension) {
        return failure('pptx.content_types.missing_attribute', 'Default is missing Extension.');
      }
      if (defaults[extension] !== undefined) {
        return failure(
          'pptx.content_types.duplicate_default',
          `Content type default is duplicated: ${extension}`,
        );
      }
      defaults[extension] = contentType;
      continue;
    }
    if (child.name === 'Override') {
      const rawPartName = child.attributes.PartName;
      if (!rawPartName) {
        return failure('pptx.content_types.missing_attribute', 'Override is missing PartName.');
      }
      let partName: string;
      try {
        partName = canonicalizePptxPartPath(rawPartName);
      } catch (error) {
        return failure(
          'pptx.content_types.invalid_part_name',
          error instanceof Error ? error.message : 'Override PartName is invalid.',
        );
      }
      const collisionKey = partName.toLowerCase();
      if (overrides[collisionKey] !== undefined) {
        return failure(
          'pptx.content_types.duplicate_override',
          `Content type override is duplicated: ${partName}`,
        );
      }
      overrides[collisionKey] = contentType;
      continue;
    }
    return failure(
      'pptx.content_types.unexpected_element',
      `Content types part contains an unexpected element: ${child.name}`,
    );
  }

  return { ok: true, contentTypes: { defaults, overrides } };
};

export const resolvePptxPartContentType = (
  contentTypes: PptxContentTypes,
  partPath: string,
): string | undefined => {
  const canonicalPath = canonicalizePptxPartPath(partPath);
  const override = contentTypes.overrides[canonicalPath.toLowerCase()];
  if (override) return override;
  const filename = canonicalPath.slice(canonicalPath.lastIndexOf('/') + 1);
  const separator = filename.lastIndexOf('.');
  if (separator < 0 || separator === filename.length - 1) return undefined;
  return contentTypes.defaults[filename.slice(separator + 1).toLowerCase()];
};
