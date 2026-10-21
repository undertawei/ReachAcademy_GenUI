import { createHash } from 'node:crypto';

/** JSONB may reorder object keys. Hash the JSON value, preserving array order. */
export function wordImportArtifactHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object') {
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return createHash('sha256')
    .update(canonical(JSON.parse(JSON.stringify(value))))
    .digest('hex');
}
