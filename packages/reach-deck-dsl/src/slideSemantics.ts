export const SLIDE_CONTENT_TYPES = [
  'single_focus',
  'parallel_items',
  'comparison',
  'sequence',
  'cause_effect',
  'hierarchy',
  'network',
  'data_evidence',
  'worked_steps',
  'media_annotation',
  'question_reveal',
  'summary_map',
] as const;

export type SlideContentType = (typeof SLIDE_CONTENT_TYPES)[number];

export const SLIDE_PAGE_ROLES = [
  'cover',
  'closing',
  'agenda',
  'section_break',
  'content',
  'summary',
  'practice',
  'observe',
  'feedback',
  'objective',
] as const;

export type SlidePageRole = (typeof SLIDE_PAGE_ROLES)[number];

/** Historical pages never infer a cover from an opening narrative or a title. */
export function resolveSlidePageRole(input: {
  pageRole?: SlidePageRole;
  narrativeRole?: SlideContentBlueprint['narrativeRole'];
  sceneType?: string;
}): SlidePageRole {
  if (input.pageRole) return input.pageRole;
  if (input.narrativeRole) {
    if (input.narrativeRole === 'practice') return 'practice';
    if (input.narrativeRole === 'conclude') return 'summary';
    if (input.narrativeRole === 'demonstrate') return 'observe';
    return 'content';
  }
  return input.sceneType === 'quiz' ? 'practice' : 'content';
}

export interface SlideContentBlueprint {
  pageId: string;
  learningGoal: string;
  keyMessage: string;
  audienceAssumption: string;
  narrativeRole: 'open' | 'explain' | 'demonstrate' | 'practice' | 'connect' | 'conclude';
  contentUnits: Array<{
    id: string;
    role: 'claim' | 'fact' | 'example' | 'step' | 'evidence' | 'label' | 'prompt' | 'takeaway';
    text: string;
    priority: 'primary' | 'supporting' | 'optional';
  }>;
  desiredStudentAttention: string;
  mediaIntent?: {
    kind: 'none' | 'image' | 'scientific-visual' | 'diagram' | 'chart' | 'equation' | 'code';
    purpose?: string;
    assetRequest?: {
      prompt: string;
      alt: string;
      aspectRatio: '16:9' | '4:3' | '1:1' | '3:4';
      placement: 'hero' | 'primary' | 'supporting';
    };
  };
  voicePlan?: Array<{
    id: string;
    label: string;
    narration: string;
    targetContentUnitIds: string[];
  }>;
}

export interface SlideContentClassification {
  primaryType: SlideContentType;
  secondaryType?: SlideContentType;
  itemCount: number;
  density: 'low' | 'medium' | 'high';
  visualFocus: 'statement' | 'process' | 'relationship' | 'evidence' | 'example' | 'summary';
  mediaType: 'none' | 'image' | 'scientific-visual' | 'diagram' | 'chart' | 'equation' | 'code';
  confidence: number;
  rationale: string;
}

export interface SlideSemanticAnalysis {
  blueprint: SlideContentBlueprint;
  classification: SlideContentClassification;
}

