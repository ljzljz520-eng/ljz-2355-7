// DAG 工具：发布时校验“有向无环”；运行时根据实例上下文与完成情况推导步骤状态。

export class CycleError extends Error {
  constructor(cycle) { super(`步骤依赖存在环: ${cycle.join(' -> ')}`); this.name = 'CycleError'; this.cycle = cycle; }
}

// Kahn 拓扑排序；有环抛 CycleError
export function topologicalSort(stepKeys, depsEdges) {
  const indeg = new Map(stepKeys.map((k) => [k, 0]));
  const adj = new Map(stepKeys.map((k) => [k, []]));
  for (const [from, to] of depsEdges) {
    if (!indeg.has(from) || !indeg.has(to)) {
      throw new Error(`依赖引用了不存在的步骤: ${from} -> ${to}`);
    }
    adj.get(from).push(to);
    indeg.set(to, (indeg.get(to) || 0) + 1);
  }
  const queue = stepKeys.filter((k) => indeg.get(k) === 0);
  const sorted = [];
  while (queue.length) {
    const n = queue.shift();
    sorted.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (sorted.length !== stepKeys.length) {
    const remaining = stepKeys.filter((k) => !sorted.includes(k));
    throw new CycleError(findCycle(remaining, adj));
  }
  return sorted;
}

function findCycle(nodes, adj) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...nodes].map((n) => [n, WHITE]));
  const stack = [];
  function dfs(u) {
    color.set(u, GRAY); stack.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) return [...stack.slice(stack.indexOf(v)), v];
      if (color.get(v) === WHITE) { const c = dfs(v); if (c) return c; }
    }
    stack.pop(); color.set(u, BLACK);
    return null;
  }
  for (const n of nodes) { if (color.get(n) === WHITE) { const c = dfs(n); if (c) return c; } }
  return nodes;
}

// 直接前驱映射 step -> deps[]
export function buildDepMap(steps) {
  const m = new Map(steps.map((s) => [s.step_key, []]));
  for (const s of steps) for (const d of s.dependencies || []) m.get(s.step_key).push(d);
  return m;
}

// 运行时步骤状态推导（不写库）：
// steps: 带 applicability {applicable,status} 的步骤定义；
// completedKeys: 已完成步骤集合；
// 返回 Map step_key -> { canCheck, blockedBy: [], notApplicable, unknown }
export function deriveStepStates(steps, completedKeys, applicability) {
  const depMap = buildDepMap(steps);
  const result = new Map();
  for (const s of steps) {
    const app = applicability.get(s.step_key) || { applicable: true, status: 'yes', reason: null };
    if (!app.applicable && app.status === 'no') {
      result.set(s.step_key, { state: 'skipped', notApplicable: true, unknown: false, blockedBy: [] });
      continue;
    }
    if (app.status === 'unknown') {
      result.set(s.step_key, { state: 'blocked', notApplicable: false, unknown: true, blockedBy: [], reason: app.reason });
      continue;
    }
    // 依赖：前驱必须 completed，或因条件不适用而 skipped（视为自动满足）
    const blockedBy = [];
    for (const d of depMap.get(s.step_key) || []) {
      const dApp = applicability.get(d) || { applicable: true, status: 'yes' };
      if (!dApp.applicable && dApp.status === 'no') continue;
      if (dApp.status === 'unknown') { blockedBy.push(`${d}(待确认)`); continue; }
      if (!completedKeys.has(d)) blockedBy.push(d);
    }
    if (completedKeys.has(s.step_key)) result.set(s.step_key, { state: 'completed', notApplicable: false, unknown: false, blockedBy: [] });
    else if (blockedBy.length) result.set(s.step_key, { state: 'blocked', notApplicable: false, unknown: false, blockedBy });
    else result.set(s.step_key, { state: 'ready', notApplicable: false, unknown: false, blockedBy: [] });
  }
  return result;
}
