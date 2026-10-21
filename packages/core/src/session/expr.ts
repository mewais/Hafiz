// A tiny, safe expression language for compliance conditions (compliance.yaml `cond`).
// Grammar:  or := and ('||' and)* · and := not ('&&' not)* · not := '!' not | cmp
//           cmp := primary (('>'|'>='|'<'|'<='|'=='|'!=') primary)? · primary := number | ident | '(' or ')'
// No property access, calls, strings or assignment: nothing in a condition can reach the host.

export class ExprError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExprError'
  }
}

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'id'; name: string }
  | { t: 'not'; e: Expr }
  | { t: 'bin'; op: '&&' | '||' | '>' | '>=' | '<' | '<=' | '==' | '!='; l: Expr; r: Expr }

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||>=|<=|==|!=|[><!()]))/y

const CMP_OPS = ['>', '>=', '<', '<=', '==', '!='] as const
const isCmp = (v: string): v is (typeof CMP_OPS)[number] =>
  (CMP_OPS as readonly string[]).includes(v)

function tokenize(src: string): Array<{ k: 'num' | 'id' | 'op'; v: string }> {
  const out: Array<{ k: 'num' | 'id' | 'op'; v: string }> = []
  TOKEN.lastIndex = 0
  let pos = 0
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(src)
    if (!m) throw new ExprError(`unexpected character at ${pos} in '${src}'`)
    pos = TOKEN.lastIndex
    if (m[1] !== undefined) out.push({ k: 'num', v: m[1] })
    else if (m[2] !== undefined) out.push({ k: 'id', v: m[2] })
    else out.push({ k: 'op', v: m[3] as string })
  }
  return out
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const isOp = (v: string) => toks[i]?.k === 'op' && toks[i]?.v === v
  const orExpr = (): Expr => {
    let l = andExpr()
    while (isOp('||')) {
      i++
      l = { t: 'bin', op: '||', l, r: andExpr() }
    }
    return l
  }
  const andExpr = (): Expr => {
    let l = notExpr()
    while (isOp('&&')) {
      i++
      l = { t: 'bin', op: '&&', l, r: notExpr() }
    }
    return l
  }
  const notExpr = (): Expr => {
    if (isOp('!')) {
      i++
      return { t: 'not', e: notExpr() }
    }
    return cmp()
  }
  const cmp = (): Expr => {
    const l = primary()
    const t = peek()
    if (t?.k === 'op' && isCmp(t.v)) {
      i++
      return { t: 'bin', op: t.v, l, r: primary() }
    }
    return l
  }
  const primary = (): Expr => {
    const t = toks[i++]
    if (!t) throw new ExprError(`unexpected end of expression '${src}'`)
    if (t.k === 'num') return { t: 'num', v: Number(t.v) }
    if (t.k === 'id') return { t: 'id', name: t.v }
    if (t.v === '(') {
      const e = orExpr()
      if (!isOp(')')) throw new ExprError(`missing ')' in '${src}'`)
      i++
      return e
    }
    throw new ExprError(`unexpected '${t.v}' in '${src}'`)
  }
  if (!toks.length) throw new ExprError('empty expression')
  const e = orExpr()
  if (i < toks.length) throw new ExprError(`unexpected '${toks[i]?.v}' in '${src}'`)
  return e
}

/** Identifier names an expression reads. */
export function identifiers(e: Expr, into = new Set<string>()): Set<string> {
  if (e.t === 'id') into.add(e.name)
  else if (e.t === 'not') identifiers(e.e, into)
  else if (e.t === 'bin') {
    identifiers(e.l, into)
    identifiers(e.r, into)
  }
  return into
}

function num(e: Expr, vars: Readonly<Record<string, number>>): number {
  switch (e.t) {
    case 'num':
      return e.v
    case 'id':
      // own properties only: `constructor`, `__proto__` and friends read as 0
      return Object.hasOwn(vars, e.name) ? (vars[e.name] as number) : 0
    case 'not':
      return num(e.e, vars) ? 0 : 1
    case 'bin': {
      if (e.op === '&&') return num(e.l, vars) && num(e.r, vars) ? 1 : 0
      if (e.op === '||') return num(e.l, vars) || num(e.r, vars) ? 1 : 0
      const a = num(e.l, vars)
      const b = num(e.r, vars)
      switch (e.op) {
        case '>':
          return a > b ? 1 : 0
        case '>=':
          return a >= b ? 1 : 0
        case '<':
          return a < b ? 1 : 0
        case '<=':
          return a <= b ? 1 : 0
        case '==':
          return a === b ? 1 : 0
        default:
          return a !== b ? 1 : 0
      }
    }
  }
}

/** Truthiness of an expression over named numbers; unknown identifiers read as 0. */
export function evalExpr(e: Expr, vars: Readonly<Record<string, number>>): boolean {
  return num(e, vars) !== 0
}

export function evaluate(src: string, vars: Readonly<Record<string, number>>): boolean {
  return evalExpr(parseExpr(src), vars)
}
