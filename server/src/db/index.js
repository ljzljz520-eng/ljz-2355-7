import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

// DATABASE_URL=postgres://... -> 使用真实 pg 驱动；否则本地 PGlite 持久化到 ./pgdata
const usePg = !!process.env.DATABASE_URL;
let client;

// ---- PGlite 串行执行器 ----
// PGlite 是单连接：所有作业（含整个事务体）必须严格串行。
// 用“链尾”原子替换保证每个作业都在其前驱完成后才启动，避免尾链竞态丢作业。
let tail = Promise.resolve();
function enqueue(job) {
  const run = tail.then(job, job);        // 前驱失败也不阻塞后继
  tail = run.catch(() => {});              // 保持链尾始终 resolved
  return run;
}

export async function initDb() {
  if (usePg) {
    client = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  } else {
    const dataDir = process.env.PGLITE_DIR || path.join(process.cwd(), 'pgdata');
    client = new PGlite(dataDir);
    await client.waitReady;
  }
  const schema = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  if (usePg) await client.query(schema);
  else await enqueue(() => client.exec(schema));
}

// 统一 query：{rows}
export function query(text, params = []) {
  if (usePg) return client.query(text, params);
  return enqueue(async () => {
    const r = await client.query(text, params);
    return { rows: r.rows };
  });
}

export async function one(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}
export async function many(text, params = []) {
  return (await query(text, params)).rows;
}

export function tx(fn) {
  if (usePg) {
    return (async () => {
      const c = await client.connect();
      try {
        await c.query('BEGIN');
        const q = async (t, p = []) => (await c.query(t, p)).rows;
        const ret = await fn(q);
        await c.query('COMMIT');
        return ret;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally { c.release(); }
    })();
  }
  // PGlite：整个事务（BEGIN…回调…COMMIT）作为一个串行作业，期间不被插队
  return enqueue(async () => {
    await client.query('BEGIN');
    try {
      const q = async (t, p = []) => (await client.query(t, p)).rows;
      const ret = await fn(q);
      await client.query('COMMIT');
      return ret;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  });
}
