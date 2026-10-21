/**
 * DrawingML geometry guide evaluation (ECMA-376 §20.1.9.11 `a:gd`): the built-in
 * shape guides, literal numbers and every formula operator the preset shape
 * definitions and `a:custGeom` guide lists use.
 *
 * Lengths are unitless — guides are evaluated against the shape extent the
 * caller passes in, so passing an extent in points yields point coordinates.
 * Angles keep the OOXML unit of 1/60000 degree.
 */

/** Angle constants usable as guide references (§20.1.9.11, "Shape Guide"). */
const ANGLE_GUIDES: Readonly<Record<string, number>> = {
  cd2: 10_800_000,
  cd4: 5_400_000,
  cd8: 2_700_000,
  '3cd4': 16_200_000,
  '3cd8': 8_100_000,
  '5cd8': 13_500_000,
  '7cd8': 18_900_000,
};

const LITERAL = /^-?\d+(?:\.\d+)?$/;
const FRACTION_GUIDE = /^(w|h|ss)d(\d+)$/;

export interface PptxGeometryGuides {
  /** Resolve a literal, built-in guide or formula reference, or undefined when unsupported. */
  resolve(token: string | undefined): number | undefined;
}

export const pptxGeometryAngleRadians = (value: number): number =>
  (value / 60_000) * (Math.PI / 180);

/**
 * Create a resolver over one shape extent. Formula results are memoized and
 * cyclic references resolve to undefined instead of recursing.
 */
export function createPptxGeometryGuides(
  extent: { readonly width: number; readonly height: number },
  formulas: ReadonlyMap<string, string>,
): PptxGeometryGuides {
  const { width, height } = extent;
  const shorter = Math.min(width, height);
  const longer = Math.max(width, height);
  const resolved = new Map<string, number | undefined>();
  const visiting = new Set<string>();

  const builtIn = (name: string): number | undefined => {
    switch (name) {
      case 'l':
      case 't':
        return 0;
      case 'r':
      case 'w':
        return width;
      case 'b':
      case 'h':
        return height;
      case 'hc':
        return width / 2;
      case 'vc':
        return height / 2;
      case 'ss':
        return shorter;
      case 'ls':
        return longer;
    }
    const fraction = FRACTION_GUIDE.exec(name);
    if (fraction !== null) {
      const divisor = Number.parseInt(fraction[2]!, 10);
      if (divisor === 0) return undefined;
      const base = fraction[1] === 'w' ? width : fraction[1] === 'h' ? height : shorter;
      return base / divisor;
    }
    return ANGLE_GUIDES[name];
  };

  const resolve = (token: string | undefined): number | undefined => {
    if (token === undefined) return undefined;
    const name = token.trim();
    if (name.length === 0) return undefined;
    if (LITERAL.test(name)) return Number.parseFloat(name);
    if (resolved.has(name)) return resolved.get(name);
    const formula = formulas.get(name);
    if (formula === undefined) return builtIn(name);
    if (visiting.has(name)) return undefined;
    visiting.add(name);
    const value = evaluate(formula, resolve);
    visiting.delete(name);
    resolved.set(name, value);
    return value;
  };

  return { resolve };
}

/** Evaluate one `a:gd@fmla` against a resolver for its operand references. */
export function evaluate(
  formula: string,
  resolve: (token: string) => number | undefined,
): number | undefined {
  const tokens = formula.trim().split(/\s+/);
  const operator = tokens[0];
  if (operator === undefined) return undefined;
  const operands: number[] = [];
  for (const token of tokens.slice(1)) {
    const value = resolve(token);
    if (value === undefined) return undefined;
    operands.push(value);
  }
  const [a, b, c] = operands;
  const arity = operands.length;
  switch (operator) {
    case 'val':
      return arity === 1 ? a : undefined;
    case 'abs':
      return arity === 1 ? Math.abs(a!) : undefined;
    case 'sqrt':
      return arity === 1 && a! >= 0 ? Math.sqrt(a!) : undefined;
    case '*/':
      return arity === 3 && c !== 0 ? (a! * b!) / c! : undefined;
    case '+-':
      return arity === 3 ? a! + b! - c! : undefined;
    case '+/':
      return arity === 3 && c !== 0 ? (a! + b!) / c! : undefined;
    case '?:':
      return arity === 3 ? (a! > 0 ? b! : c!) : undefined;
    case 'max':
      return arity === 2 ? Math.max(a!, b!) : undefined;
    case 'min':
      return arity === 2 ? Math.min(a!, b!) : undefined;
    case 'mod':
      return arity === 3 ? Math.sqrt(a! * a! + b! * b! + c! * c!) : undefined;
    case 'pin':
      return arity === 3 ? (b! < a! ? a! : b! > c! ? c! : b!) : undefined;
    case 'sin':
      return arity === 2 ? a! * Math.sin(pptxGeometryAngleRadians(b!)) : undefined;
    case 'cos':
      return arity === 2 ? a! * Math.cos(pptxGeometryAngleRadians(b!)) : undefined;
    case 'tan':
      return arity === 2 ? a! * Math.tan(pptxGeometryAngleRadians(b!)) : undefined;
    case 'at2':
      // Arc tangent of the second over the first operand, in 1/60000 degree.
      return arity === 2 ? (Math.atan2(b!, a!) * 180 * 60_000) / Math.PI : undefined;
    case 'cat2':
      return arity === 3 ? a! * Math.cos(Math.atan2(c!, b!)) : undefined;
    case 'sat2':
      return arity === 3 ? a! * Math.sin(Math.atan2(c!, b!)) : undefined;
    default:
      return undefined;
  }
}
