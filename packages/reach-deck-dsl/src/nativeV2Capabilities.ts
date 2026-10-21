import type {
  ReachDeckElementStyleV2,
  ReachDeckFillV2,
  ReachDeckNativeElementV2,
  ReachDeckNativeSlideV2,
  ReachDeckTextFrameV2,
} from './nativeV2.js';
import { parseReachDeckNativeSlideV2 } from './nativeV2Validation.js';

export const REACH_DECK_NATIVE_V2_SCHEMA_FEATURES = [
  'geometry.transform',
  'geometry.preset-shape',
  'geometry.custom-shape',
  'style.solid-fill',
  'style.gradient-fill',
  'style.pattern-fill',
  'style.image-fill',
  'style.stroke',
  'style.effects',
  'text.frame',
  'text.list',
  'text.autofit',
  'text.font-substitution',
  'line',
  'connector',
  'group',
  'image',
  'audio',
  'video',
  'table',
  'chart',
  'formula',
  'diagram',
  'scientific-visual',
  'speaker-notes',
  'transition',
  'animation',
] as const;

export type ReachDeckNativeV2Feature = (typeof REACH_DECK_NATIVE_V2_SCHEMA_FEATURES)[number];

/**
 * A consumer-owned support declaration. The DSL package intentionally exports
 * no default supported set: schema representation alone is not an implementation
 * or fidelity claim.
 */
export interface ReachDeckNativeV2CapabilityProfile {
  consumer: string;
  version: string;
  supportedFeatures: ReadonlySet<ReachDeckNativeV2Feature>;
}

export interface ReachDeckNativeV2CapabilityDiagnostic {
  code: 'UNSUPPORTED_NATIVE_V2_FEATURE';
  severity: 'error';
  feature: ReachDeckNativeV2Feature;
  path: string;
  message: string;
}

export interface ReachDeckNativeV2CapabilityReport {
  compatible: boolean;
  requiredFeatures: ReachDeckNativeV2Feature[];
  diagnostics: ReachDeckNativeV2CapabilityDiagnostic[];
}

export function analyzeReachDeckNativeSlideV2Capabilities(
  value: unknown,
  profile: ReachDeckNativeV2CapabilityProfile,
): ReachDeckNativeV2CapabilityReport {
  const slide = parseReachDeckNativeSlideV2(value);
  const requirements: Array<{ feature: ReachDeckNativeV2Feature; path: string }> = [];
  collectFill(slide.background, '$.background', requirements);
  slide.elements.forEach((element, index) =>
    collectElement(element, `$.elements[${index}]`, requirements),
  );
  if (slide.notes !== undefined) requireFeature(requirements, 'speaker-notes', '$.notes');
  if (slide.transition !== undefined) requireFeature(requirements, 'transition', '$.transition');
  if (slide.animations.length > 0) requireFeature(requirements, 'animation', '$.animations');

  const diagnostics = requirements
    .filter(({ feature }) => !profile.supportedFeatures.has(feature))
    .map(({ feature, path }) => ({
      code: 'UNSUPPORTED_NATIVE_V2_FEATURE' as const,
      severity: 'error' as const,
      feature,
      path,
      message: `${profile.consumer}@${profile.version} does not support ${feature}.`,
    }));
  return {
    compatible: diagnostics.length === 0,
    requiredFeatures: [...new Set(requirements.map(({ feature }) => feature))],
    diagnostics,
  };
}

