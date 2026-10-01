import { one, many, query, tx } from '../db/index.js';
import { evalExpression } from './expr.js';
import { ancestorsOf } from './dag.js';

const id = (p) => p + '-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
// qq: 事务回调(row-array) 或 undefined(用连接池 {rows})
const Q = async (qq, text, params = []) => {
  const r = qq ? await qq(text, params) : await query(text, params);
  return Array.isArray(r) ? r : r.rows;
};
const Q1 = async (qq, text, params = []) => (await Q(qq, text, params))[0] ?? null;

// 取实例的条件变量（已回答才进 map；未回答 => 表达式引用时为 null）
async function conditionVars(instanceId, qq) {
  const rows = await Q(qq,
    `SELECT c.key, ic.value FROM instance_condition ic
     JOIN condition_def c ON c.id = ic.condition_id
     WHERE ic.instance_id = $1 AND ic.answered_at IS NOT NULL`, [instanceId]);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// 版本完整步骤 + 依赖 + 警示 + 图纸
export async function loadVersion(versionId, qq) {
  const steps = await Q(qq,
    `SELECT s.*, dv.content_sha AS pinned_drawing_sha, dv.version AS drawing_ver
       FROM step s
       LEFT JOIN step_drawing sd ON sd.step_id = s.id
       LEFT JOIN drawing_version dv ON dv.drawing_id = sd.drawing_id AND dv.status = 'published'
      WHERE s.version_id = $1 ORDER BY s.seq`, [versionId]);
  // 每个步骤可能多图，单独聚合
  const drawRows = await Q(qq,
    `SELECT sd.step_id, d.id AS drawing_id, d.code, d.title,
            dv.id AS dv_id, dv.version, dv.object_key, dv.content_sha, dv.status,
            latest.version AS latest_ver, latest.content_sha AS latest_sha, latest.id AS latest_dv_id, latest.status AS latest_status
       FROM step_drawing sd
       JOIN drawing d ON d.id=sd.drawing_id
       JOIN drawing_version dv ON dv.id = COALESCE(sd.drawing_version_id,
             (SELECT id FROM drawing_version WHERE drawing_id=d.id AND status='published' ORDER BY published_at DESC LIMIT 1))
       LEFT JOIN LATERAL (
         SELECT * FROM drawing_version WHERE drawing_id = d.id AND status='published' ORDER BY published_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE sd.step_id IN (SELECT id FROM step WHERE version_id=$1)`, [versionId]);
  const drawings = new Map();
  for (const r of drawRows) {
    if (!drawings.has(r.step_id)) drawings.set(r.step_id, []);
    drawings.get(r.step_id).push(r);
  }
  const deps = await Q(qq, `SELECT from_step, to_step FROM step_dep WHERE version_id=$1`, [versionId]);
  const warns = await Q(qq,
    `SELECT w.*, s.code FROM step_warning w JOIN step s ON s.id=w.step_id
      WHERE s.version_id=$1 ORDER BY w.severity`, [versionId]);
  const byCode = Object.fromEntries(steps.map(s => [s.code, s]));
  return { steps, deps, drawings, warns, byCode };
}

// 计算每个步骤对实例的运行态
// applicability: applicable / not_applicable / unknown
// run_state: blocked（前置未满足/未知）/ active（可执行）/ done / recheck ...
export async function evaluateInstance(inst, qq) {
  const v = await loadVersion(inst.version_id, qq);
  const vars = await conditionVars(inst.id, qq);
  const execRows = await Q(qq,
    `SELECT * FROM instance_step WHERE instance_id=$1`, [inst.id]);
  const exec = Object.fromEntries(execRows.map(e => [e.step_id, e]));
  const reviews = await Q(qq,
    `SELECT * FROM review_item WHERE instance_id=$1 AND status='open'`, [inst.id]);
  const openByStep = new Map(reviews.filter(r => r.instance_step_id).map(r => [r.instance_step_id, r]));

  const codeOf = new Map(v.steps.map(s => [s.id, s.code]));
  const applicability = new Map();
  for (const s of v.steps) {
    const r = evalExpression(s.applicability || 'true', vars);
    applicability.set(s.id, r === null ? 'unknown' : r ? 'applicable' : 'not_applicable');
  }
  // DAG 解锁：一个步骤可执行，要求其所有 applicable/unknown 前置为 done；
  // 若有前置 unknown，则该步骤 blocked_unknown（不能跳过）
  const stateOf = new Map();
  const sorted = topoOnce(v.steps, v.deps);
  for (const sid of sorted) {
    const e = exec[sid];
    // 开放复核优先于 done 的展示（但不改底层 done，故进度百分比不平移）
    if (openByStep.has(e?.id)) { stateOf.set(sid, 'recheck_open'); continue; }
    if (e?.state === 'done') { stateOf.set(sid, 'done'); continue; }
    if (e?.state === 'superseded') { stateOf.set(sid, 'superseded'); continue; }
    if (applicability.get(sid) === 'not_applicable') { stateOf.set(sid, 'not_applicable'); continue; }
    const prereqs = ancestorsOf(sid, v.deps);
    let blockedUnknown = false, blocked = false;
    for (const p of prereqs) {
      if (applicability.get(p) === 'not_applicable') continue;
      if (stateOf.get(p) === 'done') continue;
      if (applicability.get(p) === 'unknown') blockedUnknown = true;
      else blocked = true;
    }
    const ownUnknown = applicability.get(sid) === 'unknown';
    if (ownUnknown || blockedUnknown) stateOf.set(sid, 'blocked_unknown');
    else if (blocked) stateOf.set(sid, 'blocked');
    else stateOf.set(sid, e?.state === 'in_progress' ? 'in_progress' : 'active');
  }

  // 全局：是否仍有未回答条件
  const unknownConditions = await Q(qq,
    `SELECT c.* FROM condition_def c
      WHERE (c.scope_model IS NULL OR c.scope_model = $2)
        AND c.required AND NOT EXISTS (
          SELECT 1 FROM instance_condition ic
           WHERE ic.condition_id=c.id AND ic.instance_id=$1 AND ic.answered_at IS NOT NULL)`,
    [inst.id, inst.model_id]);

  return { version: v, vars, exec, applicability, stateOf, reviews, unknownConditions };
}

function topoOnce(steps, deps) {
  const indeg = new Map(steps.map(s => [s.id, 0]));
  const adj = new Map(steps.map(s => [s.id, []]));
  for (const d of deps) { adj.get(d.from_step).push(d.to_step); indeg.set(d.to_step, indeg.get(d.to_step) + 1); }
  const q = steps.filter(s => indeg.get(s.id) === 0).map(s => s.id);
  const out = [];
  while (q.length) {
    const x = q.shift(); out.push(x);
    for (const t of adj.get(x)) { indeg.set(t, indeg.get(t) - 1); if (indeg.get(t) === 0) q.push(t); }
  }
  return out;
}

// 进度：不做简单百分比平移 —— 分母只统计可判定步骤；unknown 单独计数展示
export function progress(steps, applicability, stateOf) {
  let applicable = 0, done = 0, unknown = 0, active = 0;
  for (const s of steps) {
    const a = applicability.get(s.id), st = stateOf.get(s.id);
    if (a === 'not_applicable') continue;
    if (a === 'unknown') { unknown++; continue; }
    applicable++;
    // 有开放复核的步骤底层仍为 done（图纸升级/迁移差异），进度百分比不平移
    if (st === 'done' || st === 'recheck_open') done++;
    if (st === 'active' || st === 'in_progress') active++;
  }
  return { done, applicable, unknown, active, pct: applicable ? Math.round(done / applicable * 100) : null };
}

// 完成步骤：重复勾选幂等拒绝；凭证必须满足步骤要求且绑定本实例步骤
export async function completeStep(instanceId, stepId, actor, evidenceInputs = {}, capturedAt = null) {
  return tx(async (q) => {
    const [inst] = await q(`SELECT * FROM instance WHERE id=$1 FOR UPDATE`, [instanceId]);
    if (!inst) throw httpErr(404, '实例不存在');
    if (inst.status === 'finalized') throw httpErr(409, '实例已定稿，不能再勾选');
    const ev = await evaluateInstance(inst, q);
    const appState = ev.stateOf.get(stepId);
    const step = ev.version.steps.find(s => s.id === stepId);
    if (!step) throw httpErr(404, '步骤不存在');
    if (appState === 'done') throw httpErr(409, '重复勾选：该步骤已完成；如需修改请先由管理员/本人“撤销完成”，系统会记录次数');
    if (appState === 'blocked' || appState === 'blocked_unknown')
      throw httpErr(409, appState === 'blocked_unknown'
        ? '存在未知前置条件：必须停在待确认，不能跳过'
        : '前置 DAG 步骤未完成，不能勾选');
    if (appState === 'recheck_open') throw httpErr(409, '该步骤有未处理复核项，先关闭复核');
    // 图纸撤回：引用已撤回图纸的步骤不得继续勾选（停在待确认）
    const withdrawn = (ev.version.drawings.get(stepId) || []).filter(d => d.status === 'withdrawn');
    if (withdrawn.length) throw httpErr(409,
      '步骤引用的图纸 ' + withdrawn.map(d => d.code).join(',') + ' 已撤回：禁止按旧图执行，停在待确认，等待资料处置');
    // 证据要求
    const req = step.required_evidence;
    const photos = evidenceInputs.photos || [];      // [{object_key, content_sha, captured_at, late}]
    const values = (evidenceInputs.values || []).filter(v => v && String(v.value_text ?? '').trim() !== '');
    const needPhoto = req === 'photo' || req === 'photo_or_value' || req === 'photo_and_value';
    const needValue = req === 'value' || req === 'photo_or_value' || req === 'photo_and_value';
    const both = req === 'photo_and_value';
    if (needPhoto && photos.length === 0 && !(needValue && values.length && !both))
      throw httpErr(422, '缺少必需凭证：' + (step.evidence_label || '照片'));
    if (needValue && values.length === 0 && !(needPhoto && photos.length && req === 'photo_or_value'))
      throw httpErr(422, '缺少必需凭证：现场实测/资料值记录（不得编造，资料未给出就挂待确认）');
    if (both && (photos.length === 0 || values.length === 0))
      throw httpErr(422, '该步骤要求“照片 + 数值”两类凭证齐全');

    // 取/建 instance_step（绑定实际实例，证据不可跨实例复用）
    let [isrow] = await q(`SELECT * FROM instance_step WHERE instance_id=$1 AND step_id=$2 FOR UPDATE`, [instanceId, stepId]);
    if (!isrow) {
      const isid = id('is');
      await q(`INSERT INTO instance_step(id,instance_id,step_id,step_code,state) VALUES ($1::text,$2::text,$3::text,$4::text,'in_progress')`,
        [isid, instanceId, stepId, step.code]);
      [isrow] = await q(`SELECT * FROM instance_step WHERE id=$1`, [isid]);
    }
    // 记录执行时图纸指纹（图纸撤回/升级可据此识别旧图执行）
    const stepDrawings = ev.version.drawings.get(stepId) || [];
    const pinSha = stepDrawings.map(d => d.content_sha).filter(Boolean).sort().join(',') || null;

    for (const p of photos) {
      // 同一 sha 已绑在别的实例 -> 拒绝复用；同一实例重复上传允许（迟到照片另算）
      const dup = await q(`SELECT e.id FROM evidence e JOIN instance_step x ON x.id=e.instance_step_id
                            WHERE e.content_sha=$1 AND x.instance_id<>$2 LIMIT 1`, [p.content_sha, instanceId]);
      if (dup.length) throw httpErr(409, '照片内容已绑定其它安装实例，凭证不能跨实例复用');
      const late = capturedAt != null || p.captured_at != null; // captured_at 由离线场景显式传入
      await q(`INSERT INTO evidence(id,instance_step_id,kind,object_key,content_sha,captured_at,uploaded_by,late)
               VALUES ($1,$2,'photo',$3,$4,$5::timestamptz,$6,$7)`,
        [id('ev'), isrow.id, p.object_key, p.content_sha, p.captured_at || capturedAt || null, actor, !!p.late]);
    }
    for (const v of values) {
      await q(`INSERT INTO evidence(id,instance_step_id,kind,value_text,uploaded_by)
               VALUES ($1,$2,'value',$3,$4)`, [id('ev'), isrow.id, String(v.value_text), actor]);
    }
    await q(`UPDATE instance_step SET state='done', done_at=now(), done_by=$2, drawing_sha=$3::text WHERE id=$1`,
      [isrow.id, actor, isrow.drawing_sha ?? pinSha]);
    await q(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'step_complete',$3)`,
      [instanceId, actor, step.code + ' ' + step.title]);
    await refreshInstanceStatus(q, inst.id);
    return isrow.id;
  });
}

export async function reopenStep(instanceId, stepId, actor, reason) {
  return tx(async (q) => {
    const [row] = await q(`SELECT * FROM instance_step x WHERE x.instance_id=$1 AND x.step_id=$2`, [instanceId, stepId]);
    if (!row || row.state !== 'done') throw httpErr(409, '只能撤销已完成步骤');
    await q(`UPDATE instance_step SET state='pending', done_at=NULL, done_by=NULL, reopened_count=reopened_count+1 WHERE id=$1`, [row.id]);
    // 撤销不删除证据，标记为历史保留
    await q(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'step_reopen',$3)`,
      [instanceId, actor, stepId + '：' + (reason || '无')]);
    await refreshInstanceStatus(q, instanceId);
  });
}

