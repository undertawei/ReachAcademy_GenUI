import type { PptxDiagnostic } from '../diagnostics.js';
import { convertOmmlToLatex } from '../math/omml.js';
import type { PptxXmlElement } from './xml.js';

/** ECMA-376 Part 3 Markup Compatibility and Extensibility (MCE) namespace. */
export const PPTX_MARKUP_COMPATIBILITY_NAMESPACES: ReadonlySet<string> = new Set([
  'http://schemas.openxmlformats.org/markup-compatibility/2006',
]);

/**
 * Namespaces this importer genuinely understands for mc:Choice selection.
 * Deliberately conservative: only the OOXML main namespaces the native mapping
 * slice consumes are declared. Extension namespaces (p14/p15/a14, …) are never
 * declared, so choices requiring them fall back to their mc:Fallback branch.
 */
const UNDERSTOOD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

export interface PptxMarkupCompatibilityExpansion {
  root: PptxXmlElement;
  diagnostics: readonly PptxDiagnostic[];
}

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const isMceElement = (element: PptxXmlElement, expectedLocalName: string): boolean =>
  PPTX_MARKUP_COMPATIBILITY_NAMESPACES.has(element.namespaceUri ?? '') &&
  localName(element.name) === expectedLocalName;

const choiceIsUnderstood = (choice: PptxXmlElement): boolean => {
  const requires = choice.attributes.Requires;
  if (requires === undefined) return false;
  const prefixes = requires
    .trim()
    .split(/\s+/)
    .filter((prefix) => prefix.length > 0);
  if (prefixes.length === 0) return false;
  return prefixes.every((prefix) => UNDERSTOOD_NAMESPACES.has(choice.namespaces?.[prefix] ?? ''));
};

/**
 * The Office 2010 drawing extension namespace, whose `a14:m` element carries the
 * OOXML math a slide really holds.
 */
const OFFICE_2010_DRAWING_NAMESPACE = 'http://schemas.microsoft.com/office/drawing/2010/main';

const collectElements = (
  element: PptxXmlElement,
  predicate: (candidate: PptxXmlElement) => boolean,
  found: PptxXmlElement[] = [],
): PptxXmlElement[] => {
  for (const child of element.children) {
    if (predicate(child)) found.push(child);
    collectElements(child, predicate, found);
  }
  return found;
};

const isOfficeMathWrapper = (element: PptxXmlElement): boolean =>
  element.namespaceUri === OFFICE_2010_DRAWING_NAMESPACE && localName(element.name) === 'm';

const isOfficeMathRoot = (element: PptxXmlElement): boolean => {
  const name = localName(element.name);
  return name === 'oMath' || name === 'oMathPara';
};

/**
 * Whether a choice is elected purely to keep an equation editable.
 *
 * PowerPoint writes every equation twice: the `m:oMath` tree inside an
 * `mc:Choice Requires="a14"`, and a *picture of the equation* in the
 * `mc:Fallback`. Taking the fallback therefore means importing a raster whose
 * fonts are already gone, when the markup for the real formula is sitting right
 * there. The a14 namespace as a whole is still not understood — this elects the
 * branch only when it carries math the importer can actually convert, so an
 * equation outside that slice keeps its picture instead of losing both.
 */
const choiceCarriesConvertibleMath = (choice: PptxXmlElement): boolean => {
  const wrappers = collectElements(choice, isOfficeMathWrapper);
  if (wrappers.length === 0) return false;
  const roots = wrappers.flatMap((wrapper) => collectElements(wrapper, isOfficeMathRoot));
  const outermost = roots.filter(
    (root) =>
      !roots.some(
        (other) => other !== root && collectElements(other, (c) => c === root).length > 0,
      ),
  );
  if (outermost.length === 0) return false;
  return outermost.every((root) => convertOmmlToLatex(root) !== undefined);
};

interface AlternateContentSelection {
  branch: PptxXmlElement;
  branchPathSegment: string;
  usedFallback: boolean;
  requiredNamespaces: readonly string[];
}

/**
 * ECMA-376 Part 3 §10: pick the first mc:Choice whose Requires namespaces are
 * all understood, otherwise the (at most one) mc:Fallback. Returns undefined
 * both for "no branch applies" and for structurally invalid nodes; in either
 * case the node is left in place so the existing unknown-node diagnostics keep
 * reporting the loss.
 */
