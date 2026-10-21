import type {
  ReachDeckAnimationV2,
  ReachDeckColorV2,
  ReachDeckElementStyleV2,
  ReachDeckFillV2,
  ReachDeckNativeElementV2,
  ReachDeckNativeSlideV2,
  ReachDeckStrokeV2,
  ReachDeckTextFrameV2,
  ReachDeckTransformV2,
} from './nativeV2.js';
import { normalizeReachDeckNarrationMarkdown } from './narrationMarkdown.js';
import { isRichTextDocumentShape } from './richText.js';
import {
  parseReachScientificVisualDocumentHtmlV1,
  parseReachScientificVisualManifestV1,
  REACH_SCIENTIFIC_VISUAL_LIMITS,
} from './scientificVisual.js';
import { parseReachDeckSpeechMarkupV1 } from './speechMarkup.js';

type UnknownRecord = Record<string, unknown>;

const MAX_NATIVE_ARRAY_ITEMS = 10_000;
const MAX_NATIVE_ELEMENTS = 10_000;
const MAX_NATIVE_GROUP_DEPTH = 32;

interface NativeValidationBudget {
  remainingElements: number;
}

const elementTypes = new Set([
  'shape',
  'textFrame',
  'line',
  'group',
  'image',
  'audio',
  'video',
  'table',
  'chart',
  'formula',
  'diagram',
  'scientificVisual',
]);

export function parseReachDeckNativeSlideV2(value: unknown): ReachDeckNativeSlideV2 {
  const slide = record(value, 'native slide');
  exactKeys(
    slide,
    ['schemaVersion', 'id', 'title', 'background', 'elements', 'animations'],
    ['layoutId', 'textCompatibility', 'notes', 'transition', 'duration', 'narration'],
    'native slide',
  );
  if (slide.schemaVersion !== 'reach-deck-slide/v2') {
    throw new Error('Native slide must use schemaVersion reach-deck-slide/v2.');
  }
  nonEmptyString(slide.id, 'native slide.id');
  nonEmptyString(slide.title, 'native slide.title');
  optionalNonEmptyString(slide.layoutId, 'native slide.layoutId');
  if (
    slide.textCompatibility !== undefined &&
    slide.textCompatibility !== 'native' &&
    slide.textCompatibility !== 'pptx'
  ) {
    throw new Error('Native slide.textCompatibility is invalid.');
  }
  parseFill(slide.background, 'native slide.background');

  const elements = array(slide.elements, 'native slide.elements');
  const budget: NativeValidationBudget = { remainingElements: MAX_NATIVE_ELEMENTS };
  elements.forEach((element, index) =>
    parseElement(element, `native slide.elements[${index}]`, budget, 0),
  );
  const scientificVisualCount = elements.filter(
    (element) => record(element, 'native element').type === 'scientificVisual',
  ).length;
  if (scientificVisualCount > 1) {
    throw new Error('Native slide may contain at most one scientificVisual element.');
  }
  const elementIds: string[] = [];
  collectElementIds(elements as ReachDeckNativeElementV2[], elementIds);
  unique(elementIds, 'native element ids');

  if (slide.notes !== undefined) parseNotes(slide.notes, 'native slide.notes');
  if (slide.transition !== undefined) parseTransition(slide.transition, 'native slide.transition');
  if (slide.duration !== undefined) positive(slide.duration, 'native slide.duration');
  if (slide.narration !== undefined) {
    parseNarration(slide.narration, 'native slide.narration', slide.duration);
  }
  const animations = array(slide.animations, 'native slide.animations');
  animations.forEach((animation, index) =>
    parseAnimation(animation, `native slide.animations[${index}]`),
  );
  unique(
    animations.map((animation) =>
      nonEmptyString(record(animation, 'animation').id, 'animation.id'),
    ),
    'native animation ids',
  );
  // 目标元素已删除的孤儿动画不阻断解析：播放时忽略，编辑器时间轴标红（见 nativeOrphanAnimations）。
  const targetIds = new Set(elementIds);
  const scientificIds = new Set(
    (elements as ReachDeckNativeElementV2[])
      .filter((element) => element.type === 'scientificVisual')
      .map(({ id }) => id),
  );
  for (const scientificId of scientificIds) {
    if (
      (animations as ReachDeckAnimationV2[]).filter(
        (animation) =>
          animation.targetId === scientificId && isWholeElementEntranceAnimation(animation),
      ).length > 1
    ) {
      throw new Error(
        `Native scientific visual ${scientificId} may have at most one entrance animation.`,
      );
    }
  }
  assertElementReferences(elements as ReachDeckNativeElementV2[], targetIds);
  return value as ReachDeckNativeSlideV2;
}

export function isReachDeckNativeSlideV2(value: unknown): value is ReachDeckNativeSlideV2 {
  try {
    parseReachDeckNativeSlideV2(value);
    return true;
  } catch {
    return false;
  }
}