async function refreshInstanceStatus(q, instanceId) {
  const inst = await Q1(q, `SELECT * FROM instance WHERE id=$1`, [instanceId]);
  const ev = await evaluateInstance(inst, q);
  const { applicable: total, done, unknown } = progress(ev.version.steps, ev.applicability, ev.stateOf);
  const openReviews = ev.reviews.length;
  let status = inst.status;
  if (ev.unknownConditions.length > 0 || unknown > 0) status = openReviews ? 'blocked' : (done > 0 ? 'in_progress' : 'collecting');
  else if (total > 0 && done === total && openReviews === 0) status = 'complete';
  else status = openReviews ? 'blocked' : 'in_progress';
  await Q(q, `UPDATE instance SET status=$2 WHERE id=$1`, [instanceId, status]);
}

// 图纸升级/撤回扫描：对已执行步骤生成复核项（幂等），不“平移进度百分比”
export async function scanDrawingChanges(instanceId, qq) {
  const inst = await Q1(qq, `SELECT * FROM instance WHERE id=$1`, [instanceId]);
  const ev = await evaluateInstance(inst, qq);
  const made = [];
  for (const x of Object.values(ev.exec)) {
    if (x.state !== 'done' && x.state !== 'recheck_open') continue;
    const step = ev.version.steps.find(st => st.id === x.step_id);
    const ds = ev.version.drawings.get(step.id) || [];
    for (const d of ds) {
      const executedShas = (x.drawing_sha || '').split(',').filter(Boolean);
      const pinnedWithdrawn = d.status === 'withdrawn';
      // 钉住版被撤回
      if (pinnedWithdrawn) {
        const exists = await Q1(qq, `SELECT 1 FROM review_item WHERE instance_step_id=$1 AND reason='drawing_withdrawn' AND detail LIKE $2`,
          [x.id, '%' + d.code + '%']);
        if (!exists) {
          const detail = `步骤 ${step.code} 所用图纸 ${d.code} v${d.version} 已被撤回，禁止继续按该图执行/查看；须按资料指引复核`;
          await Q(qq, `INSERT INTO review_item(id,instance_id,instance_step_id,reason,detail) VALUES ($1,$2,$3,'drawing_withdrawn',$4)`,
            [id('rv'), instanceId, x.id, detail]);
          made.push(detail);
        }
      }
      // 图纸发布了比执行时更新的已发布版本（锁旧手册也必须收到复核，但视图仍显示旧版）
      const hasNewer = d.latest_sha && !executedShas.includes(d.latest_sha) &&
                       (d.latest_status === 'published');
      if (hasNewer) {
        const exists = await Q1(qq, `SELECT 1 FROM review_item WHERE instance_step_id=$1 AND reason='drawing_upgraded' AND detail LIKE $2`,
          [x.id, '%' + d.code + '%v' + d.latest_ver + '%']);
        if (!exists) {
          const detail = `步骤 ${step.code} 执行后图纸 ${d.code} 发布新版本 v${d.latest_ver}（执行时为 v${d.version}）；内容哈希不同，须按新版复核，进度不自动平移`;
          await Q(qq, `INSERT INTO review_item(id,instance_id,instance_step_id,reason,detail) VALUES ($1,$2,$3,'drawing_upgraded',$4)`,
            [id('rv'), instanceId, x.id, detail]);
          made.push(detail);
        }
      }
    }
  }
  if (made.length) await refreshInstanceStatus(qq, instanceId);
  return made;
}

