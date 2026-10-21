import type {
  PageInstructionalSpec,
  PlannedImageVisualAsset,
  PlannedVisualAsset,
} from './generationTypes.js';
import { parsePlannedVisualAsset } from './generationTypes.js';
import { parseRestrictedMarkdown } from './markdownSubset.js';
import {
  isSlideContentType,
  type SlideContentClassification,
  type SlideContentType,
} from './slideSemantics.js';
import type { DrawingColorToken, ShapeFillToken } from './types.js';

type WorkedExampleInstructionalSpec = Omit<PageInstructionalSpec, 'visualAssets'>;
type WorkedExampleColorToken = 'ink' | 'muted' | 'accent' | 'success' | 'warning';

export interface GeneratedExampleFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number | null;
}

interface GeneratedExampleBaseElement {
  id: string;
  layer: number;
  ariaLabel: string | null;
}

export interface GeneratedExampleTextElement extends GeneratedExampleBaseElement {
  type: 'text';
  frame: GeneratedExampleFrame;
  markdown: string;
  variant: 'title' | 'body' | 'caption';
  colorToken: WorkedExampleColorToken | null;
}

export interface GeneratedExampleShapeElement extends GeneratedExampleBaseElement {
  type: 'shape';
  frame: GeneratedExampleFrame;
  shape: 'rect' | 'roundRect';
  fillToken: ShapeFillToken;
  strokeToken: DrawingColorToken | null;
}

export interface GeneratedExampleLineElement extends GeneratedExampleBaseElement {
  type: 'line';
  start: { x: number; y: number };
  end: { x: number; y: number };
  role: 'divider' | 'connector' | 'arrow';
  colorToken: DrawingColorToken;
}

export interface GeneratedExampleImageElement extends GeneratedExampleBaseElement {
  type: 'image';
  frame: GeneratedExampleFrame;
  assetId: string;
  fit: 'cover' | 'contain';
  caption: string | null;
}

export type GeneratedExampleElement =
  | GeneratedExampleTextElement
  | GeneratedExampleShapeElement
  | GeneratedExampleLineElement
  | GeneratedExampleImageElement;

/** 模型可模仿的生成侧 slide 形态；不含 doc、objectKey、URL 或 native-v2 字段。 */
export interface GeneratedSlideExample {
  id: string;
  title: string;
  layout: 'freeform';
  duration: number;
  background: string;
  elements: GeneratedExampleElement[];
}

export interface ResolvedWorkedExampleMediaAsset extends PlannedImageVisualAsset {
  assetId: string;
  kind: 'image';
}

/**
 * 一条完整 input → output 算例。它教授构图机制，不是模板或 slot contract；slide 中的
 * 1600×900 坐标只是可改写范例，运行时模型仍自由决定所有元素及坐标。
 */
export interface LayoutWorkedExample {
  id: string;
  version: number;
  brief: {
    instructionalSpec: WorkedExampleInstructionalSpec;
    classification: SlideContentClassification;
    visibleCopyBudget: string;
    visualAssets: PlannedVisualAsset[];
  };
  resolvedMediaAssets: ResolvedWorkedExampleMediaAsset[];
  compositionNotes: string[];
  slide: GeneratedSlideExample;
}

export interface LayoutReference {
  id: string;
  version: number;
  name: string;
  appliesTo: {
    contentTypes: SlideContentType[];
    itemCount?: { min: number; max: number };
    density?: SlideContentClassification['density'][];
    mediaTypes?: SlideContentClassification['mediaType'][];
    visualFocus?: SlideContentClassification['visualFocus'][];
  };
  principles: string[];
  readingPath: string;
  focalHierarchy: string[];
  recommendedRatios: string[];
  capacityGuidance: string[];
  adaptationRules: string[];
  antiPatterns: string[];
  /** 每条 reference 包含一条完整算例；同一 primaryType 可有多条人工校阅的构图变体。 */
  examples: LayoutWorkedExample[];
}

export interface LayoutReferenceMatch {
  id: string;
  version: number;
  score: number;
}

export interface OutlinePlanningWorkedExample {
  id: string;
  version: number;
  input: {
    instructionalSpec: WorkedExampleInstructionalSpec;
    classification: SlideContentClassification;
  };
  output: { visualAssets: PlannedVisualAsset[] };
}

export interface SlideLayoutWorkedExample {
  id: string;
  version: number;
  input: {
    instructionalSpec: WorkedExampleInstructionalSpec;
    classification: SlideContentClassification;
    visibleCopyBudget: string;
    resolvedMediaAssets: ResolvedWorkedExampleMediaAsset[];
  };
  output: { compositionNotes: string[]; slide: GeneratedSlideExample };
}