function parseElement(
  value: unknown,
  label: string,
  budget: NativeValidationBudget,
  groupDepth: number,
): ReachDeckNativeElementV2 {
  budget.remainingElements -= 1;
  if (budget.remainingElements < 0) {
    throw new Error(`Native slide exceeds ${MAX_NATIVE_ELEMENTS} total elements.`);
  }
  if (groupDepth > MAX_NATIVE_GROUP_DEPTH) {
    throw new Error(`Native slide group nesting exceeds ${MAX_NATIVE_GROUP_DEPTH}.`);
  }
  const element = record(value, label);
  const type = oneOf(element.type, elementTypes, `${label}.type`);
  parseElementBase(element, label);
  switch (type) {
    case 'shape':
      exactKeys(
        element,
        baseKeys,
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'text'],
        label,
        ['geometry', 'style'],
      );
      parseGeometry(element.geometry, `${label}.geometry`);
      parseStyle(element.style, `${label}.style`);
      if (element.text !== undefined) parseTextFrame(element.text, `${label}.text`);
      break;
    case 'textFrame':
      exactKeys(
        element,
        [...baseKeys, 'text'],
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'style', 'fillSizing'],
        label,
      );
      parseTextFrame(element.text, `${label}.text`);
      if (element.style !== undefined) parseStyle(element.style, `${label}.style`);
      if (element.fillSizing !== undefined)
        oneOf(element.fillSizing, new Set(['frame', 'content']), `${label}.fillSizing`);
      break;
    case 'line':
      exactKeys(
        element,
        [...baseKeys, 'start', 'end', 'routing', 'connector', 'stroke'],
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'bend'],
        label,
      );
      parseLineEndpoint(element.start, `${label}.start`);
      parseLineEndpoint(element.end, `${label}.end`);
      oneOf(element.routing, new Set(['straight', 'elbow', 'curved']), `${label}.routing`);
      if (element.bend !== undefined) {
        if (element.routing !== 'elbow') {
          throw new Error(`${label}.bend is only valid on elbow routing.`);
        }
        range(element.bend, 0, 1, `${label}.bend`);
      }
      booleanValue(element.connector, `${label}.connector`);
      parseStroke(element.stroke, `${label}.stroke`);
      break;
    case 'group': {
      exactKeys(
        element,
        [...baseKeys, 'children'],
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'effects'],
        label,
      );
      if (element.effects !== undefined) parseEffects(element.effects, `${label}.effects`);
      const children = array(element.children, `${label}.children`);
      if (children.length === 0) throw new Error(`${label}.children cannot be empty.`);
      children.forEach((child, index) =>
        parseElement(child, `${label}.children[${index}]`, budget, groupDepth + 1),
      );
      break;
    }
    case 'image':
      exactKeys(
        element,
        [...baseKeys, 'resourceId', 'fit', 'alt'],
        [
          'name',
          'hidden',
          'opacity',
          'ariaLabel',
          'source',
          'crop',
          'stroke',
          'effects',
          'filters',
        ],
        label,
      );
      nonEmptyString(element.resourceId, `${label}.resourceId`);
      oneOf(element.fit, new Set(['cover', 'contain', 'stretch']), `${label}.fit`);
      stringValue(element.alt, `${label}.alt`);
      if (element.crop !== undefined) parseCrop(element.crop, `${label}.crop`);
      if (element.filters !== undefined) {
        const filters = record(element.filters, `${label}.filters`);
        exactKeys(filters, [], ['brightness', 'contrast', 'saturate'], `${label}.filters`);
        for (const key of Object.keys(filters))
          range(filters[key], 0, 10, `${label}.filters.${key}`);
      }
      if (element.stroke !== undefined) parseStroke(element.stroke, `${label}.stroke`);
      if (element.effects !== undefined) parseEffects(element.effects, `${label}.effects`);
      break;
    case 'audio':
      exactKeys(
        element,
        [...baseKeys, 'resourceId', 'playback', 'title'],
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source'],
        label,
      );
      nonEmptyString(element.resourceId, `${label}.resourceId`);
      parsePlayback(element.playback, `${label}.playback`);
      nonEmptyString(element.title, `${label}.title`);
      break;
    case 'video':
      exactKeys(
        element,
        [...baseKeys, 'resourceId', 'playback', 'title'],
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'posterResourceId'],
        label,
      );
      nonEmptyString(element.resourceId, `${label}.resourceId`);
      optionalNonEmptyString(element.posterResourceId, `${label}.posterResourceId`);
      parsePlayback(element.playback, `${label}.playback`);
      nonEmptyString(element.title, `${label}.title`);
      break;
    case 'table':
      parseTable(element, label);
      break;
    case 'chart':
      parseChart(element, label);
      break;
    case 'formula':
      exactKeys(
        element,
        [...baseKeys, 'latex', 'display', 'color'],
        ['name', 'hidden', 'opacity', 'ariaLabel', 'source'],
        label,
      );
      nonEmptyString(element.latex, `${label}.latex`);
      oneOf(element.display, new Set(['inline', 'block']), `${label}.display`);
      parseColor(element.color, `${label}.color`);
      break;
    case 'diagram':
      parseDiagram(element, label);
      break;
    case 'scientificVisual':
      if (groupDepth !== 0) {
        throw new Error(`${label} scientificVisual elements must be top-level.`);
      }
      exactKeys(
        element,
        [...baseKeys, 'ariaLabel', 'documentHtml', 'manifest'],
        ['name', 'hidden', 'opacity', 'source', 'locked'],
        label,
      );
      parseReachScientificVisualDocumentHtmlV1(element.documentHtml, `${label}.documentHtml`);
      const manifest = parseReachScientificVisualManifestV1(element.manifest, `${label}.manifest`);
      if (element.ariaLabel !== undefined && element.ariaLabel !== manifest.ariaLabel) {
        throw new Error(`${label}.ariaLabel must match manifest.ariaLabel.`);
      }
      optionalBoolean(element.locked, `${label}.locked`);
      break;
  }
  return value as ReachDeckNativeElementV2;
}

const baseKeys = ['id', 'type', 'transform', 'zIndex'] as const;

function parseElementBase(element: UnknownRecord, label: string): void {
  nonEmptyString(element.id, `${label}.id`);
  parseTransform(element.transform, `${label}.transform`);
  integer(element.zIndex, `${label}.zIndex`);
  optionalNonEmptyString(element.name, `${label}.name`);
  optionalBoolean(element.hidden, `${label}.hidden`);
  optionalRange(element.opacity, 0, 1, `${label}.opacity`);
  optionalNonEmptyString(element.ariaLabel, `${label}.ariaLabel`);
  if (element.source !== undefined) parseSource(element.source, `${label}.source`);
}

function parseTransform(value: unknown, label: string): ReachDeckTransformV2 {
  const transform = record(value, label);
  exactKeys(
    transform,
    ['x', 'y', 'width', 'height'],
    ['rotation', 'flipHorizontal', 'flipVertical'],
    label,
  );
  finite(transform.x, `${label}.x`);
  finite(transform.y, `${label}.y`);
  positive(transform.width, `${label}.width`);
  positive(transform.height, `${label}.height`);
  optionalFinite(transform.rotation, `${label}.rotation`);
  optionalBoolean(transform.flipHorizontal, `${label}.flipHorizontal`);
  optionalBoolean(transform.flipVertical, `${label}.flipVertical`);
  return value as ReachDeckTransformV2;
}