// 版本差异（迁移/分支切换共用）：按 step code 对齐
export async function diffVersions(fromVid, toVid, qq) {
  const a = await loadVersion(fromVid, qq), b = await loadVersion(toVid, qq);
  const codes = new Set([...Object.keys(a.byCode), ...Object.keys(b.byCode)]);
  const items = [];
  for (const code of [...codes].sort()) {
    const sa = a.byCode[code], sb = b.byCode[code];
    if (sa && !sb) items.push({ code, kind: 'removed', title: sa.title, from: sa.title, to: null });
    else if (!sa && sb) items.push({ code, kind: 'added', title: sb.title, from: null, to: sb.title });
    else {
      const fields = [];
      if (sa.title !== sb.title) fields.push('title');
      if (sa.body !== sb.body) fields.push('body');
      if (sa.applicability !== sb.applicability) fields.push('applicability');
      if (sa.required_evidence !== sb.required_evidence) fields.push('required_evidence');
      // 图纸指纹变化
      const da = (a.drawings.get(sa.id) || []).map(x => x.code + ':' + x.content_sha).sort();
      const dbg = (b.drawings.get(sb.id) || []).map(x => x.code + ':' + x.content_sha).sort();
      if (JSON.stringify(da) !== JSON.stringify(dbg)) fields.push('drawing');
      const depA = [...new Set(a.deps.filter(d => d.from_step === sa.id || d.to_step === sa.id).flatMap(d => [codeOf(a, d.from_step), codeOf(a, d.to_step)]).filter(c => c !== code))].sort();
      const depB = [...new Set(b.deps.filter(d => d.from_step === sb.id || d.to_step === sb.id).flatMap(d => [codeOf(b, d.from_step), codeOf(b, d.to_step)]).filter(c => c !== code))].sort();
      if (JSON.stringify(depA) !== JSON.stringify(depB)) fields.push('dependency');
      if (fields.length) items.push({ code, kind: 'changed', title: sb.title, fields });
    }
  }
  return { from: fromVid, to: toVid, items };
}
function codeOf(ver, sid) { const s = ver.steps.find(x => x.id === sid); return s?.code; }

