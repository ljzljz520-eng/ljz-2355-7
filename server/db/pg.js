// PostgreSQL 访问层。
// 本环境没有可用的 PG 服务端（无 sudo/docker），使用 PGlite（WASM 版真实 PostgreSQL，
// 持久化到 ./data/pgdata）。SQL 方言为标准 PostgreSQL；如环境提供外部 PG，
// 仅需将本文件替换为 `pg` Pool 连接，schema.sql 无需改动。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGDATA_DIR || path.join(__dirname, '..', '..', 'data', 'pgdata');

export const db = new PGlite(DATA_DIR);

export async function initSchema() {
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(sql);
}

// 小工具：query + queryOptional
export async function one(text, params = []) {
  const res = await db.query(text, params);
  return res.rows[0] || null;
}
export async function many(text, params = []) {
  return (await db.query(text, params)).rows;
}
let txDepth = 0;
export async function tx(fn) {
  // PGlite 单连接：外层 BEGIN，内层用 SAVEPOINT 支持嵌套事务
  const depth = ++txDepth;
  const sp = `sp_${depth}`;
  if (depth === 1) await db.query('BEGIN');
  else await db.query(`SAVEPOINT ${sp}`);
  try {
    const r = await fn();
    if (depth === 1) await db.query('COMMIT');
    // 内层 savepoint 随外层提交即可
    return r;
  } catch (e) {
    if (depth === 1) await db.query('ROLLBACK');
    else await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    throw e;
  } finally {
    txDepth--;
  }
}
