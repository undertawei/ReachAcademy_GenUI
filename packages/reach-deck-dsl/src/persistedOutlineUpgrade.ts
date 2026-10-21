/**
 * Upgrades page-outline shapes that earlier releases persisted into generation workspaces.
 *
 * The outline parsers stay strict because they also validate fresh model output, where a missing
 * visual route or a retired field must trigger a correction. Saved workspaces cannot be corrected
 * that way, so their exact legacy shapes are rewritten here before the strict parse runs.
 */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const legacyImageKeys = ['purpose', 'prompt', 'alt', 'aspectRatio', 'placement'];
const legacyFunctionPlotKeys = ['kind', 'purpose', 'plot', 'aspectRatio', 'placement', 'alt'];

const upgradeLegacyVisualAsset = (asset: unknown): unknown => {
  if (!isRecord(asset)) return asset;
  // paged-outline/v14 and older image plans had no discriminator.
  if (asset.kind === undefined && hasOnlyKeys(asset, legacyImageKeys)) {
    return { ...asset, kind: 'image' };
  }
  // Function plots predate the diagram union and carried no alt text.
  if (asset.kind === 'function-plot' && hasOnlyKeys(asset, legacyFunctionPlotKeys)) {
    return {
      ...asset,
      kind: 'diagram',
      representation: 'function-plot',
      alt: typeof asset.alt === 'string' && asset.alt.trim() !== '' ? asset.alt : asset.purpose,
    };
  }
  return asset;
};

const upgradeLegacyInstructionalSpec = (spec: unknown): unknown => {
  if (!isRecord(spec)) return spec;
  let next: JsonRecord = spec;
  if (spec.schemaVersion === undefined) {
    // Unversioned specs may predate mandatory visual planning and still carry learnerAction.
    const { learnerAction: _retired, ...rest } = spec;
    next = rest.visualAssets === undefined ? { ...rest, visualAssets: [] } : rest;
  }
  return Array.isArray(next.visualAssets)
    ? { ...next, visualAssets: next.visualAssets.map(upgradeLegacyVisualAsset) }
    : next;
};

export const upgradeLegacyPersistedPageOutline = (page: unknown): unknown => {
  if (!isRecord(page)) return page;
  // The page-level summary was retired; it was never read after the move to instructional specs.
  const { summary: _retired, ...rest } = page;
  return rest.instructionalSpec === undefined
    ? rest
    : { ...rest, instructionalSpec: upgradeLegacyInstructionalSpec(rest.instructionalSpec) };
};

const upgradeOutline = (outline: unknown): unknown =>
  isRecord(outline) && Array.isArray(outline.pages)
    ? { ...outline, pages: outline.pages.map(upgradeLegacyPersistedPageOutline) }
    : outline;

const upgradeRecords = (records: unknown): unknown =>
  isRecord(records)
    ? Object.fromEntries(
        Object.entries(records).map(([pageId, record]) => [
          pageId,
          isRecord(record) && record.page !== undefined
            ? { ...record, page: upgradeLegacyPersistedPageOutline(record.page) }
            : record,
        ]),
      )
    : records;

/** Rewrites every outline page copy (current, staged and prior generation) in a raw workspace. */
export const upgradeLegacyPersistedWorkspaceOutline = (workspace: JsonRecord): JsonRecord => {
  const upgradeKey = (target: JsonRecord, key: string, upgrade: (value: unknown) => unknown) =>
    target[key] === undefined ? target : { ...target, [key]: upgrade(target[key]) };
  let next = upgradeKey(workspace, 'pagedOutline', upgradeOutline);
  next = upgradeKey(next, 'stagedPagedOutline', upgradeOutline);
  next = upgradeKey(next, 'records', upgradeRecords);
  return upgradeKey(next, 'priorGeneration', (prior) =>
    isRecord(prior)
      ? upgradeKey(upgradeKey(prior, 'pagedOutline', upgradeOutline), 'records', upgradeRecords)
      : prior,
  );
};
