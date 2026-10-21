export interface ReachFunctionPlotIntersectionPoint {
  x: number;
  y: number;
}

const INTERSECTION_SEARCH_FRACTION = 0.05;
const INTERSECTION_SEARCH_SAMPLES = 80;
const INTERSECTION_REFINEMENT_STEPS = 48;

/**
 * Resolve a model-provided intersection hint to one host-verified coordinate.
 *
 * The hint is deliberately not trusted as the final x coordinate: generated JSON commonly rounds
 * irrational roots. Both the static renderer and the iframe helper use this same bounded local
 * search so they cannot disagree about whether a semantic intersection exists.
 */
export function resolveReachFunctionPlotIntersection(
  first: (x: number) => number,
  second: (x: number) => number,
  hintX: number,
  viewportX: readonly [number, number],
  viewportY: readonly [number, number],
  searchFraction = INTERSECTION_SEARCH_FRACTION,
): ReachFunctionPlotIntersectionPoint | undefined {
  const [domainMinimum, domainMaximum] = viewportX;
  if (
    !Number.isFinite(hintX) ||
    !Number.isFinite(domainMinimum) ||
    !Number.isFinite(domainMaximum) ||
    !Number.isFinite(searchFraction) ||
    searchFraction <= 0 ||
    searchFraction > 1 ||
    hintX < domainMinimum ||
    hintX > domainMaximum
  ) {
    return undefined;
  }

  const evaluate = (x: number) => {
    try {
      const firstY = first(x);
      const secondY = second(x);
      if (!Number.isFinite(firstY) || !Number.isFinite(secondY)) return undefined;
      return { x, firstY, secondY, difference: firstY - secondY };
    } catch {
      return undefined;
    }
  };
  const pointIfClose = (candidate: ReturnType<typeof evaluate>) => {
    if (candidate === undefined) return undefined;
    const viewportScale = Math.max(1, Math.abs(viewportY[1] - viewportY[0]));
    const valueScale = Math.max(1, Math.abs(candidate.firstY), Math.abs(candidate.secondY));
    const tolerance = Math.max(viewportScale * 1e-4, valueScale * 1e-7, 1e-8);
    return Math.abs(candidate.difference) <= tolerance
      ? { x: candidate.x, y: (candidate.firstY + candidate.secondY) / 2 }
      : undefined;
  };

  const hinted = evaluate(hintX);
  if (hinted !== undefined) {
    const exactTolerance =
      Number.EPSILON * Math.max(1, Math.abs(hinted.firstY), Math.abs(hinted.secondY)) * 16;
    if (Math.abs(hinted.difference) <= exactTolerance) {
      return { x: hinted.x, y: (hinted.firstY + hinted.secondY) / 2 };
    }
  }

  const range = domainMaximum - domainMinimum;
  const radius = Math.max(range * searchFraction, Number.EPSILON * 32);
  const left = Math.max(domainMinimum, hintX - radius);
  const right = Math.min(domainMaximum, hintX + radius);
  const step = (right - left) / INTERSECTION_SEARCH_SAMPLES;
  if (!(step > 0)) return undefined;

  let previous = evaluate(left);
  let best = previous;
  let bracket: [number, number] | undefined;
  for (let index = 1; index <= INTERSECTION_SEARCH_SAMPLES; index += 1) {
    const current = evaluate(index === INTERSECTION_SEARCH_SAMPLES ? right : left + step * index);
    if (
      current !== undefined &&
      (best === undefined || Math.abs(current.difference) < Math.abs(best.difference))
    ) {
      best = current;
    }
    if (
      previous !== undefined &&
      current !== undefined &&
      Math.sign(previous.difference) !== Math.sign(current.difference)
    ) {
      const candidate: [number, number] = [previous.x, current.x];
      if (
        bracket === undefined ||
        Math.abs((candidate[0] + candidate[1]) / 2 - hintX) <
          Math.abs((bracket[0] + bracket[1]) / 2 - hintX)
      ) {
        bracket = candidate;
      }
    }
    previous = current;
  }

  if (bracket !== undefined) {
    let [lower, upper] = bracket;
    let lowerValue = evaluate(lower);
    for (let iteration = 0; iteration < INTERSECTION_REFINEMENT_STEPS; iteration += 1) {
      const midpoint = (lower + upper) / 2;
      const midpointValue = evaluate(midpoint);
      if (lowerValue === undefined || midpointValue === undefined) return undefined;
      if (Math.sign(lowerValue.difference) === Math.sign(midpointValue.difference)) {
        lower = midpoint;
        lowerValue = midpointValue;
      } else {
        upper = midpoint;
      }
    }
    const resolved = pointIfClose(evaluate((lower + upper) / 2));
    if (resolved !== undefined) return resolved;
  }

  // Tangential intersections do not change sign. Refine the best sampled neighborhood by
  // minimizing the absolute difference, then still require the same strict final tolerance.
  if (best === undefined) return undefined;
  let lower = Math.max(left, best.x - step);
  let upper = Math.min(right, best.x + step);
  for (let iteration = 0; iteration < INTERSECTION_REFINEMENT_STEPS; iteration += 1) {
    const firstThird = lower + (upper - lower) / 3;
    const secondThird = upper - (upper - lower) / 3;
    const firstValue = evaluate(firstThird);
    const secondValue = evaluate(secondThird);
    if (firstValue === undefined || secondValue === undefined) return undefined;
    if (Math.abs(firstValue.difference) <= Math.abs(secondValue.difference)) upper = secondThird;
    else lower = firstThird;
  }
  return pointIfClose(evaluate((lower + upper) / 2));
}
