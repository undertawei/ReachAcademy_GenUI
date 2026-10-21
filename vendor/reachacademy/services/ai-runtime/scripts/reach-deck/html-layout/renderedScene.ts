export const SLIDE_SELECTOR = '[data-deck-slide], #slide';

export type LegacyDeckKind = 'text' | 'shape' | 'line' | 'visual';

export type HtmlDeckWarningCode =
  | 'AUTO_FLATTENED_COMPLEX_SUBTREE'
  | 'LAYOUT_FIGURE_CONTENT'
  | 'CANVAS_SIZE_MISMATCH'
  | 'INVALID_IMAGE_SOURCE'
  | 'NON_ABSOLUTE_SLIDE_ELEMENT'
  | 'OUT_OF_CANVAS'
  | 'OVERFLOW_CLIPPED'
  | 'RELATIVE_SIZE_USED'
  | 'TEXT_WITH_COMPLEX_CHILDREN'
  | 'UNKNOWN_VISIBLE_NODE'
  | 'UNSUPPORTED_BACKGROUND'
  | 'UNSUPPORTED_ROOT_LAYOUT'
  | 'UNSUPPORTED_TRANSFORM';

export interface HtmlDeckWarning {
  code: HtmlDeckWarningCode;
  nodeId?: string;
  selector: string;
  message: string;
  htmlSnippet?: string;
}

export interface RenderedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ComputedNodeStyle {
  display: string;
  visibility: string;
  opacity: string;
  position: string;
  zIndex: string;
  backgroundColor: string;
  backgroundImage: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  borderTopStyle: string;
  borderRightStyle: string;
  borderBottomStyle: string;
  borderLeftStyle: string;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
  boxShadow: string;
  color: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  textDecorationLine: string;
  textTransform: string;
  whiteSpace: string;
  transform: string;
  filter: string;
  clipPath: string;
  maskImage: string;
  overflow: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
}

export interface RenderedTextStyle {
  color: string;
  backgroundColor: string;
  fontFamily: string;
  fontSize: string;
  lineHeight?: string;
  fontWeight: string;
  fontStyle: string;
  letterSpacing: string;
  textDecorationLine: string;
}

export type RenderedTextRun =
  | { type: 'text'; text: string; style: RenderedTextStyle }
  | { type: 'math'; latex: string; display: boolean; style: RenderedTextStyle }
  | { type: 'break' };

export interface RenderedNode {
  tag: string;
  id?: string;
  rect: RenderedRect;
  style: ComputedNodeStyle;
  text: string;
  textRuns: RenderedTextRun[];
  children: RenderedNode[];
  domOrder: number;
  sourceElement: HTMLElement | SVGSVGElement;
  legacyKind?: LegacyDeckKind;
  legacyLayer?: number;
  legacyShape?: string;
  legacyArrowEnd: boolean;
  alt?: string;
  /** Explicit author-owned reveal contract; never inferred from geometry. */
  revealGroupId?: string;
  decorative?: boolean;
}

export interface RenderedScene {
  root: HTMLElement;
  rootRect: RenderedRect;
  rootStyle: ComputedNodeStyle;
  nodes: RenderedNode[];
}

export type MeasureRenderedElement = (element: Element) => DOMRect;

const INLINE_TEXT_TAGS = new Set(['SPAN', 'STRONG', 'EM', 'BR', 'B', 'I', 'U', 'S']);

const round = (value: number): number => Math.round(value * 100) / 100;

const toRect = (rect: DOMRect): RenderedRect => ({
  x: round(rect.x),
  y: round(rect.y),
  width: round(rect.width),
  height: round(rect.height),
  top: round(rect.top),
  right: round(rect.right),
  bottom: round(rect.bottom),
  left: round(rect.left),
});

const styleValue = (style: CSSStyleDeclaration, property: string): string =>
  style.getPropertyValue(property) || '';

