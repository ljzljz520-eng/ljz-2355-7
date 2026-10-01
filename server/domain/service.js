// 核心领域服务：实例版本锁定、条件分支、DAG 勾选、证据、迁移复核、撤回、打印。
import { db, one, many, tx } from '../db/pg.js';
import { evaluateApplicability } from './condition.js';
import { resolveVersions, diffVersions } from './manual.js';
import { deriveStepStates } from './dag.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let _seed;
export function seedData() {
  if (!_seed) _seed = JSON.parse(readFileSync(path.join(ROOT, 'demo', 'manual.seed.json'), 'utf8'));
  return _seed;
}
let _versions;
export function versionsResolved() {
  if (!_versions) _versions = resolveVersions(seedData());
  return _versions;
}

async function logEvent(instanceId, event_type, step_key = null, payload = {}) {
  await db.query(
    `INSERT INTO instance_events (instance_id, event_type, step_key, payload) VALUES ($1,$2,$3,$4)`,
    [instanceId, event_type, step_key, JSON.stringify(payload)]);
}

async function getVersionRow(id) {
  const row = await one(`SELECT * FROM manual_versions WHERE id=$1`, [id]);
  if (!row) throw Object.assign(new Error('手册版本不存在'), { status: 404 });
  return row;
}

async function loadVersionDef(versionRow) {
  const v = versionsResolved().get(versionRow.version_label);
  if (!v) throw new Error(`已解析版本缺失: ${versionRow.version_label}`);
  const dbSteps = await many(
    `SELECT step_key, title, detail_md, condition_expr, drawing_key, seq_no, kind
     FROM steps WHERE manual_version=$1 ORDER BY seq_no`, [versionRow.id]);
  const dbDeps = await many(
    `SELECT step_key, depends_on_key FROM step_dependencies WHERE manual_version=$1`, [versionRow.id]);
  const depMap = new Map(dbDeps.map((d) => [d.step_key, new Set()]));
  for (const d of dbDeps) {
    if (!depMap.has(d.step_key)) depMap.set(d.step_key, new Set());
    depMap.get(d.step_key).add(d.depends_on_key);
  }
  const warnings = await many(
    `SELECT step_key, code, message, severity, condition_expr FROM warnings WHERE manual_version=$1`, [versionRow.id]);
  return {
    row: versionRow,
    steps: dbSteps.map((s) => ({
      ...s,
      condition: s.condition_expr,
      dependencies: [...(depMap.get(s.step_key) || [])],
    })),
    warnings,
    resolved: v,
  };
}

// ---------- 目录 ----------
export async function listCatalog() {
  const seed = seedData();
  const rows = await many(
    `SELECT id, manual_code, version_label, status, published_at, superseded_by, withdrawn_at, withdraw_reason
     FROM manual_versions ORDER BY published_at`);
  return {
    manual: { code: seed.manual_code, title: seed.title, notice: seed.notice },
    models: seed.models,
    hw_revisions: seed.hw_revisions,
    versions: rows,
  };
}

export async function getVersionDetail(versionId) {
  const row = await getVersionRow(versionId);
  const def = await loadVersionDef(row);
  return { version: row, steps: def.steps, warnings: def.warnings };
}

// ---------- 实例 ----------
export async function listInstances() {
  return many(
    `SELECT i.*, mv.version_label, mv.manual_code,
            (SELECT count(*) FROM instance_steps s WHERE s.instance_id=i.id AND s.state='completed')::int AS completed_count
     FROM instances i JOIN manual_versions mv ON mv.id=i.manual_version_id
     ORDER BY i.id DESC`);
}

