export interface EqFieldConversion {
  latex: string;
  display: boolean;
}

type TokenKind =
  | 'lbrace'
  | 'rbrace'
  | 'eq'
  | 'fraction'
  | 'radical'
  | 'bracket'
  | 'displace'
  | 'integral'
  | 'list'
  | 'overstrike'
  | 'box'
  | 'array'
  | 'sup'
  | 'sub'
  | 'alignInc'
  | 'alignDec'
  | 'bracketOption'
  | 'displaceOption'
  | 'integralOption'
  | 'alignmentOption'
  | 'boxOption'
  | 'arrayOption'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'semicolon'
  | 'primitive'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

interface Expression {
  latex: string;
  display: boolean;
  kind: 'primitive' | 'sequence' | 'sup' | 'sub' | 'command';
}

const primitive = (latex: string): Expression => ({
  latex,
  display: false,
  kind: 'primitive',
});

const command = (
  latex: string,
  children: readonly Expression[] = [],
  display = false,
): Expression => ({
  latex,
  display: display || children.some((child) => child.display),
  kind: 'command',
});

function sequence(expressions: Expression[]): Expression {
  if (expressions.length === 1) return expressions[0]!;
  let latex = '';
  for (const [index, expression] of expressions.entries()) {
    latex +=
      expression.kind === 'primitive' && /[\u3400-\u9fff]/u.test(expression.latex)
        ? `\\text{${expression.latex}}`
        : expression.latex;
    const next = expressions[index + 1];
    if (next && next.kind !== 'sup' && next.kind !== 'sub') latex += ' ';
  }
  return {
    latex,
    display: expressions.some((expression) => expression.display),
    kind: 'sequence',
  };
}

function tokenize(input: string): Token[] {
  if (input.length > 100_000) throw new Error('eq-field-too-large');
  const tokens: Token[] = [];
  let offset = 0;
  const rules: Array<[TokenKind, RegExp]> = [
    ['alignmentOption', /^\\(?:al|ac|ar)/],
    ['arrayOption', /^\\(?:co|vs|hs)\d+/],
    ['boxOption', /^\\(?:to|bo|le|ri)/],
    ['integralOption', /^\\(?:su|pr|in)/],
    ['integralOption', /^\\(?:fc|vc)\\[\s\S]/],
    ['displaceOption', /^\\(?:fo|ba)\d+/],
    ['displaceOption', /^\\li/],
    ['bracketOption', /^\\(?:[lr]c|bc)\\[\s\S]/],
    ['sup', /^\\s\\up\d*/],
    ['sub', /^\\s\\do\d*/],
    ['alignInc', /^\\s\\ai\d*/],
    ['alignDec', /^\\s\\di\d*/],
    ['array', /^\\a/],
    ['box', /^\\x/],
    ['overstrike', /^\\o/],
    ['integral', /^\\i/],
    ['list', /^\\l/],
    ['displace', /^\\d/],
    ['bracket', /^\\b/],
    ['fraction', /^\\f/],
    ['radical', /^\\r/],
  ];
  while (offset < input.length) {
    const rest = input.slice(offset);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    const punctuation: Record<string, TokenKind> = {
      '{': 'lbrace',
      '}': 'rbrace',
      '(': 'lparen',
      ')': 'rparen',
      ',': 'comma',
      ';': 'semicolon',
    };
    const kind = punctuation[rest[0]!];
    if (kind) {
      tokens.push({ kind, value: rest[0]! });
      offset++;
      continue;
    }
    if (/^eq/i.test(rest)) {
      tokens.push({ kind: 'eq', value: rest.slice(0, 2) });
      offset += 2;
      continue;
    }
    let matched = false;
    for (const [ruleKind, pattern] of rules) {
      const match = pattern.exec(rest);
      if (!match) continue;
      tokens.push({ kind: ruleKind, value: match[0] });
      offset += match[0].length;
      matched = true;
      break;
    }
    if (matched) continue;
    const number = /^\d+/.exec(rest);
    const identifier = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(rest);
    const operator = /^[+\-*/=<>]/.exec(rest);
    const text = /^[^{}\\(),;+\-*/=<>\s\d]+/.exec(rest);
    const raw = number?.[0] ?? identifier?.[0] ?? operator?.[0] ?? text?.[0];
    const value = number ? number[0].replace(/^0+(?=\d)/, '') : raw;
    if (!value) throw new Error('eq-field-invalid-character');
    tokens.push({ kind: 'primitive', value });
    offset += raw!.length;
  }
  tokens.push({ kind: 'eof', value: '' });
  if (tokens.length > 20_000) throw new Error('eq-field-too-many-tokens');
  return tokens;
}

class EqFieldParser {
  private offset = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Expression {
    const wrapped = this.peek('lbrace');
    if (wrapped) this.take('lbrace');
    this.take('eq');
    const expression = this.expression(new Set(wrapped ? ['rbrace'] : ['eof']));
    if (wrapped) this.take('rbrace');
    this.take('eof');
    return expression;
  }

  private current(): Token {
    return this.tokens[this.offset] ?? { kind: 'eof', value: '' };
  }

