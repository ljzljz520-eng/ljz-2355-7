// 硬件安装手册系统前端（原生 JS）
const $ = (id) => document.getElementById(id);
const api = {
  async req(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.payload = data; err.status = res.status; throw err;
    }
    return data;
  },
  get: (p) => api.req(p),
  post: (p, body) => api.req(p, { method: 'POST', body }),
  put: (p, body) => api.req(p, { method: 'PUT', body }),
};

const state = {
  catalog: null, instances: [], currentInstanceId: null, detail: null,
  zoom: 1, selectedStepKey: null,
};

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast ' + kind;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 4200);
  t.classList.remove('hidden');
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function bootstrap() {
  state.catalog = await api.get('/catalog');
  renderVersionSelect();
  await loadInstances();
  bindEvents();
  const params = new URLSearchParams(location.search);
  if (params.get('instance')) await selectInstance(Number(params.get('instance')));
}

function renderVersionSelect() {
  $('versionSelect').innerHTML = state.catalog.versions.map((v) =>
    `<option value="${v.id}">${v.version_label}（${v.status === 'active' ? '当前激活' : v.status === 'superseded' ? '已被取代-仍可锁定' : '撤回'}，${v.published_at.slice(0, 10)}）</option>`).join('');
  const active = state.catalog.versions.find((v) => v.status === 'active');
  if (active) $('versionSelect').value = active.id;
  // 型号/修订选择
  $('modelSelect').innerHTML = '<option value="">— 待确认 —</option>' +
    state.catalog.models.map((m) => `<option value="${m.code}">${m.code} ${m.label}</option>`).join('');
  $('revSelect').innerHTML = '<option value="">— 待确认 —</option>' +
    state.catalog.hw_revisions.map((r) => `<option value="${r}">修订 ${r}</option>`).join('');
}

async function loadInstances(keepSelection = true) {
  state.instances = await api.get('/instances');
  $('instanceSelect').innerHTML = state.instances.length
    ? state.instances.map((i) => `<option value="${i.id}">${i.instance_code} · ${i.name} · 锁定${i.version_label} · ${i.status}</option>`).join('')
    : '<option value="">（暂无实例）</option>';
  if (state.currentInstanceId && keepSelection) {
    if (state.instances.some((i) => i.id === state.currentInstanceId)) $('instanceSelect').value = state.currentInstanceId;
  }
}

async function selectInstance(id) {
  if (!id) { state.currentInstanceId = null; return; }
  state.currentInstanceId = id;
  await refreshDetail();
}

async function refreshDetail() {
  if (!state.currentInstanceId) return;
  state.detail = await api.get('/instances/' + state.currentInstanceId);
  renderDetail();
}

function renderDetail() {
  const d = state.detail;
  $('contextBox').classList.remove('hidden');
  $('progressBox').classList.remove('hidden');
  $('actionPanel').classList.remove('hidden');
  $('reviewPanel').classList.remove('hidden');
  $('migrationPanel').classList.remove('hidden');

  // 顶栏锁定版本徽标
  const lv = d.locked_version;
  $('lockedBadge').classList.remove('hidden');
  $('lockedBadge').textContent = `本实例锁定资料：${lv.label}（${lv.status}）` +
    (lv.withdrawn_at ? ' · 含撤回' : '');
  $('drawingVersionTag').textContent = '查看的是 ' + lv.label + ' 的图纸';
  $('exportLink').href = '/api/instances/' + d.instance.id + '/export.md';

  $('modelSelect').value = d.instance.model || '';
  $('revSelect').value = d.instance.hw_revision || '';
  $('contextMsg').className = 'context-msg';
  if (!d.instance.model || !d.instance.hw_revision) {
    $('contextMsg').textContent = '⛔ 型号/硬件修订尚未确认：所有依赖条件的步骤停在“待确认”。';
    $('contextMsg').classList.add('err');
  } else {
    $('contextMsg').textContent = `已确认：${d.instance.model} / 修订 ${d.instance.hw_revision}`;
    $('contextMsg').classList.add('ok');
  }

  // 进度
  $('progressPct').textContent = `${d.progress.percent}%（${d.progress.completed}/${d.progress.applicable} 适用步骤）`;
  $('progressBar').style.width = d.progress.percent + '%';
  const pend = [];
  if (d.pending.unknowns.length) pend.push(`⛔ ${d.pending.unknowns.length} 个步骤条件待确认`);
  if (d.pending.offline_evidence.length) pend.push(`📷 ${d.pending.offline_evidence.length} 张离线照片迟到未送达`);
  if (d.open_review_count) pend.push(`🔁 ${d.open_review_count} 项图纸/资料复核未关闭`);
  if (d.migration) pend.push(`🔀 迁移进行中 → ${d.migration.target.version_label}（${d.migration.status}）`);
  $('pendingSummary').innerHTML = pend.length ? pend.map(esc).join('<br>') : '无未决项';

  renderSteps();
  renderReviews();
  renderMigration();
  if (state.selectedStepKey) renderActionPanel(state.selectedStepKey);
}