export async function createInstance({ name, version_id }) {
  if (!Number.isFinite(Number(version_id))) {
    throw Object.assign(new Error('创建实例必须显式选择并锁定一个手册资料版本（version_id 必填）'), { status: 400 });
  }
  const versionRow = await getVersionRow(Number(version_id));
  if (versionRow.status === 'withdrawn') {
    throw Object.assign(new Error('该资料版本已整体撤回，不能新建实例（可选择其它版本）'), { status: 409 });
  }
  return tx(async () => {
    const code = `INST-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
    const r = await db.query(
      `INSERT INTO instances (instance_code, name, manual_version_id, status) VALUES ($1,$2,$3,'open') RETURNING *`,
      [code, name || '未命名安装实例', versionRow.id]);
    const inst = r.rows[0];
    const def = await loadVersionDef(versionRow);
    for (const s of def.steps) {
      await db.query(
        `INSERT INTO instance_steps (instance_id, manual_version, step_key, state)
         VALUES ($1,$2,$3,'pending')`, [inst.id, versionRow.id, s.step_key]);
    }
    await logEvent(inst.id, 'INSTANCE_CREATED', null, { version_id: versionRow.id, version_label: versionRow.version_label });
    return inst;
  });
}

function ctxOf(inst) {
  // PG 中 NULL = 尚未确认；保留 null 让条件引擎明确判定，避免 undefined 被误读
  return { model: inst.model === undefined ? null : inst.model,
           hw_revision: inst.hw_revision === undefined ? null : inst.hw_revision,
           options: inst.options || {} };
}

// 计算实例步骤适用性（未知条件 => unknown，保持待确认，不默认）
function computeApplicability(steps, inst) {
  const ctx = ctxOf(inst);
  const map = new Map();
  for (const s of steps) map.set(s.step_key, evaluateApplicability(s.condition, ctx));
  return map;
}

// 需要证据才能勾选的步骤：紧邻 danger/warning 级别警示
function evidenceRequiredKeys(warnings) {
  const set = new Set();
  for (const w of warnings) if (w.severity === 'danger' || w.severity === 'warning') set.add(w.step_key);
  return set;
}

export async function getInstanceDetail(instanceId) {
  const inst = await one(`SELECT * FROM instances WHERE id=$1`, [instanceId]);
  if (!inst) throw Object.assign(new Error('实例不存在'), { status: 404 });
  const versionRow = await getVersionRow(inst.manual_version_id);
  const def = await loadVersionDef(versionRow);

  const rows = await many(
    `SELECT * FROM instance_steps WHERE instance_id=$1 AND manual_version=$2`, [inst.id, versionRow.id]);
  const rowByKey = new Map(rows.map((r) => [r.step_key, r]));
  const completedKeys = new Set(rows.filter((r) => r.state === 'completed').map((r) => r.step_key));

  const applicability = computeApplicability(def.steps, inst);
  const states = deriveStepStates(def.steps, completedKeys, applicability);

  const evidences = await many(
    `SELECT e.*, o.content_type AS stored_content_type FROM evidences e
     LEFT JOIN objects o ON o.object_key=e.object_key WHERE e.instance_id=$1 ORDER BY e.uploaded_at`, [inst.id]);
  const evidenceByStep = new Map();
  for (const ev of evidences) {
    if (!evidenceByStep.has(ev.step_key)) evidenceByStep.set(ev.step_key, []);
    evidenceByStep.get(ev.step_key).push(ev);
  }
  const reqSet = evidenceRequiredKeys(def.warnings);
  const reviews = await many(`SELECT * FROM review_items WHERE instance_id=$1 ORDER BY id`, [inst.id]);
  const events = await many(`SELECT * FROM instance_events WHERE instance_id=$1 ORDER BY id DESC LIMIT 30`, [inst.id]);

  const stepsOut = def.steps.map((s) => {
    const st = states.get(s.step_key);
    const row = rowByKey.get(s.step_key) || {};
    const app = applicability.get(s.step_key);
    const stepEv = evidenceByStep.get(s.step_key) || [];
    const storedEvidence = stepEv.filter((e) => e.upload_state === 'stored');
    const openReview = reviews.filter((r) => r.step_key === s.step_key && r.status !== 'reverified' && r.status !== 'waived');
    return {
      step_key: s.step_key,
      title: s.title,
      kind: s.kind,
      seq_no: s.seq_no,
      detail_md: s.detail_md,
      drawing_key: s.drawing_key,
      condition_expr: s.condition_expr,
      dependencies: s.dependencies,
      applicability: app,                 // yes/no/unknown
      runtime_state: st.state,            // ready/blocked/completed/skipped
      blocked_by: st.blockedBy || [],
      unknown_reason: st.reason || null,
      stored_state: row.state || 'pending',
      completed_at: row.completed_at || null,
      completed_by: row.completed_by || null,
      note: row.note || null,
      evidence_required: reqSet.has(s.step_key),
      evidence_pending: stepEv.some((e) => e.upload_state === 'pending_offline'),
      evidence_count: storedEvidence.length,
      has_open_review: openReview.length > 0,
      review_items: openReview,
      warnings: def.warnings.filter((w) => {
        if (w.step_key !== s.step_key) return false;
        if (!w.condition_expr) return true;
        return evaluateApplicability(w.condition_expr, ctxOf(inst)).applicable !== false;
      }),
    };
  });

  const applicableSteps = stepsOut.filter((s) => s.applicability.status === 'yes');
  const applicableCompleted = applicableSteps.filter((s) => s.stored_state === 'completed').length;
  const progress = applicableSteps.length
    ? Math.round((applicableCompleted / applicableSteps.length) * 100) : 0;
  const openReviews = reviews.filter((r) => r.status === 'open' || r.status === 'acknowledged');
  const pendingUnknowns = stepsOut.filter((s) => s.applicability.status === 'unknown').map((s) => ({
    step_key: s.step_key, title: s.title, reason: s.unknown_reason }));
  const pendingEvidence = evidences.filter((e) => e.upload_state === 'pending_offline');

  // 迁移信息
  let migration = null;
  if (inst.migration_target_version) {
    migration = {
      target_version_id: inst.migration_target_version,
      status: inst.migration_status,
      target: await one(`SELECT * FROM manual_versions WHERE id=$1`, [inst.migration_target_version]),
    };
  }
  const activeVersion = await one(`SELECT id, version_label FROM manual_versions WHERE manual_code=$1 AND status='active'`,
    [versionRow.manual_code]);
  const migrationAvailable = !migration && activeVersion && activeVersion.id !== versionRow.id;

  return {
    instance: inst,
    locked_version: { id: versionRow.id, label: versionRow.version_label, status: versionRow.status,
      withdrawn_at: versionRow.withdrawn_at, withdraw_reason: versionRow.withdraw_reason },
    catalog_models: seedData().models,
    catalog_hw_revisions: seedData().hw_revisions,
    steps: stepsOut,
    progress: { completed: applicableCompleted, applicable: applicableSteps.length, percent: progress },
    open_review_count: openReviews.length,
    reviews,
    pending: { unknowns: pendingUnknowns, offline_evidence: pendingEvidence.map((e) => ({
      id: e.id, step_key: e.step_key, filename: e.filename, captured_at: e.captured_at })) },
    migration,
    migration_available: migrationAvailable ? { target_version_id: activeVersion.id, target_label: activeVersion.version_label } : null,
    evidences: evidences.map(({ bind_state, upload_state, step_key, filename, captured_at, uploaded_at, object_key, id, note }) =>
      ({ id, step_key, filename, captured_at, uploaded_at, object_key, bind_state, upload_state, note })),
    events: events.slice(0, 15),
    can_complete: inst.status !== 'completed',
  };
}

// ---------- 型号/修订确认：精确匹配，未知即停 ----------
export async function confirmContext(instanceId, body) {
  const inst = await one(`SELECT * FROM instances WHERE id=$1`, [instanceId]);
  if (!inst) throw Object.assign(new Error('实例不存在'), { status: 404 });
  const seed = seedData();
  const model = body.model === '' || body.model == null ? null : String(body.model);
  const hwRevision = body.hw_revision === '' || body.hw_revision == null ? null : String(body.hw_revision);

  const problems = [];
  if (model !== null && !seed.models.some((m) => m.code === model)) {
    problems.push(`型号 "${model}" 不在本手册受控型号清单内；禁止以相近型号代替，须停在待确认`);
  }
  if (hwRevision !== null && !seed.hw_revisions.includes(hwRevision)) {
    problems.push(`硬件修订 "${hwRevision}" 不在受控清单（A/B）内，须停在待确认`);
  }
  if (problems.length) {
    await logEvent(instanceId, 'CONTEXT_REJECTED', 'S02', { supplied: body, problems });
    throw Object.assign(new Error(problems.join('；')), { status: 422, problems });
  }
  await tx(async () => {
    await db.query(
      `UPDATE instances SET model=COALESCE($2, model), hw_revision=COALESCE($3, hw_revision), updated_at=now() WHERE id=$1`,
      [instanceId, model, hwRevision]);
    await logEvent(instanceId, 'CONTEXT_CONFIRMED', 'S02', { model, hw_revision: hwRevision });
  });
  return getInstanceDetail(instanceId);
}

// ---------- 逐步勾选 ----------
export async function completeStep(instanceId, stepKey, { completed_by, note } = {}) {
  // 校验在事务外：拒绝类事件（重复勾选/缺证据/跳步/未知条件）必须独立留痕，
  // 不允许随同一调用抛错而被回滚。
  const detail = await getInstanceDetail(instanceId);
  const step = detail.steps.find((s) => s.step_key === stepKey);
  if (!step) throw Object.assign(new Error('步骤不存在'), { status: 404 });

  let rejection = null;
  if (step.stored_state === 'completed') {
    rejection = { code: 'DUPLICATE_CHECK', event: 'DUPLICATE_CHECK_BLOCKED',
      payload: { completed_at: step.completed_at, completed_by: step.completed_by },
      extra: {}, message: `步骤 ${stepKey} 已完成，重复勾选被阻止（幂等，状态不变）` };
  } else if (step.applicability.status === 'unknown') {
    rejection = { code: 'UNKNOWN_CONDITION', event: 'CHECK_BLOCKED_UNKNOWN', payload: { reason: step.unknown_reason },
      extra: {}, message: `条件未确认：${step.unknown_reason}。请先在 S02 确认型号/硬件修订` };
  } else if (step.applicability.status === 'no') {
    rejection = { code: 'NOT_APPLICABLE', event: 'CHECK_BLOCKED_NOT_APPLICABLE', payload: {},
      extra: {}, message: `步骤 ${stepKey} 对本型号/修订不适用` };
  } else if (step.runtime_state === 'blocked') {
    rejection = { code: 'DEPS_UNMET', event: 'CHECK_BLOCKED_DEPS', payload: { blocked_by: step.blocked_by },
      extra: { blocked_by: step.blocked_by }, message: `前置步骤未完成：${step.blocked_by.join(', ')}` };
  } else if (step.evidence_required && step.evidence_count === 0) {
    rejection = { code: 'EVIDENCE_REQUIRED', event: 'CHECK_BLOCKED_EVIDENCE',
      payload: { has_pending_offline: step.evidence_pending }, extra: {},
      message: `步骤 ${stepKey} 含强制安全/扭矩警示，必须先上传已存储的证据照片` +
        (step.evidence_pending ? '（存在离线登记但尚未送达的照片，请等待照片上传）' : '') };
  } else if (step.has_open_review) {
    rejection = { code: 'OPEN_REVIEW', event: 'CHECK_BLOCKED_REVIEW', payload: {}, extra: {},
      message: `步骤 ${stepKey} 存在未关闭的图纸/资料复核项，须先复核` };
  }
  if (rejection) {
    await logEvent(instanceId, rejection.event, stepKey, rejection.payload);
    throw Object.assign(new Error(rejection.message), { status: 409, code: rejection.code, ...rejection.extra });
  }

  return tx(async () => {
    await db.query(
      `UPDATE instance_steps SET state='completed', completed_at=now(), completed_by=$3, note=$4, applicable=true
       WHERE instance_id=$1 AND step_key=$2 AND manual_version=(SELECT manual_version_id FROM instances WHERE id=$1)`,
      [instanceId, stepKey, completed_by || 'installer', note || null]);
    await logEvent(instanceId, 'STEP_COMPLETED', stepKey, { by: completed_by || 'installer' });

    const after = await getInstanceDetail(instanceId);
    if (after.progress.completed === after.progress.applicable && after.progress.applicable > 0
        && after.open_review_count === 0) {
      await db.query(`UPDATE instances SET status='completed', updated_at=now() WHERE id=$1 AND status<>'completed'`, [instanceId]);
      await logEvent(instanceId, 'INSTANCE_COMPLETED', null, {});
    } else if (after.instance.status === 'open') {
      await db.query(`UPDATE instances SET status='in_progress', updated_at=now() WHERE id=$1`, [instanceId]);
    }
    return getInstanceDetail(instanceId);
  });
}

// ---------- 证据：离线迟到照片 ----------
export async function registerOfflineEvidence(instanceId, { step_key, filename, captured_at, note }) {
  const detail = await getInstanceDetail(instanceId);
  if (!detail.steps.some((s) => s.step_key === step_key))
    throw Object.assign(new Error('步骤不存在'), { status: 404 });
  return tx(async () => {
    const r = await db.query(
      `INSERT INTO evidences (instance_id, step_key, manual_version, filename, content_type, captured_at, upload_state, note)
       VALUES ($1,$2,(SELECT manual_version_id FROM instances WHERE id=$1),$3,'application/octet-stream',$4,'pending_offline',$5)
       RETURNING *`,
      [instanceId, step_key, filename || `offline-${Date.now()}.jpg`, captured_at || new Date().toISOString(), note || '现场离线登记，照片待送达']);
    await logEvent(instanceId, 'EVIDENCE_PENDING_OFFLINE', step_key, { evidence_id: r.rows[0].id, captured_at });
    return r.rows[0];
  });
}

export async function uploadEvidence(instanceId, evidenceId, { buffer, filename, contentType }) {
  const ev = await one(`SELECT * FROM evidences WHERE id=$1 AND instance_id=$2`, [evidenceId, instanceId]);
  if (!ev) throw Object.assign(new Error('证据不存在'), { status: 404 });
  if (ev.upload_state === 'stored')
    throw Object.assign(new Error('该证据已有照片，禁止重复覆盖；请新建证据条目'), { status: 409, code: 'EVIDENCE_EXISTS' });

  const { putObject } = await import('../storage/objectstore.js');
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(buffer).digest('hex');
  const objectKey = `instances/${instanceId}/evidence/${ev.id}-${filename}`;
  const stored = await putObject(objectKey, buffer);

  return tx(async () => {
    await db.query(
      `INSERT INTO objects (object_key, manual_code, version_label, kind, content_type, sha256, size_bytes, storage_path)
       VALUES ($1,'INSTANCE',(SELECT version_label FROM manual_versions mv JOIN instances i ON i.manual_version_id=mv.id WHERE i.id=$2),
        'photo',$3,$4,$5,$6)
       ON CONFLICT (object_key) DO UPDATE SET sha256=EXCLUDED.sha256, size_bytes=EXCLUDED.size_bytes`,
      [objectKey, instanceId, contentType, sha, buffer.length, stored.absPath.replace(/^.*data\/objects\//, '')]);
    await db.query(
      `UPDATE evidences SET object_key=$1, upload_state='stored', filename=$2, content_type=$3, size_bytes=$4, sha256=$5 WHERE id=$6`,
      [objectKey, filename, contentType, buffer.length, sha, ev.id]);
    await logEvent(instanceId, 'EVIDENCE_LATE_UPLOADED', ev.step_key,
      { evidence_id: ev.id, captured_at: ev.captured_at, late: true });
    return one(`SELECT * FROM evidences WHERE id=$1`, [ev.id]);
  });
}

// ---------- 图纸/资料复核项生成 ----------
// 规则：某步骤在旧版本已完成，而新版本该步骤正文/条件/依赖/引用图纸发生变化 => 复核项。
async function createReviewForAffected(instanceId, oldVersionId, newVersionId, diff, scope = 'migration') {
  const doneRows = await many(
    `SELECT step_key FROM instance_steps WHERE instance_id=$1 AND manual_version=$2 AND state='completed'`,
    [instanceId, oldVersionId]);
  const done = new Set(doneRows.map((r) => r.step_key));
  const created = [];
  const affectedSteps = new Map(); // step_key -> reasons[]
  for (const d of diff.stepDiffs) {
    if (done.has(d.step_key)) {
      const fields = (d.fields || []).includes('drawing_key') ? ['STEP_DRAWING_REF', ...(d.fields || [])] : (d.fields || []);
      affectedSteps.set(d.step_key, [...(affectedSteps.get(d.step_key) || []),
        { reason: 'STEP_CONTENT_CHANGED', detail: `步骤内容字段变化：${fields.join('、')}（${scope}）` }]);
    }
  }
  for (const d of diff.drawingDiffs) {
    if (d.type !== 'DRAWING_REVISED') continue;
    // 找到旧版本中引用该图纸且已完成的步骤
    const refs = await many(
      `SELECT step_key FROM steps WHERE manual_version=$1 AND drawing_key=$2`, [oldVersionId, d.drawing_key]);
    for (const ref of refs) {
      if (done.has(ref.step_key)) {
        affectedSteps.set(ref.step_key, [...(affectedSteps.get(ref.step_key) || []),
          { reason: 'DRAWING_CHANGED', detail: `引用图纸 ${d.drawing_key} 已升级：${d.change_note || '有变更'}` }]);
      }
    }
  }
  for (const [stepKey, items] of affectedSteps) {
    for (const it of items) {
      const r = await db.query(
        `INSERT INTO review_items (instance_id, step_key, old_version, new_version, reason, detail)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [instanceId, stepKey, oldVersionId, newVersionId, it.reason, it.detail]);
      created.push(r.rows[0]);
    }
  }
  return created;
}

