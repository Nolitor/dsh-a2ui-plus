/**
 * A2UI v1.0 `regex` dialect and static safety check.
 *
 * Implements `specification/v1_0/docs/a2ui_protocol.md` §"The `regex` function":
 * the portable dialect subset plus the four static rejection rules, before any
 * matching runs. The check also rejects repeated ambiguous groups before the
 * pattern reaches JavaScript's backtracking engine.
 *
 * Rules (verbatim from the spec):
 *  1. longer than 256 code points;
 *  2. a quantifier with upper bound > 1 applied to a subexpression containing an
 *     unbounded quantifier;
 *  3. an unbounded quantifier applied to an alternation where two branches can
 *     start with the same character;
 *  4. two unbounded-quantified atoms with overlapping character sets adjacent in
 *     one concatenation, where only zero-width or empty-matching items lie
 *     between them.
 */

/** Longest accepted pattern, in code points (spec §1). */
export const MAX_REGEX_PATTERN = 256
/** Longest accepted input, in code points (spec: no match, not an error). */
export const MAX_REGEX_INPUT = 4_096
/** Largest explicit repetition bound accepted by the dialect. */
const MAX_REPEAT_BOUND = 100_000

/** A pattern is admissible when this returns `undefined`. */
export function regexUnsafeReason(pattern: string): string | undefined {
  try {
    checkedBranches(pattern)
  } catch (error) {
    return error instanceof RegexSyntaxError ? error.message : 'pattern could not be parsed'
  }
  return undefined
}

function checkedBranches(pattern: string): Branch[] {
  if (pattern.length === 0) throw new RegexSyntaxError('pattern is empty')
  if ([...pattern].length > MAX_REGEX_PATTERN) throw new RegexSyntaxError(`pattern is longer than ${MAX_REGEX_PATTERN} code points`)
  const dialect = dialectProblem(pattern)
  if (dialect !== undefined) throw new RegexSyntaxError(dialect)
  const branches = parseAlternation(pattern)
  const problem = checkBranches(branches)
  if (problem !== undefined) throw new RegexSyntaxError(problem)
  return branches
}

/** Whether a pattern may be executed. */
export function isSafeRegexPattern(pattern: string): boolean {
  return regexUnsafeReason(pattern) === undefined
}

/** Whether the input is too long to test (no match, no error). */
export function regexInputUnsafeReason(input: string): string | undefined {
  return [...input].length > MAX_REGEX_INPUT ? `input is longer than ${MAX_REGEX_INPUT} code points` : undefined
}

