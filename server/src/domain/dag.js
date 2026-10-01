// 步骤依赖必须是同版本内的有向无环图（DAG）。
// 返回 topo 顺序；若有环或缺步骤则抛错。
export function topoSort(steps, deps) {
  const byId = new Map(steps.map(s => [s.id, s]));
  const indeg = new Map(steps.map(s => [s.id, 0]));
  const adj = new Map(steps.map(s => [s.id, []]));
  for (const d of deps) {
    if (!byId.has(d.from_step) || !byId.has(d.to_step)) throw new Error('依赖引用了不存在的步骤');
    adj.get(d.from_step).push(d.to_step);
    indeg.set(d.to_step, (indeg.get(d.to_step) || 0) + 1);
  }
  const q = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id)
    .sort((a, b) => (byId.get(a).seq - byId.get(b).seq) || a.localeCompare(b));
  const out = [];
  while (q.length) {
    const id = q.shift();
    out.push(id);
    for (const t of adj.get(id).slice().sort((a, b) => (byId.get(a).seq - byId.get(b).seq) || a.localeCompare(b))) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) q.push(t);
    }
  }
  if (out.length !== steps.length) throw new Error('步骤依赖存在环（必须为 DAG）');
  return out;
}

// 计算某步骤的前置步骤（直接+传递）
export function ancestorsOf(stepId, deps) {
  const direct = new Map();
  for (const d of deps) { if (!direct.has(d.to_step)) direct.set(d.to_step, []); direct.get(d.to_step).push(d.from_step); }
  const seen = new Set();
  const walk = (id) => {
    for (const p of direct.get(id) || []) {
      if (!seen.has(p)) { seen.add(p); walk(p); }
    }
  };
  walk(stepId);
  return seen;
}
