const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface MaicCanvasImageBackground {
  mode: 'cover';
  sourceUrl: unknown;
}

export const readMaicCanvasImageBackground = (
  source: unknown,
): MaicCanvasImageBackground | undefined => {
  if (!isRecord(source) || source.type !== 'image' || !isRecord(source.image)) return undefined;
  if (source.image.size !== 'cover') return undefined;
  return { mode: 'cover', sourceUrl: source.image.src };
};
