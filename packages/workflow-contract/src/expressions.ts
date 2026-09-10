/**
 * TASK-864 §3.2 — the workflow EXPRESSION language: a deterministic, side-effect-free,
 * non-Turing-complete subset of CEL (Common Expression Language) that `core.condition`
 * (`branches[].when`) and `core.loop` (`until`) are authored in.
 *
 * ## Why a native evaluator rather than a dependency
 *
 * This package has ZERO runtime dependencies by design (`package.json`; the database seed imports
 * it). The Python interpreter (`apps/harness/.../interpreter/expressions.py`) carries a
 * line-for-line mirror of THIS grammar, and the two are held together by ONE committed fixture —
 * `__tests__/fixtures/expressions.fixture.json` — that both suites evaluate. That fixture is the
 * contract; a third-party CEL implementation on either side would only be as compatible as that
 * same fixture proved it to be, so the fixture, not the library, is what carries parity.
 *
 * ## The subset
 *
 * Literals (`null`, booleans, integers, doubles, single/double-quoted strings, lists, maps),
 * identifiers with dotted member access and `[...]` indexing, unary `!`/`-`, arithmetic
 * `* / % + -`, comparison `< <= > >= == !=`, membership `in` (list / map key), logical `&&`/`||`
 * (short-circuit), the ternary `? :`, and the functions `has(a.b)`, `size(x)`, `string(x)`,
 * `int(x)`, `double(x)`, plus the string methods `contains`, `startsWith`, `endsWith`.
 *
 * ## Semantics that matter for parity (and are asserted by the fixture)
 *
 * - **Errors are values, never throws.** An unknown identifier, a missing map key, an
 *   out-of-range index or a type mismatch evaluates to `{ error }`. `has()` is the guard.
 *   `&&`/`||` short-circuit on the left operand only.
 * - **Integers stay integers.** `7 / 2` is `3` (truncating), `7 % 2` is `1`; a double operand
 *   makes the result a double. JSON carries no int/float distinction for whole numbers, so a
 *   whole double is treated as an integer on BOTH sides.
 * - `==` is deep structural equality over JSON values.
 */

export type ExpressionValue = null | boolean | number | string | ExpressionValue[] | { [key: string]: ExpressionValue };

export type ExpressionResult = { readonly value: ExpressionValue } | { readonly error: string };

// =============================================================================================
// Tokenizer
// =============================================================================================

type Token =
  | { kind: 'num'; value: number; text: string }
  | { kind: 'str'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'eof' };

const MULTI_CHAR_OPS = ['&&', '||', '==', '!=', '<=', '>='];
const SINGLE_CHAR_OPS = new Set(['(', ')', '[', ']', '{', '}', ',', '.', ':', '?', '+', '-', '*', '/', '%', '<', '>', '!']);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

