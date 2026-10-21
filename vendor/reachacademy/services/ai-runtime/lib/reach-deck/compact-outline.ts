import {
  REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
  PAGE_ROLES,
  REACH_DECK_MATERIAL_REFERENCE_ORDINAL_LIMIT,
  VISIBLE_TITLE_MODES,
  parseGeneratedPageOutlineValue,
  parsePlannedVisualAsset,
  parseGeneratedPagedDeckOutlineValue,
  parseReachDeckDesignContextValue,
  type GeneratedPageOutline,
  type GeneratedPagedDeckOutline,
  type LessonPlan,
  type ReachDeckDesignContext,
  type ReferenceCoverageManifest,
} from '@reachany/reach-deck-dsl';
import {
  buildPagedDeckOutlineSchema,
  GENERATION_SCENE_TYPES,
  type ReachDeckModelJsonSchema,
} from './model-service-schemas.js';

import {
  isReferenceMember,
  type ReferenceCategory,
} from '@reachany/reach-deck-dsl/reference-library';
import {
  collectOutlineSchemaIssues,
  OutlineIssueCollector,
} from './outline-validation-diagnostics.js';

export const COMPACT_OUTLINE_VERSION = 'reach-deck-compact-outline/v4';
export const COMPACT_OUTLINE_MAX_PAGES = 40;
export const COMPACT_OUTLINE_MAX_PAGE_BYTES = 32 * 1024;

type ObjectValue = Record<string, any>;

const bounded = (maxLength: number) => ({ type: 'string', maxLength });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });

function removeFields(object: ObjectValue, fields: string[]): void {
  for (const field of fields) delete object.properties[field];
  object.required = object.required.filter((field: string) => !fields.includes(field));
}

/** Compact planning reuses production enums and the planned visual asset union; slides own assets. */
export function buildCompactOutlineSchema(
  enabledSceneTypes: readonly string[] = GENERATION_SCENE_TYPES,
  options: {
    scientificVisualsEnabled?: boolean;
    materialReferenceCount?: number;
    referenceDesign?: boolean;
  } = {},
): ReachDeckModelJsonSchema {
  const output = structuredClone(buildPagedDeckOutlineSchema(enabledSceneTypes, options));
  output.name = 'reach_deck_compact_outline_v4';
  const root = output.schema as ObjectValue;
  const defs = root.$defs;
  root.properties.pages.maxItems = COMPACT_OUTLINE_MAX_PAGES;
  removeFields(root, ['roadmap']);
  removeFields(defs.slideClassification, ['density']);
  // Outline ordinals are global manifest ordinals; the finalizer remaps them to page-local ones.
  defs.plannedReferenceImageAsset.properties.materialReferenceOrdinal =
    (options.materialReferenceCount ?? 0) === 0
      ? { type: 'null' }
      : nullable({
          type: 'integer',
          minimum: 1,
          maximum: Math.min(
            options.materialReferenceCount!,
            REACH_DECK_MATERIAL_REFERENCE_ORDINAL_LIMIT,
          ),
        });
  const object = (properties: ObjectValue) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  });
  const supported = ['slide', 'quiz', 'interactive'].filter((type) =>
    enabledSceneTypes.includes(type),
  );
  if (!supported.length) throw new Error('At least one Reach Deck scene type must be enabled');
  defs.page = {
    anyOf: supported.map((sceneType) => {
      const slide = sceneType === 'slide';
      const spec = object({
        schemaVersion: { type: 'string', const: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3 },
        learningObjective: bounded(500),
        pageRole: {
          type: 'string',
          enum: slide
            ? PAGE_ROLES.filter(
                (role) => !['practice', 'checkpoint', 'exploration', 'attempt'].includes(role),
              )
            : [...PAGE_ROLES],
        },
        pageJob: bounded(1000),
        keyPoints: { type: 'array', items: { type: 'string' } },
        knowledgePointIds: { type: 'array', items: bounded(160) },
        assessmentEvidence: slide ? { type: 'null' } : nullable(bounded(1000)),
        visualDirection: slide ? bounded(1000) : nullable(bounded(1000)),
        ...(slide
          ? {
              density: { type: 'string', enum: ['low', 'medium', 'high'] },
              visibleTitleMode: { type: 'string', enum: [...VISIBLE_TITLE_MODES] },
            }
          : {}),
        visualAssets: {
          type: 'array',
          items: { $ref: '#/$defs/plannedVisualAsset' },
          maxItems: slide ? (options.referenceDesign ? 4 : 3) : 0,
        },
      });
      return object({
        ...defs.page.properties,
        sceneType: { type: 'string', const: sceneType },
        instructionalSpec: spec,
        slideClassification: slide ? { $ref: '#/$defs/slideClassification' } : { type: 'null' },
        interactionBrief:
          sceneType === 'interactive' ? { $ref: '#/$defs/interactionBrief' } : { type: 'null' },
      });
    }),
  };
  const used = new Set<string>();
  function visit(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.split('/').at(-1)!;
      if (!used.has(name)) {
        used.add(name);
        visit(defs[name]);
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== '$defs') visit(child);
  }
  visit(root);
  root.$defs = Object.fromEntries([...used].map((name) => [name, defs[name]]));
  return output;
}