function renderSteps() {
  const d = state.detail;
  $('stepList').innerHTML = d.steps.map((s) => {
    const cls = s.stored_state === 'completed' ? 'completed'
      : s.applicability.status === 'unknown' ? 'unknown'
      : s.runtime_state === 'skipped' || s.applicability.applicable === false ? 'skipped'
      : s.runtime_state === 'ready' ? 'ready' : 'blocked';
    let badge;
    if (s.stored_state === 'completed') badge = '<span class="badge done">✔ 已完成</span>';
    else if (s.applicability.status === 'unknown') badge = '<span class="badge unknownb">⛔ 待确认</span>';
    else if (s.applicability.applicable === false) badge = '<span class="badge skipb">不适用</span>';
    else if (s.runtime_state === 'ready') badge = '<span class="badge readyb">可执行</span>';
    else badge = `<span class="badge blockedb">等待 ${s.blocked_by.join(', ')}</span>`;
    const warnings = s.warnings.map((w) =>
      `<span class="warning-chip ${w.severity}">⚠ ${w.severity.toUpperCase()} · ${esc(w.code)}：${esc(w.message)}</span>`).join('');
    const ev = [];
    if (s.evidence_required) ev.push(`<div class="evidence-line">📸 需证据（强制警示步骤）· 已存 ${s.evidence_count} 张${s.evidence_pending ? ' · <span class="ev-late">有离线照片尚未送达</span>' : ''}</div>`);
    if (s.has_open_review) ev.push(`<span class="review-flag">🔁 ${s.review_items.length} 项复核未关闭</span>`);
    const detail = state.selectedStepKey === s.step_key || s.runtime_state === 'ready' || s.applicability.status === 'unknown'
      ? `<div class="step-detail">${esc(s.detail_md)}</div>` : '';
    return `<div class="step-card ${cls}" data-step="${s.step_key}">
      <div class="step-head">
        <span class="step-key">${s.step_key}</span>
        <span class="step-kind ${s.kind}">${s.kind === 'decision' ? '判定门' : '作业'}</span>
        <span class="step-title">${esc(s.title)}</span>
        ${badge}
      </div>
      ${detail}
      <div class="step-meta">
        依赖：${s.dependencies.length ? s.dependencies.map((x) => `<code class="k">${x}</code>`).join(' ') : '（无）'}
        ${s.drawing_key ? ` · 图纸 <code class="k">${s.drawing_key}</code> <button data-act="drawing" data-key="${s.drawing_key}">查看图纸</button>` : ''}
        <button data-act="focus" data-key="${s.step_key}">详情/证据/勾选</button>
      </div>
      ${warnings}
      ${ev.join('')}
    </div>`;
  }).join('');
}