function parseSource(value: unknown, label: string): void {
  const source = record(value, label);
  exactKeys(source, ['partPath'], ['sourceId', 'relationshipId'], label);
  nonEmptyString(source.partPath, `${label}.partPath`);
  optionalNonEmptyString(source.sourceId, `${label}.sourceId`);
  optionalNonEmptyString(source.relationshipId, `${label}.relationshipId`);
}

function parseColor(value: unknown, label: string): ReachDeckColorV2 {
  const color = record(value, label);
  if (color.kind === 'srgb') {
    exactKeys(color, ['kind', 'value'], ['alpha'], label);
    const hex = nonEmptyString(color.value, `${label}.value`);
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`${label}.value must be #RRGGBB.`);
  } else if (color.kind === 'theme') {
    exactKeys(color, ['kind', 'token'], ['tint', 'shade', 'alpha'], label);
    nonEmptyString(color.token, `${label}.token`);
    optionalRange(color.tint, 0, 1, `${label}.tint`);
    optionalRange(color.shade, 0, 1, `${label}.shade`);
  } else {
    throw new Error(`${label}.kind is unsupported.`);
  }
  optionalRange(color.alpha, 0, 1, `${label}.alpha`);
  return value as ReachDeckColorV2;
}

function parseFill(value: unknown, label: string): ReachDeckFillV2 {
  const fill = record(value, label);
  switch (fill.kind) {
    case 'none':
      exactKeys(fill, ['kind'], [], label);
      break;
    case 'solid':
      exactKeys(fill, ['kind', 'color'], [], label);
      parseColor(fill.color, `${label}.color`);
      break;
    case 'gradient': {
      exactKeys(fill, ['kind', 'angle', 'stops'], ['gradientType'], label);
      if (fill.gradientType !== undefined)
        oneOf(fill.gradientType, new Set(['linear', 'radial']), `${label}.gradientType`);
      finite(fill.angle, `${label}.angle`);
      const stops = array(fill.stops, `${label}.stops`);
      if (stops.length < 2) throw new Error(`${label}.stops must contain at least two entries.`);
      let previous = -1;
      stops.forEach((entry, index) => {
        const stop = record(entry, `${label}.stops[${index}]`);
        exactKeys(stop, ['offset', 'color'], [], `${label}.stops[${index}]`);
        const offset = range(stop.offset, 0, 1, `${label}.stops[${index}].offset`);
        if (offset < previous) throw new Error(`${label}.stops must be ordered by offset.`);
        previous = offset;
        parseColor(stop.color, `${label}.stops[${index}].color`);
      });
      break;
    }
    case 'pattern':
      exactKeys(fill, ['kind', 'preset', 'foreground', 'background'], [], label);
      nonEmptyString(fill.preset, `${label}.preset`);
      parseColor(fill.foreground, `${label}.foreground`);
      parseColor(fill.background, `${label}.background`);
      break;
    case 'image':
      exactKeys(fill, ['kind', 'resourceId', 'mode'], ['insets'], label);
      nonEmptyString(fill.resourceId, `${label}.resourceId`);
      oneOf(fill.mode, new Set(['cover', 'contain', 'stretch', 'tile']), `${label}.mode`);
      if (fill.insets !== undefined) {
        if (fill.mode !== 'stretch') {
          throw new Error(`${label}.insets requires stretch mode.`);
        }
        const insets = record(fill.insets, `${label}.insets`);
        exactKeys(insets, ['left', 'top', 'right', 'bottom'], [], `${label}.insets`);
        for (const side of ['left', 'top', 'right', 'bottom'] as const) {
          // 负值 = 出血(图片超出填充盒);正向内缩不允许吃掉整个可见区。
          range(insets[side], -10, 1, `${label}.insets.${side}`);
        }
        if (
          (insets.left as number) + (insets.right as number) >= 1 ||
          (insets.top as number) + (insets.bottom as number) >= 1
        ) {
          throw new Error(`${label}.insets cannot cover the complete fill box.`);
        }
      }
      break;
    default:
      throw new Error(`${label}.kind is unsupported.`);
  }
  return value as ReachDeckFillV2;
}

function parseStroke(value: unknown, label: string): ReachDeckStrokeV2 {
  const stroke = record(value, label);
  exactKeys(stroke, ['width', 'fill'], ['dash', 'customDash', 'cap', 'join'], label);
  positive(stroke.width, `${label}.width`);
  parseColor(stroke.fill, `${label}.fill`);
  if (stroke.dash !== undefined) {
    oneOf(
      stroke.dash,
      new Set(['solid', 'dot', 'dash', 'dashDot', 'longDash', 'custom']),
      `${label}.dash`,
    );
  }
  if (stroke.customDash !== undefined) {
    const pattern = array(stroke.customDash, `${label}.customDash`);
    if (stroke.dash !== 'custom' || pattern.length === 0) {
      throw new Error(`${label}.customDash requires dash custom and at least one value.`);
    }
    pattern.forEach((entry, index) => positive(entry, `${label}.customDash[${index}]`));
  } else if (stroke.dash === 'custom') {
    throw new Error(`${label}.dash custom requires customDash.`);
  }
  if (stroke.cap !== undefined)
    oneOf(stroke.cap, new Set(['flat', 'round', 'square']), `${label}.cap`);
  if (stroke.join !== undefined)
    oneOf(stroke.join, new Set(['miter', 'round', 'bevel']), `${label}.join`);
  return value as ReachDeckStrokeV2;
}

function parseStyle(value: unknown, label: string): ReachDeckElementStyleV2 {
  const style = record(value, label);
  exactKeys(style, [], ['fill', 'stroke', 'effects'], label);
  if (style.fill !== undefined) parseFill(style.fill, `${label}.fill`);
  if (style.stroke !== undefined) parseStroke(style.stroke, `${label}.stroke`);
  if (style.effects !== undefined) parseEffects(style.effects, `${label}.effects`);
  return value as ReachDeckElementStyleV2;
}