export const snapshotComputedStyle = (style: CSSStyleDeclaration): ComputedNodeStyle => ({
  display: style.display,
  visibility: style.visibility,
  opacity: style.opacity,
  position: style.position,
  zIndex: style.zIndex,
  backgroundColor: style.backgroundColor,
  backgroundImage: style.backgroundImage,
  borderTopWidth: style.borderTopWidth,
  borderRightWidth: style.borderRightWidth,
  borderBottomWidth: style.borderBottomWidth,
  borderLeftWidth: style.borderLeftWidth,
  borderTopStyle: style.borderTopStyle,
  borderRightStyle: style.borderRightStyle,
  borderBottomStyle: style.borderBottomStyle,
  borderLeftStyle: style.borderLeftStyle,
  borderTopColor: style.borderTopColor,
  borderRightColor: style.borderRightColor,
  borderBottomColor: style.borderBottomColor,
  borderLeftColor: style.borderLeftColor,
  borderTopLeftRadius: style.borderTopLeftRadius,
  borderTopRightRadius: style.borderTopRightRadius,
  borderBottomRightRadius: style.borderBottomRightRadius,
  borderBottomLeftRadius: style.borderBottomLeftRadius,
  boxShadow: style.boxShadow,
  color: style.color,
  fontFamily: style.fontFamily,
  fontSize: style.fontSize,
  fontWeight: style.fontWeight,
  fontStyle: style.fontStyle,
  lineHeight: style.lineHeight,
  letterSpacing: style.letterSpacing,
  textAlign: style.textAlign,
  textDecorationLine: style.textDecorationLine,
  textTransform: style.textTransform,
  whiteSpace: style.whiteSpace,
  transform: style.transform,
  filter: style.filter,
  clipPath: styleValue(style, 'clip-path'),
  maskImage: styleValue(style, 'mask-image'),
  overflow: style.overflow,
  flexDirection: style.flexDirection,
  justifyContent: style.justifyContent,
  alignItems: style.alignItems,
});

export const findSlideRoot = (document: Document): HTMLElement | null =>
  document.querySelector<HTMLElement>(SLIDE_SELECTOR);

export const isRenderedNodeVisible = (node: RenderedNode): boolean =>
  node.rect.width > 0 &&
  node.rect.height > 0 &&
  node.style.display !== 'none' &&
  node.style.visibility !== 'hidden' &&
  Number.parseFloat(node.style.opacity || '1') > 0;

export const hasOnlyInlineTextChildren = (node: RenderedNode): boolean =>
  node.children.every((child) => INLINE_TEXT_TAGS.has(child.tag));