class ExpressionSyntaxError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && isDigit(source[j]!)) j += 1;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      if ((source[j] === 'e' || source[j] === 'E') && /[0-9+-]/.test(source[j + 1] ?? '')) {
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push({ kind: 'num', value: Number(text), text });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') {
          const next = source[j + 1];
          if (next === undefined) throw new ExpressionSyntaxError(`unterminated escape at ${j}`);
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
          out += escapes[next] ?? next;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      if (source[j] !== ch) throw new ExpressionSyntaxError(`unterminated string at ${i}`);
      tokens.push({ kind: 'str', value: out });
      i = j + 1;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j]!)) j += 1;
      tokens.push({ kind: 'ident', value: source.slice(i, j) });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new ExpressionSyntaxError(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// =============================================================================================
// Parser — Pratt / precedence climbing into a small AST
// =============================================================================================

export type ExpressionNode =
  | { type: 'literal'; value: ExpressionValue }
  | { type: 'ident'; name: string }
  | { type: 'list'; items: ExpressionNode[] }
  | { type: 'map'; entries: Array<{ key: ExpressionNode; value: ExpressionNode }> }
  | { type: 'member'; object: ExpressionNode; field: string }
  | { type: 'index'; object: ExpressionNode; index: ExpressionNode }
  | { type: 'call'; name: string; args: ExpressionNode[] }
  | { type: 'method'; target: ExpressionNode; name: string; args: ExpressionNode[] }
  | { type: 'unary'; op: '!' | '-'; operand: ExpressionNode }
  | { type: 'binary'; op: string; left: ExpressionNode; right: ExpressionNode }
  | { type: 'ternary'; condition: ExpressionNode; then: ExpressionNode; else: ExpressionNode };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }
  private isOp(value: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.value === value;
  }
  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new ExpressionSyntaxError(`expected ${JSON.stringify(value)} at token ${this.pos}`);
    this.next();
  }

  parseExpression(): ExpressionNode {
    const node = this.parseTernary();
    if (this.peek().kind !== 'eof') throw new ExpressionSyntaxError(`unexpected token at ${this.pos}`);
    return node;
  }

  private parseTernary(): ExpressionNode {
    const condition = this.parseOr();
    if (this.isOp('?')) {
      this.next();
      const then = this.parseTernary();
      this.expectOp(':');
      const otherwise = this.parseTernary();
      return { type: 'ternary', condition, then, else: otherwise };
    }
    return condition;
  }

  private parseOr(): ExpressionNode {
    let left = this.parseAnd();
    while (this.isOp('||')) {
      this.next();
      left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ExpressionNode {
    let left = this.parseComparison();
    while (this.isOp('&&')) {
      this.next();
      left = { type: 'binary', op: '&&', left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): ExpressionNode {
    let left = this.parseAdditive();
    for (;;) {
      const token = this.peek();
      const isCompare = token.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value);
      const isIn = token.kind === 'ident' && token.value === 'in';
      if (!isCompare && !isIn) return left;
      this.next();
      const op = token.kind === 'op' ? token.value : 'in';
      left = { type: 'binary', op, left, right: this.parseAdditive() };
    }
  }

  private parseAdditive(): ExpressionNode {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { value: string }).value;
      left = { type: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): ExpressionNode {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.next() as { value: string }).value;
      left = { type: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExpressionNode {
    if (this.isOp('!')) {
      this.next();
      return { type: 'unary', op: '!', operand: this.parseUnary() };
    }
    if (this.isOp('-')) {
      this.next();
      return { type: 'unary', op: '-', operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExpressionNode {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const token = this.next();
        if (token.kind !== 'ident') throw new ExpressionSyntaxError(`expected a field name after "." at token ${this.pos}`);
        if (this.isOp('(')) {
          node = { type: 'method', target: node, name: token.value, args: this.parseArguments() };
        } else {
          node = { type: 'member', object: node, field: token.value };
        }
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        const index = this.parseTernary();
        this.expectOp(']');
        node = { type: 'index', object: node, index };
        continue;
      }
      return node;
    }
  }

  private parseArguments(): ExpressionNode[] {
    this.expectOp('(');
    const args: ExpressionNode[] = [];
    if (this.isOp(')')) {
      this.next();
      return args;
    }
    for (;;) {
      args.push(this.parseTernary());
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      this.expectOp(')');
      return args;
    }
  }

  private parsePrimary(): ExpressionNode {
    const token = this.next();
    switch (token.kind) {
      case 'num':
        return { type: 'literal', value: token.value };
      case 'str':
        return { type: 'literal', value: token.value };
      case 'ident': {
        if (token.value === 'true') return { type: 'literal', value: true };
        if (token.value === 'false') return { type: 'literal', value: false };
        if (token.value === 'null') return { type: 'literal', value: null };
        if (this.isOp('(')) return { type: 'call', name: token.value, args: this.parseArguments() };
        return { type: 'ident', name: token.value };
      }
      case 'op': {
        if (token.value === '(') {
          const inner = this.parseTernary();
          this.expectOp(')');
          return inner;
        }
        if (token.value === '[') {
          const items: ExpressionNode[] = [];
          if (this.isOp(']')) {
            this.next();
            return { type: 'list', items };
          }
          for (;;) {
            items.push(this.parseTernary());
            if (this.isOp(',')) {
              this.next();
              continue;
            }
            this.expectOp(']');
            return { type: 'list', items };
          }
        }
        if (token.value === '{') {
          const entries: Array<{ key: ExpressionNode; value: ExpressionNode }> = [];
          if (this.isOp('}')) {
            this.next();
            return { type: 'map', entries };
          }
          for (;;) {
            const key = this.parseTernary();
            this.expectOp(':');
            const value = this.parseTernary();
            entries.push({ key, value });
            if (this.isOp(',')) {
              this.next();
              continue;
            }
            this.expectOp('}');
            return { type: 'map', entries };
          }
        }
        throw new ExpressionSyntaxError(`unexpected ${JSON.stringify(token.value)} at token ${this.pos}`);
      }
      case 'eof':
        throw new ExpressionSyntaxError('unexpected end of expression');
    }
  }
}

/** Parse an expression. Returns the AST or a problem string — total, never throws. */
export function parseExpression(source: string): { ast: ExpressionNode } | { error: string } {
  if (typeof source !== 'string' || source.trim().length === 0) return { error: 'expression is empty' };
  try {
    return { ast: new Parser(tokenize(source)).parseExpression() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The house `problems: string[]` idiom over ONE expression: `[]` when it parses. */
export function expressionProblems(source: unknown): string[] {
  if (typeof source !== 'string') return ['expression must be a string'];
  const parsed = parseExpression(source);
  return 'error' in parsed ? [`expression does not parse: ${parsed.error}`] : [];
}

// =============================================================================================
// Evaluator
// =============================================================================================

class EvalError extends Error {}

function isMap(value: ExpressionValue): value is { [key: string]: ExpressionValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: ExpressionValue): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function typeName(value: ExpressionValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'list';
  if (isMap(value)) return 'map';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  return typeof value;
}

function deepEqual(a: ExpressionValue, b: ExpressionValue): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]!));
  }
  if (isMap(a) && isMap(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && deepEqual(a[key]!, b[key]!));
  }
  return false;
}

function truncDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

function arithmetic(op: string, left: ExpressionValue, right: ExpressionValue): ExpressionValue {
  if (op === '+') {
    if (typeof left === 'string' && typeof right === 'string') return left + right;
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new EvalError(`no such overload: ${typeName(left)} ${op} ${typeName(right)}`);
  }
  const bothInt = isInteger(left) && isInteger(right);
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) throw new EvalError('division by zero');
      return bothInt ? truncDiv(left, right) : left / right;
    case '%':
      if (!bothInt) throw new EvalError(`no such overload: ${typeName(left)} % ${typeName(right)}`);
      if (right === 0) throw new EvalError('modulus by zero');
      return left % right;
    default:
      throw new EvalError(`unknown operator ${op}`);
  }
}

