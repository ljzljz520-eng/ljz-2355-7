import { Router } from 'express';
import multer from 'multer';
import { one, many, query, tx } from '../db/index.js';
import {
  loadVersion, evaluateInstance, progress, completeStep, reopenStep,
  scanDrawingChanges, proposeMigration, confirmMigration, rejectMigration,
  branchSwitchPreview, branchSwitchExecute, httpErr,
} from '../domain/service.js';
import { putObject, getObject, sha256 } from '../store/objects.js';
import { validateExpression, evalExpression } from '../domain/expr.js';
import { topoSort } from '../domain/dag.js';

export const api = Router();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

const rid = (p) => p + '-' + Math.random().toString(36).slice(2, 10);
const actor = (req) => req.header('x-actor-role') === 'admin' ? 'admin' : 'installer';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- 目录数据 ----------
api.get('/catalog', wrap(async (req, res) => {
  const models = await many(
    `SELECT m.*, json_agg(json_build_object('rev',h.rev,'note',h.note) ORDER BY h.rev) FILTER (WHERE h.rev IS NOT NULL) AS hw_revs
       FROM model m LEFT JOIN hardware_revision h ON h.model_id=m.id GROUP BY m.id ORDER BY m.code`);
  const conditions = await many(`SELECT * FROM condition_def ORDER BY scope_model NULLS FIRST, key`);
  const versions = await many(
    `SELECT mv.id, mv.version, mv.status, mv.change_note, mv.published_at, m.model_id, m.hw_rev, mo.code AS model_code
       FROM manual_version mv JOIN manual m ON m.id=mv.manual_id JOIN model mo ON mo.id=m.model_id
      ORDER BY mo.code, m.hw_rev, mv.published_at`);
  const drawings = await many(
    `SELECT d.*, (SELECT count(*) FROM drawing_version dv WHERE dv.drawing_id=d.id) AS versions FROM drawing d ORDER BY d.code`);
  res.json({ models, conditions, versions, drawings });
}));