// ---------- 受控迁移 ----------
export async function previewMigration(instanceId, targetVersionId) {
  const inst = await one(`SELECT * FROM instances WHERE id=$1`, [instanceId]);
  if (!inst) throw Object.assign(new Error('实例不存在'), { status: 404 });
  if (inst.manual_version_id === Number(targetVersionId))
    throw Object.assign(new Error('目标版本与当前锁定版本相同'), { status: 409 });
  const oldRow = await getVersionRow(inst.manual_version_id);
  const newRow = await getVersionRow(Number(targetVersionId));
  if (newRow.status === 'withdrawn') throw Object.assign(new Error('目标版本已撤回，不能迁移'), { status: 409 });
  const oldDef = await loadVersionDef(oldRow);
  const newDef = await loadVersionDef(newRow);
  const diff = diffVersions(oldDef.resolved, newDef.resolved);

  const doneRows = await many(
    `SELECT step_key FROM instance_steps WHERE instance_id=$1 AND manual_version=$2 AND state='completed'`,
    [instanceId, oldRow.id]);
  const done = new Set(doneRows.map((r) => r.step_key));
  const affectedStepKeys = new Set();
  for (const d of diff.stepDiffs) if (done.has(d.step_key)) affectedStepKeys.add(d.step_key);
  for (const d of diff.drawingDiffs) {
    if (d.type !== 'DRAWING_REVISED') continue;
    const refs = await many(`SELECT step_key FROM steps WHERE manual_version=$1 AND drawing_key=$2`,
      [oldRow.id, d.drawing_key]);
    for (const r of refs) if (done.has(r.step_key)) affectedStepKeys.add(r.step_key);
  }

  return {
    from: { id: oldRow.id, label: oldRow.version_label },
    to: { id: newRow.id, label: newRow.version_label },
    diff,
    affected_completed_steps: [...affectedStepKeys],
    policy: [
      '迁移为受控操作：逐项确认差异后方可提交；',
      '受影响的已完成步骤不会平移完成态，将在新版本生成复核项并要求重新核实；',
      '未变化步骤保留完成态；旧版本证据全部保留（bind_state=retained_legacy），不删除、不覆盖；',
      '也可选择始终锁定旧手册继续作业（实例 manual_version_id 不变）。',
    ],
  };
}

