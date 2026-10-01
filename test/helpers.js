// 测试辅助：假设服务已在 BASE 运行；用真实 HTTP 调用做端到端验收。
export const BASE = process.env.BASE_URL || 'http://localhost:3000';

export async function req(path, opts = {}) {
  const res = await fetch(BASE + '/api' + path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

export const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAA' +
  'AAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

export async function createInstance(versionId, name) {
  const r = await req('/instances', { method: 'POST', body: { name, version_id: versionId } });
  if (r.status !== 201) throw new Error('createInstance failed: ' + JSON.stringify(r.data));
  return r.data.id;
}
export async function confirm(id, model, hw_revision) {
  return req(`/instances/${id}/context`, { method: 'POST', body: { model, hw_revision } });
}
export async function complete(id, key) {
  return req(`/instances/${id}/steps/${key}/complete`, { method: 'POST', body: {} });
}
export async function addStoredPhoto(id, step, filename, capturedAt) {
  const reg = await req(`/instances/${id}/evidence/offline`, { method: 'POST',
    body: { step_key: step, filename, captured_at: capturedAt || '2026-09-20T08:00:00Z' } });
  const evId = reg.data.id;
  const up = await req(`/instances/${id}/evidence/${evId}/upload`, { method: 'PUT',
    body: { base64: JPEG_B64, filename, content_type: 'image/jpeg' } });
  return { evId, upload: up };
}
export async function driveTo(id, stepsWithPhoto = new Set()) {
  // 按拓扑顺序完成一组步骤（含 S01/S02 前置与照片）
  const ordered = ['S01', 'S02', 'S10', 'S20', 'S21', 'S30', 'S31', 'S32', 'S40', 'S50', 'S60', 'S99'];
  for (const k of ordered) {
    const d = (await req(`/instances/${id}`)).data;
    const s = d.steps.find((x) => x.step_key === k);
    if (!s || s.applicability.status !== 'yes') continue;
    if (s.stored_state === 'completed') continue;
    if (s.evidence_required && s.evidence_count === 0) await addStoredPhoto(id, k, k + '.jpg');
    if (stepsWithPhoto.has(k)) await addStoredPhoto(id, k, k + '-extra.jpg');
    const r = await complete(id, k);
    if (r.status !== 200 && r.data.code !== 'DUPLICATE_CHECK') {
      // 不适用或仍 blocked 的步骤忽略（顺序中含分支步骤）
      if (!['DEPS_UNMET', 'NOT_APPLICABLE', 'UNKNOWN_CONDITION', 'EVIDENCE_REQUIRED', 'OPEN_REVIEW'].includes(r.data.code))
        throw new Error(`driveTo ${k} failed: ${JSON.stringify(r.data)}`);
    }
  }
}