function parseEffects(value: unknown, label: string): void {
  const effects = record(value, label);
  exactKeys(effects, [], ['shadow', 'glow'], label);
  if (effects.shadow !== undefined) {
    const shadow = record(effects.shadow, `${label}.shadow`);
    exactKeys(shadow, ['color', 'blur', 'distance', 'angle'], [], `${label}.shadow`);
    parseColor(shadow.color, `${label}.shadow.color`);
    nonNegative(shadow.blur, `${label}.shadow.blur`);
    nonNegative(shadow.distance, `${label}.shadow.distance`);
    finite(shadow.angle, `${label}.shadow.angle`);
  }
  if (effects.glow !== undefined) {
    const glow = record(effects.glow, `${label}.glow`);
    exactKeys(glow, ['color', 'radius'], [], `${label}.glow`);
    parseColor(glow.color, `${label}.glow.color`);
    nonNegative(glow.radius, `${label}.glow.radius`);
  }
}

function parseGeometry(value: unknown, label: string): void {
  const geometry = record(value, label);
  if (geometry.kind === 'preset') {
    exactKeys(geometry, ['kind', 'preset'], ['adjustments'], label);
    nonEmptyString(geometry.preset, `${label}.preset`);
    if (geometry.adjustments !== undefined)
      numericRecord(geometry.adjustments, `${label}.adjustments`);
  } else if (geometry.kind === 'custom') {
    exactKeys(geometry, ['kind', 'viewBox', 'path'], ['subpaths'], label);
    const viewBox = record(geometry.viewBox, `${label}.viewBox`);
    exactKeys(viewBox, ['width', 'height'], [], `${label}.viewBox`);
    positive(viewBox.width, `${label}.viewBox.width`);
    positive(viewBox.height, `${label}.viewBox.height`);
    nonEmptyString(geometry.path, `${label}.path`);
    if (geometry.subpaths !== undefined) {
      const subpaths = array(geometry.subpaths, `${label}.subpaths`);
      if (subpaths.length === 0) throw new Error(`${label}.subpaths must not be empty.`);
      subpaths.forEach((value, index) => {
        const subpathLabel = `${label}.subpaths[${index}]`;
        const subpath = record(value, subpathLabel);
        exactKeys(subpath, ['path'], ['fillMode', 'stroked'], subpathLabel);
        nonEmptyString(subpath.path, `${subpathLabel}.path`);
        if (
          subpath.fillMode !== undefined &&
          subpath.fillMode !== 'norm' &&
          subpath.fillMode !== 'none'
        ) {
          throw new Error(`${subpathLabel}.fillMode is unsupported.`);
        }
        optionalBoolean(subpath.stroked, `${subpathLabel}.stroked`);
      });
    }
  } else {
    throw new Error(`${label}.kind is unsupported.`);
  }
}

function parseTextFrame(value: unknown, label: string): ReachDeckTextFrameV2 {
  const frame = record(value, label);
  exactKeys(
    frame,
    ['margins', 'verticalAlignment', 'wrap', 'autofit', 'doc', 'fontSubstitutions'],
    ['columns', 'orientation'],
    label,
  );
  const margins = record(frame.margins, `${label}.margins`);
  exactKeys(margins, ['left', 'top', 'right', 'bottom'], [], `${label}.margins`);
  for (const side of ['left', 'top', 'right', 'bottom'] as const) {
    nonNegative(margins[side], `${label}.margins.${side}`);
  }
  oneOf(
    frame.verticalAlignment,
    new Set(['top', 'middle', 'bottom']),
    `${label}.verticalAlignment`,
  );
  booleanValue(frame.wrap, `${label}.wrap`);
  if (frame.columns !== undefined) positiveInteger(frame.columns, `${label}.columns`);
  if (frame.orientation !== undefined) {
    oneOf(frame.orientation, new Set(['vertical']), `${label}.orientation`);
  }
  const autofit = record(frame.autofit, `${label}.autofit`);
  exactKeys(autofit, ['mode'], ['fontScale', 'lineSpacingReduction'], `${label}.autofit`);
  oneOf(autofit.mode, new Set(['none', 'shrink-text', 'resize-shape']), `${label}.autofit.mode`);
  optionalRange(autofit.fontScale, 0, 1, `${label}.autofit.fontScale`, false);
  optionalRange(autofit.lineSpacingReduction, 0, 1, `${label}.autofit.lineSpacingReduction`);
  if (
    autofit.mode !== 'shrink-text' &&
    (autofit.fontScale !== undefined || autofit.lineSpacingReduction !== undefined)
  ) {
    throw new Error(`${label}.autofit scaling metadata requires shrink-text mode.`);
  }
  if (!isRichTextDocumentShape(frame.doc)) {
    throw new Error(`${label}.doc must be a rich-text document.`);
  }
  const substitutions = array(frame.fontSubstitutions, `${label}.fontSubstitutions`);
  substitutions.forEach((item, index) => {
    const substitution = record(item, `${label}.fontSubstitutions[${index}]`);
    exactKeys(
      substitution,
      ['requestedFamily', 'resolvedFamily', 'reason', 'metricsDigest'],
      [],
      `${label}.fontSubstitutions[${index}]`,
    );
    nonEmptyString(
      substitution.requestedFamily,
      `${label}.fontSubstitutions[${index}].requestedFamily`,
    );
    nonEmptyString(
      substitution.resolvedFamily,
      `${label}.fontSubstitutions[${index}].resolvedFamily`,
    );
    oneOf(
      substitution.reason,
      new Set(['theme-resolution', 'configured-substitute', 'system-fallback']),
      `${label}.fontSubstitutions[${index}].reason`,
    );
    nonEmptyString(
      substitution.metricsDigest,
      `${label}.fontSubstitutions[${index}].metricsDigest`,
    );
  });
  unique(
    substitutions.map((item) => {
      const substitution = item as { requestedFamily: string; resolvedFamily: string };
      return `${substitution.requestedFamily}\u0000${substitution.resolvedFamily}`;
    }),
    `${label} font substitutions`,
  );
  return value as ReachDeckTextFrameV2;
}

