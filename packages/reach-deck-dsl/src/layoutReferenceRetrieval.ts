import { LAYOUT_REFERENCE_CATALOG } from './layoutReferenceCatalog.js';
import type { LayoutReference, LayoutReferenceMatch } from './layoutReferences.js';
import type { SlideContentClassification } from './slideSemantics.js';

export interface LayoutReferenceRetrievalRequest {
  classification: SlideContentClassification;
  /** 当前 instructionalSpec.keyPoints；只用于容量/中英文密度的稳定 tie-break。 */
  keyPoints?: readonly string[];
  catalog?: readonly LayoutReference[];
  limit?: number;
  nearbyReferenceIds?: readonly string[];
}

const clampLimit = (value: number | undefined): 1 | 2 =>
  value === undefined || !Number.isFinite(value) || Math.floor(value) <= 1 ? 1 : 2;

const includesOrUnrestricted = <T>(values: readonly T[] | undefined, value: T): boolean =>
  values === undefined || values.includes(value);

const itemCountDistance = (
  range: LayoutReference['appliesTo']['itemCount'],
  count: number,
): number => {
  if (!range || (count >= range.min && count <= range.max)) return 0;
  return count < range.min ? range.min - count : count - range.max;
};

const visibleMetrics = (copy: readonly string[]): { length: number; cjkDensity: number } => {
  const joined = copy.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length === 0) return { length: 0, cjkDensity: 0 };
  const cjk = joined.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return { length: joined.length, cjkDensity: cjk / joined.length };
};

const exampleVisibleCopy = (reference: LayoutReference): string[] => {
  const example = reference.examples[0]!;
  return [...example.brief.instructionalSpec.keyPoints];
};

const capacitySimilarity = (reference: LayoutReference, keyPoints: readonly string[]): number => {
  if (keyPoints.length === 0) return 0;
  const requested = visibleMetrics(keyPoints);
  const candidate = visibleMetrics(exampleVisibleCopy(reference));
  const lengthDistance =
    Math.abs(requested.length - candidate.length) / Math.max(requested.length, candidate.length, 1);
  const cjkDistance = Math.abs(requested.cjkDensity - candidate.cjkDensity);
  return Math.max(0, 8 - lengthDistance * 5 - cjkDistance * 3);
};

const scoreReference = (
  reference: LayoutReference,
  classification: SlideContentClassification,
  keyPoints: readonly string[],
  nearby: ReadonlySet<string>,
): number => {
  const countDistance = itemCountDistance(reference.appliesTo.itemCount, classification.itemCount);
  let score = 100;
  score += countDistance === 0 ? 24 : Math.max(0, 16 - countDistance * 4);
  score += includesOrUnrestricted(reference.appliesTo.density, classification.density) ? 18 : 0;
  score += includesOrUnrestricted(reference.appliesTo.mediaTypes, classification.mediaType)
    ? 14
    : 0;
  score += includesOrUnrestricted(reference.appliesTo.visualFocus, classification.visualFocus)
    ? 10
    : 0;
  score += capacitySimilarity(reference, keyPoints);
  if (nearby.has(reference.id)) score -= 6;
  return Math.round(score * 1000) / 1000;
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const coordinateBucket = (value: number, span: number): number => Math.round((value / span) * 4);

/** 粗粒度构图指纹仅用于判断第二条算例是否真的提供另一种构图，不用于吸附当前结果。 */
const compositionSignature = (reference: LayoutReference): string => {
  const elements = reference.examples[0]!.slide.elements;
  return elements
    .map((element) => {
      if (element.type === 'line') {
        return `line:${element.role}:${coordinateBucket(element.start.x, 1600)},${coordinateBucket(element.start.y, 900)}>${coordinateBucket(element.end.x, 1600)},${coordinateBucket(element.end.y, 900)}`;
      }
      return `${element.type}:${coordinateBucket(element.frame.x, 1600)},${coordinateBucket(element.frame.y, 900)},${coordinateBucket(element.frame.width, 1600)},${coordinateBucket(element.frame.height, 900)}`;
    })
    .sort(compareCodeUnits)
    .join('|');
};

const materiallyDifferent = (first: LayoutReference, second: LayoutReference): boolean =>
  compositionSignature(first) !== compositionSignature(second);

export const retrieveLayoutReferences = ({
  classification,
  keyPoints = [],
  catalog = LAYOUT_REFERENCE_CATALOG,
  limit,
  nearbyReferenceIds = [],
}: LayoutReferenceRetrievalRequest): LayoutReferenceMatch[] => {
  const resultLimit = clampLimit(limit);
  const nearby = new Set(nearbyReferenceIds);
  // primaryType 是硬条件：错误类型的漂亮例子比没有第二例更容易带偏较弱模型。
  const scored = catalog
    .filter((reference) => reference.appliesTo.contentTypes.includes(classification.primaryType))
    .map((reference) => ({
      reference,
      score: scoreReference(reference, classification, keyPoints, nearby),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodeUnits(left.reference.id, right.reference.id) ||
        right.reference.version - left.reference.version,
    );

  const first = scored[0];
  if (!first) return [];
  const selected = [first];
  if (resultLimit === 2) {
    const second = scored
      .slice(1)
      .find(
        (candidate) =>
          candidate.score >= first.score - 12 &&
          candidate.score >= 120 &&
          materiallyDifferent(first.reference, candidate.reference),
      );
    if (second) selected.push(second);
  }
  return selected.map(({ reference, score }) => ({
    id: reference.id,
    version: reference.version,
    score,
  }));
};

export const resolveLayoutReferenceMatches = (
  matches: readonly LayoutReferenceMatch[],
  catalog: readonly LayoutReference[] = LAYOUT_REFERENCE_CATALOG,
): LayoutReference[] =>
  matches.map((match) => {
    const reference = catalog.find(
      (candidate) => candidate.id === match.id && candidate.version === match.version,
    );
    if (!reference)
      throw new Error(`Layout reference ${match.id}@${match.version} is unavailable.`);
    return reference;
  });