function compare(op: string, left: ExpressionValue, right: ExpressionValue): boolean {
  const comparable = (typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string');
  if (!comparable) throw new EvalError(`no such overload: ${typeName(left)} ${op} ${typeName(right)}`);
  switch (op) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      throw new EvalError(`unknown comparison ${op}`);
  }
}

function requireBool(value: ExpressionValue, where: string): boolean {
  if (typeof value !== 'boolean') throw new EvalError(`${where} expects a boolean, got ${typeName(value)}`);
  return value;
}

function evaluateHas(node: ExpressionNode, context: { [key: string]: ExpressionValue }): boolean {
  if (node.type !== 'member') throw new EvalError('has() takes a field selection, e.g. has(vars.patientAge)');
  let base: ExpressionValue;
  try {
    base = evalNode(node.object, context);
  } catch (error) {
    if (error instanceof EvalError) return false;
    throw error;
  }
  return isMap(base) && Object.prototype.hasOwnProperty.call(base, node.field);
}

function evalNode(node: ExpressionNode, context: { [key: string]: ExpressionValue }): ExpressionValue {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'ident': {
      if (!Object.prototype.hasOwnProperty.call(context, node.name)) throw new EvalError(`undeclared reference to '${node.name}'`);
      return context[node.name]!;
    }
    case 'list':
      return node.items.map((item) => evalNode(item, context));
    case 'map': {
      const out: { [key: string]: ExpressionValue } = {};
      for (const entry of node.entries) {
        const key = evalNode(entry.key, context);
        if (typeof key !== 'string') throw new EvalError(`map keys must be strings, got ${typeName(key)}`);
        // An OWN property, always (TASK-947 R2 L-2): `out[key] = …` with the key `__proto__` swaps
        // the prototype instead, the entry vanishes behind every `hasOwnProperty` gate, and the
        // Python mirror — which stores an ordinary dict key — disagrees on a value the run
        // supplied.
        Object.defineProperty(out, key, { value: evalNode(entry.value, context), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 'member': {
      const base = evalNode(node.object, context);
      if (!isMap(base)) throw new EvalError(`no such key: '${node.field}' on ${typeName(base)}`);
      if (!Object.prototype.hasOwnProperty.call(base, node.field)) throw new EvalError(`no such key: '${node.field}'`);
      return base[node.field]!;
    }
    case 'index': {
      const base = evalNode(node.object, context);
      const index = evalNode(node.index, context);
      if (Array.isArray(base)) {
        if (!isInteger(index)) throw new EvalError(`list index must be an int, got ${typeName(index)}`);
        if (index < 0 || index >= base.length) throw new EvalError(`index ${index} out of range`);
        return base[index]!;
      }
      if (isMap(base)) {
        if (typeof index !== 'string') throw new EvalError(`map key must be a string, got ${typeName(index)}`);
        if (!Object.prototype.hasOwnProperty.call(base, index)) throw new EvalError(`no such key: '${index}'`);
        return base[index]!;
      }
      throw new EvalError(`cannot index a ${typeName(base)}`);
    }
    case 'unary': {
      if (node.op === '!') return !requireBool(evalNode(node.operand, context), '!');
      const operand = evalNode(node.operand, context);
      if (typeof operand !== 'number') throw new EvalError(`no such overload: -${typeName(operand)}`);
      return -operand;
    }
    case 'binary': {
      if (node.op === '&&') {
        const left = requireBool(evalNode(node.left, context), '&&');
        if (!left) return false;
        return requireBool(evalNode(node.right, context), '&&');
      }
      if (node.op === '||') {
        const left = requireBool(evalNode(node.left, context), '||');
        if (left) return true;
        return requireBool(evalNode(node.right, context), '||');
      }
      const left = evalNode(node.left, context);
      const right = evalNode(node.right, context);
      switch (node.op) {
        case '==':
          return deepEqual(left, right);
        case '!=':
          return !deepEqual(left, right);
        case '<':
        case '<=':
        case '>':
        case '>=':
          return compare(node.op, left, right);
        case 'in': {
          if (Array.isArray(right)) return right.some((item) => deepEqual(item, left));
          if (isMap(right)) {
            if (typeof left !== 'string') throw new EvalError(`map membership needs a string key, got ${typeName(left)}`);
            return Object.prototype.hasOwnProperty.call(right, left);
          }
          throw new EvalError(`no such overload: ${typeName(left)} in ${typeName(right)}`);
        }
        default:
          return arithmetic(node.op, left, right);
      }
    }
    case 'ternary': {
      const condition = requireBool(evalNode(node.condition, context), '?:');
      return condition ? evalNode(node.then, context) : evalNode(node.else, context);
    }
    case 'call': {
      if (node.name === 'has') {
        if (node.args.length !== 1) throw new EvalError('has() takes exactly one argument');
        return evaluateHas(node.args[0]!, context);
      }
      const args = node.args.map((arg) => evalNode(arg, context));
      return callFunction(node.name, args);
    }
    case 'method': {
      const target = evalNode(node.target, context);
      const args = node.args.map((arg) => evalNode(arg, context));
      return callMethod(node.name, target, args);
    }
  }
}

function callFunction(name: string, args: ExpressionValue[]): ExpressionValue {
  const one = (): ExpressionValue => {
    if (args.length !== 1) throw new EvalError(`${name}() takes exactly one argument`);
    return args[0]!;
  };
  switch (name) {
    case 'size': {
      const value = one();
      if (typeof value === 'string') return Array.from(value).length;
      if (Array.isArray(value)) return value.length;
      if (isMap(value)) return Object.keys(value).length;
      throw new EvalError(`size() is not defined on ${typeName(value)}`);
    }
    case 'string': {
      const value = one();
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw new EvalError(`string() is not defined on ${typeName(value)}`);
    }
    case 'int': {
      const value = one();
      if (typeof value === 'number') return Math.trunc(value);
      if (typeof value === 'string') {
        if (!/^[+-]?\d+$/.test(value.trim())) throw new EvalError(`int() cannot parse ${JSON.stringify(value)}`);
        return Number(value.trim());
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      throw new EvalError(`int() is not defined on ${typeName(value)}`);
    }
    case 'double': {
      const value = one();
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const parsed = Number(value.trim());
        if (value.trim().length === 0 || Number.isNaN(parsed)) throw new EvalError(`double() cannot parse ${JSON.stringify(value)}`);
        return parsed;
      }
      throw new EvalError(`double() is not defined on ${typeName(value)}`);
    }
    default:
      throw new EvalError(`unknown function ${name}()`);
  }
}

function callMethod(name: string, target: ExpressionValue, args: ExpressionValue[]): ExpressionValue {
  switch (name) {
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (typeof target !== 'string') throw new EvalError(`${name}() is not defined on ${typeName(target)}`);
      if (args.length !== 1 || typeof args[0] !== 'string') throw new EvalError(`${name}() takes exactly one string argument`);
      const needle = args[0];
      if (name === 'contains') return target.includes(needle);
      if (name === 'startsWith') return target.startsWith(needle);
      return target.endsWith(needle);
    }
    case 'size':
      return callFunction('size', [target]);
    default:
      throw new EvalError(`unknown method ${name}()`);
  }
}

/**
 * Evaluate `source` against `context` — the run context `{ trigger, vars, nodes }`. TOTAL: a
 * parse failure, an unknown identifier, a missing key or a type mismatch all resolve to
 * `{ error }`; nothing here throws, reads a clock, or touches I/O.
 */
export function evaluateExpression(source: string, context: { [key: string]: ExpressionValue }): ExpressionResult {
  const parsed = parseExpression(source);
  if ('error' in parsed) return { error: parsed.error };
  try {
    return { value: evalNode(parsed.ast, context) };
  } catch (error) {
    if (error instanceof EvalError) return { error: error.message };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Evaluate as a CONDITION: `true` only when the expression evaluates to the boolean `true`. */
export function evaluateCondition(source: string, context: { [key: string]: ExpressionValue }): { taken: boolean; error?: string } {
  const result = evaluateExpression(source, context);
  if ('error' in result) return { taken: false, error: result.error };
  if (typeof result.value !== 'boolean') return { taken: false, error: `condition must evaluate to a boolean, got ${typeName(result.value)}` };
  return { taken: result.value };
}

/** Every identifier at the root of an expression — what the Studio autocompletes and the
 *  publish-time check compares against the declared context roots. */
export function expressionRootIdentifiers(source: string): string[] {
  const parsed = parseExpression(source);
  if ('error' in parsed) return [];
  const roots = new Set<string>();
  const walk = (node: ExpressionNode): void => {
    switch (node.type) {
      case 'ident':
        roots.add(node.name);
        return;
      case 'list':
        node.items.forEach(walk);
        return;
      case 'map':
        node.entries.forEach((entry) => {
          walk(entry.key);
          walk(entry.value);
        });
        return;
      case 'member':
        walk(node.object);
        return;
      case 'index':
        walk(node.object);
        walk(node.index);
        return;
      case 'call':
        node.args.forEach(walk);
        return;
      case 'method':
        walk(node.target);
        node.args.forEach(walk);
        return;
      case 'unary':
        walk(node.operand);
        return;
      case 'binary':
        walk(node.left);
        walk(node.right);
        return;
      case 'ternary':
        walk(node.condition);
        walk(node.then);
        walk(node.else);
        return;
      case 'literal':
        return;
    }
  };
  walk(parsed.ast);
  return [...roots].sort();
}

/** The three roots every run context declares (TASK-864 §3.2). */
export const EXPRESSION_CONTEXT_ROOTS: readonly string[] = Object.freeze(['trigger', 'vars', 'nodes']);