const densities = new Set(['low', 'medium', 'high']);
const mediaTypes = new Set(['none', 'image', 'diagram', 'chart', 'equation', 'code']);
const visualFocuses = new Set([
  'statement',
  'process',
  'relationship',
  'evidence',
  'example',
  'summary',
]);
const teachingMoves = new Set([
  'engage',
  'explore',
  'explain',
  'demonstrate',
  'practice',
  'evaluate',
  'transfer',
]);
const aspectRatios = new Set(['16:9', '4:3', '1:1', '3:4']);
const placements = new Set(['hero', 'primary', 'supporting']);
const variants = new Set(['title', 'body', 'caption']);
const colorTokens = new Set(['ink', 'muted', 'accent', 'success', 'warning']);
const fillTokens = new Set(['surface', 'accentSoft', 'successSoft', 'warningSoft', 'ink']);
const shapeKinds = new Set(['rect', 'roundRect']);
const lineRoles = new Set(['divider', 'connector', 'arrow']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};
const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isPositiveInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value > 0;
const isOneOf = (value: unknown, values: ReadonlySet<string>): value is string =>
  isString(value) && values.has(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const parseVisualAsset = (value: unknown): PlannedImageVisualAsset => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'purpose', 'prompt', 'alt', 'aspectRatio', 'placement']) ||
    value.kind !== 'image' ||
    !isNonEmptyString(value.purpose) ||
    !isNonEmptyString(value.prompt) ||
    !isNonEmptyString(value.alt) ||
    !isOneOf(value.aspectRatio, aspectRatios) ||
    !isOneOf(value.placement, placements)
  ) {
    throw new Error('Layout worked example visual asset is invalid.');
  }
  return value as unknown as PlannedImageVisualAsset;
};

const parseInstructionalSpec = (value: unknown): WorkedExampleInstructionalSpec => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['learningObjective', 'teachingMove', 'keyPoints', 'visualDirection', 'density'],
      ['assessmentEvidence'],
    ) ||
    !isNonEmptyString(value.learningObjective) ||
    !isOneOf(value.teachingMove, teachingMoves) ||
    !Array.isArray(value.keyPoints) ||
    value.keyPoints.length < 2 ||
    value.keyPoints.length > 6 ||
    !value.keyPoints.every(isNonEmptyString) ||
    !isNonEmptyString(value.visualDirection) ||
    !isOneOf(value.density, densities) ||
    (value.assessmentEvidence !== undefined && !isNonEmptyString(value.assessmentEvidence))
  ) {
    throw new Error('Layout worked example instructional spec is invalid.');
  }
  return value as unknown as WorkedExampleInstructionalSpec;
};

const parseClassification = (value: unknown): SlideContentClassification => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'primaryType',
        'itemCount',
        'density',
        'visualFocus',
        'mediaType',
        'confidence',
        'rationale',
      ],
      ['secondaryType'],
    ) ||
    !isSlideContentType(value.primaryType) ||
    (value.secondaryType !== undefined && !isSlideContentType(value.secondaryType)) ||
    !isPositiveInteger(value.itemCount) ||
    !isOneOf(value.density, densities) ||
    !isOneOf(value.visualFocus, visualFocuses) ||
    !isOneOf(value.mediaType, mediaTypes) ||
    !isFiniteNumber(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !isNonEmptyString(value.rationale)
  ) {
    throw new Error('Layout worked example classification is invalid.');
  }
  return value as unknown as SlideContentClassification;
};

const parseFrame = (value: unknown): GeneratedExampleFrame => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['x', 'y', 'width', 'height', 'rotation']) ||
    !isFiniteNumber(value.x) ||
    value.x < 0 ||
    !isFiniteNumber(value.y) ||
    value.y < 0 ||
    !isFiniteNumber(value.width) ||
    value.width <= 0 ||
    !isFiniteNumber(value.height) ||
    value.height <= 0 ||
    value.x + value.width > 1600 ||
    value.y + value.height > 900 ||
    (value.rotation !== null && !isFiniteNumber(value.rotation))
  ) {
    throw new Error('Layout worked example frame is invalid.');
  }
  return value as unknown as GeneratedExampleFrame;
};

