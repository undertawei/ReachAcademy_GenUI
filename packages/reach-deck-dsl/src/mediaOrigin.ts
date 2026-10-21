/** Durable provenance for a managed visual; temporary download URLs never belong here. */
export interface ReachDeckMediaOrigin {
  schemaVersion: 'reach-deck-media-origin/v1';
  route: 'reference-image' | 'diagram' | 'image';
  provider?: string;
  sourceId?: string;
  sourceUrl?: string;
  title?: string;
  description?: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  engine?: string;
  rendererVersion?: string;
  sourceDigest?: string;
}

/** 占位标识跟随媒体资源复制，不能依赖可能已被退役的页面生成记录。 */
export const REACH_DECK_PLACEHOLDER_MEDIA_PROVIDER = 'reach-deck-placeholder/v1';
export const REACH_DECK_PLACEHOLDER_MEDIA_ORIGIN: Readonly<ReachDeckMediaOrigin> = Object.freeze({
  schemaVersion: 'reach-deck-media-origin/v1',
  route: 'image',
  provider: REACH_DECK_PLACEHOLDER_MEDIA_PROVIDER,
});

const fields = [
  'provider',
  'sourceId',
  'sourceUrl',
  'title',
  'description',
  'author',
  'license',
  'licenseUrl',
  'attribution',
  'engine',
  'rendererVersion',
  'sourceDigest',
] as const;

export function parseReachDeckMediaOrigin(value: unknown): ReachDeckMediaOrigin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Reach Deck media origin.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(['schemaVersion', 'route', ...fields]);
  if (
    record.schemaVersion !== 'reach-deck-media-origin/v1' ||
    !['reference-image', 'diagram', 'image'].includes(record.route as string) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error('Invalid Reach Deck media origin contract.');
  }
  const result: ReachDeckMediaOrigin = {
    schemaVersion: 'reach-deck-media-origin/v1',
    route: record.route as ReachDeckMediaOrigin['route'],
  };
  for (const field of fields) {
    const candidate = record[field];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== 'string' ||
      !candidate.trim() ||
      candidate.length > 4000 ||
      /[\u0000-\u001f]/u.test(candidate)
    ) {
      throw new Error(`Invalid media origin ${field}.`);
    }
    const text = candidate.trim();
    if (field === 'sourceUrl' || field === 'licenseUrl') {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        throw new Error(`Invalid media origin ${field}.`);
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) =>
          /(?:signature|credential|security-token|access[_-]?token|api[_-]?key|expires|^x-amz-|^x-oss-|^auth[_-]?key$|^sign$|^token$)/i.test(
            key,
          ),
        )
      ) {
        throw new Error(`Media origin ${field} must be a stable public source URL.`);
      }
    }
    if (field === 'sourceDigest' && !/^[a-f0-9]{64}$/i.test(text)) {
      throw new Error('Media origin sourceDigest must be a SHA-256 digest.');
    }
    result[field] = text;
  }
  return result;
}
