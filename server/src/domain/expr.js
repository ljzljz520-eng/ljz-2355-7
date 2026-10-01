// 极小安全表达式语言（仅用于后端管理的型号条件判定）：
//   字面量: true false 数字 '字符串'
//   变量:   条件 key（未回答 => null，绝不可猜测）
//   运算:   and or not  = != in () 
//   示例:   rack_unit = '2U' and psu_count = 2
// 不允许：函数调用、成员访问、注释、JS 求值。

const TOKEN = /\s*(=>|<=|<>|!=|==|=|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?)/y;
const KW = new Set(['and', 'or', 'not', 'true', 'false', 'in']);

function tokenize(src) {
  const toks = [];
  let m, last = 0;
  TOKEN.lastIndex = 0;
  const s = src ?? 'true';
  while ((m = TOKEN.exec(s))) {
    if (m.index !== last && s.slice(last, m.index).trim() !== '') throw new Error('非法字符: ' + s.slice(last, m.index));
    toks.push(m[0].trim());
    last = TOKEN.lastIndex;
  }
  if (s.slice(last).trim() !== '') throw new Error('非法字符: ' + s.slice(last));
  return toks;
}

function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  const eat = (v) => { if (toks[i] !== v) throw new Error(`期望 ${v}，得到 ${toks[i] ?? 'EOF'}`); i++; };

  function parsePrimary() {
    const t = peek();
    if (t === '(') { eat('('); const e = parseOr(); eat(')'); return e; }
    if (t === 'not') { i++; return { t: 'not', c: parsePrimary() }; }
    if (t === 'true') { i++; return { t: 'lit', v: true }; }
    if (t === 'false') { i++; return { t: 'lit', v: false }; }
    if (t?.startsWith("'")) { i++; return { t: 'lit', v: t.slice(1, -1).replace(/''/g, "'") }; }
    if (t !== undefined && /^-?\d/.test(t)) { i++; return { t: 'lit', v: Number(t) }; }
    if (t && !KW.has(t)) { i++; return { t: 'var', name: t }; }
    throw new Error('意外的 token: ' + t);
  }
  function parseCmp() {
    let left = parsePrimary();
    while (['=', '==', '!=', '<>'].includes(peek()) || peek() === 'in') {
      const op = toks[i++];
      if (op === 'in') {
        eat('(');
        const vals = [];
        vals.push(parsePrimary());
        while (peek() === ',') { i++; vals.push(parsePrimary()); }
        eat(')');
        left = { t: 'in', left, vals };
      } else {
        const right = parsePrimary();
        left = { t: 'cmp', op: (op === '=' || op === '==') ? '=' : '!=', left, right };
      }
    }
    return left;
  }
  function parseAnd() {
    let l = parseCmp();
    while (peek() === 'and') { i++; l = { t: 'and', l, r: parseCmp() }; }
    return l;
  }
  function parseOr() {
    let l = parseAnd();
    while (peek() === 'or') { i++; l = { t: 'or', l, r: parseAnd() }; }
    return l;
  }
  const ast = parseOr();
  if (i !== toks.length) throw new Error('多余 token: ' + toks[i]);
  return ast;
}

// 求值。vars 为 { key: value }；任何引用变量缺失 => null（三值逻辑，未知即阻塞）
function evalAst(n, vars) {
  switch (n.t) {
    case 'lit': return n.v;
    case 'var': return (n.name in vars && vars[n.name] !== null && vars[n.name] !== '') ? vars[n.name] : null;
    case 'not': {
      const v = evalAst(n.c, vars);
      return v === null ? null : !v;
    }
    case 'and': {
      const a = evalAst(n.l, vars), b = evalAst(n.r, vars);
      if (a === false || b === false) return false;
      if (a === null || b === null) return null;
      return a && b;
    }
    case 'or': {
      const a = evalAst(n.l, vars), b = evalAst(n.r, vars);
      if (a === true || b === true) return true;
      if (a === null || b === null) return null;
      return a || b;
    }
    case 'cmp': {
      const a = evalAst(n.left, vars), b = evalAst(n.right, vars);
      if (a === null || b === null) return null;
      // eslint-disable-next-line eqeqeq
      const eq = a == b || String(a) === String(b);
      return n.op === '=' ? eq : !eq;
    }
    case 'in': {
      const a = evalAst(n.left, vars);
      if (a === null) return null;
      for (const v of n.vals) {
        const b = evalAst(v, vars);
        if (b !== null && (String(a) === String(b))) return true;
      }
      return n.vals.some(v => evalAst(v, vars) === null) ? null : false;
    }
  }
}

export function validateExpression(src) { parse(tokenize(src ?? 'true')); return true; }
// 返回 true/false/null（null=未知，必须停在待确认，不能按外观猜选）
export function evalExpression(src, vars) { return evalAst(parse(tokenize(src)), vars); }
