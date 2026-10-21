import type { PptxBinaryAsset } from '@reachany/importer/pptx';

import { storeReachDeckGeneratedMedia } from './content-service-client.js';
import type { ContentServiceRequestOptions } from './content-service-client.js';
import {
  isReachDeckNormalizableImageType,
  normalizeReachDeckImportRaster,
  REACH_DECK_IMPORT_IMAGE_MAX_BYTES,
  type ReachDeckNormalizedImportRaster,
} from './import-image-normalization.js';
import {
  convertReachDeckPptxMetafile,
  convertReachDeckPptxSvg,
  isReachDeckPptxMetafile,
  isReachDeckPptxSvg,
} from './pptx-metafile.js';
import type { ReachDeckPptxMediaResolver, ReachDeckPptxMediaUpload } from './pptx-import.js';

const UPLOAD_CONCURRENCY = 4;
export type ReachDeckPptxNormalizedAsset = ReachDeckNormalizedImportRaster;

/**
 * Whether a package asset can reach the generated-media bridge at all.
 *
 * Cheap and byte-free: the real gate is `normalizeReachDeckPptxAsset`, which
 * has to decode. Offline harnesses reuse both instead of restating them, so
 * their preflight drops exactly the assets a real import would drop.
 */
export function isStorableReachDeckPptxAsset(asset: PptxBinaryAsset): boolean {
  if (asset.byteLength <= 0) return false;
  return (
    isReachDeckNormalizableImageType(asset.contentType) ||
    isReachDeckPptxMetafile(asset.contentType) ||
    isReachDeckPptxSvg(asset.contentType)
  );
}

/**
 * Bring a package asset within the media pipeline's limits. Returns undefined
 * when the bytes cannot be decoded at all, which the mapper then reports as a
 * lost picture.
 */
export async function normalizeReachDeckPptxAsset(
  asset: PptxBinaryAsset,
): Promise<ReachDeckPptxNormalizedAsset | undefined> {
  if (!isStorableReachDeckPptxAsset(asset)) return undefined;
  // Vector art is what no raster codec can read: a metafile carries legacy
  // equations and clip art, an SVG part carries the icons a modern generator
  // writes without any raster fallback. Rasterizing is what makes either
  // importable at all.
  const metafile = isReachDeckPptxMetafile(asset.contentType);
  if (metafile || isReachDeckPptxSvg(asset.contentType)) {
    const raster = metafile
      ? await convertReachDeckPptxMetafile(asset)
      : await convertReachDeckPptxSvg(asset);
    if (raster === undefined) return undefined;
    // A scaled-up raster of a large drawing can outgrow the generated-media
    // limit. Uploading it anyway would throw and fail the whole import, so it
    // goes through the same normalization as any other oversized picture.
    if (raster.bytes.byteLength <= REACH_DECK_IMPORT_IMAGE_MAX_BYTES) return raster;
    return normalizeReachDeckImportRaster(raster.bytes, raster.contentType);
  }
  return normalizeReachDeckImportRaster(asset.bytes, asset.contentType);
}

export type ReachDeckPptxMediaStorageOptions = ContentServiceRequestOptions;

/**
 * Uploads referenced PPTX images through the shared generated-media bridge.
 *
 * The idempotency key is content-addressed on the *source* asset
 * (`pptx-media:{digest}`), so the resulting object key is a pure function of the
 * package bytes within the module-version scope: preflight and apply converge on
 * the same key, repeats skip the PutObject, and identical images dedupe across
 * imports even when normalization re-encodes them.
 *
 * Assets that cannot be decoded are omitted; the mapper then blocks the owning
 * picture with an explicit diagnostic instead of degrading silently.
 */
export function createReachDeckPptxMediaResolver(
  storageOptions: ReachDeckPptxMediaStorageOptions,
): ReachDeckPptxMediaResolver {
  return async (assets: readonly PptxBinaryAsset[]) => {
    const resolved = new Map<string, ReachDeckPptxMediaUpload>();
    const queue = assets.filter(isStorableReachDeckPptxAsset);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const asset = queue[cursor];
        cursor += 1;
        const normalized = await normalizeReachDeckPptxAsset(asset);
        if (normalized === undefined) continue;
        const stored = await storeReachDeckGeneratedMedia(
          {
            kind: 'image',
            idempotencyKey: `pptx-media:${asset.digest}`,
            contentType: normalized.contentType,
            bytes: normalized.bytes,
          },
          storageOptions,
        );
        resolved.set(asset.partPath, {
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          previewUrl: stored.downloadUrl,
        });
      }
    });
    await Promise.all(workers);
    return resolved;
  };
}
