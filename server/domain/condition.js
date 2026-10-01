// 条件求值：仅支持白名单表达式，避免 eval/Function 注入。
// 允许：字符串/数字/布尔字面量、标识符(model, hw_revision, options.xxx)、
//       == != === !== && || ! 与括号。
// 未知条件（缺少所需上下文变量）=> 抛 UnknownConditionError，由上层转为“待确认”，
// 绝不默认选择看起来相近的型号。

export class UnknownConditionError extends Error {
  constructor(message) { super(message); this.name = 'UnknownConditionError'; }
}

const KEYWORDS = new Set(['true', 'false', 'null', 'and', 'or', 'not']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      const quote = c; let j = i + 1; let val = '';
      while (j < src.length && src[j] !== quote) { val += src[j]; j++; }
      if (j >= src.length) throw new Error(`条件表达式字符串未闭合: ${src}`);
      tokens.push({ t: 'str', v: val }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'true' || word === 'false') tokens.push({ t: 'bool', v: word === 'true' });
      else if (word === 'null') tokens.push({ t: 'null', v: null });
      else if (word === 'and') tokens.push({ t: 'op', v: '&&' });
      else if (word === 'or') tokens.push({ t: 'op', v: '||' });
      else if (word === 'not') tokens.push({ t: 'punct', v: '!' });
      else tokens.push({ t: 'ident', v: word });
      i = j; continue;
    }
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==') { tokens.push({ t: 'op', v: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ t: 'op', v: two === '==' ? '===' : two === '!=' ? '!==' : two });
      i += 2; continue;
    }
    if ('()!'.includes(c)) { tokens.push({ t: 'punct', v: c }); i++; continue; }
    throw new Error(`条件表达式含非法字符 "${c}": ${src}`);
  }
  return tokens;
}

// 递归下降解析器
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (v) => {
    if (!peek() || peek().v !== v) throw new Error(`条件表达式语法错误，期望 ${v}`);
    p++;
  };
  function parseExpr() { return parseOr(); }
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'op' && peek().v === '||') { p++; const right = parseAnd(); left = ['or', left, right]; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().t === 'op' && peek().v === '&&') { p++; const right = parseNot(); left = ['and', left, right]; }
    return left;
  }
  function parseNot() {
    if (peek() && peek().v === '!') { p++; return ['not', parseNot()]; }
    return parseCmp();
  }
  function parsePrimary() {
    if (peek() && peek().v === '(') { eat('('); const e = parseExpr(); eat(')'); return e; }
    const tok = peek();
    if (!tok) throw new Error('条件表达式意外结束');
    p++;
    if (tok.t === 'ident') return ['ident', tok.v];
    if (['str', 'num', 'bool', 'null'].includes(tok.t)) return [tok.t, tok.v];
    throw new Error('条件表达式语法错误');
  }
  function parseCmp() {
    const left = parsePrimary();
    const tok = peek();
    if (tok && tok.t === 'op' && (tok.v === '===' || tok.v === '!==')) {
      p++;
      const rhsTok = peek();
      if (!rhsTok || !['str', 'num', 'bool', 'null', 'ident'].includes(rhsTok.t))
        throw new Error('条件表达式比较右侧必须是字面量或上下文变量');
      p++;
      const rhs = rhsTok.t === 'ident' ? ['ident', rhsTok.v] : [rhsTok.t, rhsTok.v];
      return [tok.v === '===' ? 'eq' : 'ne', left, rhs];
    }
    // 裸标识符 => 真值判断；裸字面量直接返回
    return left[0] === 'ident' ? ['truthy', left] : left;
  }
  const ast = parseExpr();
  if (p !== tokens.length) throw new Error('条件表达式存在多余记号');
  return ast;
}

function resolveIdent(path, ctx) {
  const parts = path.split('.');
  let cur = ctx;
  for (const part of parts) {
    // 仅当整条路径根本不存在（未建模的变量）才算表达式错误；null=明确未确认
    if (cur === null || cur === undefined || typeof cur !== 'object' || !(part in cur)) {
      throw new UnknownConditionError(`条件所需上下文未确认：${path}`);
    }
    cur = cur[part];
  }
  if (cur === null || cur === undefined) {
    throw new UnknownConditionError(`条件所需上下文未确认：${path}`);
  }
  return cur;
}

function evalAst(node, ctx) {
  const [kind, ...args] = node;
  switch (kind) {
    case 'str': case 'num': case 'bool': return args[0];
    case 'null': return null;
    case 'ident': return resolveIdent(args[0], ctx);
    case 'truthy': return !!evalAst(args[0], ctx);
    case 'not': return !evalAst(args[0], ctx);
    case 'and': return evalAst(args[0], ctx) && evalAst(args[1], ctx);
    case 'or': return evalAst(args[0], ctx) || evalAst(args[1], ctx);
    case 'eq': {
      const l = evalAst(args[0], ctx);
      const r = evalAst(args[1], ctx);
      return l === r;
    }
    case 'ne': {
      const l = evalAst(args[0], ctx);
      const r = evalAst(args[1], ctx);
      return l !== r;
    }
    default: throw new Error(`不支持的表达式节点: ${kind}`);
  }
}

const ALLOWED_IDENT_ROOTS = new Set(['model', 'hw_revision', 'options']);

// 发布/求值时都可调用：标识符必须在受控上下文白名单内
export function assertAllowedIdent(expr) {
  for (const ref of conditionReferences(expr)) {
    if (!ALLOWED_IDENT_ROOTS.has(ref)) {
      throw new Error(`条件表达式引用了未授权的上下文变量：${ref}（仅允许 model / hw_revision / options）`);
    }
  }
}

const cache = new Map();
export function evaluateCondition(expr, ctx) {
  if (expr === null || expr === undefined || String(expr).trim() === '') return true; // 无条件适用
  if (!cache.has(expr)) {
    assertAllowedIdent(expr);
    cache.set(expr, parse(tokenize(expr)));
  }
  return evalAst(cache.get(expr), ctx);
}

// 返回 { applicable, status: 'yes'|'no'|'unknown', reason? }
export function evaluateApplicability(expr, ctx) {
  try {
    return { applicable: evaluateCondition(expr, ctx), status: 'yes', reason: null };
  } catch (e) {
    if (e instanceof UnknownConditionError) return { applicable: false, status: 'unknown', reason: e.message };
    throw e;
  }
}

// 发布前自检：所有条件表达式引用的标识符
export function conditionReferences(expr) {
  if (!expr) return [];
  const refs = new Set();
  const walk = (node) => {
    const [kind, ...args] = node;
    if (kind === 'ident') refs.add(args[0].split('.')[0]);
    else args.forEach((a) => Array.isArray(a) && walk(a));
  };
  walk(parse(tokenize(expr)));
  return [...refs];
}
