import { Parser } from 'expr-eval-fork';

const MAX_EXPRESSION_LENGTH = 512;
const MAX_VARIABLES = 32;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const parser = new Parser({
  allowMemberAccess: false,
  operators: {
    assignment: false,
    concatenate: false,
    conditional: false,
    factorial: false,
    fndef: false,
    in: false,
    logical: false,
    random: false,
  },
});
delete parser.functions.random;

const evaluate = (source: string, variables: Readonly<Record<string, number>> = {}): number => {
  if (typeof source !== 'string' || source.length < 1 || source.length > MAX_EXPRESSION_LENGTH) {
    throw new Error('ReachExpression source is invalid.');
  }
  const entries = Object.entries(variables);
  if (
    entries.length > MAX_VARIABLES ||
    entries.some(
      ([name, value]) =>
        !IDENTIFIER.test(name) || typeof value !== 'number' || !Number.isFinite(value),
    )
  ) {
    throw new Error('ReachExpression variables are invalid.');
  }
  const expression = parser.parse(source);
  const allowed = new Set(entries.map(([name]) => name));
  if (expression.variables().some((name) => !allowed.has(name))) {
    throw new Error('ReachExpression contains an undeclared variable.');
  }
  const scope = Object.assign(Object.create(null), variables);
  const result = expression.evaluate(scope);
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('ReachExpression result must be finite.');
  }
  return result;
};

Object.defineProperty(window, 'ReachExpression', {
  value: Object.freeze({ evaluate }),
  configurable: false,
  writable: false,
});
