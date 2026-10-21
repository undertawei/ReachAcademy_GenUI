import {
  MATERIAL_ASSET_ID_PATTERN,
  parseWorkspaceMaterialSources,
  type MaterialReference,
  type WorkspaceMaterialSources,
} from '@reachany/reach-deck-dsl';
import { assertReachDeckMaterialAdmission } from './material-admission.js';
import { loadPreparedReachDeckMaterials } from './prepared-material-store.js';
import { resolveReachDeckMaterialAsset } from './content-service-client.js';
import {
  badRequest,
  readOptionalBoolean,
  readOptionalString,
  readRequiredString,
  type AuthorizedWorkspaceRouteContext,
} from './workspace-route.js';

export async function resolveReachDeckWorkspaceMaterialInput(
  body: Record<string, unknown>,
  scoped: AuthorizedWorkspaceRouteContext,
  defaults: {
    source?: string;
    generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
    systemLanguage?: 'zh-CN' | 'en-US';
    webSearch?: boolean;
    materialReferences?: readonly MaterialReference[];
    materialSources?: WorkspaceMaterialSources;
  } = {},
) {
  let source = readRequiredString(body.source, 'source');
  const preparationId = readOptionalString(body.materialPreparationId, 'materialPreparationId');
  const requestedGenerationLanguage = readOptionalString(
    body.generationLanguage,
    'generationLanguage',
  );
  const requestedSystemLanguage = readOptionalString(body.systemLanguage, 'systemLanguage');
  const generationLanguage = requestedGenerationLanguage ?? defaults.generationLanguage;
  const systemLanguage = requestedSystemLanguage ?? defaults.systemLanguage;
  if (
    generationLanguage !== undefined &&
    !['follow-system', 'zh-CN', 'en-US'].includes(generationLanguage)
  )
    throw badRequest('generationLanguage is invalid');
  if (systemLanguage !== undefined && !['zh-CN', 'en-US'].includes(systemLanguage))
    throw badRequest('systemLanguage is invalid');
  const webSearch =
    readOptionalBoolean(body.webSearch, 'webSearch') ??
    (preparationId === undefined ? defaults.webSearch : false);
  const acceptWarnings = readOptionalBoolean(body.acceptMaterialWarnings, 'acceptMaterialWarnings');
  let materialReferences =
    readMaterialReferences(body.materialReferences) ?? defaults.materialReferences;
  let materialSources =
    source === defaults.source &&
    (body.materialReferences === undefined ||
      JSON.stringify(materialReferences) === JSON.stringify(defaults.materialReferences))
      ? defaults.materialSources
      : undefined;
  if (preparationId !== undefined) {
    if (body.materialReferences !== undefined)
      throw badRequest('Prepared materials cannot include caller materialReferences');
    const prepared = await loadPreparedReachDeckMaterials({
      preparationId,
      source,
      scoped: scoped.workspaceContext,
      webSearch,
      // Preparation identity uses the upload options; workspace defaults apply only after validation.
      generationLanguage: requestedGenerationLanguage,
      systemLanguage: requestedSystemLanguage,
      acceptWarnings,
    });
    source = prepared.source;
    materialReferences = prepared.materialReferences;
    materialSources = prepared.materialSources;
  }
  const input = {
    source,
    ...(generationLanguage === undefined
      ? {}
      : { generationLanguage: generationLanguage as 'follow-system' | 'zh-CN' | 'en-US' }),
    ...(systemLanguage === undefined
      ? {}
      : { systemLanguage: systemLanguage as 'zh-CN' | 'en-US' }),
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(materialReferences === undefined ? {} : { materialReferences }),
    materialSources,
  };
  await assertReachDeckMaterialAdmission({
    ...input,
    context: { ...scoped.jobScope, jobId: 'material-admission', runId: 'material-admission' },
  });
  // 临时素材 24 小时后会被 content-service 清理。调用方本次提交的图片引用（素材准备结果或
  // 直接传入的 materialReferences）在落库前一律换成稳定素材；工作区已有的引用保持原样，
  // 避免已过期的旧引用让一次普通的 source 更新失败。
  const bindsImages = preparationId !== undefined || body.materialReferences !== undefined;
  if (bindsImages && materialReferences !== undefined) {
    const existingIds = new Set(
      preparationId === undefined
        ? (defaults.materialReferences ?? []).map((reference) => reference.id)
        : [],
    );
    const stableIds = new Map<string, string>();
    for (const reference of materialReferences) {
      if (reference.kind !== 'image' || existingIds.has(reference.id)) continue;
      const assetId = reference.id.slice('image:'.length);
      if (!reference.id.startsWith('image:') || !MATERIAL_ASSET_ID_PATTERN.test(assetId)) {
        // 直接传入的引用沿用旧契约：非素材资产形态的 ID 不对应临时素材，保持原样。
        if (preparationId === undefined) continue;
        throw badRequest('Material image id is invalid');
      }
      if (stableIds.has(assetId)) continue;
      const stable = await resolveReachDeckMaterialAsset(assetId, scoped.workspaceContext);
      if (
        stable.checksumSha256 !== reference.sha256 ||
        !MATERIAL_ASSET_ID_PATTERN.test(stable.assetId)
      )
        throw badRequest('Material image binding is invalid');
      stableIds.set(assetId, stable.assetId);
    }
    const stableId = (assetId: string) => stableIds.get(assetId) ?? assetId;
    input.materialReferences = materialReferences.map((reference) => {
      const assetId = reference.id.slice('image:'.length);
      return reference.kind === 'image' && stableIds.has(assetId)
        ? { ...reference, id: `image:${stableIds.get(assetId)!}` }
        : reference;
    });
    if (materialSources !== undefined)
      input.materialSources = parseWorkspaceMaterialSources(
        {
          ...materialSources,
          documents: materialSources.documents.map((document) => ({
            ...document,
            blocks: document.blocks.map((block) =>
              block.type === 'image' ? { ...block, assetId: stableId(block.assetId) } : block,
            ),
          })),
        },
        input.materialReferences,
      );
  }
  return input;
}

function readMaterialReferences(value: unknown): readonly MaterialReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest('materialReferences is invalid');
  return value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.id !== 'string' ||
      typeof entry.fileName !== 'string' ||
      !['text', 'image'].includes(entry.kind) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (entry.page !== undefined && (!Number.isSafeInteger(entry.page) || entry.page < 1))
    )
      throw badRequest('materialReferences is invalid');
    return {
      id: entry.id,
      kind: entry.kind as 'text' | 'image',
      sha256: entry.sha256,
      fileName: entry.fileName,
      ...(entry.page === undefined ? {} : { page: entry.page as number }),
    };
  });
}
