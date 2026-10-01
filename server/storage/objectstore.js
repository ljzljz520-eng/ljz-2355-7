// 对象存储：接口 put/get/stats，默认实现写本地磁盘（data/objects）。
// 生产可替换为 S3/MinIO 实现，保持相同接口；元数据（sha256/血缘）始终在 PG。
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
export const OBJECT_ROOT = process.env.OBJECT_ROOT || path.join(ROOT, 'data', 'objects');

function safeKey(key) {
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) throw Object.assign(new Error('非法对象键'), { status: 400 });
  const abs = path.resolve(OBJECT_ROOT, key);
  if (!abs.startsWith(path.resolve(OBJECT_ROOT))) throw Object.assign(new Error('对象键越界'), { status: 400 });
  return abs;
}

export async function putObject(key, buffer) {
  const abs = safeKey(key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return { key, absPath: abs, sha256, size: buffer.length };
}

export async function getObjectStream(key) {
  const abs = safeKey(key);
  await fs.access(abs);
  return { stream: createReadStream(abs), absPath: abs };
}

export async function objectExists(key) {
  try { await fs.access(safeKey(key)); return true; } catch { return false; }
}