const selectAlternateContentBranch = (
  element: PptxXmlElement,
): AlternateContentSelection | undefined => {
  const choices: { element: PptxXmlElement; pathSegment: string }[] = [];
  const fallbacks: { element: PptxXmlElement; pathSegment: string }[] = [];
  const occurrences = new Map<string, number>();
  for (const child of element.children) {
    const occurrence = (occurrences.get(child.name) ?? 0) + 1;
    occurrences.set(child.name, occurrence);
    const pathSegment = `${child.name}[${occurrence}]`;
    if (isMceElement(child, 'Choice')) choices.push({ element: child, pathSegment });
    else if (isMceElement(child, 'Fallback')) fallbacks.push({ element: child, pathSegment });
    else return undefined;
  }
  if (fallbacks.length > 1) return undefined;
  const requiredNamespaces = [
    ...new Set(
      choices.flatMap((choice) =>
        (choice.element.attributes.Requires ?? '')
          .trim()
          .split(/\s+/)
          .filter((prefix) => prefix.length > 0)
          .map((prefix) => choice.element.namespaces?.[prefix] ?? prefix),
      ),
    ),
  ].sort();
  const understood =
    choices.find((choice) => choiceIsUnderstood(choice.element)) ??
    choices.find((choice) => choiceCarriesConvertibleMath(choice.element));
  if (understood) {
    return {
      branch: understood.element,
      branchPathSegment: understood.pathSegment,
      usedFallback: false,
      requiredNamespaces,
    };
  }
  const fallback = fallbacks[0];
  if (!fallback) return undefined;
  return {
    branch: fallback.element,
    branchPathSegment: fallback.pathSegment,
    usedFallback: true,
    requiredNamespaces,
  };
};

/**
 * Resolve mc:AlternateContent nodes in a parsed OOXML tree by splicing the
 * selected branch's child elements into the parent, so downstream sp/pic/
 * cxnSp/grpSp handling needs no MCE awareness. Nested AlternateContent
 * (including inside a chosen mc:Fallback) is resolved in the same single
 * linear walk; untouched subtrees are shared, not copied. Applying a fallback
 * emits an advisory (info) diagnostic; nodes without any applicable branch are
 * intentionally left unexpanded for the existing unsupported-content paths.
 */
export const expandPptxMarkupCompatibility = (
  root: PptxXmlElement,
  partPath: string,
): PptxMarkupCompatibilityExpansion => {
  const diagnostics: PptxDiagnostic[] = [];

  const expandElement = (element: PptxXmlElement, path: string): PptxXmlElement => {
    const children: PptxXmlElement[] = [];
    const content: (PptxXmlElement | string)[] = [];
    let changed = false;

    const appendExpanded = (child: PptxXmlElement, childPath: string): void => {
      if (isMceElement(child, 'AlternateContent')) {
        const selection = selectAlternateContentBranch(child);
        if (selection === undefined) {
          // No understood choice and no fallback (or malformed structure):
          // keep the opaque node so existing unknown-node handling reports it.
          children.push(child);
          content.push(child);
          return;
        }
        changed = true;
        if (selection.usedFallback) {
          diagnostics.push({
            code: 'pptx.mce.fallback_applied',
            severity: 'info',
            feature: 'unknown-ooxml',
            message:
              'mc:AlternateContent requires unsupported extension namespaces; the mc:Fallback compatibility content was imported instead.',
            location: { partPath, nodePath: childPath },
            details: { requiredNamespaces: [...selection.requiredNamespaces] },
          });
        }
        // Branch content is ordinary content: recurse so nested
        // AlternateContent resolves too. MCE containers carry element content
        // only, so text nodes inside the container are not propagated.
        const branchOccurrences = new Map<string, number>();
        for (const branchChild of selection.branch.children) {
          const occurrence = (branchOccurrences.get(branchChild.name) ?? 0) + 1;
          branchOccurrences.set(branchChild.name, occurrence);
          appendExpanded(
            branchChild,
            `${childPath}/${selection.branchPathSegment}/${branchChild.name}[${occurrence}]`,
          );
        }
        return;
      }
      const expanded = expandElement(child, childPath);
      if (expanded !== child) changed = true;
      children.push(expanded);
      content.push(expanded);
    };

    const occurrences = new Map<string, number>();
    for (const entry of element.content) {
      if (typeof entry === 'string') {
        content.push(entry);
        continue;
      }
      const occurrence = (occurrences.get(entry.name) ?? 0) + 1;
      occurrences.set(entry.name, occurrence);
      appendExpanded(entry, `${path}/${entry.name}[${occurrence}]`);
    }
    return changed ? { ...element, children, content } : element;
  };

  return { root: expandElement(root, `/${root.name}[1]`), diagnostics };
};
