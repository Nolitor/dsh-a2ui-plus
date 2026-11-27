/**
 * A deliberately small arithmetic expression language for the `Plot`
 * extension component.
 *
 * Why not use `eval`/`new Function`: a model-authored string must never become
 * executable code. This parser accepts only numbers, a fixed identifier set
 * (the plot's `x` plus caller-supplied variables and named constants), the
 * operators `+ - * / ^ %`, parentheses, and calls to a closed list of math
 * functions. Everything else is a compile error, so a payload can never reach
 * `window`, `fetch`, constructors, or property access.
 */

export interface ExpressionScope {
  [name: string]: number
}

export interface CompiledExpression {
  /** Evaluate with a variable scope; returns `NaN` for an undefined variable. */
  evaluate: (scope: ExpressionScope) => number
  /** Variables the expression reads, for validation and for diagnostics. */
  variables: readonly string[]
}

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: '-' | '+'; operand: Node }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/' | '^' | '%'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
}

const UNARY_FUNCTIONS: Record<string, (value: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  trunc: Math.trunc,
  sign: Math.sign,
  radians: (value: number) => (value * Math.PI) / 180,
  degrees: (value: number) => (value * 180) / Math.PI,
}

const BINARY_FUNCTIONS: Record<string, (left: number, right: number) => number> = {
  pow: (left, right) => left ** right,
  min: Math.min,
  max: Math.max,
  atan2: Math.atan2,
  mod: (left, right) => left % right,
}

/** Names that must never be read as plot variables (they exist in the browser). */
const RESERVED_NAMES = new Set([
  'this',
  'window',
  'globalThis',
  'self',
  'document',
  'process',
  'global',
  'constructor',
  'prototype',
  '__proto__',
  'eval',
  'Function',
  'require',
  'import',
  'await',
  'new',
  'typeof',
  'void',
])

const MAX_SOURCE = 240
const MAX_TOKENS = 512
const MAX_DEPTH = 32
const MAX_ARGUMENTS = 4

interface Token {
  kind: 'number' | 'name' | 'operator' | 'lparen' | 'rparen' | 'comma'
  text: string
  position: number
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionError'
  }
}

function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE) throw new ExpressionError(`expression is longer than ${MAX_SOURCE} characters`)
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index] as string
    if (/\s/u.test(character)) {
      index += 1
      continue
    }
    if (tokens.length >= MAX_TOKENS) throw new ExpressionError('expression has too many tokens')
    if (/[0-9.]/u.test(character)) {
      const start = index
      index += 1
      while (index < source.length && /[0-9.eE]/u.test(source[index] as string)) {
        // Support `1e-3`.
        if (/[eE]/u.test(source[index] as string) && /[+-]/u.test(source[index + 1] ?? '')) index += 1
        index += 1
      }
      const text = source.slice(start, index)
      if (!Number.isFinite(Number(text))) throw new ExpressionError(`"${text}" is not a number`)
      tokens.push({ kind: 'number', text, position: start })
      continue
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index
      index += 1
      while (index < source.length && /[A-Za-z0-9_]/u.test(source[index] as string)) index += 1
      tokens.push({ kind: 'name', text: source.slice(start, index), position: start })
      continue
    }
    if ('+-*/^%'.includes(character)) {
      tokens.push({ kind: 'operator', text: character, position: index })
      index += 1
      continue
    }
    if (character === '(') {
      tokens.push({ kind: 'lparen', text: character, position: index })
      index += 1
      continue
    }
    if (character === ')') {
      tokens.push({ kind: 'rparen', text: character, position: index })
      index += 1
      continue
    }
    if (character === ',') {
      tokens.push({ kind: 'comma', text: character, position: index })
      index += 1
      continue
    }
    throw new ExpressionError(`unexpected character "${character}" at position ${index}`)
  }
  if (tokens.length === 0) throw new ExpressionError('expression is empty')
  return tokens
}