const contentTypes = new Set<string>(SLIDE_CONTENT_TYPES);
const narrativeRoles = new Set([
  'open',
  'explain',
  'demonstrate',
  'practice',
  'connect',
  'conclude',
]);
const contentUnitRoles = new Set([
  'claim',
  'fact',
  'example',
  'step',
  'evidence',
  'label',
  'prompt',
  'takeaway',
]);
const priorities = new Set(['primary', 'supporting', 'optional']);
const mediaTypes = new Set([
  'none',
  'image',
  'scientific-visual',
  'diagram',
  'chart',
  'equation',
  'code',
]);
const assetAspectRatios = new Set(['16:9', '4:3', '1:1', '3:4']);
const assetPlacements = new Set(['hero', 'primary', 'supporting']);
const densities = new Set(['low', 'medium', 'high']);
const visualFocuses = new Set([
  'statement',
  'process',
  'relationship',
  'evidence',
  'example',
  'summary',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isOneOf = (value: unknown, allowed: Set<string>): value is string =>
  typeof value === 'string' && allowed.has(value);
const hasUniqueIds = (items: Array<{ id: string }>): boolean =>
  items.length === new Set(items.map((item) => item.id)).size;

export const isSlideContentType = (value: unknown): value is SlideContentType =>
  isOneOf(value, contentTypes);

const parseContentUnit = (value: unknown): SlideContentBlueprint['contentUnits'][number] => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'role', 'text', 'priority']) ||
    !isNonEmptyString(value.id) ||
    !isOneOf(value.role, contentUnitRoles) ||
    !isNonEmptyString(value.text) ||
    !isOneOf(value.priority, priorities)
  ) {
    throw new Error('AI provider returned an invalid slide content unit.');
  }
  return {
    id: value.id,
    role: value.role as SlideContentBlueprint['contentUnits'][number]['role'],
    text: value.text,
    priority: value.priority as SlideContentBlueprint['contentUnits'][number]['priority'],
  };
};

const parseMediaIntent = (value: unknown): NonNullable<SlideContentBlueprint['mediaIntent']> => {
  if (
    !isRecord(value) ||
    // renderFallback was dropped from the blueprint, but persisted workspaces still carry it;
    // accept and discard it so pre-existing decks keep loading.
    !hasExactKeys(value, ['kind'], ['purpose', 'assetRequest', 'renderFallback']) ||
    !isOneOf(value.kind, mediaTypes) ||
    (value.purpose !== undefined && !isNonEmptyString(value.purpose)) ||
    (value.assetRequest !== undefined && !isRecord(value.assetRequest))
  ) {
    throw new Error('AI provider returned an invalid slide media intent.');
  }
  let assetRequest:
    | NonNullable<NonNullable<SlideContentBlueprint['mediaIntent']>['assetRequest']>
    | undefined;
  if (value.assetRequest !== undefined) {
    if (
      value.kind !== 'image' ||
      !hasExactKeys(value.assetRequest, ['prompt', 'alt', 'aspectRatio', 'placement']) ||
      !isNonEmptyString(value.assetRequest.prompt) ||
      !isNonEmptyString(value.assetRequest.alt) ||
      !isOneOf(value.assetRequest.aspectRatio, assetAspectRatios) ||
      !isOneOf(value.assetRequest.placement, assetPlacements)
    ) {
      throw new Error('AI provider returned an invalid slide media asset request.');
    }
    assetRequest = {
      prompt: value.assetRequest.prompt,
      alt: value.assetRequest.alt,
      aspectRatio: value.assetRequest.aspectRatio as NonNullable<
        NonNullable<SlideContentBlueprint['mediaIntent']>['assetRequest']
      >['aspectRatio'],
      placement: value.assetRequest.placement as NonNullable<
        NonNullable<SlideContentBlueprint['mediaIntent']>['assetRequest']
      >['placement'],
    };
  }
  return {
    kind: value.kind as NonNullable<SlideContentBlueprint['mediaIntent']>['kind'],
    ...(value.purpose !== undefined ? { purpose: value.purpose } : {}),
    ...(assetRequest === undefined ? {} : { assetRequest }),
  };
};

const parseVoicePlanItem = (
  value: unknown,
): NonNullable<SlideContentBlueprint['voicePlan']>[number] => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'label', 'narration', 'targetContentUnitIds']) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.label) ||
    !isNonEmptyString(value.narration) ||
    !Array.isArray(value.targetContentUnitIds) ||
    !value.targetContentUnitIds.every(isNonEmptyString)
  ) {
    throw new Error('AI provider returned an invalid slide voice plan item.');
  }
  return {
    id: value.id,
    label: value.label,
    narration: value.narration,
    targetContentUnitIds: [...value.targetContentUnitIds],
  };
};

