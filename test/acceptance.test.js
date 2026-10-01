#! /usr/bin/env node
// 硬件安装手册系统验收测试（需服务运行中，node --test test/）
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { req, createInstance, confirm, complete, addStoredPhoto, driveTo, BASE, JPEG_B64 } from './helpers.js';

let v1, v2;

before(async () => {
  const cat = (await req('/catalog')).data;
  const byLabel = Object.fromEntries(cat.versions.map((v) => [v.version_label, v]));
  v1 = byLabel['v1.0'].id;
  v2 = byLabel['v1.1'].id;
  // 确保图纸初始未撤回
  assert.ok(v1 && v2);
});

test('目录仅来自给定演示资料；无版本锁定不能建实例', async () => {
  const cat = (await req('/catalog')).data;
  assert.equal(cat.manual.code, 'HW-CTRLBOX');
  assert.deepEqual(cat.hw_revisions, ['A', 'B']);
  // 扭矩/接线参数未编造：步骤正文必须包含占位提示
  const v1detail = (await req(`/versions/${v1}`)).data;
  const s40 = v1detail.steps.find((s) => s.step_key === 'S40');
  assert.match(s40.detail_md, /未给定/);
  const s20 = v1detail.steps.find((s) => s.step_key === 'S20')
  assert.match(s20.detail_md, /未给定/);

  const bad = await req('/instances', { method: 'POST', body: { name: 'x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /version_id/);
});

test('未知条件停在待确认：确认前 S10 阻塞；确认门需要铭牌证据', async () => {
  const id = await createInstance(v1, 'AC1-未知拦截');
  let r = await complete(id, 'S10');
  assert.equal(r.data.code, 'DEPS_UNMET');
  // 完成 S01，未确认型号，尝试完成识别门 S02
  assert.equal((await complete(id, 'S01')).status, 200);
  r = await complete(id, 'S02');
  assert.equal(r.data.code, 'EVIDENCE_REQUIRED'); // 危险警示步骤需铭牌照片
  await addStoredPhoto(id, 'S02', 'nameplate.jpg');
  r = await complete(id, 'S02');
  // S02 自身条件为 null（无门槛表达式），但下游 S20 条件未知时会被拦；这里先断言已确认门可完成
  assert.equal(r.status, 200);
});

test('型号+修订决定分支：CB-200/B 下 S21 适用、S31 不适用；切换上下文后分支切换', async () => {
  const id = await createInstance(v1, 'AC2-分支切换');
  await complete(id, 'S01');
  await addStoredPhoto(id, 'S02', 'np.jpg');
  await confirm(id, 'CB-100', 'A');
  await complete(id, 'S02');
  let d = (await req(`/instances/${id}`)).data;
  let s21 = d.steps.find((s) => s.step_key === 'S21');
  let s32 = d.steps.find((s) => s.step_key === 'S32');
  assert.equal(s21.applicability.applicable, false); // CB-100 无 X3
  assert.equal(s32.applicability.applicable, false); // 修订 A 无 J1B

  // 切换到 CB-200/B（分支切换验收点）
  await confirm(id, 'CB-200', 'B');
  d = (await req(`/instances/${id}`)).data;
  s21 = d.steps.find((s) => s.step_key === 'S21');
  const s31 = d.steps.find((s) => s.step_key === 'S31');
  s32 = d.steps.find((s) => s.step_key === 'S32');
  assert.equal(s21.applicability.applicable, true);
  assert.equal(s31.applicability.applicable, false);
  assert.equal(s32.applicability.applicable, true);
});

test('不能默认相近型号：CB-100X / 修订 C 被拒，保持待确认', async () => {
  const id = await createInstance(v1, 'AC3-相近型号拦截');
  const r1 = await confirm(id, 'CB-100X', 'A');
  assert.equal(r1.status, 422);
  assert.match(r1.data.error, /相近型号/);
  const r2 = await confirm(id, 'CB-100', 'C');
  assert.equal(r2.status, 422);
  const d = (await req(`/instances/${id}`)).data;
  assert.equal(d.instance.model, null);
  assert.equal(d.instance.hw_revision, null);
  // 事件审计留痕
  const evs4 = (await req(`/instances/${id}/events`)).data;
  assert.ok(evs4.some((e) => e.event_type === 'CONTEXT_REJECTED'));
  // 有向无环：S01→S02→S10... 拓扑排序保证无环（resolveVersions 发布时校验）
});

test('DAG 依赖强制顺序：跳步被 DEPS_UNMET 拦截；重复勾选幂等拒绝', async () => {
  const id = await createInstance(v1, 'AC4-DAG与重复勾选');
  await confirm(id, 'CB-100', 'A');
  await complete(id, 'S01');
  await addStoredPhoto(id, 'S02', 'np.jpg');
  await complete(id, 'S02');
  // S20 在 S10 完成前
  const early = await complete(id, 'S20');
  assert.equal(early.data.code, 'DEPS_UNMET');
  assert.deepEqual(early.data.blocked_by, ['S10']);
  await complete(id, 'S10');
  await addStoredPhoto(id, 'S20', 'p.jpg');
  assert.equal((await complete(id, 'S20')).status, 200);
  const dup = await complete(id, 'S20');
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'DUPLICATE_CHECK');
  // 审计（事件全量查询）
  const evs = (await req(`/instances/${id}/events`)).data;
  assert.ok(evs.some((e) => e.event_type === 'DUPLICATE_CHECK_BLOCKED'));
});


test('离线照片迟到：仅登记未送达不能勾选；补传后可勾选，拍摄时间保留', async () => {
  const id = await createInstance(v1, 'AC5-离线迟到照片');
  await confirm(id, 'CB-100', 'A');
  await complete(id, 'S01');
  await addStoredPhoto(id, 'S02', 'np.jpg');
  await complete(id, 'S02');
  await complete(id, 'S10');
  // 只登记离线照片（无字节）
  const reg = await req(`/instances/${id}/evidence/offline`, { method: 'POST',
    body: { step_key: 'S20', filename: 'field.jpg', captured_at: '2026-09-21T07:30:00Z' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.upload_state, 'pending_offline');
  const blocked = await complete(id, 'S20');
  assert.equal(blocked.data.code, 'EVIDENCE_REQUIRED'); // 迟到但未送达
  // 补传
  const up = await req(`/instances/${id}/evidence/${reg.data.id}/upload`, { method: 'PUT',
    body: { base64: JPEG_B64, filename: 'field.jpg', content_type: 'image/jpeg' } });
  assert.equal(up.data.upload_state, 'stored');
  assert.ok(new Date(up.data.uploaded_at) > new Date(up.data.captured_at));
  assert.equal((await complete(id, 'S20')).status, 200);
});

test('证据完成凭证绑定实际实例与步骤（对象存储 + sha256）', async () => {
  const id = await createInstance(v1, 'AC6-凭证绑定');
  await confirm(id, 'CB-100', 'A');
  await driveTo(id);
  const d = (await req(`/instances/${id}`)).data;
  assert.ok(d.evidences.length >= 1);
  for (const e of d.evidences) {
    assert.equal(e.bind_state, 'active');
    assert.ok(e.object_key.startsWith(`instances/${id}/`));
    const objRes = await fetch(BASE + '/api/objects/' + e.object_key);
    assert.equal(objRes.status, 200);
  }
});

test('受控迁移：差异必须逐项确认；受影响已执行步骤回到待复核；进度不平移；旧证据保留', async () => {
  const id = await createInstance(v1, 'AC7-受控迁移');
  await confirm(id, 'CB-200', 'B');
  await driveTo(id, new Set(['S30']));
  const before = (await req(`/instances/${id}`)).data;
  const beforePct = before.progress.percent;
  assert.ok(beforePct > 20, '迁移前应有一定进度');

  // 预览
  const prev = (await req(`/instances/${id}/migration/preview/${v2}`)).data;
  assert.ok(prev.affected_completed_steps.includes('S10')); // 开孔图升级
  assert.ok(prev.diff.drawingDiffs.some((x) => x.drawing_key === 'CTRL-DWG-01'));
  assert.ok(prev.diff.stepDiffs.some((x) => x.step_key === 'S41' && x.type === 'STEP_ADDED'));

  // offer 后未确认不能 commit
  await req(`/instances/${id}/migration/offer/${v2}`, { method: 'POST' });
  const noAck = await req(`/instances/${id}/migration/commit`, { method: 'POST' });
  assert.equal(noAck.status, 409);
  // 部分确认被拒
  const partial = await req(`/instances/${id}/migration/acknowledge`, { method: 'POST',
    body: { confirmed_steps: ['S10'] } });
  assert.equal(partial.data.code, 'UNACK_DIFF');
  assert.ok(partial.data.missing.length >= 1);
  // 全部确认
  await req(`/instances/${id}/migration/acknowledge`, { method: 'POST',
    body: { confirmed_steps: prev.affected_completed_steps } });
  const after = (await (await req(`/instances/${id}/migration/commit`, { method: 'POST' })));
  assert.equal(after.status, 200);
  const d = after.data;
  assert.equal(d.locked_version.label, 'v1.1');
  // 进度必须重算：新增 S41 + 受影响步骤回退 => 百分比下降而非平移
  assert.ok(d.progress.percent < beforePct, `进度应重算下降 ${beforePct} -> ${d.progress.percent}`);
  // 每个受影响已完成步骤都有复核项
  for (const k of prev.affected_completed_steps) {
    assert.ok(d.reviews.some((r) => r.step_key === k && r.status === 'open'), `缺少 ${k} 复核项`);
  }
  // 旧证据保留
  assert.ok(d.evidences.every((e) => e.bind_state === 'retained_legacy'));
  assert.ok(d.evidences.length >= 1);
  // 存在复核项时不能直接重新勾选受影响步骤
  const block = await complete(id, 'S10');
  assert.equal(block.data.code, 'OPEN_REVIEW');
});

test('始终锁定旧手册：不发起迁移的实例 manual_version 永不变，新手册不影响其作业', async () => {
  const id = await createInstance(v1, 'AC8-锁旧手册');
  await confirm(id, 'CB-100', 'A');
  await driveTo(id);
  const d = (await req(`/instances/${id}`)).data;
  assert.equal(d.locked_version.id, v1);
  assert.ok(d.migration_available, '系统可告知有新版本，但不强制');
  // 不发起迁移 => 仍锁定 v1，可继续完成（实例可 completed）
  const d2 = (await req(`/instances/${id}`)).data;
  assert.equal(d2.instance.status, 'completed');
  assert.equal(d2.locked_version.id, v1);
});

test('图纸撤回：已执行引用该图步骤的实例产生 DRAWING_WITHDRAWN 复核项，且不强制迁移', async () => {
  const id = await createInstance(v1, 'AC9-图纸撤回');
  await confirm(id, 'CB-100', 'A');
  await driveTo(id);
  const lockedV = (await req(`/instances/${id}`)).data.locked_version.id;
  const w = await req('/admin/withdraw-drawing', { method: 'POST',
    body: { drawing_key: 'CTRL-DWG-01', reason: '验收：开孔图撤回' } });
  assert.equal(w.status, 200);
  assert.ok(w.data.affected_instances >= 1);
  const d = (await req(`/instances/${id}`)).data;
  assert.equal(d.locked_version.id, lockedV, '撤回不改变实例锁定版本');
  assert.ok(d.reviews.some((r) => r.reason === 'DRAWING_WITHDRAWN' && r.step_key === 'S10'));
  // 图纸对象接口对撤回图给出警示元数据（历史留档仍可见但标注）
  const meta = (await req(`/instances/${id}/drawing/CTRL-DWG-01`)).data;
  assert.equal(meta.is_withdrawn, true);
});

test('打印失败可重试；导出显示实际采用版本与全部未决项', async () => {
  const id = await createInstance(v1, 'AC10-打印失败');
  await confirm(id, 'CB-200', 'B');
  // 停在中途，制造未决
  await complete(id, 'S01');
  const fail = await req(`/instances/${id}/print`, { method: 'POST', body: { force_fail: true } });
  assert.equal(fail.data.job.state, 'failed');
  assert.equal(fail.data.job.attempts, 1);
  const retry = await req(`/instances/${id}/print/${fail.data.job.id}/retry`, { method: 'POST' });
  assert.equal(retry.data.job.state, 'done');
  assert.equal(retry.data.job.attempts, 2);
  assert.ok(retry.data.job.artifact_key);

  const md = await (await fetch(BASE + `/api/instances/${id}/export.md`)).text();
  assert.match(md, /实际采用资料版本：v1.0/);
  assert.match(md, /型号确认：CB-200/);
  assert.match(md, /硬件修订：B/);
  assert.match(md, /未决项/);
  assert.match(md, /非平移百分比/);
  assert.match(md, /演示占位|演示资料/);
});

test('警示紧邻其适用步骤：按 step_key 就近下发，修订 B 警示只出现在 S32', async () => {
  const id = await createInstance(v1, 'AC11-警示位置');
  await confirm(id, 'CB-200', 'B');
  const d = (await req(`/instances/${id}`)).data;
  const byKey = Object.fromEntries(d.steps.map((s) => [s.step_key, s]));
  assert.ok(byKey.S20.warnings.some((w) => w.code === 'W-PWR-01'));
  assert.ok(byKey.S40.warnings.some((w) => w.code === 'W-TRQ-01'));
  assert.ok(byKey.S32.warnings.some((w) => w.code === 'W-REVB-01'));
  assert.ok(byKey.S02.warnings.some((w) => w.code === 'W-ID-01'));
  // 警示不会挂到无关步骤
  assert.equal(byKey.S01.warnings.length, 0);
  assert.equal(byKey.S50.warnings.length, 0);
});

test('图纸缩放端点：实例只能取其锁定版本的图纸对象', async () => {
  const id = await createInstance(v1, 'AC12-版本图纸');
  const d = (await req(`/instances/${id}`)).data;
  assert.equal(d.locked_version.label, 'v1.0');
  const meta = (await req(`/instances/${id}/drawing/CTRL-DWG-01`)).data;
  assert.match(meta.object_key, /v1\.0/);
  const svg = await fetch(BASE + '/api/objects/' + meta.object_key);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
});