function parseLineEndpoint(value: unknown, label: string): void {
  const endpoint = record(value, label);
  exactKeys(endpoint, ['x', 'y'], ['marker', 'markerSize', 'markerAnchor', 'connection'], label);
  finite(endpoint.x, `${label}.x`);
  finite(endpoint.y, `${label}.y`);
  if (endpoint.marker !== undefined)
    oneOf(
      endpoint.marker,
      new Set(['none', 'arrow', 'diamond', 'oval', 'triangle']),
      `${label}.marker`,
    );
  if (endpoint.markerSize !== undefined) {
    positive(endpoint.markerSize, `${label}.markerSize`);
    range(endpoint.markerSize, 0, 100, `${label}.markerSize`);
  }
  if (endpoint.markerAnchor !== undefined)
    oneOf(endpoint.markerAnchor, new Set(['center', 'tip']), `${label}.markerAnchor`);
  if (endpoint.connection !== undefined) {
    const connection = record(endpoint.connection, `${label}.connection`);
    exactKeys(connection, ['elementId', 'site'], [], `${label}.connection`);
    nonEmptyString(connection.elementId, `${label}.connection.elementId`);
    nonNegativeInteger(connection.site, `${label}.connection.site`);
  }
}

function parseCrop(value: unknown, label: string): void {
  const crop = record(value, label);
  exactKeys(crop, ['left', 'top', 'right', 'bottom'], [], label);
  // 负值 srcRect 合法:位图内嵌在帧内,边缘留空。下界放到 -10 是因为 MAIC 课件里
  // 常见把裁剪窗口开到原图两倍多高(如 range 底边 226.8%,换算 bottom = -1.268),
  // 渲染端按 1/(1-top-bottom) 反向放大即可,原来的 -1 会把这类图整页判废。
  for (const side of ['left', 'top', 'right', 'bottom'] as const)
    range(crop[side], -10, 1, `${label}.${side}`);
  if (
    (crop.left as number) + (crop.right as number) >= 1 ||
    (crop.top as number) + (crop.bottom as number) >= 1
  ) {
    throw new Error(`${label} cannot crop the complete image.`);
  }
}

function parsePlayback(value: unknown, label: string): void {
  const playback = record(value, label);
  exactKeys(playback, ['startAt', 'autoplay', 'loop', 'volume'], ['endAt'], label);
  nonNegative(playback.startAt, `${label}.startAt`);
  if (playback.endAt !== undefined) {
    positive(playback.endAt, `${label}.endAt`);
    if ((playback.endAt as number) <= (playback.startAt as number))
      throw new Error(`${label}.endAt must be after startAt.`);
  }
  booleanValue(playback.autoplay, `${label}.autoplay`);
  booleanValue(playback.loop, `${label}.loop`);
  range(playback.volume, 0, 1, `${label}.volume`);
}

function parseTable(element: UnknownRecord, label: string): void {
  exactKeys(
    element,
    [...baseKeys, 'columnWidths', 'rowHeights', 'rows'],
    ['name', 'hidden', 'opacity', 'ariaLabel', 'source'],
    label,
  );
  const widths = array(element.columnWidths, `${label}.columnWidths`);
  const heights = array(element.rowHeights, `${label}.rowHeights`);
  const rows = array(element.rows, `${label}.rows`);
  if (widths.length === 0 || heights.length === 0 || rows.length !== heights.length) {
    throw new Error(`${label} table dimensions are inconsistent.`);
  }
  widths.forEach((width, index) => positive(width, `${label}.columnWidths[${index}]`));
  heights.forEach((height, index) => positive(height, `${label}.rowHeights[${index}]`));
  rows.forEach((rowValue, rowIndex) => {
    const row = record(rowValue, `${label}.rows[${rowIndex}]`);
    exactKeys(row, ['id', 'cells'], [], `${label}.rows[${rowIndex}]`);
    nonEmptyString(row.id, `${label}.rows[${rowIndex}].id`);
    const cells = array(row.cells, `${label}.rows[${rowIndex}].cells`);
    if (cells.length === 0) throw new Error(`${label}.rows[${rowIndex}].cells cannot be empty.`);
    cells.forEach((cellValue, cellIndex) => {
      const cell = record(cellValue, `${label}.rows[${rowIndex}].cells[${cellIndex}]`);
      exactKeys(
        cell,
        ['id', 'rowSpan', 'columnSpan', 'text', 'style'],
        ['header'],
        `${label}.rows[${rowIndex}].cells[${cellIndex}]`,
      );
      nonEmptyString(cell.id, `${label}.rows[${rowIndex}].cells[${cellIndex}].id`);
      positiveInteger(cell.rowSpan, `${label}.rows[${rowIndex}].cells[${cellIndex}].rowSpan`);
      if (cell.header !== undefined && typeof cell.header !== 'boolean') {
        throw new Error(`${label}.rows[${rowIndex}].cells[${cellIndex}].header must be boolean.`);
      }
      positiveInteger(cell.columnSpan, `${label}.rows[${rowIndex}].cells[${cellIndex}].columnSpan`);
      parseTextFrame(cell.text, `${label}.rows[${rowIndex}].cells[${cellIndex}].text`);
      parseStyle(cell.style, `${label}.rows[${rowIndex}].cells[${cellIndex}].style`);
    });
    unique(
      cells.map((cell) => nonEmptyString(record(cell, 'cell').id, 'cell.id')),
      `${label} cell ids`,
    );
  });
  unique(
    rows.map((row) => nonEmptyString(record(row, 'row').id, 'row.id')),
    `${label} row ids`,
  );
}