export async function offerMigration(instanceId, targetVersionId) {
  const preview = await previewMigration(instanceId, targetVersionId);
  await tx(async () => {
    await db.query(
      `UPDATE instances SET migration_target_version=$2, migration_status='offered', updated_at=now() WHERE id=$1`,
      [instanceId, targetVersionId]);
    await logEvent(instanceId, 'MIGRATION_OFFERED', null, { target: targetVersionId,
      affected: preview.affected_completed_steps });
  });
  return preview;
}

// 差异确认：前端逐项回传 { step_key: 'confirmed', drawings: {key: 'confirmed'}, acknowledge_all }
export async function acknowledgeMigration(instanceId, body) {
  const inst = await one(`SELECT * FROM instances WHERE id=$1`, [instanceId]);
  if (!inst || inst.migration_status !== 'offered')
    throw Object.assign(new Error('没有待确认的迁移提议'), { status: 409 });
  const preview = await previewMigration(instanceId, inst.migration_target_version);
  const need = new Set(preview.affected_completed_steps);
  const ack = new Set(body.confirmed_steps || []);
  const missing = [...need].filter((k) => !ack.has(k));
  if (!body.acknowledge_all && missing.length) {
    throw Object.assign(new Error(`仍有差异项未确认：${missing.join(', ')}`),
      { status: 409, code: 'UNACK_DIFF', missing });
  }
  await tx(async () => {
    await db.query(`UPDATE instances SET migration_status='acknowledged', updated_at=now() WHERE id=$1`, [instanceId]);
    await logEvent(instanceId, 'MIGRATION_DIFF_ACKNOWLEDGED', null,
      { confirmed: body.acknowledge_all ? [...need] : body.confirmed_steps });
  });
  return getInstanceDetail(instanceId);
}