// ---------- 实例 ----------
api.post('/instances', wrap(async (req, res) => {
  const { label, model_code, hw_rev } = req.body || {};
  if (!label || !model_code || !hw_rev) throw httpErr(400, '缺少 label/model_code/hw_rev');
  const m = await one(`SELECT * FROM model WHERE code=$1 AND status='active'`, [model_code]);
  if (!m) throw httpErr(404, `型号 ${model_code} 不存在或已停用；不得猜选相近型号`);
  let mv;
  if (req.body.version_id) {
    mv = await one(
      `SELECT mv.* FROM manual_version mv JOIN manual m ON m.id=mv.manual_id
        WHERE mv.id=$1 AND m.model_id=$2 AND m.hw_rev=$3 AND mv.status='published'`,
      [req.body.version_id, m.id, hw_rev]);
    if (!mv) throw httpErr(409, '所选版本不属于该型号/硬件修订或未发布：不得跨分支钉版本');
  } else {
    mv = await one(
      `SELECT mv.* FROM manual_version mv JOIN manual m ON m.id=mv.manual_id
        WHERE m.model_id=$1 AND m.hw_rev=$2 AND mv.status='published'
        ORDER BY mv.published_at DESC LIMIT 1`, [m.id, hw_rev]);
  }
  if (!mv) throw httpErr(409, `型号 ${model_code} 修订 ${hw_rev} 无已发布手册：停在待确认`);
  const iid = rid('ins');
  await query(`INSERT INTO instance(id,label,model_id,hw_rev,version_id,status,migration_policy)
               VALUES ($1,$2,$3,$4,$5,'collecting',$6)`,
    [iid, label, m.id, hw_rev, mv.id, req.body.migration_policy === 'controlled' ? 'controlled' : 'lock']);
  const steps = await many(`SELECT * FROM step WHERE version_id=$1`, [mv.id]);
  for (const s of steps) {
    await query(`INSERT INTO instance_step(id,instance_id,step_id,step_code,state) VALUES ($1,$2,$3,$4,'pending')`,
      [rid('is'), iid, s.id, s.code]);
  }
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'instance_create',$3)`,
    [iid, actor(req), `${model_code}/${hw_rev} 钉住手册版本 ${mv.version}`]);
  res.status(201).json(await instancePayload(iid));
}));

api.get('/instances', wrap(async (req, res) => {
  const rows = await many(
    `SELECT i.*, m.code AS model_code, mv.version AS manual_version,
            (SELECT count(*) FROM review_item r WHERE r.instance_id=i.id AND r.status='open') AS open_reviews
       FROM instance i JOIN model m ON m.id=i.model_id JOIN manual_version mv ON mv.id=i.version_id
      ORDER BY i.created_at DESC`);
  res.json(rows);
}));

async function instancePayload(iid) {
  const inst = await one(
    `SELECT i.*, m.code AS model_code, m.name AS model_name, mv.version AS manual_version,
            man.id AS manual_id
       FROM instance i JOIN model m ON m.id=i.model_id
       JOIN manual_version mv ON mv.id=i.version_id JOIN manual man ON man.id=mv.manual_id
      WHERE i.id=$1`, [iid]);
  if (!inst) throw httpErr(404, '实例不存在');
  const ev = await evaluateInstance(inst);
  const steps = ev.version.steps.map(s => {
    const x = ev.exec[s.id];
    return {
      id: s.id, code: s.code, seq: s.seq, title: s.title, body: s.body,
      applicability: ev.applicability.get(s.id),
      run_state: ev.stateOf.get(s.id),
      required_evidence: s.required_evidence, evidence_label: s.evidence_label, value_unit: s.value_unit,
      state: x?.state || 'pending', done_at: x?.done_at || null, done_by: x?.done_by || null,
      reopened_count: x?.reopened_count || 0,
      drawings: (ev.version.drawings.get(s.id) || []).map(d => ({
        code: d.code, title: d.title,
        version: d.version, object_key: d.object_key, content_sha: d.content_sha, status: d.status,
        latest_version: d.latest_ver, latest_sha: d.latest_sha, latest_status: d.latest_status,
        has_upgrade: !!d.latest_sha && d.latest_sha !== d.content_sha && d.latest_status === 'published',
        executed_sha_matches: !x?.drawing_sha || !d.content_sha || x.drawing_sha.split(',').includes(d.content_sha),
      })),
      warnings: ev.version.warns.filter(w => w.step_id === s.id).map(w => {
        // 警示紧邻适用步骤：表达式为 true 显示；未知（引用了未答条件）也必须显示，宁可多提示
        let shown = true;
        try { const r = evalExpression(w.condition_expr || 'true', ev.vars); shown = r !== false; } catch { shown = true; }
        return { severity: w.severity, message: w.message, shown };
      }).filter(w => w.shown),
    };
  });
  const evidRows = await many(
    `SELECT e.*, x.step_id, x.step_code FROM evidence e
      JOIN instance_step x ON x.id=e.instance_step_id WHERE x.instance_id=$1 ORDER BY e.uploaded_at`, [iid]);
  const conds = await many(
    `SELECT c.id,c.key,c.label,c.kind,c.options_json,c.required,c.scope_model, ic.value, ic.answered_at
       FROM condition_def c LEFT JOIN instance_condition ic ON ic.condition_id=c.id AND ic.instance_id=$1
      WHERE c.scope_model IS NULL OR c.scope_model=$2 ORDER BY c.key`, [iid, inst.model_id]);
  const migrations = await many(`SELECT * FROM migration WHERE instance_id=$1 ORDER BY created_at DESC`, [iid]);
  const prg = progress(ev.version.steps, ev.applicability, ev.stateOf);
  const events = await many(`SELECT type,detail,actor,at FROM event_log WHERE instance_id=$1 ORDER BY id DESC LIMIT 30`, [iid]);
  return {
    instance: inst,
    steps,
    progress: prg,
    reviews: ev.reviews,
    conditions: conds.map(c => ({ ...c, options_json: JSON.parse(c.options_json), answered: !!c.answered_at })),
    evidence: evidRows.map(e => ({ ...e, object_url: e.object_key ? '/api/objects/' + encodeURIComponent(e.object_key) : null })),
    migrations: migrations.map(m => ({ ...m, diff_json: JSON.parse(m.diff_json) })),
    events,
    can_finalize: inst.status === 'complete',
  };
}

api.get('/instances/:id', wrap(async (req, res) => res.json(await instancePayload(req.params.id))));

// 条件回答（未知留空 => 停在待确认；显式 null 也视为未回答）
api.put('/instances/:id/conditions', wrap(async (req, res) => {
  const iid = req.params.id;
  const answers = req.body.answers || {};
  for (const [cid, value] of Object.entries(answers)) {
    const c = await one(`SELECT * FROM condition_def WHERE id=$1`, [cid]);
    if (!c) continue;
    if (value === null || value === undefined || String(value).trim() === '') {
      await query(`INSERT INTO instance_condition(instance_id,condition_id,value,answered_at)
                   VALUES ($1,$2,NULL,NULL) ON CONFLICT (instance_id,condition_id)
                   DO UPDATE SET value=NULL, answered_at=NULL`, [iid, cid]);
    } else {
      if (c.kind === 'choice') {
        const ok = JSON.parse(c.options_json).some(o => o.value === value);
        if (!ok) throw httpErr(422, `条件 ${c.label} 的取值不在受控选项内；未知应留空待确认`);
      }
      await query(`INSERT INTO instance_condition(instance_id,condition_id,value,answered_at)
                   VALUES ($1,$2,$3,now()) ON CONFLICT (instance_id,condition_id)
                   DO UPDATE SET value=$3, answered_at=now()`, [iid, cid, String(value)]);
    }
  }
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'conditions_update','条件回答更新')`, [iid, actor(req)]);
  await refreshAndScan(iid);
  res.json(await instancePayload(iid));
}));

