export interface CIntegerResult {
  value: bigint;
  display: string;
}

type Operator = '+' | '-' | '*' | '/' | '%' | '<<' | '>>' | '&' | '^' | '|' | '~';
type Token = { kind: 'number'; value: bigint } | { kind: 'operator'; value: Operator } | { kind: 'left' | 'right' };

const MAX_SHIFT = 4096n;
const MAX_BITS = 16_384;

function readIntegerLiteral(source: string, start: number): { token: Token; end: number } | null {
  const rest = source.slice(start);
  const match = rest.match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)(?:[uUlL]+)?/);
  if (!match) return null;
  const literal = match[0];
  const digits = literal.replace(/[uUlL]+$/, '');
  let value: bigint;
  try {
    if (/^0[xX]/.test(digits)) value = BigInt(digits);
    else if (/^0[bB]/.test(digits)) value = BigInt(digits);
    else if (/^0[0-7]+$/.test(digits) && digits.length > 1) value = BigInt(`0o${digits.slice(1)}`);
    else value = BigInt(digits || '0');
  } catch {
    return null;
  }
  return { token: { kind: 'number', value }, end: start + literal.length };
}

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) { index += 1; continue; }
    const literal = readIntegerLiteral(source, index);
    if (literal) { tokens.push(literal.token); index = literal.end; continue; }
    const pair = source.slice(index, index + 2);
    if (pair === '<<' || pair === '>>') {
      tokens.push({ kind: 'operator', value: pair }); index += 2; continue;
    }
    const current = source[index]!;
    if (current === '(') { tokens.push({ kind: 'left' }); index += 1; continue; }
    if (current === ')') { tokens.push({ kind: 'right' }); index += 1; continue; }
    if ('+-*/%&^|~'.includes(current)) {
      tokens.push({ kind: 'operator', value: current as Operator }); index += 1; continue;
    }
    return null;
  }
  return tokens;
}

class IntegerParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): bigint | undefined {
    const value = this.bitwiseOr();
    return value !== undefined && this.index === this.tokens.length && this.withinLimit(value) ? value : undefined;
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
  private take(): Token | undefined { return this.tokens[this.index++]; }
  private operator(value: Operator): boolean {
    const token = this.peek();
    if (token?.kind !== 'operator' || token.value !== value) return false;
    this.index += 1; return true;
  }
  private withinLimit(value: bigint): boolean {
    return (value < 0n ? -value : value).toString(2).length <= MAX_BITS;
  }
  private combine(left: bigint | undefined, readRight: () => bigint | undefined, operators: Operator[]): bigint | undefined {
    if (left === undefined) return undefined;
    while (true) {
      const token = this.peek();
      if (token?.kind !== 'operator' || !operators.includes(token.value)) return left;
      this.take();
      const right = readRight();
      if (right === undefined) return undefined;
      try {
        switch (token.value) {
          case '|': left |= right; break;
          case '^': left ^= right; break;
          case '&': left &= right; break;
          case '+': left += right; break;
          case '-': left -= right; break;
          case '*': left *= right; break;
          case '/': if (right === 0n) return undefined; left /= right; break;
          case '%': if (right === 0n) return undefined; left %= right; break;
          case '<<': if (right < 0n || right > MAX_SHIFT) return undefined; left <<= right; break;
          case '>>': if (right < 0n || right > MAX_SHIFT) return undefined; left >>= right; break;
          default: return undefined;
        }
      } catch {
        return undefined;
      }
      if (!this.withinLimit(left)) return undefined;
    }
  }
  private bitwiseOr(): bigint | undefined { return this.combine(this.bitwiseXor(), () => this.bitwiseXor(), ['|']); }
  private bitwiseXor(): bigint | undefined { return this.combine(this.bitwiseAnd(), () => this.bitwiseAnd(), ['^']); }
  private bitwiseAnd(): bigint | undefined { return this.combine(this.shift(), () => this.shift(), ['&']); }
  private shift(): bigint | undefined { return this.combine(this.additive(), () => this.additive(), ['<<', '>>']); }
  private additive(): bigint | undefined { return this.combine(this.multiplicative(), () => this.multiplicative(), ['+', '-']); }
  private multiplicative(): bigint | undefined { return this.combine(this.unary(), () => this.unary(), ['*', '/', '%']); }
  private unary(): bigint | undefined {
    if (this.operator('+')) return this.unary();
    if (this.operator('-')) { const value = this.unary(); return value === undefined ? undefined : -value; }
    if (this.operator('~')) { const value = this.unary(); return value === undefined ? undefined : ~value; }
    return this.primary();
  }
  private primary(): bigint | undefined {
    const token = this.take();
    if (token?.kind === 'number') return token.value;
    if (token?.kind !== 'left') return undefined;
    const value = this.bitwiseOr();
    if (this.take()?.kind !== 'right') return undefined;
    return value;
  }
}

export function evaluateCIntegerExpression(expression: string): bigint | undefined {
  const tokens = tokenize(expression);
  if (!tokens?.length) return undefined;
  return new IntegerParser(tokens).parse();
}

export function formatCIntegerValue(value: bigint, expression = ''): string {
  const decimal = value.toString(10);
  if (value < 0n) return `${decimal} (10진수)`;
  const bitwise = /(?:<<|>>|[&|^~])/.test(expression);
  const fromHex = /0[xX][0-9a-fA-F]+/.test(expression);
  const fromBinary = /0[bB][01]+/.test(expression);
  const hexadecimal = `0x${value.toString(16).toUpperCase()}`;
  const binary = `0b${value.toString(2)}`;
  const bitLength = Math.max(1, value.toString(2).length);
  if ((bitwise || fromBinary) && bitLength <= 16) return `${binary} (2진수) · ${decimal} (10진수) · ${hexadecimal} (16진수)`;
  if (bitwise || fromHex) return `${hexadecimal} (16진수) · ${decimal} (10진수)`;
  return `${decimal} (10진수)`;
}

export function calculateCIntegerExpression(expression: string): CIntegerResult | undefined {
  const value = evaluateCIntegerExpression(expression);
  return value === undefined ? undefined : { value, display: formatCIntegerValue(value, expression) };
}