export async function cancelMigration(instanceId) {
  await tx(async () => {
    await db.query(
      `UPDATE instances SET migration_target_version=NULL, migration_status=NULL, updated_at=now() WHERE id=$1`, [instanceId]);
    await logEvent(instanceId, 'MIGRATION_CANCELED', null, {});
  });
  return getInstanceDetail(instanceId);
}

export async function commitMigration(instanceId) {
  return tx(async () => {
    const inst = await one(`SELECT * FROM instances WHERE id=$1`, [instanceId]);
    if (!inst) throw Object.assign(new Error('实例不存在'), { status: 404 });
    if (!['acknowledged', 'reviewed'].includes(inst.migration_status))
      throw Object.assign(new Error('迁移须先完成差异确认（acknowledged）'), { status: 409 });
    const oldId = inst.manual_version_id;
    const newId = inst.migration_target_version;
    const oldRow = await getVersionRow(oldId);
    const newRow = await getVersionRow(newId);
    const oldDef = await loadVersionDef(oldRow);
    const newDef = await loadVersionDef(newRow);
    const diff = diffVersions(oldDef.resolved, newDef.resolved);

    // 1) 复核项（图纸/内容影响已执行步骤）
    const reviews = await createReviewForAffected(instanceId, oldId, newId, diff, 'migration');
    const affectedKeys = new Set(reviews.map((r) => r.step_key));

    // 2) 旧证据保留
    await db.query(
      `UPDATE evidences SET bind_state='retained_legacy' WHERE instance_id=$1 AND manual_version=$2 AND bind_state='active'`,
      [instanceId, oldId]);

    // 3) 新版本步骤行：未受影响的已完成步骤保留完成态；受影响步骤回到 pending（等待 reverify）
    const oldRows = await many(`SELECT * FROM instance_steps WHERE instance_id=$1 AND manual_version=$2`, [instanceId, oldId]);
    const oldByKey = new Map(oldRows.map((r) => [r.step_key, r]));
    for (const s of newDef.steps) {
      const prior = oldByKey.get(s.step_key);
      const carry = prior && prior.state === 'completed' && !affectedKeys.has(s.step_key);
      await db.query(
        `INSERT INTO instance_steps (instance_id, manual_version, step_key, state, applicable, completed_at, completed_by, note)
         VALUES ($1,$2,$3,$4,true,$5,$6,$7)
         ON CONFLICT (instance_id, manual_version, step_key) DO NOTHING`,
        [instanceId, newId, s.step_key, carry ? 'completed' : 'pending',
         carry ? prior.completed_at : null, carry ? prior.completed_by : null,
         carry ? `迁移自 ${oldRow.version_label}，内容无变化，保留完成态` : null]);
    }

    // 4) 切换实例锁定版本（百分比由新步骤行重新计算，不平移）
    await db.query(
      `UPDATE instances SET manual_version_id=$2, migration_target_version=NULL, migration_status='committed',
                           status='in_progress', migrated_at=now(), updated_at=now() WHERE id=$1`,
      [instanceId, newId]);
    await logEvent(instanceId, 'MIGRATION_COMMITTED', null,
      { from: oldId, to: newId, review_items: reviews.length, affected: [...affectedKeys] });
    return getInstanceDetail(instanceId);
  });
}

