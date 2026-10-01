import { Router } from 'express';
import { one, many } from '../db/pg.js';
import {
  listCatalog, getVersionDetail, listInstances, createInstance, getInstanceDetail,
  confirmContext, completeStep, registerOfflineEvidence, uploadEvidence,
  previewMigration, offerMigration, acknowledgeMigration, cancelMigration, commitMigration,
  resolveReview, withdrawDrawing, createPrintJob, retryPrintJob, exportMarkdown,
} from '../domain/service.js';
import { getObjectStream, objectExists } from '../storage/objectstore.js';

export const api = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 目录 / 手册版本 ----
api.get('/catalog', wrap(async (req, res) => res.json(await listCatalog())));
api.get('/versions/:id', wrap(async (req, res) => res.json(await getVersionDetail(Number(req.params.id)))));

// ---- 实例 ----
api.get('/instances', wrap(async (req, res) => res.json(await listInstances())));
api.post('/instances', wrap(async (req, res) => res.status(201).json(await createInstance(req.body || {}))));
api.get('/instances/:id', wrap(async (req, res) => res.json(await getInstanceDetail(Number(req.params.id)))));
api.post('/instances/:id/context', wrap(async (req, res) => res.json(await confirmContext(Number(req.params.id), req.body || {}))));

// ---- 逐步勾选 ----
api.post('/instances/:id/steps/:key/complete', wrap(async (req, res) =>
  res.json(await completeStep(Number(req.params.id), req.params.key, req.body || {}))));

// ---- 证据：离线登记 / 迟到上传 ----
api.post('/instances/:id/evidence/offline', wrap(async (req, res) =>
  res.status(201).json(await registerOfflineEvidence(Number(req.params.id), req.body || {}))));

api.put('/instances/:id/evidence/:evId/upload', wrap(async (req, res) => {
  // 简单的 JSON/base64 上传，避免引入 multer；前端用 FileReader
  const { base64, filename, content_type } = req.body || {};
  if (!base64) return res.status(400).json({ error: '缺少 base64 图片数据' });
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: '图片过大（>8MB）' });
  res.json(await uploadEvidence(Number(req.params.id), Number(req.params.evId),
    { buffer, filename: filename || 'photo.jpg', contentType: content_type || 'image/jpeg' }));
}));

api.get('/instances/:id/events', wrap(async (req, res) =>
  res.json(await many(`SELECT id, event_type, step_key, payload, created_at
                       FROM instance_events WHERE instance_id=$1 ORDER BY id`, [Number(req.params.id)]))));

// ---- 迁移 ----
api.get('/instances/:id/migration/preview/:targetId', wrap(async (req, res) =>
  res.json(await previewMigration(Number(req.params.id), Number(req.params.targetId)))));
api.post('/instances/:id/migration/offer/:targetId', wrap(async (req, res) =>
  res.json(await offerMigration(Number(req.params.id), Number(req.params.targetId)))));
api.post('/instances/:id/migration/acknowledge', wrap(async (req, res) =>
  res.json(await acknowledgeMigration(Number(req.params.id), req.body || {}))));
api.post('/instances/:id/migration/cancel', wrap(async (req, res) =>
  res.json(await cancelMigration(Number(req.params.id)))));
api.post('/instances/:id/migration/commit', wrap(async (req, res) =>
  res.json(await commitMigration(Number(req.params.id)))));

// ---- 复核 ----
api.post('/instances/:id/reviews/:rid/resolve', wrap(async (req, res) =>
  res.json(await resolveReview(Number(req.params.id), Number(req.params.rid), req.body || {}))));

// ---- 管理员：图纸撤回 ----
api.post('/admin/withdraw-drawing', wrap(async (req, res) =>
  res.json(await withdrawDrawing(req.body?.drawing_key, req.body?.reason))));

// ---- 打印 / 导出 ----
api.post('/instances/:id/print', wrap(async (req, res) =>
  res.json(await createPrintJob(Number(req.params.id), { force_fail: !!req.body?.force_fail }))));
api.post('/instances/:id/print/:jobId/retry', wrap(async (req, res) =>
  res.json(await retryPrintJob(Number(req.params.id), Number(req.params.jobId)))));
api.get('/instances/:id/export.md', wrap(async (req, res) => {
  const md = await exportMarkdown(Number(req.params.id));
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="instance-${req.params.id}-record.md"`);
  res.send(md);
}));

// ---- 对象库存图：按 object_key 取字节 ----
api.get('/objects/*', wrap(async (req, res) => {
  const key = req.params[0];
  if (!(await objectExists(key))) return res.status(404).json({ error: '对象不存在或已撤回' });
  const { stream } = await getObjectStream(key);
  const ct = key.endsWith('.svg') ? 'image/svg+xml' : key.endsWith('.jpg') || key.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  stream.pipe(res);
}));

// 取实例锁定版本下某 drawing_key 的当前 object_key（前端渲染图纸用）
api.get('/instances/:id/drawing/:drawingKey', wrap(async (req, res) => {
  // 实例看到的永远是其锁定版本的图纸对象；但撤回是按跨版本图纸键生效的：
  // 任何版本的该图纸被撤回 => 实例视图必须警示（历史图仍留档可调阅）。
  const row = await one(
    `SELECT dl.object_key,
            (dl.is_withdrawn OR EXISTS(
               SELECT 1 FROM drawing_lineage x
               WHERE x.manual_code=dl.manual_code AND x.drawing_key=dl.drawing_key AND x.is_withdrawn
             )) AS is_withdrawn,
            dl.change_note, o.sha256, o.version_label
     FROM instances i
     JOIN manual_versions mv ON mv.id=i.manual_version_id
     JOIN drawing_lineage dl ON dl.manual_code=mv.manual_code AND dl.version_label=mv.version_label
       AND dl.drawing_key=$2
     JOIN objects o ON o.object_key=dl.object_key
     WHERE i.id=$1`, [Number(req.params.id), req.params.drawingKey]);
  if (!row) return res.status(404).json({ error: '该实例版本中无此图纸' });
  res.json(row);
}));