// 受控迁移：逐项确认差异；不确认不切换。旧证据保留。
export async function proposeMigration(instanceId, toVersionId, actor) {
  const inst = await one(`SELECT * FROM instance WHERE id=$1`, [instanceId]);
  if (!inst) throw httpErr(404, '实例不存在');
  if (inst.version_id === toVersionId) throw httpErr(409, '已经是该版本');
  // 目标版本必须属于同一型号 + 同一硬件修订（型号/HW 修订切换走 branch switch，不允许借迁移“猜近邻”）
  const [target] = await many(`SELECT mv.*, m.model_id, m.hw_rev FROM manual_version mv JOIN manual m ON m.id=mv.manual_id WHERE mv.id=$1`, [toVersionId]);
  if (!target || target.model_id !== inst.model_id || target.hw_rev !== inst.hw_rev)
    throw httpErr(409, '迁移只允许同一型号同一硬件修订内的手册版本；型号/修订变更必须走分支切换并重新确认条件');
  if (target.status !== 'published') throw httpErr(409, '目标版本未发布');
  const diff = await diffVersions(inst.version_id, toVersionId);
  const mid = id('mg');
  await query(`INSERT INTO migration(id,instance_id,from_version_id,to_version_id,diff_json,status) VALUES ($1,$2,$3,$4,$5,'proposed')`,
    [mid, instanceId, inst.version_id, toVersionId, JSON.stringify(diff)]);
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'migration_propose',$3)`,
    [instanceId, actor, `${inst.version_id} -> ${toVersionId}，差异 ${diff.items.length} 项待确认`]);
  return { migrationId: mid, diff };
}

export async function confirmMigration(instanceId, migrationId, confirmedCodes, actor) {
  return tx(async (q) => {
    const [m] = await q(`SELECT * FROM migration WHERE id=$1 AND instance_id=$2 FOR UPDATE`, [migrationId, instanceId]);
    if (!m) throw httpErr(404, '迁移单不存在');
    if (m.status !== 'proposed') throw httpErr(409, '迁移单已处理');
    const diff = JSON.parse(m.diff_json);
    const need = diff.items.map(i => i.code).sort();
    const got = [...new Set(confirmedCodes || [])].sort();
    if (JSON.stringify(need) !== JSON.stringify(got))
      throw httpErr(422, `必须逐项确认全部差异（需要 ${need.join(',')}；收到 ${got.join(',') || '空'}），不能整体跳过`);

    const [inst] = await q(`SELECT * FROM instance WHERE id=$1 FOR UPDATE`, [instanceId]);
    const oldExec = await q(`SELECT * FROM instance_step WHERE instance_id=$1`, [instanceId]);

    // 切换版本指针
    await q(`UPDATE instance SET version_id=$2 WHERE id=$1`, [instanceId, m.to_version_id]);
    // 重新映射 instance_step：code 对齐
    const newSteps = await q(`SELECT * FROM step WHERE version_id=$1`, [m.to_version_id]);
    const byCode = Object.fromEntries(newSteps.map(s => [s.code, s]));
    for (const e of oldExec) {
      const ns = byCode[e.step_code];
      if (!ns) {
        await q(`UPDATE instance_step SET state='superseded' WHERE id=$1`, [e.id]);
        await q(`INSERT INTO review_item(id,instance_id,instance_step_id,reason,detail) VALUES ($1,$2,$3,'migration_diff',$4)`,
          [id('rv'), instanceId, e.id, `旧版步骤 ${e.step_code} 在新版中被移除：其完成记录与证据保留，但需人工确认处置`]);
      } else {
        await q(`UPDATE instance_step SET step_id=$2 WHERE id=$1`, [e.id, ns.id]);
        const d = diff.items.find(i => i.code === e.step_code);
        if (d && e.state === 'done') {
          // 已完成且有实质差异 -> 生成复核项；步骤保持 done，进度百分比不平移，仅以开放复核阻塞定稿
          await q(`INSERT INTO review_item(id,instance_id,instance_step_id,reason,detail) VALUES ($1,$2,$3,'migration_diff',$4)`,
            [id('rv'), instanceId, e.id, `迁移差异字段 [${d.fields.join(',')}] @ ${e.step_code}：旧证据保留，按新版复核`]);
        }
      }
    }
    // 新版新增步骤自动建 pending 行
    const oldCodes = new Set(oldExec.map(e => e.step_code));
    for (const s of newSteps) {
      if (!oldCodes.has(s.code)) {
        await q(`INSERT INTO instance_step(id,instance_id,step_id,step_code,state) VALUES ($1,$2,$3,$4,'pending')`,
          [id('is'), instanceId, s.id, s.code]);
      }
    }
    await q(`UPDATE migration SET status='confirmed', confirmed_at=now(), confirmed_by=$2 WHERE id=$1`, [m.id, actor]);
    await q(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'migration_confirm',$3)`,
      [instanceId, actor, `${m.from_version_id} -> ${m.to_version_id}；旧证据全部保留`]);
    await scanDrawingChanges(instanceId, q);
    await refreshInstanceStatus(q, instanceId);
  });
}