/** Dialect-level rejections — constructs the portable subset does not allow. */
function dialectProblem(pattern: string): string | undefined {
  if (/\\[1-9]/u.test(pattern)) return 'backreferences are not allowed'
  if (/\(\?<(?=[=!])/u.test(pattern)) return 'lookbehind assertions are not allowed'
  if (/\(\?<[A-Za-z]/u.test(pattern)) return 'named groups are not allowed'
  if (/\\[pP]\{/u.test(pattern)) return '\\p{...} character properties are not allowed'
  if (/\\c[A-Za-z]/u.test(pattern)) return '\\cX control escapes are not allowed'
  if (/\(\?[A-Za-z-]+[:)]/u.test(pattern)) return 'inline flags are not allowed'
  if (/\(\?>/u.test(pattern)) return 'atomic groups are not allowed'
  if (/\\k</u.test(pattern)) return 'named backreferences are not allowed'
  return undefined
}

/* ------------------------------------------------------------------ */
/* Character sets                                                      */
/* ------------------------------------------------------------------ */

interface CharSet {
  any: boolean
  chars: Set<string>
}

const DIGITS = '0123456789'
const WORD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
const SPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'

function setOf(text: string): CharSet {
  return { any: false, chars: new Set([...text]) }
}

const ANY: CharSet = { any: true, chars: new Set() }

function emptySet(): CharSet {
  return { any: false, chars: new Set() }
}

function unionSet(into: CharSet, other: CharSet): void {
  if (other.any) {
    into.any = true
    into.chars.clear()
    return
  }
  if (into.any) return
  for (const char of other.chars) into.chars.add(char)
}

function overlaps(left: CharSet, right: CharSet): boolean {
  if (left.any || right.any) return true
  for (const char of left.chars) if (right.chars.has(char)) return true
  return false
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export class RegexSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexSyntaxError'
  }
}

interface Quantifier {
  min: number
  /** `Infinity` for `*`, `+`, `{n,}`. */
  max: number
  lazy?: boolean
}

interface Term {
  /** A single atom or assertion, with no group or quantifier. */
  atom?: RegExp
  set: CharSet
  nullable: boolean
  zeroWidth: boolean
  /** Quantifier applied to this term, if any. */
  quantifier?: Quantifier
  /** Whether the term's subexpression contains an unbounded quantifier. */
  containsUnbounded: boolean
  /** Branch analyses for groups and lookaheads. */
  groupBranches?: Branch[]
  lookahead?: 'positive' | 'negative'
}

interface Branch {
  terms: Term[]
  /** Nullable: every term is zero-width or nullable. */
  nullable: boolean
  /** First-character set of the branch. */
  first: CharSet
  /** Whether any term inside carries an unbounded quantifier. */
  containsUnbounded: boolean
}

interface Frame {
  branches: Branch[]
  terms: Term[]
}

function newFrame(): Frame {
  return { branches: [], terms: [] }
}

function finishBranch(frame: Frame): void {
  const first = emptySet()
  let nullable = true
  for (const term of frame.terms) {
    if (!term.zeroWidth && term.quantifier?.max !== 0) unionSet(first, term.set)
    if (!term.nullable && !term.zeroWidth) {
      nullable = false
      break
    }
  }
  frame.branches.push({
    terms: frame.terms,
    nullable,
    first,
    containsUnbounded: frame.terms.some((term) => term.containsUnbounded),
  })
  frame.terms = []
}

function parseAlternation(pattern: string): Branch[] {
  const root = newFrame()
  const stack: Array<{ frame: Frame; lookahead?: Term['lookahead'] }> = []
  let frames = root
  let index = 0

  const pushTerm = (term: Term, source?: string): void => {
    if (source !== undefined) term.atom = new RegExp(source, 'uy')
    frames.terms.push(term)
  }

  while (index < pattern.length) {
    const char = String.fromCodePoint(pattern.codePointAt(index) as number)
    if (char === '\\') {
      const { term, next } = parseEscape(pattern, index)
      pushTerm(term, pattern.slice(index, next))
      index = next
      continue
    }
    if (char === '[') {
      const { set, next } = parseClass(pattern, index)
      pushTerm({ set, nullable: false, zeroWidth: false, containsUnbounded: false }, pattern.slice(index, next))
      index = next
      continue
    }
    if (char === '.') {
      pushTerm({ set: ANY, nullable: false, zeroWidth: false, containsUnbounded: false }, char)
      index += 1
      continue
    }
    if (char === '(') {
      // `(?:`, `(?=`, `(?!` are the accepted group openers.
      const rest = pattern.slice(index)
      const lookahead = rest.startsWith('(?=') ? 'positive' : rest.startsWith('(?!') ? 'negative' : undefined
      const opener = /^\(\?(?:[:=!])/u.test(rest) ? 3 : 1
      const frame = newFrame()
      stack.push({ frame, lookahead })
      frames = frame
      index += opener
      continue
    }
    if (char === ')') {
      const entry = stack.pop()
      if (entry === undefined) throw new RegexSyntaxError('unbalanced ")"')
      finishBranch(entry.frame)
      const branches = entry.frame.branches
      const first = emptySet()
      let nullable = false
      let containsUnbounded = false
      for (const branch of branches) {
        unionSet(first, branch.first)
        nullable = nullable || branch.nullable
        containsUnbounded = containsUnbounded || branch.containsUnbounded
      }
      frames = stack.length > 0 ? stack[stack.length - 1].frame : root
      const assertion = entry.lookahead !== undefined
      pushTerm({
        set: assertion ? emptySet() : first,
        nullable: assertion || nullable,
        zeroWidth: assertion,
        containsUnbounded,
        groupBranches: branches,
        lookahead: entry.lookahead,
      })
      index += 1
      continue
    }
    if (char === '|') {
      finishBranch(frames)
      index += 1
      continue
    }
    if (char === '*' || char === '+' || char === '?' || char === '{') {
      index = applyQuantifier(frames, pattern, index)
      continue
    }
    if (char === '^' || char === '$') {
      pushTerm({ set: emptySet(), nullable: true, zeroWidth: true, containsUnbounded: false }, char)
      index += 1
      continue
    }
    // A literal character.
    if (char === ']' || char === '}') throw new RegexSyntaxError(`unexpected "${char}"`)
    pushTerm({ set: setOf(char), nullable: false, zeroWidth: false, containsUnbounded: false }, char)
    index += char.length
  }
  if (stack.length > 0) throw new RegexSyntaxError('unbalanced "("')
  finishBranch(root)
  return root.branches
}

function applyQuantifier(frame: Frame, pattern: string, index: number): number {
  const last = frame.terms[frame.terms.length - 1]
  if (last === undefined) throw new RegexSyntaxError('quantifier without a target')
  if (last.quantifier !== undefined) throw new RegexSyntaxError('a quantifier cannot follow another quantifier')
  const char = pattern[index] as string
  let quantifier: Quantifier
  let next = index + 1
  if (char === '*') quantifier = { min: 0, max: Infinity }
  else if (char === '+') quantifier = { min: 1, max: Infinity }
  else if (char === '?') quantifier = { min: 0, max: 1 }
  else {
    const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(index))
    if (match === null) throw new RegexSyntaxError('malformed repetition quantifier')
    const min = Number(match[1])
    const max = match[2] === undefined ? min : match[2] === '' ? Infinity : Number(match[2])
    if (min > MAX_REPEAT_BOUND || (Number.isFinite(max) && max > MAX_REPEAT_BOUND)) {
      throw new RegexSyntaxError(`repetition bound exceeds ${MAX_REPEAT_BOUND}`)
    }
    if (Number.isFinite(max) && max < min) throw new RegexSyntaxError('repetition range is inverted')
    quantifier = { min, max }
    next = index + match[0].length
  }
  if (pattern[next] === '?') {
    quantifier.lazy = true
    next += 1
  }
  applyQuantifierTo(last, quantifier)
  return next
}

function applyQuantifierTo(term: Term, quantifier: Quantifier): void {
  if (term.zeroWidth) throw new RegexSyntaxError('an assertion cannot be quantified')
  // Rule 2: a bounded-but-above-1 quantifier over a subexpression that itself
  // repeats without bound is the nested-quantifier shape.
  if (quantifier.max > 1 && term.containsUnbounded) {
    throw new RegexSyntaxError('a repeated subexpression must not contain an unbounded repetition')
  }
  // Even a bounded repeat can backtrack exponentially over overlapping alternatives.
  if (quantifier.max > 1 && term.groupBranches !== undefined) {
    const branches = term.groupBranches
    for (let left = 0; left < branches.length; left += 1) {
      for (let right = left + 1; right < branches.length; right += 1) {
        if (overlaps((branches[left] as Branch).first, (branches[right] as Branch).first)) {
          throw new RegexSyntaxError('a repeated group over alternatives that can start the same way is not allowed')
        }
      }
    }
  }
  term.quantifier = quantifier
  term.nullable = term.nullable || quantifier.min === 0
  if (quantifier.max === Infinity) term.containsUnbounded = true
}

type Step =
  | { kind: 'branch'; terms: readonly Term[]; index: number; next?: Step }
  | { kind: 'repeat'; term: Term; count: number; previous?: number; next?: Step }

/** Work limit shared by search, repeats and nested lookaheads for one match. */
const MAX_MATCH_STEPS = 100_000

/**
 * Execute only single atoms with native RegExp. The explicit worklist bounds
 * group expansion and backtracking even for patterns the static checks accept.
 */
export function matchRegex(pattern: string, input: string): boolean {
  const branches = checkedBranches(pattern)
  let remaining = MAX_MATCH_STEPS
  const spend = (): void => {
    if (--remaining < 0) throw new RegexSyntaxError('pattern exceeded the match work limit')
  }
  const search = (options: Branch[], start: number): boolean => {
    const pending: Array<{ position: number; step?: Step }> = []
    const pushBranches = (choices: Branch[], position: number, next?: Step): void => {
      for (let index = choices.length - 1; index >= 0; index -= 1) {
        spend()
        pending.push({ position, step: { kind: 'branch', terms: choices[index].terms, index: 0, next } })
      }
    }
    pushBranches(options, start)
    while (pending.length > 0) {
      spend()
      const { position, step } = pending.pop()!
      if (step === undefined) return true
      if (step.kind === 'branch') {
        const term = step.terms[step.index]
        if (term === undefined) {
          pending.push({ position, step: step.next })
        } else {
          const next: Step = { ...step, index: step.index + 1 }
          pending.push({ position, step: { kind: 'repeat', term, count: 0, next } })
        }
        continue
      }

      const { term, count, previous, next } = step
      const min = term.quantifier?.min ?? 1
      const max = term.quantifier?.max ?? 1
      const canStop = count >= min
      const lazy = term.quantifier?.lazy === true
      if (canStop && !lazy) pending.push({ position, step: next })
      if (count < max && !(position === previous && canStop)) {
        const repeat: Step = { ...step, count: count + 1, previous: position }
        if (term.atom !== undefined) {
          term.atom.lastIndex = position
          if (term.atom.test(input)) pending.push({ position: term.atom.lastIndex, step: repeat })
        } else if (term.groupBranches !== undefined) {
          if (term.lookahead === undefined) pushBranches(term.groupBranches, position, repeat)
          else if (search(term.groupBranches, position) === (term.lookahead === 'positive')) {
            pending.push({ position, step: repeat })
          }
        }
      }
      if (canStop && lazy) pending.push({ position, step: next })
    }
    return false
  }
  for (let start = 0; start <= input.length; ) {
    if (search(branches, start)) return true
    const code = input.codePointAt(start)
    start += code !== undefined && code > 0xffff ? 2 : 1
  }
  return false
}

function checkBranches(branches: Branch[]): string | undefined {
  for (const branch of branches) {
    // Rule 4: two unbounded atoms whose character sets overlap, with only
    // zero-width or empty-matching items between them. An item that can match
    // empty keeps the previous candidates reachable, so the candidates are kept
    // as a set rather than a single "last" value.
    const active: CharSet[] = []
    for (const term of branch.terms) {
      if (term.groupBranches !== undefined) {
        const problem = checkBranches(term.groupBranches)
        if (problem !== undefined) return problem
      }
      const unbounded = term.quantifier !== undefined && term.quantifier.max === Infinity
      const trivial = term.zeroWidth || term.nullable
      if (unbounded) {
        for (const set of active) {
          if (overlaps(set, term.set)) return 'two adjacent unbounded repetitions can match the same characters'
        }
        if (trivial) active.push(term.set)
        else {
          active.length = 0
          active.push(term.set)
        }
        continue
      }
      if (trivial) continue
      // A consuming item that cannot match empty separates the repetitions.
      active.length = 0
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Lexical helpers                                                     */
/* ------------------------------------------------------------------ */

function parseEscape(pattern: string, index: number): { term: Term; next: number } {
  const char = pattern[index + 1]
  if (char === undefined) throw new RegexSyntaxError('pattern ends with a backslash')
  const simple = (text: string): { term: Term; next: number } => ({
    term: { set: setOf(text), nullable: false, zeroWidth: false, containsUnbounded: false },
    next: index + 2,
  })
  if (char === 'd') return { term: { set: setOf(DIGITS), nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + 2 }
  if (char === 'w') return { term: { set: setOf(WORD), nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + 2 }
  if (char === 's') return { term: { set: setOf(SPACE), nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + 2 }
  if (char === 'D' || char === 'W' || char === 'S') {
    return { term: { set: ANY, nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + 2 }
  }
  if (char === 'b' || char === 'B') {
    return { term: { set: emptySet(), nullable: true, zeroWidth: true, containsUnbounded: false }, next: index + 2 }
  }
  if (char === 'n') return simple('\n')
  if (char === 't') return simple('\t')
  if (char === 'r') return simple('\r')
  if (char === 'v') return simple('\v')
  if (char === 'f') return simple('\f')
  if (char === '0') {
    if (/\d/u.test(pattern[index + 2] ?? '')) throw new RegexSyntaxError('octal escapes are not allowed')
    return simple('\0')
  }
  if (char === 'x') {
    const hex = pattern.slice(index + 2, index + 4)
    if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) throw new RegexSyntaxError('malformed \\xHH escape')
    return { term: { set: setOf(String.fromCharCode(Number.parseInt(hex, 16))), nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + 4 }
  }
  if (char === 'u') {
    const braced = /^u\{([0-9A-Fa-f]{1,6})\}/u.exec(pattern.slice(index + 1))
    if (braced !== null) {
      const code = Number.parseInt(braced[1] as string, 16)
      if (code > 0x10ffff) throw new RegexSyntaxError('code point out of range')
      return { term: { set: setOf(String.fromCodePoint(code)), nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + 1 + braced[0].length }
    }
    const hex = pattern.slice(index + 2, index + 6)
    if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) throw new RegexSyntaxError('malformed \\uHHHH escape')
    const high = Number.parseInt(hex, 16)
    const low = /^\\u([dD][c-fC-F][0-9A-Fa-f]{2})/u.exec(pattern.slice(index + 6))
    const pair = high >= 0xd800 && high <= 0xdbff && low !== null
    const value = pair ? String.fromCharCode(high, Number.parseInt(low[1], 16)) : String.fromCharCode(high)
    return { term: { set: setOf(value), nullable: false, zeroWidth: false, containsUnbounded: false }, next: index + (pair ? 12 : 6) }
  }
  // Identity escape of a syntax character or any literal.
  return simple(char)
}

function parseClass(pattern: string, index: number): { set: CharSet; next: number } {
  const end = skipClass(pattern, index + 1)
  let cursor = index + 1
  if (pattern[cursor] === '^') return { set: ANY, next: end }
  const chars = new Set<string>()
  while (cursor < end - 1) {
    const char = String.fromCodePoint(pattern.codePointAt(cursor) as number)
    const after = cursor + char.length
    if (char === '\\') {
      // Native Unicode classes interpret \b as backspace, and escapes can
      // participate in ranges. Use a conservative set for these classes.
      if (pattern[cursor + 1] === 'b') return { set: ANY, next: end }
      const { term, next } = parseEscape(pattern, cursor)
      if (term.set.any || pattern[next] === '-') return { set: ANY, next: end }
      for (const member of term.set.chars) chars.add(member)
      cursor = next
      continue
    }
    // Range `a-z`.
    if (pattern[after] === '-' && after + 1 < end - 1) {
      if (pattern[after + 1] === '\\') return { set: ANY, next: end }
      const from = char.codePointAt(0) as number
      const to = pattern.codePointAt(after + 1) as number
      if (to < from) throw new RegexSyntaxError('character class range is inverted')
      if (to - from > 5_000) return { set: ANY, next: end }
      for (let code = from; code <= to; code += 1) chars.add(String.fromCodePoint(code))
      cursor = after + (to > 0xffff ? 3 : 2)
      continue
    }
    chars.add(char)
    cursor = after
  }
  return { set: { any: false, chars }, next: end }
}

/** Skip to the end of a character class without expanding it. */
function skipClass(pattern: string, index: number): number {
  let cursor = index
  while (cursor < pattern.length) {
    if (pattern[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (pattern[cursor] === ']') return cursor + 1
    cursor += 1
  }
  throw new RegexSyntaxError('unterminated character class')
}
