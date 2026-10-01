// 仅从给定演示资料（demo/manual.seed.json + data/objects/demo）装载。
// 幂等：重复执行不会产生重复数据。
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, one } from './pg.js';
import { resolveVersions } from '../domain/manual.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

export async function isSeeded() {
  const r = await one('SELECT count(*)::int AS n FROM manual_versions');
  return r.n > 0;
}

export async function seed() {
  if (await isSeeded()) return { skipped: true };
  const seedJson = JSON.parse(readFileSync(path.join(ROOT, 'demo', 'manual.seed.json'), 'utf8'));
  const versions = resolveVersions(seedJson);
  const idByLabel = new Map();

  for (const [label, v] of versions) {
    const r = await db.query(
      `INSERT INTO manual_versions (manual_code, version_label, status, published_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [seedJson.manual_code, label, v.status, v.published_at],
    );
    idByLabel.set(label, r.rows[0].id);
  }
  const active = [...versions.values()].find((x) => x.status === 'active');
  for (const [label, v] of versions) {
    if (v.status === 'superseded' && active) {
      await db.query('UPDATE manual_versions SET superseded_by=$1 WHERE id=$2',
        [idByLabel.get(active.label), idByLabel.get(label)]);
    }
  }

  for (const [label, v] of versions) {
    const mvId = idByLabel.get(label);
    for (const s of v.steps) {
      await db.query(
        `INSERT INTO steps (manual_version, step_key, title, detail_md, condition_expr, drawing_key, seq_no, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mvId, s.step_key, s.title, s.detail_md, s.condition, s.drawing_key, s.seq_no, s.kind]);
      for (const d of s.dependencies || []) {
        await db.query(
          `INSERT INTO step_dependencies (manual_version, step_key, depends_on_key)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [mvId, s.step_key, d]);
      }
    }
    for (const w of v.warnings) {
      await db.query(
        `INSERT INTO warnings (manual_version, step_key, code, message, severity, condition_expr)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [mvId, w.step_key, w.code, w.message, w.severity, w.condition]);
    }
    for (const d of v.drawings) {
      const filePath = path.join(ROOT, 'data', 'objects', 'demo', label, d.file);
      if (!existsSync(filePath)) throw new Error(`演示图纸缺失: ${filePath}`);
      const buf = readFileSync(filePath);
      const sha = createHash('sha256').update(buf).digest('hex');
      const objectKey = `demo/${label}/${d.file}`;
      await db.query(
        `INSERT INTO objects (object_key, manual_code, version_label, kind, content_type, sha256, size_bytes, storage_path)
         VALUES ($1,$2,$3,'drawing','image/svg+xml',$4,$5,$6)
         ON CONFLICT (object_key) DO UPDATE SET sha256=EXCLUDED.sha256, size_bytes=EXCLUDED.size_bytes`,
        [objectKey, seedJson.manual_code, label, sha, buf.length, path.relative(ROOT, filePath)]);
      await db.query(
        `INSERT INTO drawing_lineage (manual_code, drawing_key, version_label, object_key, change_note)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [seedJson.manual_code, d.drawing_key, label, objectKey, d.change_note]);
    }
  }
  return { skipped: false, versions: [...idByLabel.entries()] };
}