function collectElement(
  element: ReachDeckNativeElementV2,
  path: string,
  requirements: Array<{ feature: ReachDeckNativeV2Feature; path: string }>,
): void {
  requireFeature(requirements, 'geometry.transform', `${path}.transform`);
  switch (element.type) {
    case 'shape':
      requireFeature(
        requirements,
        element.geometry.kind === 'custom' ? 'geometry.custom-shape' : 'geometry.preset-shape',
        `${path}.geometry`,
      );
      collectStyle(element.style, `${path}.style`, requirements);
      if (element.text !== undefined) collectText(element.text, `${path}.text`, requirements);
      return;
    case 'textFrame':
      collectText(element.text, `${path}.text`, requirements);
      if (element.style !== undefined) collectStyle(element.style, `${path}.style`, requirements);
      return;
    case 'line':
      requireFeature(requirements, 'line', path);
      if (element.connector) requireFeature(requirements, 'connector', path);
      requireFeature(requirements, 'style.stroke', `${path}.stroke`);
      return;
    case 'group':
      requireFeature(requirements, 'group', path);
      if (element.effects !== undefined) {
        requireFeature(requirements, 'style.effects', `${path}.effects`);
      }
      element.children.forEach((child, index) =>
        collectElement(child, `${path}.children[${index}]`, requirements),
      );
      return;
    case 'image':
      requireFeature(requirements, 'image', path);
      if (element.effects !== undefined) {
        requireFeature(requirements, 'style.effects', `${path}.effects`);
      }
      return;
    case 'audio':
      requireFeature(requirements, 'audio', path);
      return;
    case 'video':
      requireFeature(requirements, 'video', path);
      return;
    case 'table':
      requireFeature(requirements, 'table', path);
      element.rows.forEach((row, rowIndex) =>
        row.cells.forEach((cell, cellIndex) => {
          const cellPath = `${path}.rows[${rowIndex}].cells[${cellIndex}]`;
          collectText(cell.text, `${cellPath}.text`, requirements);
          collectStyle(cell.style, `${cellPath}.style`, requirements);
        }),
      );
      return;
    case 'chart':
      requireFeature(requirements, 'chart', path);
      return;
    case 'formula':
      requireFeature(requirements, 'formula', path);
      return;
    case 'diagram':
      requireFeature(requirements, 'diagram', path);
      element.nodes.forEach((node, index) => {
        collectText(node.label, `${path}.nodes[${index}].label`, requirements);
        collectStyle(node.style, `${path}.nodes[${index}].style`, requirements);
      });
      return;
    case 'scientificVisual':
      requireFeature(requirements, 'scientific-visual', path);
      return;
  }
}

function collectText(
  text: ReachDeckTextFrameV2,
  path: string,
  requirements: Array<{ feature: ReachDeckNativeV2Feature; path: string }>,
): void {
  requireFeature(requirements, 'text.frame', path);
  if (
    (text.doc.content ?? []).some(
      (node) => node.type === 'bulletList' || node.type === 'orderedList',
    )
  ) {
    requireFeature(requirements, 'text.list', `${path}.doc`);
  }
  if (text.autofit.mode !== 'none') requireFeature(requirements, 'text.autofit', `${path}.autofit`);
  if (text.fontSubstitutions.length > 0) {
    requireFeature(requirements, 'text.font-substitution', `${path}.fontSubstitutions`);
  }
}

function collectStyle(
  style: ReachDeckElementStyleV2,
  path: string,
  requirements: Array<{ feature: ReachDeckNativeV2Feature; path: string }>,
): void {
  if (style.fill !== undefined) collectFill(style.fill, `${path}.fill`, requirements);
  if (style.stroke !== undefined) requireFeature(requirements, 'style.stroke', `${path}.stroke`);
  if (style.effects !== undefined) requireFeature(requirements, 'style.effects', `${path}.effects`);
}

function collectFill(
  fill: ReachDeckFillV2,
  path: string,
  requirements: Array<{ feature: ReachDeckNativeV2Feature; path: string }>,
): void {
  switch (fill.kind) {
    case 'none':
      return;
    case 'solid':
      requireFeature(requirements, 'style.solid-fill', path);
      return;
    case 'gradient':
      requireFeature(requirements, 'style.gradient-fill', path);
      return;
    case 'pattern':
      requireFeature(requirements, 'style.pattern-fill', path);
      return;
    case 'image':
      requireFeature(requirements, 'style.image-fill', path);
  }
}

function requireFeature(
  requirements: Array<{ feature: ReachDeckNativeV2Feature; path: string }>,
  feature: ReachDeckNativeV2Feature,
  path: string,
): void {
  if (
    !requirements.some(
      (requirement) => requirement.feature === feature && requirement.path === path,
    )
  ) {
    requirements.push({ feature, path });
  }
}