async function refreshAndScan(iid) {
  await scanDrawingChanges(iid);
  const inst = await one(`SELECT * FROM instance WHERE id=$1`, [iid]);
  // 轻量状态刷新
  const { refreshStatusStandalone } = await import('../domain/service.js');
  if (refreshStatusStandalone) await refreshStatusStandalone(iid);
}

// 上传证据对象（离线迟到照片带 X-Captured-At）
api.post('/instances/:id/evidence', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpErr(400, '缺少文件');
  const buf = req.file.buffer;
  const sha = sha256(buf);
  const key = `evidence/${req.params.id}/${Date.now().toString(36)}-${sha}-${req.file.originalname.replace(/[^\w.\-]+/g, '_')}`;
  await putObject(key, buf, req.file.mimetype || 'application/octet-stream');
  res.status(201).json({ object_key: key, content_sha: sha, size: buf.length,
    captured_at: req.header('x-captured-at') || null });
}));

// 勾选完成
api.post('/instances/:id/steps/:stepId/complete', wrap(async (req, res) => {
  const { photos, values, captured_at } = req.body || {};
  await completeStep(req.params.id, req.params.stepId, actor(req), { photos, values }, captured_at || null);
  res.json(await instancePayload(req.params.id));
}));

api.post('/instances/:id/steps/:stepId/reopen', wrap(async (req, res) => {
  await reopenStep(req.params.id, req.params.stepId, actor(req), req.body?.reason || '');
  res.json(await instancePayload(req.params.id));
}));

