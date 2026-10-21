import type { MaterialReference } from './generationTypes.js';

export type WorkspaceMaterialBlock =
  | { type: 'text'; text: string; page?: number }
  | {
      type: 'image';
      assetId: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
      page?: number;
    };
export interface WorkspaceMaterialDocument {
  fileName: string;
  contentType: string;
  pageCount?: number;
  blocks: readonly WorkspaceMaterialBlock[];
  diagnostics: readonly string[];
}
export interface WorkspaceMaterialSources {
  schemaVersion: 'reach-deck-material-sources/v1';
  documents: readonly WorkspaceMaterialDocument[];
  webSearch?: {
    query: string;
    answer: string;
    sources: readonly { title: string; url: string; content: string }[];
    excludedSources: readonly {
      title: string;
      url: string;
      reason: 'pdf_binary_content' | 'empty_content';
    }[];
  };
}
export const MATERIAL_SOURCES_MAX_TEXT = 95_000;
export const MATERIAL_SOURCES_MAX_BYTES = 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const DOCUMENT_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
export const MATERIAL_ASSET_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class WorkspaceMaterialSourcesError extends Error {
  constructor(readonly code: 'material_inspection_invalid' | 'material_inspection_too_large') {
    super(`workspace.materialSources is invalid: ${code}`);
  }
}

export function parseWorkspaceMaterialSources(
  input: unknown,
  references: readonly MaterialReference[] = [],
): WorkspaceMaterialSources {
  let textCharacters = 0;
  let blockCount = 0;
  const imageIds = new Set<string>();
  const invalid = (): never => {
    throw new WorkspaceMaterialSourcesError('material_inspection_invalid');
  };
  const oversized = (): never => {
    throw new WorkspaceMaterialSourcesError('material_inspection_too_large');
  };
  const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const result = value as Record<string, unknown>;
    if (Object.keys(result).some((key) => !keys.includes(key))) return invalid();
    return result;
  };
  const text = (value: unknown, maximum = MATERIAL_SOURCES_MAX_TEXT): string => {
    if (typeof value !== 'string') return invalid();
    if (value.length > maximum) return oversized();
    textCharacters += value.length;
    if (textCharacters > MATERIAL_SOURCES_MAX_TEXT) return oversized();
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value))
      return invalid();
    return value;
  };
  const array = (value: unknown, maximum: number): unknown[] => {
    if (!Array.isArray(value)) return invalid();
    if (value.length > maximum) return oversized();
    return value;
  };
  const page = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000)
      return invalid();
    return value as number;
  };
  const url = (value: unknown): string => {
    const result = text(value, 2048);
    try {
      if (!['http:', 'https:'].includes(new URL(result).protocol)) return invalid();
    } catch {
      return invalid();
    }
    return result;
  };
  const root = record(input, ['schemaVersion', 'documents', 'webSearch']);
  if (root.schemaVersion !== 'reach-deck-material-sources/v1') return invalid();
  const allowedAssets = new Set(
    references.filter((ref) => ref.kind === 'image').map((ref) => ref.id.slice('image:'.length)),
  );
  const documents = array(root.documents, 64).map((value): WorkspaceMaterialDocument => {
    const document = record(value, [
      'fileName',
      'contentType',
      'pageCount',
      'blocks',
      'diagnostics',
    ]);
    const fileName = text(document.fileName, 255);
    const contentType = text(document.contentType, 160);
    if (!fileName.trim() || !DOCUMENT_TYPES.includes(contentType)) return invalid();
    let documentText = 0;
    const blocks = array(document.blocks, 2048).map((value): WorkspaceMaterialBlock => {
      blockCount += 1;
      if (blockCount > 4096) return oversized();
      const block = record(value, ['type', 'text', 'assetId', 'mimeType', 'page']);
      const blockPage = page(block.page);
      if (block.type === 'text') {
        if (block.assetId !== undefined || block.mimeType !== undefined) return invalid();
        const content = text(block.text, 60_000);
        documentText += content.length;
        if (documentText > 60_000) return oversized();
        return {
          type: 'text',
          text: content,
          ...(blockPage === undefined ? {} : { page: blockPage }),
        };
      }
      if (
        block.type !== 'image' ||
        block.text !== undefined ||
        typeof block.assetId !== 'string' ||
        !MATERIAL_ASSET_ID_PATTERN.test(block.assetId) ||
        !allowedAssets.has(block.assetId) ||
        !IMAGE_TYPES.includes(block.mimeType as (typeof IMAGE_TYPES)[number])
      )
        return invalid();
      imageIds.add(block.assetId);
      if (imageIds.size > 64) return oversized();
      return {
        type: 'image',
        assetId: block.assetId,
        mimeType: block.mimeType as (typeof IMAGE_TYPES)[number],
        ...(blockPage === undefined ? {} : { page: blockPage }),
      };
    });
    const pageCount = page(document.pageCount);
    return {
      fileName,
      contentType,
      blocks,
      diagnostics: array(document.diagnostics, 128).map((code) => text(code, 256)),
      ...(pageCount === undefined ? {} : { pageCount }),
    };
  });
  const web =
    root.webSearch === undefined
      ? undefined
      : record(root.webSearch, ['query', 'answer', 'sources', 'excludedSources']);
  const result: WorkspaceMaterialSources = {
    schemaVersion: 'reach-deck-material-sources/v1',
    documents,
    ...(web === undefined
      ? {}
      : {
          webSearch: {
            query: text(web.query, 400),
            answer: text(web.answer),
            sources: array(web.sources, 5).map((value) => {
              const source = record(value, ['title', 'url', 'content']);
              return {
                title: text(source.title, 1000),
                url: url(source.url),
                content: text(source.content),
              };
            }),
            excludedSources: array(web.excludedSources, 5).map((value) => {
              const source = record(value, ['title', 'url', 'reason']);
              if (source.reason !== 'pdf_binary_content' && source.reason !== 'empty_content')
                return invalid();
              return {
                title: text(source.title, 1000),
                url: url(source.url),
                reason: source.reason,
              };
            }),
          },
        }),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MATERIAL_SOURCES_MAX_BYTES)
    return oversized();
  return result;
}