const parsePoint = (value: unknown): { x: number; y: number } => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['x', 'y']) ||
    !isFiniteNumber(value.x) ||
    value.x < 0 ||
    value.x > 1600 ||
    !isFiniteNumber(value.y) ||
    value.y < 0 ||
    value.y > 900
  ) {
    throw new Error('Layout worked example point is invalid.');
  }
  return { x: value.x, y: value.y };
};

const parseElement = (value: unknown): GeneratedExampleElement => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isFiniteNumber(value.layer) ||
    (value.ariaLabel !== null && !isNonEmptyString(value.ariaLabel)) ||
    !isNonEmptyString(value.type)
  ) {
    throw new Error('Layout worked example element is invalid.');
  }
  const base = ['id', 'layer', 'ariaLabel', 'type'];
  switch (value.type) {
    case 'text':
      if (
        !hasExactKeys(value, [...base, 'frame', 'markdown', 'variant', 'colorToken']) ||
        !isNonEmptyString(value.markdown) ||
        !isOneOf(value.variant, variants) ||
        (value.colorToken !== null && !isOneOf(value.colorToken, colorTokens))
      )
        throw new Error('Layout worked example text is invalid.');
      parseFrame(value.frame);
      break;
    case 'shape':
      if (
        !hasExactKeys(value, [...base, 'frame', 'shape', 'fillToken', 'strokeToken']) ||
        !isOneOf(value.shape, shapeKinds) ||
        !isOneOf(value.fillToken, fillTokens) ||
        (value.strokeToken !== null && !isOneOf(value.strokeToken, colorTokens))
      )
        throw new Error('Layout worked example shape is invalid.');
      parseFrame(value.frame);
      break;
    case 'line': {
      if (
        !hasExactKeys(value, [...base, 'start', 'end', 'role', 'colorToken']) ||
        !isOneOf(value.role, lineRoles) ||
        !isOneOf(value.colorToken, colorTokens)
      )
        throw new Error('Layout worked example line is invalid.');
      const start = parsePoint(value.start);
      const end = parsePoint(value.end);
      if (start.x === end.x && start.y === end.y)
        throw new Error('Layout worked example line has zero length.');
      break;
    }
    case 'image':
      if (
        !hasExactKeys(value, [...base, 'frame', 'assetId', 'fit', 'caption']) ||
        !isNonEmptyString(value.assetId) ||
        (value.fit !== 'cover' && value.fit !== 'contain') ||
        (value.caption !== null && !isString(value.caption))
      )
        throw new Error('Layout worked example image is invalid.');
      parseFrame(value.frame);
      break;
    default:
      throw new Error('Layout worked example uses an unsupported element type.');
  }
  return value as unknown as GeneratedExampleElement;
};