function renderActionPanel(stepKey) {
  state.selectedStepKey = stepKey;
  const s = state.detail.steps.find((x) => x.step_key === stepKey);
  $('actionStepTitle').textContent = `${s.step_key} · ${s.title}`;
  const evs = state.detail.evidences.filter((e) => e.step_key === stepKey);
  const canCheck = s.stored_state !== 'completed' && s.applicability.status === 'yes' && s.runtime_state === 'ready' && !s.has_open_review;
  let blockReason = '';
  if (s.stored_state === 'completed') blockReason = '该步骤已完成（重复勾选会被后端幂等阻止并记录审计）。';
  else if (s.applicability.status === 'unknown') blockReason = `⛔ 条件待确认：${esc(s.unknown_reason || '型号/修订未知')}，停在 S02。`;
  else if (s.applicability.applicable === false) blockReason = '该步骤对当前型号/硬件修订不适用。';
  else if (s.runtime_state === 'blocked') blockReason = `等待前置：${s.blocked_by.join(', ')}`;
  else if (s.has_open_review) blockReason = '存在未关闭复核项，须先复核图纸/资料。';
  else if (s.evidence_required && s.evidence_count === 0) blockReason = '需要已存储的证据照片（离线登记但未送达不算）。';

  $('actionBody').innerHTML = `
    <div class="step-detail">${esc(s.detail_md)}</div>
    ${s.drawing_key ? `<button data-act="drawing" data-key="${s.drawing_key}">在右侧查看图纸 ${s.drawing_key}</button>` : ''}
    <div class="section-label">证据（绑定本实例）</div>
    ${evs.length ? evs.map((e) => `
      <div class="evidence-line">
        ${e.object_key ? `<img class="ev-thumb" src="/api/objects/${e.object_key}" alt="">` : '📷'}
        ${esc(e.filename)} · 拍摄 ${e.captured_at ? new Date(e.captured_at).toLocaleString() : '—'} ·
        上传 ${new Date(e.uploaded_at).toLocaleString()} ·
        ${e.upload_state === 'stored' ? '已存储' : '<span class="ev-late">离线登记·照片迟到未送达</span>'} ·
        ${e.bind_state === 'retained_legacy' ? '<b>旧版证据-保留</b>' : '当前版'}
      </div>`).join('') : '<div class="hint">无证据</div>'}
    <div class="row" style="margin-top:8px">
      <button data-act="offline">登记离线照片（现场无网）</button>
      <label class="hint">照片文件（迟到补传）：<input type="file" id="evFile" accept="image/*"></label>
      <button data-act="upload" ${evs.some((e) => e.upload_state === 'pending_offline') ? '' : 'disabled'}>上传送达选中照片</button>
    </div>
    <div class="section-label">完成勾选</div>
    ${blockReason ? `<div class="hint" style="color:#b45309">${blockReason}</div>` : ''}
    <button class="primary" data-act="complete" ${canCheck ? '' : 'disabled'}>✔ 勾选完成（完成凭证绑定本实例）</button>
    <div id="actionMsg" class="context-msg"></div>`;
  renderSteps();
}

async function uploadEvidenceFile(stepKey, file, evidenceId) {
  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);
    fr.onerror = reject; fr.readAsDataURL(file);
  });
  return api.put(`/instances/${state.currentInstanceId}/evidence/${evidenceId}/upload`,
    { base64: b64, filename: file.name, content_type: file.type });
}

function renderReviews() {
  const d = state.detail;
  const open = d.reviews.filter((r) => r.status !== 'waived');
  if (!open.length) { $('reviewPanel').classList.add('hidden'); return; }
  $('reviewPanel').classList.remove('hidden');
  $('reviewList').innerHTML = open.map((r) => `
    <div class="step-card ${r.status === 'open' ? 'unknown' : 'ready'}">
      <div><b>${r.step_key}</b> · ${r.reason === 'DRAWING_WITHDRAWN' ? '⚠ 图纸撤回' : '🔁 图纸升级'} · 状态 ${r.status}</div>
      <div class="step-detail">${esc(r.detail)}</div>
      <div class="row">
        <button data-review="${r.id}" data-action="acknowledge">已知悉差异</button>
        <button data-review="${r.id}" data-action="reverify">已按新资料重新核实</button>
        <button data-review="${r.id}" data-action="waive">书面豁免</button>
      </div>
      ${r.resolution_note ? `<div class="hint">处理说明：${esc(r.resolution_note)}</div>` : ''}
    </div>`).join('');
}

async function renderMigration() {
  const d = state.detail;
  const body = $('migrationBody');
  const policy = `<div class="hint">两种策略并存：<b>始终锁定旧手册</b>（什么都不做即可，实例继续使用 ${d.locked_version.label}）
    或 <b>受控迁移</b>（逐项确认差异 → 提交后受影响步骤产生复核项，不平移进度，旧证据保留）。</div>`;
  if (d.migration) {
    const m = d.migration;
    body.innerHTML = policy + `
      <div>迁移目标：<b>${m.target.version_label}</b> · 状态：<b>${m.status}</b></div>
      ${m.status === 'offered' ? `
        <div class="hint">请逐项阅读下方差异并勾选，全部确认后才能提交：</div>
        <div id="migDiffs"></div>
        <div class="row">
          <button class="primary" id="migAckBtn">逐项确认差异</button>
          <button id="migCommitBtn" disabled>提交迁移</button>
          <button class="danger" id="migCancelBtn">取消，继续锁定旧手册</button>
        </div>` : ''}
      ${m.status === 'acknowledged' ? `<div class="row">
        <button class="primary" id="migCommitBtn">提交迁移（重算进度+生成复核项）</button>
        <button class="danger" id="migCancelBtn">取消迁移</button></div>` : ''}
      ${m.status === 'committed' ? '<div class="hint ok">迁移已提交，正在处理复核项。</div>' : ''}`;
    if (m.status === 'offered') await renderMigrationDiffs();
  } else if (d.migration_available) {
    body.innerHTML = policy + `
      <div class="row"><button class="primary" id="offerMigBtn">发起向 ${d.migration_available.target_label} 的受控迁移（预览差异）</button></div>
      <div class="hint">不点击即表示本实例始终锁定 ${d.locked_version.label}。</div>`;
  } else {
    body.innerHTML = policy + '<div class="hint">当前没有可用的迁移（已是最新或无更新版本）。</div>';
  }
}