// ---------- 复核项处理 ----------
export async function resolveReview(instanceId, reviewId, { action, note }) {
  const r = await one(`SELECT * FROM review_items WHERE id=$1 AND instance_id=$2`, [reviewId, instanceId]);
  if (!r) throw Object.assign(new Error('复核项不存在'), { status: 404 });
  if (!['acknowledge', 'waive', 'reverify'].includes(action))
    throw Object.assign(new Error('动作必须是 acknowledge / waive / reverify'), { status: 400 });
  const newStatus = action === 'waive' ? 'waived' : action === 'reverify' ? 'reverified' : 'acknowledged';
  await tx(async () => {
    await db.query(
      `UPDATE review_items SET status=$3, resolution_note=$4, resolved_at=CASE WHEN $3 IN ('reverified','waived') THEN now() ELSE resolved_at END WHERE id=$1`,
      [r.id, instanceId, newStatus, note || null]);
    await logEvent(instanceId, 'REVIEW_RESOLVED', r.step_key, { review_id: r.id, action, note: note || null });
  });
  return getInstanceDetail(instanceId);
}

// ---------- 图纸撤回（管理员；不强制迁移） ----------
export async function withdrawDrawing(drawingKey, reason) {
  return tx(async () => {
    const lineageRows = await many(
      `SELECT * FROM drawing_lineage WHERE drawing_key=$1 ORDER BY version_label`, [drawingKey]);
    if (!lineageRows.length) throw Object.assign(new Error('图纸不存在'), { status: 404 });
    const latest = lineageRows[lineageRows.length - 1];
    await db.query(`UPDATE drawing_lineage SET is_withdrawn=true WHERE id=$1`, [latest.id]);

    // 所有实例：任意版本（含迁移前旧版本）中已完成的步骤引用该图纸 => 生成复核项；
    // 实例不被强制迁移、不被强制升级，只产生必须处理的复核。
    const instRows = await many(
      `SELECT i.id AS instance_id, ist.manual_version AS ver_id, ist.step_key
       FROM instances i
       JOIN instance_steps ist ON ist.instance_id=i.id AND ist.state='completed'
       JOIN steps st ON st.manual_version=ist.manual_version AND st.step_key=ist.step_key
       WHERE st.drawing_key=$1`, [drawingKey]);
    let created = 0;
    for (const row of instRows) {
      const exists = await one(
        `SELECT id FROM review_items WHERE instance_id=$1 AND step_key=$2 AND reason='DRAWING_WITHDRAWN' AND status='open'`,
        [row.instance_id, row.step_key]);
      if (!exists) {
        await db.query(
          `INSERT INTO review_items (instance_id, step_key, old_version, new_version, reason, detail)
           VALUES ($1,$2,$3,$3,'DRAWING_WITHDRAWN',$4)`,
          [row.instance_id, row.step_key, row.ver_id,
            `图纸 ${drawingKey} 被撤回：${reason || '无'}。该步骤在资料版本 ${row.ver_id} 下曾执行完成；实例保持锁定当前手册版本，须按受控流程复核，旧证据保留。`]);
        await logEvent(row.instance_id, 'DRAWING_WITHDRAWN_ALERT', row.step_key, { drawing_key: drawingKey, reason });
        created++;
      }
    }
    return { drawing_key: drawingKey, withdrawn_object: latest.object_key, affected_instances: created };
  });
}