const nodeSelector = (element: Element, domOrder: number): string =>
  element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}:nth-node(${domOrder + 1})`;

const snippet = (element: Element): string => element.outerHTML.replace(/\s+/g, ' ').slice(0, 240);

const warning = (
  code: HtmlDeckWarningCode,
  node: RenderedNode | undefined,
  message: string,
): HtmlDeckWarning => ({
  code,
  ...(node?.id ? { nodeId: node.id } : {}),
  selector: node ? nodeSelector(node.sourceElement, node.domOrder) : SLIDE_SELECTOR,
  message,
  ...(node ? { htmlSnippet: snippet(node.sourceElement) } : {}),
});

const applyTextTransform = (value: string, transform: string): string => {
  if (transform === 'uppercase') return value.toUpperCase();
  if (transform === 'lowercase') return value.toLowerCase();
  if (transform === 'capitalize') {
    return value.replace(
      /(^|\s)(\S)/g,
      (_, prefix: string, character: string) => `${prefix}${character.toUpperCase()}`,
    );
  }
  return value;
};

const textStyleFromComputed = (style: CSSStyleDeclaration): RenderedTextStyle => ({
  color: style.color,
  backgroundColor: style.backgroundColor,
  fontFamily: style.fontFamily,
  fontSize: style.fontSize,
  lineHeight: style.lineHeight,
  fontWeight: style.fontWeight,
  fontStyle: style.fontStyle,
  letterSpacing: style.letterSpacing,
  textDecorationLine: style.textDecorationLine,
});

const extractTextRuns = (element: HTMLElement): RenderedTextRun[] => {
  const view = element.ownerDocument.defaultView;
  if (element.dataset.reachMathLatex !== undefined) {
    return [
      {
        type: 'math',
        latex: element.dataset.reachMathLatex,
        display: element.dataset.reachMathDisplay === 'true',
        style: textStyleFromComputed(view?.getComputedStyle(element) ?? element.style),
      },
    ];
  }
  const runs: RenderedTextRun[] = [];
  const appendBreak = () => {
    if (runs[runs.length - 1]?.type !== 'break') runs.push({ type: 'break' });
  };

  const visit = (node: Node, inheritedElement: HTMLElement) => {
    if (node.nodeType === 3) {
      const style = view?.getComputedStyle(inheritedElement) ?? inheritedElement.style;
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const text = applyTextTransform(
        (node.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' '),
        style.textTransform,
      );
      if (!text) return;
      const runStyle = textStyleFromComputed(style);
      const previous = runs[runs.length - 1];
      if (
        previous?.type === 'text' &&
        JSON.stringify(previous.style) === JSON.stringify(runStyle)
      ) {
        previous.text += text;
      } else {
        runs.push({ type: 'text', text, style: runStyle });
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as HTMLElement;
    if (child.tagName === 'BR') {
      appendBreak();
      return;
    }
    const childStyle = view?.getComputedStyle(child) ?? child.style;
    if (childStyle.display === 'none' || childStyle.visibility === 'hidden') return;
    if (child.dataset.reachMathLatex !== undefined) {
      runs.push({
        type: 'math',
        latex: child.dataset.reachMathLatex,
        display: child.dataset.reachMathDisplay === 'true',
        style: textStyleFromComputed(childStyle),
      });
      return;
    }
    child.childNodes.forEach((nested) => visit(nested, child));
  };

  element.childNodes.forEach((node) => visit(node, element));
  while (runs[0]?.type === 'text') {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    if (runs[0].text) break;
    runs.shift();
  }
  while (runs[runs.length - 1]?.type === 'text') {
    const last = runs[runs.length - 1];
    if (last?.type !== 'text') break;
    last.text = last.text.replace(/\s+$/, '');
    if (last.text) break;
    runs.pop();
  }
  while (runs[runs.length - 1]?.type === 'break') runs.pop();
  return runs;
};

const normalizedText = (element: Element): string => {
  const htmlElement = element as HTMLElement;
  const raw =
    element.matches('[data-reach-math-latex]') || element.querySelector('[data-reach-math-latex]')
      ? extractTextRuns(htmlElement)
          .map((run) => (run.type === 'break' ? '\n' : run.type === 'math' ? run.latex : run.text))
          .join('')
      : htmlElement.innerText || element.textContent || '';
  return raw
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
};

const parseLegacyKind = (value: string | undefined): LegacyDeckKind | undefined =>
  value === 'text' || value === 'shape' || value === 'line' || value === 'visual'
    ? value
    : undefined;

const buildRenderedNode = (
  element: HTMLElement | SVGSVGElement,
  domOrder: number,
  sourceIndexes: ReadonlyMap<Element, number>,
  measure: MeasureRenderedElement,
): RenderedNode => {
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element) ?? element.style;
  const children = (element.hasAttribute('data-reach-math-latex') ? [] : [...element.children]).map(
    (child, childIndex) =>
      buildRenderedNode(
        child as HTMLElement | SVGSVGElement,
        sourceIndexes.get(child) ?? domOrder + childIndex + 1,
        sourceIndexes,
        measure,
      ),
  );
  const legacyLayer = Number(element.dataset.layer);

  return {
    tag: element.tagName.toUpperCase(),
    ...(element.id ? { id: element.id } : {}),
    rect: toRect(measure(element)),
    style: snapshotComputedStyle(computed),
    text: normalizedText(element),
    textRuns:
      element.tagName.toUpperCase() === 'SVG' ? [] : extractTextRuns(element as HTMLElement),
    children,
    domOrder,
    sourceElement: element,
    ...(parseLegacyKind(element.dataset.kind)
      ? { legacyKind: parseLegacyKind(element.dataset.kind) }
      : {}),
    ...(Number.isFinite(legacyLayer) ? { legacyLayer } : {}),
    ...(element.dataset.shape ? { legacyShape: element.dataset.shape } : {}),
    legacyArrowEnd: element.dataset.arrowEnd === 'true' || element.dataset.role === 'arrow',
    ...(element.dataset.alt?.trim() || element.getAttribute('aria-label')?.trim()
      ? { alt: element.dataset.alt?.trim() || element.getAttribute('aria-label')?.trim() }
      : {}),
    ...(element.dataset.reachRevealGroup?.trim()
      ? { revealGroupId: element.dataset.reachRevealGroup.trim() }
      : {}),
    ...(element.dataset.reachDecorative === 'true' ? { decorative: true } : {}),
  };
};

const isInsideVisualSandbox = (element: Element): boolean =>
  Boolean(element.parentElement?.closest('figure, [data-deck-element][data-kind="visual"]'));

const selectCandidateElements = (root: HTMLElement): Array<HTMLElement | SVGSVGElement> => {
  const all = [...root.querySelectorAll<HTMLElement | SVGSVGElement>('*')];
  return all.filter((element) => {
    if (element.hasAttribute('data-deck-element')) return !isInsideVisualSandbox(element);
    if (element.parentElement !== root) return false;
    if (element.querySelector('[data-deck-element]')) return false;
    return true;
  });
};

export const extractRenderedScene = (
  document: Document,
  measure: MeasureRenderedElement = (element) => element.getBoundingClientRect(),
): RenderedScene => {
  const root = findSlideRoot(document);
  if (!root) throw new Error('HTML 中缺少 #slide 或 data-deck-slide 根节点。');
  const allElements = [...root.querySelectorAll<Element>('*')];
  const sourceIndexes = new Map(allElements.map((element, index) => [element, index] as const));
  const view = document.defaultView;
  const rootStyle = view?.getComputedStyle(root) ?? root.style;
  const nodes = selectCandidateElements(root).map((element, index) =>
    buildRenderedNode(element, sourceIndexes.get(element) ?? index, sourceIndexes, measure),
  );

  return {
    root,
    rootRect: toRect(measure(root)),
    rootStyle: snapshotComputedStyle(rootStyle),
    nodes,
  };
};

const usesRelativeGeometry = (element: Element): boolean => {
  const inlineStyle = element.getAttribute('style') ?? '';
  const geometryDeclarations = inlineStyle.match(
    /(?:left|right|top|bottom|width|height)\s*:\s*([^;]+)/gi,
  );
  return Boolean(
    geometryDeclarations?.some((declaration) =>
      /(?:%|\bvw\b|\bvh\b|\bcalc\s*\(|\bmin\s*\(|\bmax\s*\(|\bclamp\s*\()/i.test(declaration),
    ),
  );
};

const isOutsideCanvas = (node: RenderedNode, scene: RenderedScene): boolean =>
  node.rect.left < scene.rootRect.left - 0.5 ||
  node.rect.top < scene.rootRect.top - 0.5 ||
  node.rect.right > scene.rootRect.right + 0.5 ||
  node.rect.bottom > scene.rootRect.bottom + 0.5;

export const validateRenderedScene = (scene: RenderedScene): HtmlDeckWarning[] => {
  const warnings: HtmlDeckWarning[] = [];
  if (Math.abs(scene.rootRect.width - 1600) > 1 || Math.abs(scene.rootRect.height - 900) > 1) {
    warnings.push(
      warning(
        'CANVAS_SIZE_MISMATCH',
        undefined,
        `画布渲染尺寸为 ${scene.rootRect.width}×${scene.rootRect.height}，预期为 1600×900。`,
      ),
    );
  }

  for (const node of scene.nodes) {
    if (!isRenderedNodeVisible(node) || node.legacyKind) continue;
    if (node.style.position !== 'absolute') {
      warnings.push(
        warning(
          'NON_ABSOLUTE_SLIDE_ELEMENT',
          node,
          `Slide-level 元素 ${node.id ?? node.tag.toLowerCase()} 不是 absolute 定位。`,
        ),
      );
    }
    if (node.style.display === 'flex' || node.style.display === 'grid') {
      warnings.push(
        warning(
          'UNSUPPORTED_ROOT_LAYOUT',
          node,
          `Slide-level 元素 ${node.id ?? node.tag.toLowerCase()} 使用了 ${node.style.display} 布局。`,
        ),
      );
    }
    if (usesRelativeGeometry(node.sourceElement)) {
      warnings.push(
        warning(
          'RELATIVE_SIZE_USED',
          node,
          `元素 ${node.id ?? node.tag.toLowerCase()} 使用了相对或计算几何单位。`,
        ),
      );
    }
    if (isOutsideCanvas(node, scene)) {
      warnings.push(
        warning(
          'OUT_OF_CANVAS',
          node,
          `元素 ${node.id ?? node.tag.toLowerCase()} 超出 1600×900 画布边界。`,
        ),
      );
    }
    if (node.tag !== 'FIGURE' && node.style.transform && node.style.transform !== 'none') {
      warnings.push(
        warning(
          'UNSUPPORTED_TRANSFORM',
          node,
          `元素 ${node.id ?? node.tag.toLowerCase()} 使用了需要降级处理的 transform。`,
        ),
      );
    }
    const htmlElement = node.sourceElement as HTMLElement;
    if (
      node.style.overflow === 'hidden' &&
      ((htmlElement.scrollWidth > 0 && htmlElement.scrollWidth > htmlElement.clientWidth) ||
        (htmlElement.scrollHeight > 0 && htmlElement.scrollHeight > htmlElement.clientHeight))
    ) {
      warnings.push(
        warning(
          'OVERFLOW_CLIPPED',
          node,
          `元素 ${node.id ?? node.tag.toLowerCase()} 存在被 overflow:hidden 裁切的内容。`,
        ),
      );
    }
  }
  return warnings;
};

export const createNodeWarning = warning;