export const parseSlideContentBlueprintValue = (value: unknown): SlideContentBlueprint => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'pageId',
        'learningGoal',
        'keyMessage',
        'audienceAssumption',
        'narrativeRole',
        'contentUnits',
        'desiredStudentAttention',
      ],
      ['mediaIntent', 'voicePlan'],
    ) ||
    !isNonEmptyString(value.pageId) ||
    !isNonEmptyString(value.learningGoal) ||
    !isNonEmptyString(value.keyMessage) ||
    !isNonEmptyString(value.audienceAssumption) ||
    !isOneOf(value.narrativeRole, narrativeRoles) ||
    !Array.isArray(value.contentUnits) ||
    value.contentUnits.length === 0 ||
    !isNonEmptyString(value.desiredStudentAttention) ||
    (value.voicePlan !== undefined && !Array.isArray(value.voicePlan))
  ) {
    throw new Error('AI provider returned JSON that is not a slide content blueprint.');
  }
  const contentUnits = value.contentUnits.map(parseContentUnit);
  const voicePlan =
    value.voicePlan === undefined ? undefined : value.voicePlan.map(parseVoicePlanItem);
  if (!hasUniqueIds(contentUnits) || (voicePlan !== undefined && !hasUniqueIds(voicePlan))) {
    throw new Error('AI provider returned duplicate slide semantic IDs.');
  }
  const unitIds = new Set(contentUnits.map((unit) => unit.id));
  if (
    voicePlan?.some((item) => item.targetContentUnitIds.some((targetId) => !unitIds.has(targetId)))
  ) {
    throw new Error('AI provider returned a broken slide voice plan reference.');
  }
  return {
    pageId: value.pageId,
    learningGoal: value.learningGoal,
    keyMessage: value.keyMessage,
    audienceAssumption: value.audienceAssumption,
    narrativeRole: value.narrativeRole as SlideContentBlueprint['narrativeRole'],
    contentUnits,
    desiredStudentAttention: value.desiredStudentAttention,
    ...(value.mediaIntent !== undefined
      ? { mediaIntent: parseMediaIntent(value.mediaIntent) }
      : {}),
    ...(voicePlan !== undefined ? { voicePlan } : {}),
  };
};

export const parseSlideContentClassificationValue = (
  value: unknown,
): SlideContentClassification => {
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
    value.secondaryType === value.primaryType ||
    typeof value.itemCount !== 'number' ||
    !Number.isInteger(value.itemCount) ||
    value.itemCount < 1 ||
    !isOneOf(value.density, densities) ||
    !isOneOf(value.visualFocus, visualFocuses) ||
    !isOneOf(value.mediaType, mediaTypes) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !isNonEmptyString(value.rationale)
  ) {
    throw new Error('AI provider returned JSON that is not a slide content classification.');
  }
  return {
    primaryType: value.primaryType,
    ...(value.secondaryType !== undefined ? { secondaryType: value.secondaryType } : {}),
    itemCount: value.itemCount,
    density: value.density as SlideContentClassification['density'],
    visualFocus: value.visualFocus as SlideContentClassification['visualFocus'],
    mediaType: value.mediaType as SlideContentClassification['mediaType'],
    confidence: value.confidence,
    rationale: value.rationale,
  };
};

export const parseSlideSemanticAnalysisValue = (value: unknown): SlideSemanticAnalysis => {
  if (!isRecord(value) || !hasExactKeys(value, ['blueprint', 'classification'])) {
    throw new Error('AI provider returned JSON that is not a slide semantic analysis.');
  }
  return {
    blueprint: parseSlideContentBlueprintValue(value.blueprint),
    classification: parseSlideContentClassificationValue(value.classification),
  };
};

export const isSlideContentBlueprint = (value: unknown): value is SlideContentBlueprint => {
  try {
    parseSlideContentBlueprintValue(value);
    return true;
  } catch {
    return false;
  }
};

export const isSlideContentClassification = (
  value: unknown,
): value is SlideContentClassification => {
  try {
    parseSlideContentClassificationValue(value);
    return true;
  } catch {
    return false;
  }
};
