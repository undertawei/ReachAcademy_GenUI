import type {
  ReachDeckDocumentV2,
  ReachDeckEffectsV2,
  ReachDeckElementStyleV2,
  ReachDeckFillV2,
  ReachDeckNativeElementV2,
  ReachDeckStrokeV2,
  ReachDeckTextFrameV2,
  RichTextNode,
} from '@reachany/reach-deck-dsl';
import type { PptxDiagnostic } from '../diagnostics.js';

/** Included in Runtime's mapping profile so preview/apply use the same transform. */
export const PPTX_STAGE_FIT_VERSION = 'pptx-stage-fit/v1';

/**
 * Bake a uniform, centered fit into editable native coordinates. This is not the
 * PPTX group's child-space conversion: physical typography and effects scale too.
 * The source candidate is never mutated, and an already-fitted candidate is a no-op.
 */
export function fitReachDeckPptxToStage(
  source: ReachDeckDocumentV2,
  target: ReachDeckDocumentV2['stage'],
): { document: ReachDeckDocumentV2; diagnostics: PptxDiagnostic[] } {
  for (const value of [source.stage.width, source.stage.height, target.width, target.height]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid PPTX fit stage dimension');
  }
  if (source.stage.width === target.width && source.stage.height === target.height) {
    return { document: { ...source, stage: { ...target } }, diagnostics: [] };
  }
  const document = structuredClone(source);
  const scale = Math.min(target.width / source.stage.width, target.height / source.stage.height);
  const dx = (target.width - source.stage.width * scale) / 2;
  const dy = (target.height - source.stage.height * scale) / 2;
  const diagnostics: PptxDiagnostic[] = [];
  const dimension = (value: number) => value * scale;
  const warn = (
    pageId: string,
    feature: 'chart' | 'image' | 'formula' | 'diagram',
    message: string,
  ) => {
    if (diagnostics.some((item) => item.details?.pageId === pageId && item.feature === feature))
      return;
    diagnostics.push({
      code: `pptx.stage_fit.${feature}_appearance`,
      severity: 'warning',
      feature,
      message,
      details: { pageId, scale },
    });
  };
  const fill = (value: ReachDeckFillV2 | undefined, pageId: string) => {
    if (scale !== 1 && value?.kind === 'image' && value.mode === 'tile') {
      warn(
        pageId,
        'image',
        'Tiled image fills retain their original tile pixel size after stage fitting.',
      );
    }
  };
  const effects = (value: ReachDeckEffectsV2 | undefined) => {
    if (value?.shadow) {
      value.shadow.blur = dimension(value.shadow.blur);
      value.shadow.distance = dimension(value.shadow.distance);
    }
    if (value?.glow) value.glow.radius = dimension(value.glow.radius);
  };
  const stroke = (value: ReachDeckStrokeV2 | undefined) => {
    if (!value) return;
    value.width = dimension(value.width);
    if (value.customDash) value.customDash = value.customDash.map(dimension);
  };
  const style = (value: ReachDeckElementStyleV2 | undefined, pageId: string) => {
    if (!value) return;
    stroke(value.stroke);
    effects(value.effects);
    fill(value.fill, pageId);
  };
  const absoluteTextAttrs = new Set([
    'fontSize',
    'letterSpacing',
    'lineHeightPx',
    'spaceBefore',
    'spaceAfter',
    'leftIndent',
    'rightIndent',
    'firstLineIndent',
  ]);
  const textAttrs = (attrs: Record<string, unknown> | undefined) => {
    if (!attrs) return;
    for (const [key, value] of Object.entries(attrs)) {
      if (!absoluteTextAttrs.has(key)) continue;
      if (typeof value === 'number') attrs[key] = dimension(value);
      else if (typeof value === 'string' && /^-?\d+(?:\.\d+)?px$/.test(value)) {
        attrs[key] = `${dimension(Number.parseFloat(value))}px`;
      }
    }
  };
  const textNode = (node: RichTextNode) => {
    textAttrs(node.attrs);
    node.marks?.forEach((mark) => textAttrs(mark.attrs));
    node.content?.forEach(textNode);
  };
  const text = (value: ReachDeckTextFrameV2) => {
    for (const side of ['left', 'top', 'right', 'bottom'] as const) {
      value.margins[side] = dimension(value.margins[side]);
    }
    value.doc.content?.forEach(textNode);
  };
  const element = (value: ReachDeckNativeElementV2, pageId: string, topLevel: boolean) => {
    value.transform = {
      ...value.transform,
      x: dimension(value.transform.x) + (topLevel ? dx : 0),
      y: dimension(value.transform.y) + (topLevel ? dy : 0),
      width: dimension(value.transform.width),
      height: dimension(value.transform.height),
    };
    switch (value.type) {
      case 'group':
        effects(value.effects);
        value.children.forEach((child) => element(child, pageId, false));
        break;
      case 'shape':
        // Custom SVG geometry remains in its original viewBox. The renderer
        // fits that viewBox to the scaled box and uses non-scaling-stroke.
        style(value.style, pageId);
        if (value.text) text(value.text);
        break;
      case 'textFrame':
        style(value.style, pageId);
        text(value.text);
        break;
      case 'line':
        value.start.x = dimension(value.start.x);
        value.start.y = dimension(value.start.y);
        value.end.x = dimension(value.end.x);
        value.end.y = dimension(value.end.y);
        stroke(value.stroke);
        break;
      case 'image':
        stroke(value.stroke);
        effects(value.effects);
        break;
      case 'table':
        value.columnWidths = value.columnWidths.map(dimension);
        value.rowHeights = value.rowHeights.map(dimension);
        value.rows.forEach((row) =>
          row.cells.forEach((cell) => {
            text(cell.text);
            style(cell.style, pageId);
          }),
        );
        break;
      case 'diagram':
        value.nodes.forEach((node) => {
          text(node.label);
          style(node.style, pageId);
        });
        if (scale !== 1)
          warn(
            pageId,
            'diagram',
            'Diagram layout retains renderer-defined details after stage fitting.',
          );
        break;
      case 'chart':
        if (scale !== 1)
          warn(
            pageId,
            'chart',
            'Chart data and bounds are retained, but label sizes and line weights follow the native chart renderer.',
          );
        break;
      case 'formula':
        if (scale !== 1)
          warn(
            pageId,
            'formula',
            'Formula bounds are fitted; mathematical typography follows the native formula renderer.',
          );
        break;
      case 'audio':
      case 'video':
      case 'scientificVisual':
        break;
    }
  };
  for (const { pageId, slide } of document.nativeSlides) {
    fill(slide.background, pageId);
    slide.elements.forEach((value) => element(value, pageId, true));
    if (dx !== 0 || dy !== 0) {
      // Keep background images/gradients in the same coordinate space as the
      // imported content. Painting them across the target would distort them.
      const ids = new Set<string>();
      const collect = (value: ReachDeckNativeElementV2) => {
        ids.add(value.id);
        if (value.type === 'group') value.children.forEach(collect);
      };
      slide.elements.forEach(collect);
      let id = `${slide.id}-stage-fit-background`;
      while (ids.has(id)) id += '-';
      slide.elements.unshift({
        id,
        type: 'shape',
        transform: {
          x: dx,
          y: dy,
          width: source.stage.width * scale,
          height: source.stage.height * scale,
        },
        zIndex: Math.min(0, ...slide.elements.map((value) => value.zIndex)) - 1,
        geometry: { kind: 'preset', preset: 'rect' },
        style: { fill: slide.background },
      });
      slide.background = { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } };
    }
  }
  document.stage = { ...target };
  return { document, diagnostics };
}