// 离线照片迟到：补传到已完成步骤（标记 late，不改变完成时间，触发一次复核提示而非重算进度）
api.post('/instances/:id/steps/:stepId/late-photo', upload.single('file'), wrap(async (req, res) => {
  const iid = req.params.id;
  const x = await one(`SELECT * FROM instance_step WHERE instance_id=$1 AND step_id=$2`, [iid, req.params.stepId]);
  if (!x) throw httpErr(404, '步骤记录不存在');
  const buf = req.file.buffer; const sha = sha256(buf);
  const key = `evidence/${iid}/late-${sha}-${req.file.originalname.replace(/[^\w.\-]+/g, '_')}`;
  await putObject(key, buf, req.file.mimetype || 'image/svg+xml');
  const capturedAt = req.header('x-captured-at') || null;
  await query(`INSERT INTO evidence(id,instance_step_id,kind,object_key,content_sha,captured_at,uploaded_by,late)
               VALUES ($1,$2,'photo',$3,$4,$5,$6,TRUE)`,
    [rid('ev'), x.id, key, sha, capturedAt, actor(req)]);
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'late_photo',$3)`,
    [iid, actor(req), `${x.step_code} 迟到照片（拍摄于 ${capturedAt || '未知'}）已归档，原完成时间不变`]);
  res.json(await instancePayload(iid));
}));

// 复核项处理
api.post('/instances/:id/reviews/:rid/resolve', wrap(async (req, res) => {
  const iid = req.params.id;
  const r = await one(`SELECT * FROM review_item WHERE id=$1 AND instance_id=$2 FOR UPDATE`, [req.params.rid, iid]);
  if (!r || r.status !== 'open') throw httpErr(404, '复核项不存在或已关闭');
  await query(`UPDATE review_item SET status='resolved', resolved_at=now(), resolution=$2 WHERE id=$1`,
    [r.id, req.body?.resolution || '已按现行资料复核']);
  const { refreshStatusStandalone } = await import('../domain/service.js');
  await refreshStatusStandalone?.(iid);
  res.json(await instancePayload(iid));
}));

// 迁移
api.post('/instances/:id/migrations', wrap(async (req, res) => {
  const out = await proposeMigration(req.params.id, req.body.to_version_id, actor(req));
  res.status(201).json(out);
}));
api.post('/instances/:id/migrations/:mid/confirm', wrap(async (req, res) => {
  await confirmMigration(req.params.id, req.params.mid, req.body.confirmed_codes || [], actor(req));
  res.json(await instancePayload(req.params.id));
}));
api.post('/instances/:id/migrations/:mid/reject', wrap(async (req, res) => {
  await rejectMigration(req.params.id, req.params.mid, actor(req));
  res.json(await instancePayload(req.params.id));
}));
api.put('/instances/:id/policy', wrap(async (req, res) => {
  const p = req.body.policy === 'controlled' ? 'controlled' : 'lock';
  await query(`UPDATE instance SET migration_policy=$2 WHERE id=$1`, [req.params.id, p]);
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'policy_change',$3)`,
    [req.params.id, actor(req), p === 'lock' ? '锁定旧手册' : '允许受控迁移']);
  res.json(await instancePayload(req.params.id));
}));

// 分支切换
api.post('/instances/:id/branch-switch/preview', wrap(async (req, res) => {
  res.json(await branchSwitchPreview(req.params.id, req.body.model_code, req.body.hw_rev));
}));
api.post('/instances/:id/branch-switch/execute', wrap(async (req, res) => {
  await branchSwitchExecute(req.params.id, req.body.model_code, req.body.hw_rev, actor(req));
  res.json(await instancePayload(req.params.id));
}));