export async function rejectMigration(instanceId, migrationId, actor) {
  await query(`UPDATE migration SET status='rejected' WHERE id=$1 AND instance_id=$2 AND status='proposed'`, [migrationId, instanceId]);
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'migration_reject','继续锁定旧手册')`, [instanceId, actor]);
}

// 分支切换（型号 或 硬件修订改变）：不迁移勾选；只产出差异，要求重新确认条件
export async function branchSwitchPreview(instanceId, modelCode, hwRev, qq) {
  const inst = await Q1(qq, `SELECT i.*, m.code AS model_code FROM instance i JOIN model m ON m.id=i.model_id WHERE i.id=$1`, [instanceId]);
  const [targetModel] = await Q(qq, `SELECT * FROM model WHERE code=$1`, [modelCode]);
  if (!targetModel) throw httpErr(404, '型号不存在：不得选择相近型号，未知须待确认');
  const mv = await Q1(qq,
    `SELECT mv.* FROM manual_version mv JOIN manual m ON m.id=mv.manual_id
      WHERE m.model_id=$1 AND m.hw_rev=$2 AND mv.status='published'
      ORDER BY mv.published_at DESC LIMIT 1`, [targetModel.id, hwRev]);
  if (!mv) throw httpErr(409, `型号 ${modelCode} / 修订 ${hwRev} 没有已发布手册——停在待确认，禁止猜测`);
  // 关键规则：型号或硬件修订变化 => 不做证据迁移，只给差异
  const sameBranch = targetModel.id === inst.model_id && hwRev === inst.hw_rev;
  const diff = sameBranch ? null : await diffVersions(inst.version_id, mv.id, qq);
  return { targetModel, hwRev, version: mv, diff, sameBranch };
}

export async function branchSwitchExecute(instanceId, modelCode, hwRev, actor) {
  return tx(async (q) => {
    const preview = await branchSwitchPreview(instanceId, modelCode, hwRev, q);
    const [inst] = await q(`SELECT * FROM instance WHERE id=$1 FOR UPDATE`, [instanceId]);
    if (preview.sameBranch) throw httpErr(409, '型号与硬件修订未变化，无需切换分支');
    // 旧执行行全部保留为历史（superseded），证据不删；新建干净步骤集合
    await q(`UPDATE instance_step SET state='superseded' WHERE instance_id=$1 AND state <> 'superseded'`, [instanceId]);
    for (const it of preview.diff.items) {
      await q(`INSERT INTO review_item(id,instance_id,instance_step_id,reason,detail)
               SELECT $1,$2,id,'branch_switch_diff',$3 FROM instance_step WHERE instance_id=$4 AND step_code=$5 LIMIT 1`,
        [id('rv'), instanceId, `分支切换差异（${it.kind}/${(it.fields||[]).join('|')}）@ ${it.code}：旧证据保留，需重新确认`, instanceId, it.code]);
    }
    await q(`UPDATE instance SET model_id=$2, hw_rev=$3, version_id=$4, status='collecting' WHERE id=$1`,
      [instanceId, preview.targetModel.id, hwRev, preview.version.id]);
    // 清空条件回答：新分支必须重新逐项确认（不得沿用猜测）
    await q(`DELETE FROM instance_condition WHERE instance_id=$1`, [instanceId]);
    const steps = await q(`SELECT * FROM step WHERE version_id=$1`, [preview.version.id]);
    for (const s of steps) {
      await q(`INSERT INTO instance_step(id,instance_id,step_id,step_code,state) VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING`,
        [id('is'), instanceId, s.id, s.code]);
    }
    await q(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'branch_switch',$3)`,
      [instanceId, actor, `${inst.model_id}/${inst.hw_rev} -> ${modelCode}/${hwRev}（${preview.version.version}）；旧证据保留，条件需重新确认`]);
  });
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// 供路由在事务外调用
export async function refreshStatusStandalone(instanceId) {
  await refreshInstanceStatus(undefined, instanceId);
}