function parseChart(element: UnknownRecord, label: string): void {
  const chartType = oneOf(
    element.chartType,
    new Set([
      'bar',
      'column',
      'line',
      'area',
      'pie',
      'doughnut',
      'scatter',
      'bubble',
      'unsupported',
    ]),
    `${label}.chartType`,
  );
  if (chartType === 'unsupported') {
    exactKeys(
      element,
      [...baseKeys, 'chartType', 'sourceChartType', 'showLegend', 'showDataLabels'],
      ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'title'],
      label,
    );
    nonEmptyString(element.sourceChartType, `${label}.sourceChartType`);
    optionalNonEmptyString(element.title, `${label}.title`);
    booleanValue(element.showLegend, `${label}.showLegend`);
    booleanValue(element.showDataLabels, `${label}.showDataLabels`);
    return;
  }
  const isCategorical = chartType !== 'scatter' && chartType !== 'bubble';
  exactKeys(
    element,
    isCategorical
      ? [...baseKeys, 'chartType', 'categories', 'series', 'showLegend', 'showDataLabels']
      : [...baseKeys, 'chartType', 'series', 'showLegend', 'showDataLabels'],
    ['name', 'hidden', 'opacity', 'ariaLabel', 'source', 'title'],
    label,
  );
  optionalNonEmptyString(element.title, `${label}.title`);
  const categories = isCategorical ? array(element.categories, `${label}.categories`) : undefined;
  categories?.forEach((category, index) => stringValue(category, `${label}.categories[${index}]`));
  const series = array(element.series, `${label}.series`);
  if (series.length === 0) throw new Error(`${label}.series cannot be empty.`);
  series.forEach((seriesValue, index) => {
    const item = record(seriesValue, `${label}.series[${index}]`);
    exactKeys(
      item,
      ['id', 'name', isCategorical ? 'values' : 'points'],
      ['color'],
      `${label}.series[${index}]`,
    );
    nonEmptyString(item.id, `${label}.series[${index}].id`);
    nonEmptyString(item.name, `${label}.series[${index}].name`);
    if (isCategorical) {
      const values = array(item.values, `${label}.series[${index}].values`);
      if (values.length !== categories?.length) {
        throw new Error(`${label}.series[${index}] must align with categories.`);
      }
      values.forEach((entry, valueIndex) => {
        if (entry !== null) finite(entry, `${label}.series[${index}].values[${valueIndex}]`);
      });
    } else {
      const points = array(item.points, `${label}.series[${index}].points`);
      if (points.length === 0) throw new Error(`${label}.series[${index}].points cannot be empty.`);
      points.forEach((pointValue, pointIndex) => {
        const point = record(pointValue, `${label}.series[${index}].points[${pointIndex}]`);
        exactKeys(
          point,
          chartType === 'bubble' ? ['x', 'y', 'size'] : ['x', 'y'],
          [],
          `${label}.series[${index}].points[${pointIndex}]`,
        );
        finite(point.x, `${label}.series[${index}].points[${pointIndex}].x`);
        finite(point.y, `${label}.series[${index}].points[${pointIndex}].y`);
        if (chartType === 'bubble') {
          positive(point.size, `${label}.series[${index}].points[${pointIndex}].size`);
        }
      });
    }
    if (item.color !== undefined) parseColor(item.color, `${label}.series[${index}].color`);
  });
  unique(
    series.map((item) => nonEmptyString(record(item, 'series').id, 'series.id')),
    `${label} series ids`,
  );
  booleanValue(element.showLegend, `${label}.showLegend`);
  booleanValue(element.showDataLabels, `${label}.showDataLabels`);
}

function parseDiagram(element: UnknownRecord, label: string): void {
  exactKeys(
    element,
    [...baseKeys, 'diagramType', 'nodes', 'edges'],
    ['name', 'hidden', 'opacity', 'ariaLabel', 'source'],
    label,
  );
  nonEmptyString(element.diagramType, `${label}.diagramType`);
  const nodes = array(element.nodes, `${label}.nodes`);
  const edges = array(element.edges, `${label}.edges`);
  nodes.forEach((nodeValue, index) => {
    const node = record(nodeValue, `${label}.nodes[${index}]`);
    exactKeys(node, ['id', 'label', 'style'], [], `${label}.nodes[${index}]`);
    nonEmptyString(node.id, `${label}.nodes[${index}].id`);
    parseTextFrame(node.label, `${label}.nodes[${index}].label`);
    parseStyle(node.style, `${label}.nodes[${index}].style`);
  });
  unique(
    nodes.map((node) => nonEmptyString(record(node, 'node').id, 'node.id')),
    `${label} node ids`,
  );
  const nodeIds = new Set(nodes.map((node) => (node as { id: string }).id));
  edges.forEach((edgeValue, index) => {
    const edge = record(edgeValue, `${label}.edges[${index}]`);
    exactKeys(edge, ['id', 'from', 'to'], ['label'], `${label}.edges[${index}]`);
    nonEmptyString(edge.id, `${label}.edges[${index}].id`);
    const from = nonEmptyString(edge.from, `${label}.edges[${index}].from`);
    const to = nonEmptyString(edge.to, `${label}.edges[${index}].to`);
    optionalNonEmptyString(edge.label, `${label}.edges[${index}].label`);
    if (!nodeIds.has(from) || !nodeIds.has(to))
      throw new Error(`${label}.edges[${index}] references an unknown node.`);
  });
  unique(
    edges.map((edge) => nonEmptyString(record(edge, 'edge').id, 'edge.id')),
    `${label} edge ids`,
  );
}

function parseNotes(value: unknown, label: string): void {
  const notes = record(value, label);
  exactKeys(notes, ['doc'], [], label);
  if (!isRichTextDocumentShape(notes.doc)) {
    throw new Error(`${label}.doc must be a rich-text document.`);
  }
}