// 定稿
api.post('/instances/:id/finalize', wrap(async (req, res) => {
  const p = await instancePayload(req.params.id);
  if (!p.can_finalize) throw httpErr(409, '仍有未完成适用步骤、未决复核或未知条件，不能定稿');
  await query(`UPDATE instance SET status='finalized', finalized_at=now() WHERE id=$1`, [req.params.id]);
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'finalize','按钉住版本定稿')`, [req.params.id, actor(req)]);
  res.json(await instancePayload(req.params.id));
}));

// 导出（本实例实际采用的资料版 + 未决项）
api.get('/instances/:id/export', wrap(async (req, res) => {
  const p = await instancePayload(req.params.id);
  const doc = {
    document: '硬件安装记录（导出）',
    generated_at: new Date().toISOString(),
    instance: {
      id: p.instance.id, label: p.instance.label,
      model_code: p.instance.model_code, hw_rev: p.instance.hw_rev,
      status: p.instance.status, migration_policy: p.instance.migration_policy,
    },
    materials_actually_used: {
      // 实例实际采用的资料版本（锁定/迁移后都会准确反映）
      manual_version: p.instance.manual_version,
      version_id: p.instance.version_id,
      drawings: [...new Map(p.steps.flatMap(s => s.drawings.map(d => [d.code, { code: d.code, version: d.version, sha256: d.content_sha, status: d.status }]))).values()],
    },
    conditions: p.conditions.map(c => ({ key: c.key, label: c.label, value: c.answered ? c.value : null, state: c.answered ? 'answered' : 'PENDING' })),
    steps: p.steps.map(s => ({
      code: s.code, title: s.title, applicability: s.applicability, state: s.state,
      done_at: s.done_at, done_by: s.done_by, reopened_count: s.reopened_count,
      drawings: s.drawings.map(d => `${d.code}@v${d.version}[${d.status}]`),
    })),
    evidence: p.evidence.map(e => ({ step: e.step_code, kind: e.kind, late: e.late, superseded: e.superseded,
      object_key: e.object_key, sha256: e.content_sha, value_text: e.value_text, uploaded_at: e.uploaded_at })),
    open_items: [
      ...p.conditions.filter(c => !c.answered).map(c => ({ type: 'unknown_condition', text: `${c.label} 未确认（待确认）` })),
      ...p.reviews.map(r => ({ type: r.reason, text: r.detail })),
      ...p.steps.filter(s => s.applicability === 'unknown').map(s => ({ type: 'unknown_step', text: `步骤 ${s.code} 适用性未知，停在待确认` })),
    ],
    progress: p.progress,
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="install-${p.instance.id}.json"`);
  res.send(JSON.stringify(doc, null, 2));
}));

