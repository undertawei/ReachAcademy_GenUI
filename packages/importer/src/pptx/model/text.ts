import type { PptxDiagnostic } from '../diagnostics.js';
import { createStablePptxId } from '../identity.js';
import type { PptxSourceLocation } from '../ir.js';
import { convertOmmlToLatex } from '../math/omml.js';
import type { PptxXmlElement } from '../package/xml.js';
import { canonicalPptxXmlFragment } from '../package/xml.js';
import {
  pptxAngle,
  pptxEmu,
  pptxPercentage,
  type PptxAngle,
  type PptxEmu,
  type PptxPercentage,
} from './units.js';

export interface PptxTextBodyPropertiesIR {
  readonly margins: {
    readonly left?: PptxEmu;
    readonly top?: PptxEmu;
    readonly right?: PptxEmu;
    readonly bottom?: PptxEmu;
  };
  readonly verticalAnchor?: string;
  readonly wrap?: string;
  readonly columns?: string;
  readonly rotation?: PptxAngle;
  readonly verticalText?: string;
  readonly autofit?:
    | { readonly mode: 'none' }
    | {
        readonly mode: 'shrink-text';
        readonly fontScale?: PptxPercentage;
        readonly lineSpacingReduction?: PptxPercentage;
      }
    | { readonly mode: 'resize-shape' };
  readonly xml: PptxXmlElement;
}

export interface PptxTextRunPropertiesIR {
  readonly language?: string;
  readonly alternateLanguage?: string;
  /** OOXML hundredths-of-a-point integer token. */
  readonly fontSize?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: string;
  readonly strike?: string;
  readonly baseline?: string;
  readonly characterSpacing?: string;
  readonly kerning?: string;
  readonly typefaces: Readonly<
    Partial<Record<'latin' | 'eastAsia' | 'complexScript' | 'symbol', string>>
  >;
  readonly xml: PptxXmlElement;
}

export type PptxTextRunIR =
  | {
      readonly kind: 'text';
      readonly id: string;
      readonly text: string;
      readonly properties?: PptxTextRunPropertiesIR;
      readonly xml: PptxXmlElement;
    }
  | {
      readonly kind: 'break';
      readonly id: string;
      readonly properties?: PptxTextRunPropertiesIR;
      readonly xml: PptxXmlElement;
    }
  | {
      readonly kind: 'field';
      readonly id: string;
      readonly fieldId?: string;
      readonly fieldType?: string;
      readonly text: string;
      readonly properties?: PptxTextRunPropertiesIR;
      readonly xml: PptxXmlElement;
    }
  | {
      /** An OOXML equation (`a14:m`), already converted to LaTeX. */
      readonly kind: 'math';
      readonly id: string;
      readonly latex: string;
      /** True for `m:oMathPara`, which PowerPoint lays out on its own line. */
      readonly display: boolean;
      readonly properties?: PptxTextRunPropertiesIR;
      readonly xml: PptxXmlElement;
    };

export type PptxTextBulletIR =
  | { readonly kind: 'none' }
  | { readonly kind: 'character'; readonly character: string }
  | { readonly kind: 'automatic-number'; readonly numberingType: string; readonly startAt?: string }
  | { readonly kind: 'image'; readonly relationshipId?: string; readonly xml: PptxXmlElement };

export type PptxTextSpacingIR =
  | { readonly kind: 'percentage'; readonly value: PptxPercentage }
  | { readonly kind: 'points'; readonly value: string };

export interface PptxTextParagraphPropertiesIR {
  readonly level?: string;
  readonly alignment?: string;
  readonly leftMargin?: PptxEmu;
  readonly rightMargin?: PptxEmu;
  readonly indent?: PptxEmu;
  readonly defaultTabSize?: PptxEmu;
  readonly lineSpacing?: PptxTextSpacingIR;
  readonly spaceBefore?: PptxTextSpacingIR;
  readonly spaceAfter?: PptxTextSpacingIR;
  readonly bullet?: PptxTextBulletIR;
  readonly defaultRunProperties?: PptxTextRunPropertiesIR;
  readonly tabs: readonly { readonly position: PptxEmu; readonly alignment?: string }[];
  readonly xml: PptxXmlElement;
}

export interface PptxTextParagraphIR {
  readonly id: string;
  readonly properties?: PptxTextParagraphPropertiesIR;
  readonly runs: readonly PptxTextRunIR[];
  readonly endProperties?: PptxTextRunPropertiesIR;
  readonly unknownChildren: readonly PptxXmlElement[];
  readonly xml: PptxXmlElement;
}

