import { createHash } from 'node:crypto';
import {
  officeKindForMetadata,
  OfficeIngestionError,
  prepareOfficeDocument,
} from '@reachany/ai-runtime-common/office-ingestion';

import {
  storeReachDeckMaterialAsset,
  type ContentServiceRequestOptions,
} from './content-service-client.js';
import { parseReachDeckPdf, type ReachDeckParsedDocument } from './model-service-tools.js';
import type { ReachDeckModelRequestContext } from './model-service-client.js';
import { badRequest } from './workspace-route.js';

export const MATERIAL_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
export const MATERIAL_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const MATERIAL_AGGREGATE_MAX_BYTES = 200 * 1024 * 1024;
export interface MaterialWarning {
  fileName: string;
  code: string;
}
export interface ParsedReachDeckMaterial extends ReachDeckParsedDocument {
  warnings: MaterialWarning[];
  blocks?: readonly (
    | { type: 'text'; text: string; page?: number }
    | { type: 'image'; imageIndex: number; page?: number }
  )[];
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
function metadata(file: File) {
  const name = file.name.trim();
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const contentType = (file.type || 'application/octet-stream').split(';', 1)[0]!.toLowerCase();
  return { name, ext, contentType, image: Object.hasOwn(IMAGE_MIME, ext) };
}
function magic(bytes: Uint8Array, expected: number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}
export function reachDeckMaterialFileByteLimit(file: File): number {
  return metadata(file).image ? MATERIAL_IMAGE_MAX_BYTES : MATERIAL_DOCUMENT_MAX_BYTES;
}

/** Validate the complete batch before any parser or asset write runs. */
export async function validateReachDeckMaterialFile(file: File): Promise<void> {
  if (!(file instanceof File) || file.size <= 0 || !file.name.trim())
    throw badRequest('Material file is required');
  const { ext, contentType, image } = metadata(file);
  if (file.size > reachDeckMaterialFileByteLimit(file))
    throw badRequest(
      image
        ? 'Image material must be 15 MiB or smaller'
        : 'Document material must be 50 MiB or smaller',
    );
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (image) {
    if (IMAGE_MIME[ext] !== contentType) throw badRequest('Image MIME does not match extension');
    const valid =
      (ext === '.png' && magic(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      (['.jpg', '.jpeg'].includes(ext) && magic(bytes, [0xff, 0xd8, 0xff])) ||
      (ext === '.webp' &&
        magic(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        magic(bytes, [0x57, 0x45, 0x42, 0x50], 8));
    if (!valid) throw badRequest('Material file signature does not match image format');
  } else if (ext === '.pdf') {
    if (contentType !== 'application/pdf' || !magic(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
      throw badRequest('Material file signature or MIME does not match PDF');
  } else {
    if (!officeKindForMetadata(contentType, ext)) throw badRequest('Unsupported material format');
    if (!magic(bytes, [0x50, 0x4b, 0x03, 0x04]))
      throw badRequest('Office material signature is invalid');
  }
}

export async function parseReachDeckMaterial(
  file: File,
  context: ReachDeckModelRequestContext,
): Promise<ParsedReachDeckMaterial> {
  await validateReachDeckMaterialFile(file);
  const { name, ext, contentType, image } = metadata(file);
  if (ext === '.pdf')
    return { ...(await parseReachDeckPdf(file, name, { context })), warnings: [] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (image)
    return {
      fileName: name,
      contentType,
      sizeBytes: file.size,
      markdown: `[Image material: ${name}; image reference is bound by the application]`,
      provider: 'direct-image',
      images: [
        {
          sha256: materialDigest(bytes),
          mimeType: contentType,
          source: 'direct',
          dataBase64: Buffer.from(bytes).toString('base64'),
        },
      ],
      warnings: [],
      blocks: [{ type: 'image', imageIndex: 0 }],
    };
  const kind = officeKindForMetadata(contentType, ext)!;
  const prepared = await prepareOfficeDocument(bytes, kind, { extractPresentationImages: true });
  const base = { fileName: name, contentType, sizeBytes: file.size, provider: 'office-ingestion' };
  if (prepared.kind === 'docx') {
    let imageIndex = 0;
    return {
      ...base,
      markdown:
        prepared.blocks
          .map((block) => (block.type === 'text' ? block.text : '[Embedded image]'))
          .filter(Boolean)
          .join('\n\n') || '[DOCX contains no readable text]',
      images: prepared.blocks.flatMap((block) =>
        block.type === 'image'
          ? [
              {
                sha256: materialDigest(Buffer.from(block.image.data, 'base64')),
                mimeType: block.image.mimeType,
                source: 'embedded' as const,
                dataBase64: block.image.data,
              },
            ]
          : [],
      ),
      warnings: prepared.warnings.map((code) => ({ fileName: name, code })),
      blocks: prepared.blocks.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'image', imageIndex: imageIndex++ },
      ),
    };
  }
  if (prepared.kind === 'xlsx')
    return {
      ...base,
      markdown: prepared.text || '[XLSX contains no visible cells]',
      warnings: [{ fileName: name, code: 'xlsx_text_only' }],
      blocks: [{ type: 'text', text: prepared.text || '[XLSX contains no visible cells]' }],
    };
  const images: NonNullable<ReachDeckParsedDocument['images']>[number][] = [];
  const blocks: NonNullable<ParsedReachDeckMaterial['blocks']>[number][] = [];
  const warnings: MaterialWarning[] = [];
  let imageBytes = 0;
  const uniqueImageDigests = new Set<string>();
  const appendText = (text: string, page: number) => {
    const previous = blocks.at(-1);
    if (previous?.type === 'text' && previous.page === page) previous.text += '\n' + text;
    else blocks.push({ type: 'text', text, page });
  };
  for (const slide of prepared.slides) {
    for (const block of slide.blocks ?? [{ type: 'text' as const, text: slide.text }]) {
      if (block.type === 'text') {
        appendText(block.text, slide.slideNumber);
        continue;
      }
      const bytes = Buffer.from(block.image.data, 'base64');
      const digest = materialDigest(bytes);
      if (!uniqueImageDigests.has(digest)) {
        uniqueImageDigests.add(digest);
        imageBytes += bytes.byteLength;
      }
      if (
        !bytes.byteLength ||
        bytes.byteLength > MATERIAL_IMAGE_MAX_BYTES ||
        imageBytes > MATERIAL_AGGREGATE_MAX_BYTES
      )
        throw new OfficeIngestionError(
          'processing_budget_exceeded',
          'PPTX image bytes exceed material limits',
        );
      blocks.push({ type: 'image', imageIndex: images.length, page: slide.slideNumber });
      images.push({
        sha256: digest,
        mimeType: block.image.mimeType,
        source: 'embedded',
        page: slide.slideNumber,
        dataBase64: block.image.data,
      });
    }
    for (const code of slide.warnings ?? []) warnings.push({ fileName: name, code });
  }
  return {
    ...base,
    markdown:
      prepared.slides.map((slide) => `## Slide ${slide.slideNumber}\n${slide.text}`).join('\n\n') ||
      '[PPTX contains no visible slides]',
    pageCount: prepared.slides.length,
    images,
    blocks,
    warnings,
  };
}

export function materialDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function persistReachDeckMaterialImages(
  document: ParsedReachDeckMaterial,
  input: {
    runId: string;
    idempotencyKey: string;
    scoped: ContentServiceRequestOptions;
    imagesByDigest?: Map<string, string>;
    onAsset?: (assetId: string) => void;
  },
): Promise<ParsedReachDeckMaterial> {
  const images: NonNullable<ReachDeckParsedDocument['images']>[number][] = [];
  for (const [index, image] of (document.images ?? []).entries()) {
    if (!image.dataBase64) throw badRequest('Parsed material image bytes are missing');
    const bytes = Buffer.from(image.dataBase64, 'base64');
    const sha256 = materialDigest(bytes);
    let assetId = input.imagesByDigest?.get(sha256);
    if (assetId === undefined) {
      const stored = await storeReachDeckMaterialAsset(
        {
          runId: input.runId,
          fileName: document.fileName,
          contentType: image.mimeType,
          sha256,
          bytes,
          idempotencyKey:
            image.source === 'direct'
              ? `${input.idempotencyKey}:direct`
              : `${input.idempotencyKey}:image:${index}`,
        },
        input.scoped,
      );
      assetId = stored.assetId;
      input.onAsset?.(assetId);
      input.imagesByDigest?.set(sha256, assetId);
    }
    images.push({
      sha256,
      mimeType: image.mimeType,
      source: image.source,
      ...(image.page === undefined ? {} : { page: image.page }),
      assetId,
    });
  }
  return { ...document, ...(document.images === undefined ? {} : { images }) };
}