// ---------- 打印/导出（失败可重试） ----------
async function renderExport(instanceId) {
  const d = await getInstanceDetail(instanceId);
  const L = [];
  L.push(`# 硬件安装记录（导出）`);
  L.push('');
  L.push(`实例：${d.instance.instance_code} / ${d.instance.name}`);
  L.push(`状态：${d.instance.status}`);
  L.push(`本实例实际采用资料版本：${d.locked_version.label}（状态：${d.locked_version.status}）` +
    (d.locked_version.withdrawn_at ? `，该版本图纸曾撤回：${d.locked_version.withdraw_reason || ''}` : ''));
  L.push(`创建时间：${d.instance.created_at}`);
  L.push(`型号确认：${d.instance.model ?? '【未决：待确认】'}；硬件修订：${d.instance.hw_revision ?? '【未决：待确认】'}`);
  L.push('');
  L.push('## 步骤进度（按适用性与 DAG 实时计算，非平移百分比）');
  L.push(`完成 ${d.progress.completed}/${d.progress.applicable}（适用步骤）= ${d.progress.percent}%；未决/复核项见文末`);
  L.push('');
  for (const s of d.steps) {
    const app = s.applicability.status === 'yes' ? '适用' : s.applicability.status === 'no' ? '不适用' : '待确认';
    const mark = s.stored_state === 'completed' ? '[x]' : s.runtime_state === 'skipped' ? '[~]' : '[ ]';
    L.push(`- ${mark} ${s.step_key} ${s.title} [${app}] 状态=${s.stored_state}` +
      (s.evidence_count ? ` 证据×${s.evidence_count}` : '') +
      (s.has_open_review ? ' **【未决复核项】**' : ''));
    if (s.warnings.length) for (const w of s.warnings) L.push(`    - 警示(${w.severity}) ${w.code}: ${w.message}`);
  }
  L.push('');
  L.push('## 证据（旧证据保留标注）');
  for (const e of d.evidences) {
    L.push(`- ${e.step_key} ${e.filename} | 拍摄=${e.captured_at} | 上传=${e.uploaded_at} | ` +
      `上传状态=${e.upload_state} | 绑定=${e.bind_state === 'retained_legacy' ? '旧版证据-已保留' : e.bind_state}` +
      (e.object_key ? ` | 对象=${e.object_key}` : ' | 照片尚未送达'));
  }
  L.push('');
  L.push('## 复核项');
  if (!d.reviews.length) L.push('- 无');
  for (const r of d.reviews) L.push(`- [${r.status}] ${r.step_key} ${r.reason}: ${r.detail}`);
  L.push('');
  L.push('## 未决项（导出必须显式列出）');
  const pend = [];
  if (!d.instance.model) pend.push('型号未确认（停在 S02，禁止猜测）');
  if (!d.instance.hw_revision) pend.push('硬件修订未确认（停在 S02）');
  for (const u of d.pending.unknowns) pend.push(`步骤 ${u.step_key} 条件未知：${u.reason}`);
  for (const e of d.pending.offline_evidence) pend.push(`离线照片迟到未送达：${e.step_key} ${e.filename}`);
  for (const r of d.reviews) if (r.status === 'open' || r.status === 'acknowledged')
    pend.push(`复核项未关闭：${r.step_key} ${r.reason}`);
  if (d.migration) pend.push(`存在进行中的受控迁移（目标 ${d.migration.target?.version_label}，状态 ${d.migration.status}）`);
  L.push(pend.length ? pend.map((p) => `- ${p}`).join('\n') : '- 无未决项');
  L.push('');
  L.push(`> 数据来源：给定演示资料 HW-CTRLBOX；含【演示占位】的参数不得用于实际施工。`);
  return L.join('\n');
}