export interface PptxTextBodyIR {
  readonly properties: PptxTextBodyPropertiesIR;
  readonly listStyleXml?: PptxXmlElement;
  readonly paragraphs: readonly PptxTextParagraphIR[];
  readonly unknownChildren: readonly PptxXmlElement[];
  readonly xml: PptxXmlElement;
}

export type PptxTextProjectionResult =
  | { readonly ok: true; readonly text: PptxTextBodyIR }
  | { readonly ok: false; readonly diagnostics: readonly PptxDiagnostic[] };

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

const children = (element: PptxXmlElement, name: string): PptxXmlElement[] =>
  element.children.filter(
    (child) => localName(child.name) === name && DRAWING_NAMESPACES.has(child.namespaceUri ?? ''),
  );

const one = (element: PptxXmlElement, name: string): PptxXmlElement | undefined =>
  children(element, name)[0];

/** Collapse canonically identical repeats to the first occurrence. */
const dedupeIdenticalElements = (elements: readonly PptxXmlElement[]): PptxXmlElement[] => {
  const seen = new Set<string>();
  const distinct: PptxXmlElement[] = [];
  for (const element of elements) {
    const canonical = canonicalPptxXmlFragment(element);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    distinct.push(element);
  }
  return distinct;
};

const optionalBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`Invalid OOXML boolean: ${value}`);
};

const failure = (message: string, source: PptxSourceLocation): PptxTextProjectionResult => ({
  ok: false,
  diagnostics: [
    {
      code: 'pptx.text_frame.invalid_structure',
      severity: 'fatal',
      feature: 'text-frame',
      message,
      location: source,
    },
  ],
});

const faceNames = {
  latin: 'latin',
  ea: 'eastAsia',
  cs: 'complexScript',
  sym: 'symbol',
} as const;

const parseRunProperties = (element: PptxXmlElement): PptxTextRunPropertiesIR => {
  const typefaces: Partial<Record<(typeof faceNames)[keyof typeof faceNames], string>> = {};
  for (const child of element.children) {
    const name = localName(child.name);
    if (!(name in faceNames)) continue;
    const typeface = child.attributes.typeface?.trim();
    if (typeface) typefaces[faceNames[name as keyof typeof faceNames]] = typeface;
  }
  return {
    ...(element.attributes.lang ? { language: element.attributes.lang } : {}),
    ...(element.attributes.altLang ? { alternateLanguage: element.attributes.altLang } : {}),
    ...(element.attributes.sz ? { fontSize: element.attributes.sz } : {}),
    ...(optionalBoolean(element.attributes.b) === undefined
      ? {}
      : { bold: optionalBoolean(element.attributes.b) }),
    ...(optionalBoolean(element.attributes.i) === undefined
      ? {}
      : { italic: optionalBoolean(element.attributes.i) }),
    ...(element.attributes.u ? { underline: element.attributes.u } : {}),
    ...(element.attributes.strike ? { strike: element.attributes.strike } : {}),
    ...(element.attributes.baseline ? { baseline: element.attributes.baseline } : {}),
    ...(element.attributes.spc ? { characterSpacing: element.attributes.spc } : {}),
    ...(element.attributes.kern ? { kerning: element.attributes.kern } : {}),
    typefaces,
    xml: element,
  };
};

const parseSpacing = (parent: PptxXmlElement | undefined): PptxTextSpacingIR | undefined => {
  if (!parent) return undefined;
  const percentage = one(parent, 'spcPct')?.attributes.val;
  const points = one(parent, 'spcPts')?.attributes.val;
  if (percentage !== undefined && points !== undefined)
    throw new Error('Text spacing is ambiguous.');
  if (percentage !== undefined) return { kind: 'percentage', value: pptxPercentage(percentage) };
  if (points !== undefined) return { kind: 'points', value: points };
  return undefined;
};

