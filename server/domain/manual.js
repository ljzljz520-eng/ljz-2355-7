// 手册版本解析：v1.1 这类版本以 base + patch 描述，发布时展开为完整快照；
// 同时产出 patch 明细供“受控迁移差异确认”使用。
import { topologicalSort } from './dag.js';

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// seed -> Map(version_label, { meta, steps[], warnings[], drawings[], patchReport })
export function resolveVersions(seed) {
  const byLabel = new Map();
  for (const v of seed.versions) byLabel.set(v.version_label, v);
  const out = new Map();

  function resolve(label) {
    if (out.has(label)) return out.get(label);
    const v = byLabel.get(label);
    if (!v) throw new Error(`演示资料中缺少版本 ${label}`);
    let steps, warnings, drawings, base = null, patchReport = null;
    if (v.base) {
      const parent = resolve(v.base);
      base = v.base;
      const stepMap = new Map(parent.steps.map((s) => [s.step_key, clone(s)]));
      const stepChanges = [];
      for (const [key, patch] of Object.entries(v.step_patches || {})) {
        if (!stepMap.has(key)) throw new Error(`${label} 补丁试图修改不存在的步骤 ${key}`);
        const before = clone(stepMap.get(key));
        stepMap.set(key, { ...before, ...clone(patch) });
        const fields = Object.keys(patch);
        stepChanges.push({ step_key: key, change_type: 'STEP_CHANGED', fields, before, after: clone(stepMap.get(key)) });
      }
      for (const s of v.add_steps || []) {
        if (stepMap.has(s.step_key)) throw new Error(`${label} 新增步骤键冲突 ${s.step_key}`);
        stepMap.set(s.step_key, clone(s));
        stepChanges.push({ step_key: s.step_key, change_type: 'STEP_ADDED', fields: Object.keys(s), before: null, after: clone(s) });
      }
      // 删除的步骤（本演示没有，但机制保留）
      for (const key of v.remove_steps || []) {
        if (!stepMap.has(key)) throw new Error(`${label} 试图删除不存在的步骤 ${key}`);
        const before = clone(stepMap.get(key));
        stepMap.delete(key);
        stepChanges.push({ step_key: key, change_type: 'STEP_REMOVED', fields: [], before, after: null });
      }
      steps = [...stepMap.values()].sort((a, b) => a.seq_no - b.seq_no);
      // 清理指向已删步骤的依赖边
      for (const s of steps) if (s.dependencies) s.dependencies = s.dependencies.filter((d) => stepMap.has(d));

      const warnMap = new Map(parent.warnings.map((w) => [`${w.step_key}:${w.code}`, clone(w)]));
      for (const w of v.add_warnings || []) warnMap.set(`${w.step_key}:${w.code}`, clone(w));
      warnings = [...warnMap.values()];

      // 图纸：按 drawing_key 覆盖
      const drawMap = new Map(parent.drawings.map((d) => [d.drawing_key, clone(d)]));
      const drawingChanges = [];
      for (const d of v.drawings || []) {
        const had = drawMap.has(d.drawing_key);
        const before = had ? clone(drawMap.get(d.drawing_key)) : null;
        drawMap.set(d.drawing_key, clone(d));
        drawingChanges.push({
          drawing_key: d.drawing_key,
          change_type: had ? 'DRAWING_REVISED' : 'DRAWING_ADDED',
          before, after: clone(d), change_note: d.change_note,
        });
      }
      drawings = [...drawMap.values()];
      patchReport = { base, stepChanges, drawingChanges };
    } else {
      steps = clone(v.steps || []);
      warnings = clone(v.warnings || []);
      drawings = clone(v.drawings || []);
    }
    // 发布时强制 DAG 校验：必须有向无环
    const keys = steps.map((s) => s.step_key);
    const edges = [];
    for (const s of steps) for (const d of s.dependencies || []) edges.push([d, s.step_key]);
    topologicalSort(keys, edges);
    const resolved = {
      label,
      status: v.status,
      published_at: v.published_at,
      base,
      steps,
      warnings,
      drawings,
      patchReport,
    };
    out.set(label, resolved);
    return resolved;
  }

  for (const label of byLabel.keys()) resolve(label);
  return out;
}

// 生成两版本间的完整差异（迁移审查用）。old/new 均为 resolved。
export function diffVersions(oldV, newV) {
  const oldSteps = new Map(oldV.steps.map((s) => [s.step_key, s]));
  const newSteps = new Map(newV.steps.map((s) => [s.step_key, s]));
  const diffs = [];
  for (const [key, ns] of newSteps) {
    const os = oldSteps.get(key);
    if (!os) { diffs.push({ type: 'STEP_ADDED', step_key: key, title: ns.title }); continue; }
    const changedFields = [];
    for (const f of ['title', 'detail_md', 'condition', 'drawing_key', 'kind', 'seq_no']) {
      if (JSON.stringify(os[f] ?? null) !== JSON.stringify(ns[f] ?? null)) changedFields.push(f);
    }
    if (JSON.stringify([...(os.dependencies || [])].sort()) !== JSON.stringify([...(ns.dependencies || [])].sort())) {
      changedFields.push('dependencies');
    }
    if (changedFields.length) {
      diffs.push({ type: 'STEP_CHANGED', step_key: key, title: ns.title, fields: changedFields, before: os, after: ns });
    }
  }
  for (const [key, os] of oldSteps) {
    if (!newSteps.has(key)) diffs.push({ type: 'STEP_REMOVED', step_key: key, title: os.title });
  }
  // 图纸差异
  const oldD = new Map(oldV.drawings.map((d) => [d.drawing_key, d]));
  const newD = new Map(newV.drawings.map((d) => [d.drawing_key, d]));
  const drawingDiffs = [];
  for (const [key, nd] of newD) {
    const od = oldD.get(key);
    if (!od) drawingDiffs.push({ type: 'DRAWING_ADDED', drawing_key: key });
    else if (od.file !== nd.file || od.change_note !== nd.change_note)
      drawingDiffs.push({ type: 'DRAWING_REVISED', drawing_key: key, before: od, after: nd, change_note: nd.change_note });
  }
  for (const [key] of oldD) if (!newD.has(key)) drawingDiffs.push({ type: 'DRAWING_REMOVED', drawing_key: key });
  // 警示差异
  const oldW = new Set(oldV.warnings.map((w) => `${w.step_key}:${w.code}`));
  const newW = new Set(newV.warnings.map((w) => `${w.step_key}:${w.code}`));
  const warningDiffs = [];
  for (const w of newV.warnings) if (!oldW.has(`${w.step_key}:${w.code}`)) warningDiffs.push({ type: 'WARNING_ADDED', ...w });
  for (const w of oldV.warnings) if (!newW.has(`${w.step_key}:${w.code}`)) warningDiffs.push({ type: 'WARNING_REMOVED', ...w });
  return { stepDiffs: diffs, drawingDiffs, warningDiffs };
}