const parseWorkedExample = (value: unknown): LayoutWorkedExample => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'version',
      'brief',
      'resolvedMediaAssets',
      'compositionNotes',
      'slide',
    ]) ||
    !isNonEmptyString(value.id) ||
    !isPositiveInteger(value.version) ||
    !isRecord(value.brief) ||
    !hasExactKeys(value.brief, [
      'instructionalSpec',
      'classification',
      'visibleCopyBudget',
      'visualAssets',
    ]) ||
    !isNonEmptyString(value.brief.visibleCopyBudget) ||
    !Array.isArray(value.brief.visualAssets) ||
    value.brief.visualAssets.length > 3 ||
    !Array.isArray(value.resolvedMediaAssets) ||
    value.resolvedMediaAssets.length > 3 ||
    !strings(value.compositionNotes) ||
    !isRecord(value.slide) ||
    !hasExactKeys(value.slide, ['id', 'title', 'layout', 'duration', 'background', 'elements']) ||
    !isNonEmptyString(value.slide.id) ||
    !isNonEmptyString(value.slide.title) ||
    value.slide.layout !== 'freeform' ||
    !isFiniteNumber(value.slide.duration) ||
    value.slide.duration <= 0 ||
    !isNonEmptyString(value.slide.background) ||
    !Array.isArray(value.slide.elements) ||
    value.slide.elements.length === 0
  ) {
    throw new Error('Value is not a valid layout worked example.');
  }
  const visualAssets = value.brief.visualAssets.map(parsePlannedVisualAsset);
  const resolvedMediaAssets = value.resolvedMediaAssets.map((asset) => {
    if (
      !isRecord(asset) ||
      !hasExactKeys(asset, [
        'assetId',
        'kind',
        'purpose',
        'prompt',
        'alt',
        'aspectRatio',
        'placement',
      ]) ||
      !isNonEmptyString(asset.assetId) ||
      asset.kind !== 'image'
    )
      throw new Error('Layout worked example resolved media is invalid.');
    return {
      assetId: asset.assetId,
      ...parseVisualAsset({
        kind: 'image',
        purpose: asset.purpose,
        prompt: asset.prompt,
        alt: asset.alt,
        aspectRatio: asset.aspectRatio,
        placement: asset.placement,
      }),
    };
  });
  const elements = value.slide.elements.map(parseElement);
  const ids = elements.map((element) => element.id);
  if (new Set(ids).size !== ids.length)
    throw new Error('Layout worked example contains duplicate element ids.');
  const commonSignature = (asset: PlannedVisualAsset) =>
    JSON.stringify({
      purpose: asset.purpose,
      alt: asset.alt,
      aspectRatio: asset.aspectRatio,
      placement: asset.placement,
      prompt: 'prompt' in asset ? asset.prompt : undefined,
    });
  const plannedSignature = visualAssets.map(commonSignature);
  const resolvedSignature = resolvedMediaAssets.map(commonSignature);
  if (plannedSignature.join('\n') !== resolvedSignature.join('\n'))
    throw new Error('Layout worked example media plan and manifest do not correspond.');
  const suppliedIds = resolvedMediaAssets.map((asset) => asset.assetId);
  if (new Set(suppliedIds).size !== suppliedIds.length)
    throw new Error('Layout worked example contains duplicate asset ids.');
  const usedIds = elements.flatMap((element) =>
    element.type === 'image' ? [element.assetId] : [],
  );
  if (
    usedIds.length !== suppliedIds.length ||
    usedIds.some((id) => !suppliedIds.includes(id)) ||
    new Set(usedIds).size !== usedIds.length
  ) {
    throw new Error('Layout worked example must use every resolved media asset exactly once.');
  }
  return {
    id: value.id,
    version: value.version,
    brief: {
      instructionalSpec: parseInstructionalSpec(value.brief.instructionalSpec),
      classification: parseClassification(value.brief.classification),
      visibleCopyBudget: value.brief.visibleCopyBudget,
      visualAssets,
    },
    resolvedMediaAssets,
    compositionNotes: [...value.compositionNotes],
    slide: { ...value.slide, elements } as GeneratedSlideExample,
  };
};

const parseAppliesTo = (value: unknown): LayoutReference['appliesTo'] => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['contentTypes'], ['itemCount', 'density', 'mediaTypes', 'visualFocus']) ||
    !Array.isArray(value.contentTypes) ||
    value.contentTypes.length === 0 ||
    !value.contentTypes.every(isSlideContentType)
  )
    throw new Error('Layout reference appliesTo is invalid.');
  if (
    value.itemCount !== undefined &&
    (!isRecord(value.itemCount) ||
      !hasExactKeys(value.itemCount, ['min', 'max']) ||
      !isPositiveInteger(value.itemCount.min) ||
      !isPositiveInteger(value.itemCount.max) ||
      value.itemCount.min > value.itemCount.max)
  )
    throw new Error('Layout reference itemCount is invalid.');
  if (
    value.density !== undefined &&
    (!Array.isArray(value.density) || !value.density.every((item) => isOneOf(item, densities)))
  )
    throw new Error('Layout reference density is invalid.');
  if (
    value.mediaTypes !== undefined &&
    (!Array.isArray(value.mediaTypes) ||
      !value.mediaTypes.every((item) => isOneOf(item, mediaTypes)))
  )
    throw new Error('Layout reference media types are invalid.');
  if (
    value.visualFocus !== undefined &&
    (!Array.isArray(value.visualFocus) ||
      !value.visualFocus.every((item) => isOneOf(item, visualFocuses)))
  )
    throw new Error('Layout reference visual focus is invalid.');
  return structuredClone(value) as LayoutReference['appliesTo'];
};