const parseParagraphProperties = (element: PptxXmlElement): PptxTextParagraphPropertiesIR => {
  const bulletElements = element.children.filter((child) =>
    ['buNone', 'buChar', 'buAutoNum', 'buBlip'].includes(localName(child.name)),
  );
  if (bulletElements.length > 1) throw new Error('Paragraph contains multiple bullet definitions.');
  const bulletElement = bulletElements[0];
  let bullet: PptxTextBulletIR | undefined;
  if (bulletElement) {
    switch (localName(bulletElement.name)) {
      case 'buNone':
        bullet = { kind: 'none' };
        break;
      case 'buChar': {
        const character = bulletElement.attributes.char;
        if (character === undefined) throw new Error('Character bullet is missing char.');
        bullet = { kind: 'character', character };
        break;
      }
      case 'buAutoNum': {
        const numberingType = bulletElement.attributes.type;
        if (!numberingType) throw new Error('Automatic-number bullet is missing type.');
        bullet = {
          kind: 'automatic-number',
          numberingType,
          ...(bulletElement.attributes.startAt
            ? { startAt: bulletElement.attributes.startAt }
            : {}),
        };
        break;
      }
      case 'buBlip':
        bullet = {
          kind: 'image',
          ...(Object.entries(bulletElement.attributes).find(
            ([name]) => localName(name) === 'embed',
          )?.[1]
            ? {
                relationshipId: Object.entries(bulletElement.attributes).find(
                  ([name]) => localName(name) === 'embed',
                )![1],
              }
            : {}),
          xml: bulletElement,
        };
        break;
    }
  }
  const tabList = one(element, 'tabLst');
  const tabs = (tabList?.children ?? []).flatMap((tab) => {
    if (localName(tab.name) !== 'tab' || tab.attributes.pos === undefined) return [];
    return [
      {
        position: pptxEmu(tab.attributes.pos),
        ...(tab.attributes.algn ? { alignment: tab.attributes.algn } : {}),
      },
    ];
  });
  const defaultRunProperties = one(element, 'defRPr');
  return {
    ...(element.attributes.lvl ? { level: element.attributes.lvl } : {}),
    ...(element.attributes.algn ? { alignment: element.attributes.algn } : {}),
    ...(element.attributes.marL ? { leftMargin: pptxEmu(element.attributes.marL) } : {}),
    ...(element.attributes.marR ? { rightMargin: pptxEmu(element.attributes.marR) } : {}),
    ...(element.attributes.indent ? { indent: pptxEmu(element.attributes.indent) } : {}),
    ...(element.attributes.defTabSz
      ? { defaultTabSize: pptxEmu(element.attributes.defTabSz) }
      : {}),
    ...(parseSpacing(one(element, 'lnSpc'))
      ? { lineSpacing: parseSpacing(one(element, 'lnSpc')) }
      : {}),
    ...(parseSpacing(one(element, 'spcBef'))
      ? { spaceBefore: parseSpacing(one(element, 'spcBef')) }
      : {}),
    ...(parseSpacing(one(element, 'spcAft'))
      ? { spaceAfter: parseSpacing(one(element, 'spcAft')) }
      : {}),
    ...(bullet ? { bullet } : {}),
    ...(defaultRunProperties
      ? { defaultRunProperties: parseRunProperties(defaultRunProperties) }
      : {}),
    tabs,
    xml: element,
  };
};

const parseBodyProperties = (element: PptxXmlElement): PptxTextBodyPropertiesIR => {
  const autofitElements = element.children.filter((child) =>
    ['noAutofit', 'normAutofit', 'spAutoFit'].includes(localName(child.name)),
  );
  if (autofitElements.length > 1) throw new Error('Text body contains multiple autofit modes.');
  const autofitElement = autofitElements[0];
  const autofit =
    autofitElement === undefined
      ? undefined
      : localName(autofitElement.name) === 'noAutofit'
        ? ({ mode: 'none' } as const)
        : localName(autofitElement.name) === 'spAutoFit'
          ? ({ mode: 'resize-shape' } as const)
          : ({
              mode: 'shrink-text',
              ...(autofitElement.attributes.fontScale
                ? { fontScale: pptxPercentage(autofitElement.attributes.fontScale) }
                : {}),
              ...(autofitElement.attributes.lnSpcReduction
                ? {
                    lineSpacingReduction: pptxPercentage(autofitElement.attributes.lnSpcReduction),
                  }
                : {}),
            } as const);
  return {
    margins: {
      ...(element.attributes.lIns ? { left: pptxEmu(element.attributes.lIns) } : {}),
      ...(element.attributes.tIns ? { top: pptxEmu(element.attributes.tIns) } : {}),
      ...(element.attributes.rIns ? { right: pptxEmu(element.attributes.rIns) } : {}),
      ...(element.attributes.bIns ? { bottom: pptxEmu(element.attributes.bIns) } : {}),
    },
    ...(element.attributes.anchor ? { verticalAnchor: element.attributes.anchor } : {}),
    ...(element.attributes.wrap ? { wrap: element.attributes.wrap } : {}),
    ...(element.attributes.numCol ? { columns: element.attributes.numCol } : {}),
    ...(element.attributes.rot ? { rotation: pptxAngle(element.attributes.rot) } : {}),
    ...(element.attributes.vert ? { verticalText: element.attributes.vert } : {}),
    ...(autofit ? { autofit } : {}),
    xml: element,
  };
};

/** Parse an rPr/defRPr/endParaRPr-shaped element for inheritance resolution. */
export const parsePptxRunPropertiesElement = parseRunProperties;

/** Parse a pPr/lvlXpPr-shaped element for inheritance resolution. */
export const parsePptxParagraphPropertiesElement = parseParagraphProperties;