// 打印（失败可重试；不静默）
api.post('/instances/:id/print', wrap(async (req, res) => {
  const iid = req.params.id;
  const jid = rid('pj');
  await query(`INSERT INTO print_job(id,instance_id,kind,status) VALUES ($1,$2,$3,'queued')`,
    [jid, iid, req.body?.kind || 'checklist']);
  // 演示打印机：PRINTER_FAIL=1 或 body.simulate_fail=true 时失败
  const fail = process.env.PRINTER_FAIL === '1' || req.body?.simulate_fail === true;
  if (fail) {
    await query(`UPDATE print_job SET status='failed', attempts=attempts+1, error=$2 WHERE id=$1`, [jid, '打印机离线（模拟）']);
    await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'print_failed','打印失败，可重试；勾选记录不受影响')`, [iid, actor(req)]);
    return res.status(502).json({ print_job_id: jid, status: 'failed', error: '打印机离线（模拟）', retryable: true });
  }
  await query(`UPDATE print_job SET status='printed', attempts=attempts+1 WHERE id=$1`, [jid]);
  res.json({ print_job_id: jid, status: 'printed' });
}));
api.post('/print-jobs/:jid/retry', wrap(async (req, res) => {
  const j = await one(`SELECT * FROM print_job WHERE id=$1`, [req.params.jid]);
  if (!j) throw httpErr(404, '打印任务不存在');
  const fail = process.env.PRINTER_FAIL === '1' || req.body?.simulate_fail === true;
  if (fail) {
    await query(`UPDATE print_job SET status='failed', attempts=attempts+1, error=$2 WHERE id=$1`, [j.id, '打印机仍离线（模拟）']);
    return res.status(502).json({ print_job_id: j.id, status: 'failed', retryable: true });
  }
  await query(`UPDATE print_job SET status='printed', attempts=attempts+1, error='' WHERE id=$1`, [j.id]);
  await query(`INSERT INTO event_log(instance_id,actor,type,detail) VALUES ($1,$2,'print_retry','重打成功')`, [j.instance_id, actor(req)]);
  res.json({ print_job_id: j.id, status: 'printed' });
}));

// ---------- 管理端：型号条件 / 图纸 ----------
api.post('/admin/conditions', wrap(async (req, res) => {
  if (actor(req) !== 'admin') throw httpErr(403, '仅管理员');
  const { key, label, kind, options, scope_model } = req.body;
  if (!key || !label || !['choice', 'text', 'boolean'].includes(kind)) throw httpErr(400, '字段不合法');
  const cid = rid('c');
  await query(`INSERT INTO condition_def(id,scope_model,key,label,kind,options_json)
               VALUES ($1,$2,$3,$4,$5,$6)`, [cid, scope_model || null, key, label, kind, JSON.stringify(options || [])]);
  res.status(201).json({ id: cid });
}));

// 新版本图纸（上传后成为 published，旧版自动 superseded；随后实例扫描产生复核项）
api.post('/admin/drawings/:code/versions', upload.single('file'), wrap(async (req, res) => {
  if (actor(req) !== 'admin') throw httpErr(403, '仅管理员');
  const d = await one(`SELECT * FROM drawing WHERE code=$1`, [req.params.code]);
  if (!d) throw httpErr(404, '图纸不存在');
  const buf = req.file.buffer; const sha = sha256(buf);
  const vers = (await many(`SELECT version FROM drawing_version WHERE drawing_id=$1`, [d.id]))
    .map(r => parseInt(r.version, 10)).filter(n => Number.isFinite(n));
  const nextVer = String((vers.length ? Math.max(...vers) : 0) + 1);
  const key = `drawings/${d.code}-v${nextVer}.${(req.file.originalname.split('.').pop() || 'svg')}`;
  await putObject(key, buf, req.file.mimetype || 'image/svg+xml');
  const dvid = rid('dv');
  await query(`UPDATE drawing_version SET status='superseded' WHERE drawing_id=$1 AND status='published'`, [d.id]);
  await query(`INSERT INTO drawing_version(id,drawing_id,version,object_key,content_sha,media_type,change_note)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [dvid, d.id, nextVer, key, sha, req.file.mimetype || 'image/svg+xml', req.body.change_note || '']);
  await query(`INSERT INTO event_log(actor,type,detail) VALUES ('admin','drawing_publish',$1)`, [`${d.code} v${nextVer} 发布`]);
  // 对所有使用该图、且已执行的实例生成复核项（不平移进度）
  const insts = await many(
    `SELECT DISTINCT x.instance_id FROM instance_step x
       JOIN step s ON s.id=x.step_id JOIN step_drawing sd ON sd.step_id=s.id
      WHERE sd.drawing_id=$1 AND x.state='done'`, [d.id]);
  const touched = [];
  for (const i of insts) touched.push(...(await scanDrawingChanges(i.instance_id)));
  res.status(201).json({ drawing_version_id: dvid, version: nextVer, sha, review_items_generated: touched.length });
}));

// 撤回图纸：published -> withdrawn；引用步骤禁止新查看/新执行，已执行产生复核
api.post('/admin/drawings/:code/withdraw', wrap(async (req, res) => {
  if (actor(req) !== 'admin') throw httpErr(403, '仅管理员');
  const d = await one(`SELECT * FROM drawing WHERE code=$1`, [req.params.code]);
  if (!d) throw httpErr(404, '图纸不存在');
  await query(`UPDATE drawing_version SET status='withdrawn' WHERE drawing_id=$1 AND status='published'`, [d.id]);
  await query(`INSERT INTO event_log(actor,type,detail) VALUES ('admin','drawing_withdraw',$1)`, [`${d.code} 撤回`]);
  const insts = await many(
    `SELECT DISTINCT x.instance_id FROM instance_step x
       JOIN step s ON s.id=x.step_id JOIN step_drawing sd ON sd.step_id=s.id
      WHERE sd.drawing_id=$1 AND x.state IN ('done','recheck_open')`, [d.id]);
  for (const i of insts) await scanDrawingChanges(i.instance_id);
  res.json({ withdrawn: true });
}));

