// 对象存储抽象：演示用本地文件“对象桶”，键不可变、按 sha256 去重。
// 生产可替换为 S3（putObject/getObject，key 与 sha 不变）。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.env.OBJECT_STORE_DIR || path.join(process.cwd(), '..', 'storage');
const ensure = mkdir(ROOT, { recursive: true });

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

export async function putObject(key, buf, mediaType = 'application/octet-stream') {
  await ensure;
  const full = path.join(ROOT, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf);
  return { key, sha: sha256(buf), mediaType, size: buf.length };
}


export async function getObject(key) {
  await ensure;
  const buf = await readFile(path.join(ROOT, key));
  return { buf, sha: sha256(buf) };
}

export function objectUrl(key) { return '/api/objects/' + encodeURIComponent(key); }