/** Parse a bodyPr-shaped element for inheritance resolution. */
export const parsePptxBodyPropertiesElement = parseBodyProperties;

/** Parse editable paragraph/run semantics while retaining every original XML node. */
export const projectPptxTextBody = (
  shapeId: string,
  textBody: PptxXmlElement,
  source: PptxSourceLocation,
): PptxTextProjectionResult => {
  try {
    const bodyProperties = children(textBody, 'bodyPr');
    const listStyles = children(textBody, 'lstStyle');
    if (bodyProperties.length !== 1 || listStyles.length > 1) {
      return failure('Text body requires one bodyPr and at most one lstStyle.', source);
    }
    const paragraphs: PptxTextParagraphIR[] = [];
    const unknownChildren: PptxXmlElement[] = [];
    for (const child of textBody.children) {
      if (['bodyPr', 'lstStyle'].includes(localName(child.name))) continue;
      if (localName(child.name) !== 'p') {
        unknownChildren.push(child);
        continue;
      }
      const paragraphIndex = paragraphs.length;
      // 一些生成器（WPS 系）会在每个 run 前重复输出同一份 pPr/endParaRPr。
      // 完全相同的重复可无损合一；内容互相矛盾时仍然拒绝。
      const paragraphProperties = dedupeIdenticalElements(children(child, 'pPr'));
      const endProperties = dedupeIdenticalElements(children(child, 'endParaRPr'));
      if (paragraphProperties.length > 1 || endProperties.length > 1) {
        return failure('Text paragraph contains conflicting duplicate property elements.', source);
      }
      const runs: PptxTextRunIR[] = [];
      const unknownParagraphChildren: PptxXmlElement[] = [];
      for (const runElement of child.children) {
        const runName = localName(runElement.name);
        if (runName === 'pPr' || runName === 'endParaRPr') continue;
        if (!['r', 'br', 'fld', 'm'].includes(runName)) {
          unknownParagraphChildren.push(runElement);
          continue;
        }
        const runIndex = runs.length;
        const runProperties = one(runElement, 'rPr');
        const id = createStablePptxId('text-run', [
          shapeId,
          String(paragraphIndex),
          String(runIndex),
        ]);
        if (runName === 'm') {
          // `a14:m` wraps the equation markup the MCE resolution elected; it is
          // only ever elected when every equation inside it converts.
          const math = runElement.children
            .map((child) => convertOmmlToLatex(child))
            .find((conversion) => conversion !== undefined);
          if (math === undefined) {
            unknownParagraphChildren.push(runElement);
            continue;
          }
          runs.push({
            kind: 'math',
            id,
            latex: math.latex,
            display: math.display,
            ...(runProperties ? { properties: parseRunProperties(runProperties) } : {}),
            xml: runElement,
          });
          continue;
        }
        if (runName === 'br') {
          runs.push({
            kind: 'break',
            id,
            ...(runProperties ? { properties: parseRunProperties(runProperties) } : {}),
            xml: runElement,
          });
          continue;
        }
        const textElements = children(runElement, 't');
        // fld 可以不带缓存文本（如 slidenum 由渲染端动态求值），此时视为空串。
        const allowEmpty = runName === 'fld';
        if (textElements.length !== 1 && !(allowEmpty && textElements.length === 0)) {
          return failure(`${runName} requires exactly one t.`, source);
        }
        const text = textElements[0]?.text ?? '';
        if (runName === 'fld') {
          runs.push({
            kind: 'field',
            id,
            ...(runElement.attributes.id ? { fieldId: runElement.attributes.id } : {}),
            ...(runElement.attributes.type ? { fieldType: runElement.attributes.type } : {}),
            text,
            ...(runProperties ? { properties: parseRunProperties(runProperties) } : {}),
            xml: runElement,
          });
        } else {
          runs.push({
            kind: 'text',
            id,
            text,
            ...(runProperties ? { properties: parseRunProperties(runProperties) } : {}),
            xml: runElement,
          });
        }
      }
      paragraphs.push({
        id: createStablePptxId('paragraph', [shapeId, String(paragraphIndex)]),
        ...(paragraphProperties[0]
          ? { properties: parseParagraphProperties(paragraphProperties[0]) }
          : {}),
        runs,
        ...(endProperties[0] ? { endProperties: parseRunProperties(endProperties[0]) } : {}),
        unknownChildren: unknownParagraphChildren,
        xml: child,
      });
    }
    return {
      ok: true,
      text: {
        properties: parseBodyProperties(bodyProperties[0]!),
        ...(listStyles[0] ? { listStyleXml: listStyles[0] } : {}),
        paragraphs,
        unknownChildren,
        xml: textBody,
      },
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Text body is invalid.', source);
  }
};