function validate(value: any, schema: ObjectValue, root: ObjectValue, path: string): void {
  if (schema.$ref) return validate(value, root.$defs[schema.$ref.split('/').at(-1)], root, path);
  if (schema.anyOf) {
    const discriminated =
      value && typeof value === 'object' && !Array.isArray(value)
        ? schema.anyOf.find(
            (branch: ObjectValue) =>
              branch?.properties?.sceneType?.const !== undefined &&
              branch.properties.sceneType.const === value.sceneType,
          )
        : undefined;
    if (discriminated !== undefined) return validate(value, discriminated, root, path);
    for (const branch of schema.anyOf) {
      try {
        validate(value, branch, root, path);
        return;
      } catch {
        // Try the next allowed shape.
      }
    }
    throw new Error(`${path}: no allowed shape matched`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum`);
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(`${path}: invalid literal`);
  if (schema.type === 'null') {
    if (value !== null) throw new Error(`${path}: expected null`);
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${path}: expected object`);
    for (const key of schema.required ?? [])
      if (!(key in value)) throw new Error(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (!schema.properties[key]) throw new Error(`${path}.${key}: unknown field`);
      validate(child, schema.properties[key], root, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw new Error(`${path}: invalid array size`);
    value.forEach((child, index) => validate(child, schema.items, root, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      [...value].length > (schema.maxLength ?? Infinity) ||
      [...value].length < (schema.minLength ?? 0)
    )
      throw new Error(`${path}: invalid Unicode character length`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity) ||
      (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
    )
      throw new Error(`${path}: invalid number`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${path}: expected boolean`);
  }
}

function omitNulls(value: any): any {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, omitNulls(child)]),
  );
}

export function parseCompactOutlinePage(
  value: unknown,
  lessonPlan?: LessonPlan,
  schema = buildCompactOutlineSchema(),
  designContext?: ReachDeckDesignContext,
): GeneratedPageOutline {
  const root = schema.schema as ObjectValue;
  validate(value, root.$defs.page, root, 'page');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COMPACT_OUTLINE_MAX_PAGE_BYTES) {
    throw new Error('page: exceeds 32 KiB limit');
  }
  const modelPage = omitNulls(value);
  // Canonicalize the planned assets here; teacher drafts keep incomplete cards editable.
  modelPage.instructionalSpec.visualAssets =
    modelPage.instructionalSpec.visualAssets.map(parsePlannedVisualAsset);
  // The DSL performs the single canonical-to-legacy projection used by saved
  // teacher edits as well. The model never writes duplicate compatibility fields.
  if (modelPage.slideClassification)
    modelPage.slideClassification.density = modelPage.instructionalSpec.density;
  if (modelPage.interactionBrief)
    modelPage.instructionalSpec.interactionBrief = modelPage.interactionBrief;
  return parseGeneratedPageOutlineValue(modelPage, designContext);
}

export interface CompactOutlineFrozenContext {
  designContext?: ReachDeckDesignContext;
  manifestVersion?: string;
  referenceCoverage?: ReferenceCoverageManifest;
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function parseCompactOutlineStrict(
  value: unknown,
  lessonPlan?: LessonPlan,
  schema = buildCompactOutlineSchema(),
  frozen: CompactOutlineFrozenContext = {},
): GeneratedPagedDeckOutline {
  validate(value, schema.schema, schema.schema, 'outline');
  const root = value as ObjectValue;
  const designContext =
    root.designContext === undefined
      ? undefined
      : parseReachDeckDesignContextValue(root.designContext);
  if (
    frozen.designContext !== undefined &&
    canonicalValue(designContext) !==
      canonicalValue(parseReachDeckDesignContextValue(frozen.designContext))
  ) {
    throw new Error('Compact outline design context differs from the frozen generation context.');
  }
  return parseGeneratedPagedDeckOutlineValue({
    title: root.title,
    ...(root.themeName === undefined ? {} : { themeName: root.themeName }),
    ...(designContext === undefined ? {} : { designContext }),
    ...(frozen.manifestVersion === undefined && root.manifestVersion === undefined
      ? {}
      : { manifestVersion: frozen.manifestVersion ?? root.manifestVersion }),
    ...(frozen.referenceCoverage === undefined && root.referenceCoverage === undefined
      ? {}
      : { referenceCoverage: frozen.referenceCoverage ?? root.referenceCoverage }),
    ...(lessonPlan?.story === undefined ? {} : { story: lessonPlan.story }),
    ...(lessonPlan?.story === undefined
      ? {}
      : {
          roadmap: {
            required: false,
            entries: lessonPlan.story.sections.map((section) => ({
              sectionId: section.id,
              label: section.title,
              learnerAction: section.exitOutcome,
              knowledgePointIds:
                lessonPlan.knowledgePlan?.points
                  .filter((point) => point.sectionId === section.id)
                  .map((point) => point.id) ?? [],
            })),
          },
        }),
    pages: root.pages.map((page: unknown) =>
      parseCompactOutlinePage(page, lessonPlan, schema, designContext),
    ),
  });
}

/** Preserve the canonical acceptance boundary; diagnostics are collected only after rejection. */
export function parseCompactOutline(
  value: unknown,
  lessonPlan?: LessonPlan,
  schema = buildCompactOutlineSchema(),
  frozen: CompactOutlineFrozenContext = {},
): GeneratedPagedDeckOutline {
  try {
    return parseCompactOutlineStrict(value, lessonPlan, schema, frozen);
  } catch (error) {
    const collector = new OutlineIssueCollector();
    collectOutlineSchemaIssues(value, schema.schema, schema.schema, 'outline', collector);
    const root = value as ObjectValue | null;
    if (root && typeof root === 'object' && Array.isArray(root.pages)) {
      if (root.pages.length > COMPACT_OUTLINE_MAX_PAGES) collector.truncated = true;
      let designContext: ReachDeckDesignContext | undefined;
      try {
        if (root.designContext !== undefined)
          designContext = parseReachDeckDesignContextValue(root.designContext);
      } catch {
        collector.add('outline.designContext', 'outline-invalid');
      }
      for (let index = 0; index < Math.min(root.pages.length, COMPACT_OUTLINE_MAX_PAGES); index++) {
        if (!collector.visit()) break;
        const page = root.pages[index];
        const path = `outline.pages[${index}]`;
        if (!page || typeof page !== 'object' || Array.isArray(page)) continue;
        // Bound all semantic probes, including canonical parsers and null normalization.
        if (!collector.canInspect(page, COMPACT_OUTLINE_MAX_PAGE_BYTES)) continue;
        let pageBytes = Infinity;
        try {
          pageBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
        } catch {
          collector.truncated = true;
        }
        if (pageBytes > COMPACT_OUTLINE_MAX_PAGE_BYTES) {
          collector.add(path, 'page-too-large');
          continue;
        }
        const assets = page.instructionalSpec?.visualAssets;
        if (Array.isArray(assets)) {
          if (assets.length > 4) collector.truncated = true;
          for (let assetIndex = 0; assetIndex < Math.min(assets.length, 4); assetIndex++) {
            const asset = assets[assetIndex];
            const assetPath = `${path}.instructionalSpec.visualAssets[${assetIndex}]`;
            try {
              parsePlannedVisualAsset(omitNulls(asset));
            } catch {
              let promptInvalid = false;
              if (asset && ['image', 'scientific-visual'].includes(asset.kind)) {
                try {
                  // Reuse the canonical text contract, including markup stripping and UTF-16 limit.
                  parsePlannedVisualAsset({
                    kind: 'image',
                    purpose: 'Diagnostic',
                    alt: 'Diagnostic',
                    aspectRatio: '16:9',
                    placement: 'supporting',
                    prompt: asset.prompt,
                  });
                } catch {
                  promptInvalid = true;
                  collector.add(`${assetPath}.prompt`, 'asset-prompt-invalid');
                }
              }
              if (!promptInvalid) collector.add(assetPath, 'asset-invalid');
            }
          }
        }
        const categories: ReadonlyArray<readonly [string, ReferenceCategory]> = [
          ['layoutReferenceIds', 'layouts'],
          ['componentReferenceIds', 'components'],
          ['imageStyleReferenceIds', 'imageStyles'],
        ];
        for (const [field, category] of categories) {
          const ids = page.designIntent?.[field];
          if (!Array.isArray(ids)) continue;
          const seen = new Set<string>();
          if (ids.length > 200) collector.truncated = true;
          for (let idIndex = 0; idIndex < Math.min(ids.length, 200); idIndex++) {
            const id = ids[idIndex];
            if (typeof id !== 'string' || !isReferenceMember(category, id))
              collector.add(`${path}.designIntent.${field}[${idIndex}]`, 'reference-invalid');
            else if (seen.has(id))
              collector.add(`${path}.designIntent.${field}[${idIndex}]`, 'reference-duplicate');
            if (typeof id === 'string') seen.add(id);
          }
        }
        try {
          parseCompactOutlinePage(page, lessonPlan, schema, designContext);
        } catch {
          if (
            !collector.issues.some(
              (issue) => issue.path === path || issue.path.startsWith(`${path}.`),
            )
          )
            collector.add(path, 'page-invalid');
        }
      }
    }
    if (
      error instanceof Error &&
      error.message === 'Compact outline design context differs from the frozen generation context.'
    )
      collector.add('outline.designContext', 'frozen-context-mismatch');
    throw collector.error();
  }
}