// 管理端：发布新手册版本（步骤含适用性表达式、DAG 依赖、警示、钉住图纸版本）
api.post('/admin/manuals/:manualId/versions', wrap(async (req, res) => {
  if (actor(req) !== 'admin') throw httpErr(403, '仅管理员');
  const manual = await one(`SELECT * FROM manual WHERE id=$1`, [req.params.manualId]);
  if (!manual) throw httpErr(404, '手册不存在');
  const { version, change_note, steps } = req.body || {};
  if (!version || !Array.isArray(steps) || !steps.length) throw httpErr(400, '需要 version 与 steps[]');
  // 校验表达式与 DAG（环 => 拒绝发布）
  for (const st of steps) validateExpression(st.applicability || 'true');
  const idx = Object.fromEntries(steps.map((st, i) => [st.code, i]));
  for (const st of steps) for (const depCode of st.depends_on || [])
    if (!(depCode in idx)) throw httpErr(422, `步骤 ${st.code} 依赖了不存在的 ${depCode}`);
  const tmpSteps = steps.map((st, i) => ({ id: 'tmp-' + i, seq: st.seq ?? (i + 1) }));
  const depSet = [];
  for (const st of steps) for (const depCode of st.depends_on || [])
    depSet.push({ from_step: 'tmp-' + idx[depCode], to_step: 'tmp-' + idx[st.code] });
  try { topoSort(tmpSteps, depSet); } catch (e) { throw httpErr(422, e.message); }  // 有环/引用缺失 => 拒绝发布
  const mvid = rid('mv');
  await tx(async (q) => {
    await q(`INSERT INTO manual_version(id,manual_id,version,status,published_at,change_note)
             VALUES ($1,$2,$3,'published',now(),$4)`, [mvid, manual.id, version, change_note || '']);
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const sid = 'st-' + rid('v');
      st.__sid = sid;
      await q(`INSERT INTO step(id,version_id,code,seq,title,body,applicability,required_evidence,evidence_label,value_unit)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sid, mvid, st.code, st.seq ?? (i + 1), st.title, st.body || '', st.applicability || 'true',
         st.required_evidence || 'none', st.evidence_label || '', st.value_unit || null]);
      for (const w of st.warnings || []) {
        if (w.condition_expr) validateExpression(w.condition_expr);
        await q(`INSERT INTO step_warning(id,step_id,severity,message,condition_expr) VALUES ($1,$2,$3,$4,$5)`,
          [rid('w'), sid, w.severity || 'warning', w.message, w.condition_expr || null]);
      }
      for (const dvId of st.drawing_version_ids || []) {
        await q(`INSERT INTO step_drawing(step_id,drawing_id,drawing_version_id)
                 SELECT $1,drawing_id,$2 FROM drawing_version WHERE id=$2`, [sid, dvId]);
      }
    }
    const byCode = Object.fromEntries(steps.map(st => [st.code, st.__sid]));
    for (const st of steps) {
      for (const depCode of st.depends_on || []) {
        await q(`INSERT INTO step_dep(version_id,from_step,to_step) VALUES ($1,$2,$3)`,
          [mvid, byCode[depCode], byCode[st.code]]);
      }
    }
  });
  res.status(201).json({ manual_version_id: mvid, version, steps: steps.length });
}));

// 管理端：发布新手册版本前的 DAG / 表达式校验（演示端点）
api.post('/admin/validate-version', wrap(async (req, res) => {
  if (actor(req) !== 'admin') throw httpErr(403, '仅管理员');
  const { steps, deps } = req.body;
  for (const s of steps) validateExpression(s.applicability || 'true');
  topoSort(steps, deps);
  res.json({ ok: true, message: '表达式合法且依赖为 DAG' });
}));

// 对象读取
api.get('/objects/:key(*)', wrap(async (req, res) => {
  const { buf } = await getObject(req.params.key);
  const ext = req.params.key.split('.').pop().toLowerCase();
  const type = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'application/octet-stream';
  res.type(type).send(buf);
}));