export const parseLayoutReferenceValue = (value: unknown): LayoutReference => {
  const fields = [
    'id',
    'version',
    'name',
    'appliesTo',
    'principles',
    'readingPath',
    'focalHierarchy',
    'recommendedRatios',
    'capacityGuidance',
    'adaptationRules',
    'antiPatterns',
    'examples',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, fields) ||
    !isNonEmptyString(value.id) ||
    !isPositiveInteger(value.version) ||
    !isNonEmptyString(value.name) ||
    !strings(value.principles) ||
    !isNonEmptyString(value.readingPath) ||
    !strings(value.focalHierarchy) ||
    !strings(value.recommendedRatios) ||
    !strings(value.capacityGuidance) ||
    !strings(value.adaptationRules) ||
    !strings(value.antiPatterns) ||
    !Array.isArray(value.examples) ||
    value.examples.length === 0
  )
    throw new Error('Value is not a valid layout reference.');
  const examples = value.examples.map(parseWorkedExample);
  const keys = examples.map((example) => `${example.id}\u0000${example.version}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('Layout reference contains duplicate worked examples.');
  return {
    ...structuredClone(value),
    appliesTo: parseAppliesTo(value.appliesTo),
    examples,
  } as LayoutReference;
};

export const parseLayoutReferenceMatchValue = (value: unknown): LayoutReferenceMatch => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'version', 'score']) ||
    !isNonEmptyString(value.id) ||
    !isPositiveInteger(value.version) ||
    !isFiniteNumber(value.score)
  )
    throw new Error('Value is not a valid layout reference match.');
  return { id: value.id, version: value.version, score: value.score };
};

export const isLayoutReference = (value: unknown): value is LayoutReference => {
  try {
    parseLayoutReferenceValue(value);
    return true;
  } catch {
    return false;
  }
};

export const isLayoutReferenceMatch = (value: unknown): value is LayoutReferenceMatch => {
  try {
    parseLayoutReferenceMatchValue(value);
    return true;
  } catch {
    return false;
  }
};

export function validateLayoutReferenceCatalog(value: unknown): asserts value is LayoutReference[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Layout reference catalog must contain at least one valid reference.');
  value.forEach((reference, index) => {
    try {
      parseLayoutReferenceValue(reference);
    } catch (error) {
      throw new Error(
        `Layout reference catalog entry ${index} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  const keys = value.map((reference) => `${reference.id}\u0000${reference.version}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('Layout reference catalog contains a duplicate id and version.');
}

export const projectWorkedExampleForOutline = (
  example: LayoutWorkedExample,
): OutlinePlanningWorkedExample => ({
  id: example.id,
  version: example.version,
  input: {
    instructionalSpec: structuredClone(example.brief.instructionalSpec),
    classification: structuredClone(example.brief.classification),
  },
  output: { visualAssets: structuredClone(example.brief.visualAssets) },
});

export const projectWorkedExampleForSlide = (
  example: LayoutWorkedExample,
): SlideLayoutWorkedExample => ({
  id: example.id,
  version: example.version,
  input: {
    instructionalSpec: structuredClone(example.brief.instructionalSpec),
    classification: structuredClone(example.brief.classification),
    visibleCopyBudget: example.brief.visibleCopyBudget,
    resolvedMediaAssets: structuredClone(example.resolvedMediaAssets),
  },
  output: {
    compositionNotes: [...example.compositionNotes],
    slide: structuredClone(example.slide),
  },
});

/** 测试/目录验证用：将 assetId 和 markdown 确定性物化成可由 v1 parser 接受的形态。 */
export const materializeWorkedExampleSlide = (example: LayoutWorkedExample): unknown => {
  const assets = new Map(
    example.resolvedMediaAssets.map((asset) => [asset.assetId, asset] as const),
  );
  const modelBase = (element: GeneratedExampleElement): Record<string, unknown> => {
    const { ariaLabel, ...withoutAria } = element;
    const withAria = ariaLabel === null ? withoutAria : { ...withoutAria, ariaLabel };
    if (!('frame' in withAria)) return withAria;
    const { rotation, ...withoutRotation } = withAria.frame;
    return {
      ...withAria,
      frame: rotation === null ? withoutRotation : withAria.frame,
    };
  };
  return {
    ...structuredClone(example.slide),
    elements: example.slide.elements.map((element) => {
      if (element.type === 'text') {
        const { markdown, colorToken, ...rest } = element;
        return {
          ...modelBase(rest as GeneratedExampleElement),
          ...(colorToken === null ? {} : { colorToken }),
          doc: parseRestrictedMarkdown(markdown).doc,
        };
      }
      if (element.type === 'shape') {
        const { strokeToken, ...rest } = element;
        return {
          ...modelBase(rest as GeneratedExampleElement),
          ...(strokeToken === null ? {} : { strokeToken }),
        };
      }
      if (element.type === 'image') {
        const asset = assets.get(element.assetId)!;
        const { assetId, caption, ...rest } = element;
        return {
          ...modelBase(rest as GeneratedExampleElement),
          objectKey: `worked-examples/${example.id}/${assetId}.png`,
          alt: asset.alt,
          ...(caption === null ? {} : { caption }),
        };
      }
      return modelBase(element);
    }),
    animations: [],
    voiceTimeline: [],
  };
};