class Parser {
  private position = 0
  private depth = 0
  readonly variables = new Set<string>()

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseExpression()
    if (this.position !== this.tokens.length) {
      const token = this.tokens[this.position] as Token
      throw new ExpressionError(`unexpected "${token.text}" at position ${token.position}`)
    }
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.position]
  }

  private next(): Token | undefined {
    const token = this.tokens[this.position]
    this.position += 1
    return token
  }

  private enter(): void {
    this.depth += 1
    if (this.depth > MAX_DEPTH) throw new ExpressionError('expression nests too deeply')
  }

  private leave(): void {
    this.depth -= 1
  }

  private parseExpression(): Node {
    this.enter()
    try {
      let left = this.parseTerm()
      for (;;) {
        const token = this.peek()
        if (token?.kind !== 'operator' || (token.text !== '+' && token.text !== '-')) break
        this.next()
        left = { kind: 'binary', operator: token.text, left, right: this.parseTerm() }
      }
      return left
    } finally {
      this.leave()
    }
  }

  private parseTerm(): Node {
    let left = this.parseUnary()
    for (;;) {
      const token = this.peek()
      if (token?.kind !== 'operator' || !'*/%'.includes(token.text)) break
      this.next()
      left = { kind: 'binary', operator: token.text as '*' | '/' | '%', left, right: this.parseUnary() }
    }
    return left
  }

  private parseUnary(): Node {
    const token = this.peek()
    if (token?.kind === 'operator' && (token.text === '-' || token.text === '+')) {
      this.next()
      this.enter()
      try {
        return { kind: 'unary', operator: token.text, operand: this.parseUnary() }
      } finally {
        this.leave()
      }
    }
    return this.parsePower()
  }

  private parsePower(): Node {
    const base = this.parsePrimary()
    const token = this.peek()
    if (token?.kind === 'operator' && token.text === '^') {
      this.next()
      this.enter()
      try {
        // Right-associative: 2^3^2 is 2^(3^2).
        return { kind: 'binary', operator: '^', left: base, right: this.parseUnary() }
      } finally {
        this.leave()
      }
    }
    return base
  }

  private parsePrimary(): Node {
    const token = this.next()
    if (token === undefined) throw new ExpressionError('expression ends unexpectedly')
    if (token.kind === 'number') return { kind: 'number', value: Number(token.text) }
    if (token.kind === 'lparen') {
      const inner = this.parseExpression()
      const close = this.next()
      if (close?.kind !== 'rparen') throw new ExpressionError(`expected ")" at position ${token.position}`)
      return inner
    }
    if (token.kind === 'name') {
      if (RESERVED_NAMES.has(token.text)) throw new ExpressionError(`"${token.text}" is not allowed in a plot expression`)
      const following = this.peek()
      if (following?.kind === 'lparen') {
        this.next()
        const args: Node[] = []
        if (this.peek()?.kind !== 'rparen') {
          for (;;) {
            if (args.length >= MAX_ARGUMENTS) throw new ExpressionError(`"${token.text}" takes at most ${MAX_ARGUMENTS} arguments`)
            args.push(this.parseExpression())
            const separator = this.next()
            if (separator?.kind === 'rparen') break
            if (separator?.kind !== 'comma') throw new ExpressionError(`expected "," or ")" in call to "${token.text}"`)
          }
        } else {
          this.next()
        }
        return this.makeCall(token.text, args)
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, token.text)) {
        return { kind: 'number', value: CONSTANTS[token.text] as number }
      }
      this.variables.add(token.text)
      return { kind: 'variable', name: token.text }
    }
    throw new ExpressionError(`unexpected "${token.text}" at position ${token.position}`)
  }

  private makeCall(name: string, args: Node[]): Node {
    if (Object.prototype.hasOwnProperty.call(UNARY_FUNCTIONS, name)) {
      if (args.length !== 1) throw new ExpressionError(`"${name}" takes exactly 1 argument`)
      return { kind: 'call', name, args }
    }
    if (Object.prototype.hasOwnProperty.call(BINARY_FUNCTIONS, name)) {
      if (args.length !== 2) throw new ExpressionError(`"${name}" takes exactly 2 arguments`)
      return { kind: 'call', name, args }
    }
    throw new ExpressionError(`unknown function "${name}"`)
  }
}

function evaluateNode(node: Node, scope: ExpressionScope): number {
  switch (node.kind) {
    case 'number':
      return node.value
    case 'variable': {
      const value = node.name === 'x' ? scope.x : scope[node.name]
      return typeof value === 'number' ? value : Number.NaN
    }
    case 'unary': {
      const operand = evaluateNode(node.operand, scope)
      return node.operator === '-' ? -operand : operand
    }
    case 'binary': {
      const left = evaluateNode(node.left, scope)
      const right = evaluateNode(node.right, scope)
      switch (node.operator) {
        case '+':
          return left + right
        case '-':
          return left - right
        case '*':
          return left * right
        case '/':
          return right === 0 ? Number.NaN : left / right
        case '%':
          return right === 0 ? Number.NaN : left % right
        case '^':
          return left ** right
        default:
          return Number.NaN
      }
    }
    case 'call': {
      const values = node.args.map((argument) => evaluateNode(argument, scope))
      const unary = UNARY_FUNCTIONS[node.name]
      if (unary !== undefined) return unary(values[0] as number)
      const binary = BINARY_FUNCTIONS[node.name]
      if (binary !== undefined) return binary(values[0] as number, values[1] as number)
      return Number.NaN
    }
    default:
      return Number.NaN
  }
}

/**
 * Compile an expression.
 * @throws {ExpressionError} when the source uses anything outside the grammar.
 */
export function compileExpression(source: string): CompiledExpression {
  const parser = new Parser(tokenize(source))
  const ast = parser.parse()
  const variables = [...parser.variables].filter((name) => name !== 'x')
  return {
    evaluate: (scope) => evaluateNode(ast, scope),
    variables,
  }
}

/** Non-throwing compile used by the renderer. */
export function tryCompileExpression(source: string): CompiledExpression | undefined {
  try {
    return compileExpression(source)
  } catch {
    return undefined
  }
}

/** Names a plot may bind besides `x`. */
export const EXPRESSION_FUNCTIONS = [...Object.keys(UNARY_FUNCTIONS), ...Object.keys(BINARY_FUNCTIONS)]
export const EXPRESSION_CONSTANTS = Object.keys(CONSTANTS)