async function renderMigrationDiffs() {
  const d = state.detail;
  const preview = await api.get(`/instances/${d.instance.id}/migration/preview/${d.migration.target_version_id}`);
  const affected = preview.affected_completed_steps;
  const stepLis = preview.diff.stepDiffs.map((x) => {
    const mark = affected.includes(x.step_key) ? '（影响你已执行的步骤）' : '';
    return `<li>${x.type === 'STEP_ADDED' ? '新增步骤' : x.type === 'STEP_REMOVED' ? '删除步骤' : '步骤变化'}
      <code class="k">${x.step_key}</code>${mark}${x.fields ? '：' + x.fields.join('、') : ''}</li>`;
  }).join('');
  const drawLis = preview.diff.drawingDiffs.map((x) =>
    `<li>${x.type === 'DRAWING_REVISED' ? '图纸升级' : x.type} <code class="k">${x.drawing_key}</code>${x.change_note ? '：' + esc(x.change_note) : ''}</li>`).join('');
  $('migDiffs').innerHTML = `<ul class="mig-diff">${stepLis}${drawLis}</ul>
    <div class="hint">受影响的已完成步骤（将要求复核，不平移完成态）：<b>${affected.join(', ') || '无'}</b></div>`;
}

function bindEvents() {
  $('createInstanceBtn').onclick = async () => {
    try {
      const inst = await api.post('/instances', { name: $('newInstanceName').value || '现场安装实例', version_id: Number($('versionSelect').value) });
      toast('实例已创建，PG 锁定资料版本', 'ok');
      await loadInstances(false);
      $('instanceSelect').value = inst.id;
      await selectInstance(inst.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('instanceSelect').onchange = (e) => selectInstance(Number(e.target.value));
  $('refreshBtn').onclick = refreshDetail;
  $('confirmContextBtn').onclick = async () => {
    try {
      await api.post(`/instances/${state.currentInstanceId}/context`,
        { model: $('modelSelect').value || null, hw_revision: $('revSelect').value || null });
      await refreshDetail(); toast('型号/修订已确认', 'ok');
    } catch (e) {
      await refreshDetail();
      toast(e.message, 'err');
    }
  };

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const id = state.currentInstanceId;
    if (!id) return;
    try {
      if (btn.dataset.act === 'drawing') { await showDrawing(btn.dataset.key); }
      if (btn.dataset.act === 'focus') { renderActionPanel(btn.dataset.key); }
      if (btn.dataset.act === 'offline') {
        const fn = prompt('离线登记：输入现场照片文件名（照片之后再补传）', 'site-photo.jpg');
        if (fn) {
          await api.post(`/instances/${id}/evidence/offline`, { step_key: state.selectedStepKey, filename: fn, captured_at: new Date().toISOString() });
          await refreshDetail(); renderActionPanel(state.selectedStepKey);
          toast('已登记离线照片：完成勾选仍需照片真正送达', '');
        }
      }
      if (btn.dataset.act === 'upload') {
        const file = $('evFile').files[0];
        const pending = state.detail.evidences.find((e) => e.step_key === state.selectedStepKey && e.upload_state === 'pending_offline');
        if (!file || !pending) return toast('请选择要送达的文件，且该步骤需存在离线登记', 'err');
        await uploadEvidenceFile(state.selectedStepKey, file, pending.id);
        await refreshDetail(); renderActionPanel(state.selectedStepKey);
        toast('迟到照片已上传并绑定（captured_at 保留现场时间）', 'ok');
      }
      if (btn.dataset.act === 'complete') {
        await api.post(`/instances/${id}/steps/${state.selectedStepKey}/complete`, { completed_by: '现场安装员' });
        await refreshDetail();
        toast(`步骤 ${state.selectedStepKey} 已完成并绑定本实例`, 'ok');
      }
      if (btn.dataset.review) {
        const note = prompt(`复核处理说明（${btn.dataset.action}）`, '已对照新资料复核') || '';
        await api.post(`/instances/${id}/reviews/${btn.dataset.review}/resolve`, { action: btn.dataset.action, note });
        await refreshDetail(); toast('复核项已处理', 'ok');
      }
      if (btn.id === 'offerMigBtn') {
        const target = state.detail.migration_available.target_version_id;
        await api.post(`/instances/${id}/migration/offer/${target}`, {});
        await refreshDetail(); toast('已生成迁移差异，请逐项确认', '');
      }
      if (btn.id === 'migAckBtn') {
        // 逐项确认：前端把受影响步骤全部回传确认
        const preview = await api.get(`/instances/${id}/migration/preview/${state.detail.migration.target_version_id}`);
        await api.post(`/instances/${id}/migration/acknowledge`, { confirmed_steps: preview.affected_completed_steps });
        await refreshDetail(); toast('差异已逐项确认，可以提交迁移', 'ok');
      }
      if (btn.id === 'migCommitBtn') {
        await api.post(`/instances/${id}/migration/commit`, {});
        await loadInstances(); await refreshDetail();
        toast('迁移完成：受影响步骤已生成复核项，进度已重算（非平移）', 'ok');
      }
      if (btn.id === 'migCancelBtn') {
        await api.post(`/instances/${id}/migration/cancel`, {});
        await refreshDetail(); toast('已取消迁移，实例继续锁定旧手册', '');
      }
      if (btn.id === 'withdrawBtn') {
        const r = await api.post('/admin/withdraw-drawing', { drawing_key: $('withdrawKey').value, reason: '演示：现场勘误撤回' });
        await refreshDetail();
        toast(`图纸已撤回；${r.affected_instances} 个实例的已执行步骤生成复核项`, 'err');
      }
      if (btn.id === 'printBtn') await doPrint(false);
      if (btn.id === 'printFailBtn') await doPrint(true);
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  // 图纸缩放
  $('zoomInBtn').onclick = () => setZoom(state.zoom * 1.2);
  $('zoomOutBtn').onclick = () => setZoom(state.zoom / 1.2);
  $('zoomResetBtn').onclick = () => setZoom(1);
  $('drawingViewport').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });
}

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(0.3, z));
  $('drawingScaler').style.transform = `scale(${state.zoom})`;
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
}