function parseNarration(value: unknown, label: string, duration: unknown): void {
  const narration = record(value, label);
  exactKeys(
    narration,
    [],
    [
      'markdown',
      'speechMarkup',
      'segments',
      'audioResourceId',
      'scientificAnchorBindings',
      'contentBaseline',
    ],
    label,
  );
  optionalNonEmptyString(narration.markdown, `${label}.markdown`);
  const markdown =
    narration.markdown === undefined
      ? undefined
      : nonEmptyString(narration.markdown, `${label}.markdown`);
  if (narration.contentBaseline !== undefined && typeof narration.contentBaseline !== 'string') {
    throw new Error(`${label}.contentBaseline must be a string.`);
  }
  if (markdown !== undefined && normalizeReachDeckNarrationMarkdown(markdown) !== markdown) {
    throw new Error(`${label}.markdown must use canonical narration Markdown.`);
  }
  if (narration.speechMarkup !== undefined) {
    if (markdown === undefined) {
      throw new Error(`${label}.speechMarkup requires authoritative markdown.`);
    }
    parseReachDeckSpeechMarkupV1(narration.speechMarkup, markdown);
  }
  optionalNonEmptyString(narration.audioResourceId, `${label}.audioResourceId`);
  const segments =
    narration.segments === undefined ? undefined : array(narration.segments, `${label}.segments`);
  if (segments !== undefined && segments.length === 0) {
    throw new Error(`${label}.segments cannot be empty when present.`);
  }
  if (markdown === undefined && segments === undefined) {
    throw new Error(`${label} must contain legacy segments or authoritative markdown.`);
  }
  if (markdown !== undefined) {
    const invalidatedDraft = segments === undefined && narration.audioResourceId === undefined;
    const generatedResult = segments !== undefined && narration.audioResourceId !== undefined;
    if (!invalidatedDraft && !generatedResult) {
      throw new Error(
        `${label} authoritative markdown must be either an invalidated draft without segments/audio or a generated result with both.`,
      );
    }
  }
  // 带时间戳的相邻段必须按 start 单调非降排列;未做 TTS 时间戳解析的段落缺省 start/end,不参与排序校验。
  let previousStart: number | undefined;
  (segments ?? []).forEach((segmentValue, index) => {
    const segment = record(segmentValue, `${label}.segments[${index}]`);
    exactKeys(segment, ['text'], ['start', 'end', 'words'], `${label}.segments[${index}]`);
    nonEmptyString(segment.text, `${label}.segments[${index}].text`);
    if (segment.words !== undefined) {
      parseNarrationWords(segment.words, `${label}.segments[${index}].words`);
    }
    const hasStart = segment.start !== undefined;
    const hasEnd = segment.end !== undefined;
    if (hasStart !== hasEnd) {
      throw new Error(
        `${label}.segments[${index}].start and end must both be present or both absent.`,
      );
    }
    if (hasStart && hasEnd) {
      const start = nonNegative(segment.start, `${label}.segments[${index}].start`);
      const end = nonNegative(segment.end, `${label}.segments[${index}].end`);
      if (start > end) {
        throw new Error(`${label}.segments[${index}].start must not exceed end.`);
      }
      if (previousStart !== undefined && start < previousStart) {
        throw new Error(
          `${label}.segments[${index}].start must be non-decreasing across timestamped segments.`,
        );
      }
      previousStart = start;
    }
    if (markdown !== undefined && (!hasStart || !hasEnd)) {
      throw new Error(
        `${label}.segments[${index}] must be fully timed for authoritative markdown.`,
      );
    }
  });
  if (narration.scientificAnchorBindings !== undefined) {
    if (
      segments === undefined ||
      narration.audioResourceId === undefined ||
      segments.some((candidate) => {
        const segment = record(candidate, `${label}.segments`);
        return segment.start === undefined || segment.end === undefined;
      })
    ) {
      throw new Error(
        `${label}.scientificAnchorBindings require generated audio and fully timed segments.`,
      );
    }
    let timedEnd = 0;
    segments.forEach((candidate) => {
      const segment = record(candidate, `${label}.segments`);
      timedEnd = Math.max(timedEnd, finite(segment.end, `${label}.segments.end`));
    });
    parseScientificAnchorBindings(
      narration.scientificAnchorBindings,
      `${label}.scientificAnchorBindings`,
      duration === undefined ? timedEnd : duration,
    );
  }
}

function parseScientificAnchorBindings(value: unknown, label: string, duration: unknown): void {
  const bindings = array(value, label);
  if (bindings.length === 0 || bindings.length > REACH_SCIENTIFIC_VISUAL_LIMITS.anchors) {
    throw new Error(`${label} must contain a bounded non-empty binding set.`);
  }
  const ids: string[] = [];
  const pairs: string[] = [];
  let previousStart: number | undefined;
  bindings.forEach((candidate, index) => {
    const binding = record(candidate, `${label}[${index}]`);
    exactKeys(binding, ['id', 'elementId', 'anchorId', 'start', 'end'], [], `${label}[${index}]`);
    const elementId = nonEmptyString(binding.elementId, `${label}[${index}].elementId`);
    const anchorId = nonEmptyString(binding.anchorId, `${label}[${index}].anchorId`);
    const id = nonEmptyString(binding.id, `${label}[${index}].id`);
    if (id !== `narration-anchor:${elementId}:${anchorId}`) {
      throw new Error(`${label}[${index}].id does not match its elementId and anchorId.`);
    }
    const start = nonNegative(binding.start, `${label}[${index}].start`);
    const end = nonNegative(binding.end, `${label}[${index}].end`);
    if (start > end) throw new Error(`${label}[${index}].start must not exceed end.`);
    if (duration !== undefined && end > finite(duration, 'native slide.duration')) {
      throw new Error(`${label}[${index}].end must not exceed native slide.duration.`);
    }
    if (previousStart !== undefined && start < previousStart) {
      throw new Error(`${label}[${index}].start must be non-decreasing.`);
    }
    previousStart = start;
    ids.push(id);
    pairs.push(`${elementId}\u0000${anchorId}`);
  });
  unique(ids, `${label} ids`);
  unique(pairs, `${label} element/anchor pairs`);
}