  private peek(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private take(kind?: TokenKind): Token {
    const token = this.current();
    if (kind && token.kind !== kind) throw new Error(`eq-field-expected-${kind}`);
    this.offset++;
    return token;
  }

  private expression(stops: ReadonlySet<TokenKind>): Expression {
    if (++this.depth > 64) throw new Error('eq-field-too-deep');
    const expressions: Expression[] = [];
    try {
      while (!stops.has(this.current().kind)) expressions.push(this.atom());
      if (!expressions.length) throw new Error('eq-field-empty-expression');
      return sequence(expressions);
    } finally {
      this.depth--;
    }
  }

  private parenthesized(): Expression {
    this.take('lparen');
    const value = this.expression(new Set(['rparen']));
    this.take('rparen');
    return value;
  }

  private arguments(separators: readonly TokenKind[]): Expression[] {
    this.take('lparen');
    const values: Expression[] = [];
    const stops = new Set<TokenKind>([...separators, 'rparen']);
    values.push(this.expression(stops));
    while (separators.includes(this.current().kind)) {
      this.take();
      values.push(this.expression(stops));
    }
    this.take('rparen');
    return values;
  }

  private options(kind: TokenKind): string[] {
    const values: string[] = [];
    while (this.peek(kind)) values.push(this.take().value);
    return values;
  }

  private atom(): Expression {
    const token = this.take();
    if (token.kind === 'primitive') return primitive(token.value);
    if (token.kind === 'fraction') {
      const values = this.arguments(['comma', 'semicolon']);
      if (values.length !== 2) throw new Error('eq-field-invalid-fraction');
      return command(`\\frac{${values[0]!.latex}}{${values[1]!.latex}}`, values);
    }
    if (token.kind === 'radical') {
      const values = this.arguments(['comma']);
      if (values.length === 1) return command(`\\sqrt{${values[0]!.latex}}`, values);
      if (values.length === 2)
        return command(`\\sqrt[${values[0]!.latex}]{${values[1]!.latex}}`, values);
      throw new Error('eq-field-invalid-radical');
    }
    if (token.kind === 'sup' || token.kind === 'sub') {
      const value = this.parenthesized();
      return {
        latex: `${token.kind === 'sup' ? '^' : '_'}{${value.latex}}`,
        display: value.display,
        kind: token.kind,
      };
    }
    if (token.kind === 'alignInc' || token.kind === 'alignDec') return this.parenthesized();
    if (token.kind === 'bracket') {
      const options = this.options('bracketOption');
      const value = this.parenthesized();
      let left = '(';
      let right = ')';
      const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
      for (const option of options) {
        const optionType = option.slice(1, 3);
        const bracket = option.slice(4);
        if (optionType === 'lc') left = bracket;
        if (optionType === 'rc') right = bracket;
        if (optionType === 'bc') {
          left = bracket;
          right = pairs[bracket] ?? bracket;
        }
      }
      const latexBracket = (value: string): string =>
        ({ '{': '\\{', '}': '\\}', '<': '\\langle', '>': '\\rangle', '\\': '\\backslash' })[
          value
        ] ?? value;
      return command(`\\left${latexBracket(left)} ${value.latex} \\right${latexBracket(right)}`, [
        value,
      ]);
    }
    if (token.kind === 'displace') {
      this.options('displaceOption');
      this.take('lparen');
      const value = this.peek('rparen')
        ? primitive('')
        : this.expression(new Set<TokenKind>(['rparen']));
      this.take('rparen');
      return command(`\\text{${value.latex}}`, [value]);
    }
    if (token.kind === 'integral') {
      const options = this.options('integralOption');
      const values = this.arguments(['comma']);
      if (values.length !== 3) throw new Error('eq-field-invalid-integral');
      const symbol = options.includes('\\su')
        ? '\\sum'
        : options.includes('\\pr')
          ? '\\prod'
          : '\\int';
      return command(
        `${symbol}_{${values[0]!.latex}}^{${values[1]!.latex}} {${values[2]!.latex}}`,
        values,
      );
    }
    if (token.kind === 'list' || token.kind === 'overstrike') {
      if (token.kind === 'overstrike') this.options('alignmentOption');
      const values = this.arguments(token.kind === 'list' ? ['comma', 'semicolon'] : ['comma']);
      return command(values.map((value) => value.latex).join(','), values);
    }
    if (token.kind === 'array') {
      const options: string[] = [];
      while (this.peek('alignmentOption') || this.peek('arrayOption'))
        options.push(this.take().value);
      const values = this.arguments(['comma']);
      const columnOption = options.filter((option) => option.startsWith('\\co')).at(-1);
      const columns = columnOption ? Number(columnOption.slice(3)) : 1;
      if (!Number.isSafeInteger(columns) || columns < 1 || columns > 256)
        throw new Error('eq-field-invalid-array-columns');
      const cells = values.map((value) => value.latex);
      const rows: string[] = [];
      for (let index = 0; index < cells.length; index += columns) {
        const row = cells.slice(index, index + columns);
        while (row.length < columns) row.push('');
        rows.push(row.join(' & '));
      }
      return command(`\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`, values, true);
    }
    if (token.kind === 'box') {
      this.options('boxOption');
      return this.parenthesized();
    }
    throw new Error(`eq-field-unexpected-${token.kind}`);
  }
}

/** Convert the complete lexer/grammar surface supported by the legacy mseq2latex 0.1.2 parser. */
export function convertWordEqFieldToLatex(fieldCode: string): EqFieldConversion | undefined {
  try {
    const expression = new EqFieldParser(tokenize(fieldCode.trim())).parse();
    return { latex: expression.latex, display: expression.display };
  } catch {
    return undefined;
  }
}
