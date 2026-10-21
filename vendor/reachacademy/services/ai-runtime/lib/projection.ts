const PRIVATE_KEYS = new Set(['teachernotes', 'courseagentroster']);

function normalizeKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Tutor grounding retains authoritative answers and explanations so the model
 * can teach accurately. Teacher-private notes remain outside model context.
 */
export function projectForTutor(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[depth limit]';
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => projectForTutor(item, depth + 1));
  }
  if (typeof value !== 'object' || value === null) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(normalizeKey(key))) continue;
    projected[key] = projectForTutor(item, depth + 1);
  }
  return projected;
}