export async function createPrintJob(instanceId, { force_fail = false } = {}) {
  const inst = await one(`SELECT * FROM instances WHERE id=$1`, [instanceId]);
  if (!inst) throw Object.assign(new Error('实例不存在'), { status: 404 });
  return tx(async () => {
    const j = (await db.query(
      `INSERT INTO print_jobs (instance_id, job_type, state) VALUES ($1,'manual_export','queued') RETURNING *`,
      [instanceId])).rows[0];
    try {
      if (force_fail) throw new Error('模拟打印机离线/渲染失败（force_fail）');
      const md = await renderExport(instanceId);
      const { putObject } = await import('../storage/objectstore.js');
      const key = `instances/${instanceId}/exports/print-${j.id}.md`;
      const stored = await putObject(key, Buffer.from(md, 'utf8'));
      await db.query(
        `UPDATE print_jobs SET state='done', artifact_key=$2, attempts=attempts+1, finished_at=now() WHERE id=$1`,
        [j.id, key]);
      await logEvent(instanceId, 'PRINT_DONE', null, { job_id: j.id, artifact: key });
      return { job: await one(`SELECT * FROM print_jobs WHERE id=$1`, [j.id]), markdown: md };
    } catch (e) {
      await db.query(
        `UPDATE print_jobs SET state='failed', error_message=$2, attempts=attempts+1 WHERE id=$1`,
        [j.id, String(e.message || e)]);
      await logEvent(instanceId, 'PRINT_FAILED', null, { job_id: j.id, error: String(e.message || e) });
      return { job: await one(`SELECT * FROM print_jobs WHERE id=$1`, [j.id]), error: String(e.message || e) };
    }
  });
}

export async function retryPrintJob(instanceId, jobId) {
  const j = await one(`SELECT * FROM print_jobs WHERE id=$1 AND instance_id=$2`, [jobId, instanceId]);
  if (!j) throw Object.assign(new Error('打印任务不存在'), { status: 404 });
  if (j.state !== 'failed') throw Object.assign(new Error('仅失败任务可重试'), { status: 409 });
  return tx(async () => {
    try {
      const md = await renderExport(instanceId);
      const { putObject } = await import('../storage/objectstore.js');
      const key = `instances/${instanceId}/exports/print-${j.id}.md`;
      await putObject(key, Buffer.from(md, 'utf8'));
      await db.query(
        `UPDATE print_jobs SET state='done', error_message=NULL, artifact_key=$2, attempts=attempts+1, finished_at=now() WHERE id=$1`,
        [j.id, key]);
      await logEvent(instanceId, 'PRINT_RETRY_DONE', null, { job_id: j.id });
      return { job: await one(`SELECT * FROM print_jobs WHERE id=$1`, [j.id]), markdown: md };
    } catch (e) {
      await db.query(
        `UPDATE print_jobs SET state='failed', error_message=$2, attempts=attempts+1 WHERE id=$1`,
        [j.id, String(e.message || e)]);
      await logEvent(instanceId, 'PRINT_RETRY_FAILED', null, { job_id: j.id, error: String(e.message || e) });
      throw Object.assign(new Error('重试仍失败：' + (e.message || e)), { status: 500 });
    }
  });
}

export async function exportMarkdown(instanceId) {
  await one(`SELECT id FROM instances WHERE id=$1`, [instanceId]);
  return renderExport(instanceId);
}