/** 词级时间戳：TTS 引擎原样条目（词文本可含标点），要求成对秒偏移且按 start 单调非降。 */
function parseNarrationWords(value: unknown, label: string): void {
  const words = array(value, label);
  if (words.length === 0) throw new Error(`${label} cannot be empty when present.`);
  let previousStart: number | undefined;
  words.forEach((wordValue, index) => {
    const word = record(wordValue, `${label}[${index}]`);
    exactKeys(word, ['text', 'start', 'end'], [], `${label}[${index}]`);
    nonEmptyString(word.text, `${label}[${index}].text`);
    const start = nonNegative(word.start, `${label}[${index}].start`);
    const end = nonNegative(word.end, `${label}[${index}].end`);
    if (start > end) throw new Error(`${label}[${index}].start must not exceed end.`);
    if (previousStart !== undefined && start < previousStart) {
      throw new Error(`${label}[${index}].start must be non-decreasing.`);
    }
    previousStart = start;
  });
}

function parseTransition(value: unknown, label: string): void {
  const transition = record(value, label);
  exactKeys(transition, ['type', 'duration'], ['direction', 'advanceAfter'], label);
  oneOf(
    transition.type,
    new Set(['none', 'fade', 'push', 'wipe', 'split', 'cover', 'uncover', 'cut']),
    `${label}.type`,
  );
  nonNegative(transition.duration, `${label}.duration`);
  if (transition.direction !== undefined)
    oneOf(
      transition.direction,
      new Set(['left', 'right', 'up', 'down', 'horizontal', 'vertical']),
      `${label}.direction`,
    );
  optionalNonNegative(transition.advanceAfter, `${label}.advanceAfter`);
}

function parseAnimation(value: unknown, label: string): void {
  const animation = record(value, label);
  exactKeys(
    animation,
    ['id', 'targetId', 'trigger', 'effect', 'start', 'duration'],
    ['delay', 'easing', 'from', 'to'],
    label,
  );
  nonEmptyString(animation.id, `${label}.id`);
  nonEmptyString(animation.targetId, `${label}.targetId`);
  oneOf(
    animation.trigger,
    new Set(['on-enter', 'on-click', 'after-previous', 'with-previous']),
    `${label}.trigger`,
  );
  oneOf(
    animation.effect,
    new Set(['appear', 'fade', 'move', 'scale', 'rotate', 'color', 'disappear']),
    `${label}.effect`,
  );
  nonNegative(animation.start, `${label}.start`);
  nonNegative(animation.duration, `${label}.duration`);
  optionalNonNegative(animation.delay, `${label}.delay`);
  if (animation.easing !== undefined)
    oneOf(
      animation.easing,
      new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']),
      `${label}.easing`,
    );
  if (animation.effect === 'color') {
    if (animation.from !== undefined) colorTweenRecord(animation.from, `${label}.from`);
    if (animation.to !== undefined) colorTweenRecord(animation.to, `${label}.to`);
  } else {
    if (animation.from !== undefined) scalarRecord(animation.from, `${label}.from`);
    if (animation.to !== undefined) scalarRecord(animation.to, `${label}.to`);
  }
}

function isWholeElementEntranceAnimation(animation: ReachDeckAnimationV2): boolean {
  return !new Set<ReachDeckAnimationV2['effect']>(['color', 'disappear']).has(animation.effect);
}

function collectElementIds(elements: ReachDeckNativeElementV2[], ids: string[]): void {
  for (const element of elements) {
    ids.push(element.id);
    if (element.type === 'group') collectElementIds(element.children, ids);
  }
}

function assertElementReferences(elements: ReachDeckNativeElementV2[], ids: Set<string>): void {
  for (const element of elements) {
    if (element.type === 'line') {
      for (const endpoint of [element.start, element.end]) {
        if (endpoint.connection && !ids.has(endpoint.connection.elementId)) {
          throw new Error(`Native line ${element.id} references an unknown connected element.`);
        }
      }
    }
    if (element.type === 'group') assertElementReferences(element.children, ids);
  }
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > MAX_NATIVE_ARRAY_ITEMS) {
    throw new Error(`${label} exceeds ${MAX_NATIVE_ARRAY_ITEMS} items.`);
  }
  return value;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  additionalRequired: readonly string[] = [],
): void {
  const allRequired = [...required, ...additionalRequired];
  const allowed = new Set([...allRequired, ...optional]);
  const missing = allRequired.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0)
    throw new Error(`${label} is missing required fields: ${missing.join(', ')}.`);
  if (unknown.length > 0)
    throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(', ')}.`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function optionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) nonEmptyString(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined) booleanValue(value, label);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} must be finite.`);
  return value;
}

function optionalFinite(value: unknown, label: string): void {
  if (value !== undefined) finite(value, label);
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function nonNegative(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function optionalNonNegative(value: unknown, label: string): void {
  if (value !== undefined) nonNegative(value, label);
}

function integer(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer.`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function range(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  inclusiveMinimum = true,
): number {
  const parsed = finite(value, label);
  const below = inclusiveMinimum ? parsed < minimum : parsed <= minimum;
  if (below || parsed > maximum)
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  return parsed;
}

function optionalRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  inclusiveMinimum = true,
): void {
  if (value !== undefined) range(value, minimum, maximum, label, inclusiveMinimum);
}

function oneOf(value: unknown, allowed: Set<string>, label: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error(`${label} is unsupported.`);
  return value;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function numericRecord(value: unknown, label: string): void {
  const entries = record(value, label);
  for (const [key, entry] of Object.entries(entries)) {
    if (key.trim().length === 0) throw new Error(`${label} keys cannot be empty.`);
    finite(entry, `${label}.${key}`);
  }
}

function scalarRecord(value: unknown, label: string): void {
  const entries = record(value, label);
  for (const [key, entry] of Object.entries(entries)) {
    if (key.trim().length === 0 || (typeof entry !== 'number' && typeof entry !== 'string')) {
      throw new Error(`${label} must contain finite numbers or strings.`);
    }
    if (typeof entry === 'number') finite(entry, `${label}.${key}`);
  }
}

function colorTweenRecord(value: unknown, label: string): void {
  const tween = record(value, label);
  exactKeys(tween, ['color'], [], label);
  if (typeof tween.color !== 'string' || !/^#[0-9A-F]{6}$/.test(tween.color)) {
    throw new Error(`${label}.color must be an uppercase #RRGGBB color.`);
  }
}