async function showDrawing(drawingKey) {
  try {
    const meta = await api.get(`/instances/${state.currentInstanceId}/drawing/${drawingKey}`);
    $('drawingImg').src = '/api/objects/' + meta.object_key + '?t=' + Date.now();
    const withdrawn = !!meta.is_withdrawn;
    $('drawingWithdrawn').classList.toggle('hidden', !withdrawn);
    $('drawingHint').textContent = withdrawn
      ? `⚠ ${drawingKey} 已在资料 ${meta.version_label} 中撤回；下方为历史留档图，不能作为施工依据，相关已执行步骤已有复核项。`
      : `${drawingKey}（实例锁定版本的受控图纸，sha256 前缀 ${meta.sha256.slice(0, 12)}…）`;
  } catch (e) { toast(e.message, 'err'); }
}

async function doPrint(forceFail) {
  const id = state.currentInstanceId;
  const r = await api.post(`/instances/${id}/print`, { force_fail: forceFail });
  const ps = $('printStatus');
  if (r.job.state === 'failed') {
    ps.className = 'print-status failed';
    ps.innerHTML = `❌ 打印失败（第 ${r.job.attempts} 次）：${esc(r.job.error_message)}
      <button id="retryPrintBtn" data-job="${r.job.id}">重试打印</button>`;
  } else {
    ps.className = 'print-status done';
    ps.textContent = `✔ 打印/导出成功（第 ${r.job.attempts} 次尝试）：${r.job.artifact_key}`;
  }
}
$('printStatus')?.addEventListener?.('click', async (e) => {
  const b = e.target.closest('#retryPrintBtn');
  if (!b) return;
  try {
    const r = await api.post(`/instances/${state.currentInstanceId}/print/${b.dataset.job}/retry`, {});
    const ps = $('printStatus'); ps.className = 'print-status done';
    ps.textContent = `✔ 重试成功（共 ${r.job.attempts} 次尝试）：${r.job.artifact_key}`;
  } catch (err) { toast(err.message, 'err'); }
});

bootstrap().catch((e) => toast('初始化失败：' + e.message, 'err'));
