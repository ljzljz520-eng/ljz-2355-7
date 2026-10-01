/* 硬件安装手册 —— 前端（无构建，原生 JS） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let state = { role: 'installer', catalog: null, instances: [], currentId: null, current: null, zoom: 1, printerOffline: false, migration: null };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'X-Actor-Role': state.role,
      ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.capturedAt ? { 'X-Captured-At': opts.capturedAt } : {}),
    },
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { status: res.status, data });
  return data;
}
const toast = (msg, kind = '') => {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '';

// ---------- 视图切换 ----------
$$('.navbtn').forEach(b => b.onclick = () => {
  $$('.navbtn').forEach(x => x.classList.toggle('active', x === b));
  $('#view-installer').hidden = b.dataset.view !== 'installer';
  $('#view-admin').hidden = b.dataset.view !== 'admin';
  if (b.dataset.view === 'admin') renderAdmin();
});
$('#role').onchange = e => { state.role = e.target.value; toast('角色切换为：' + (state.role === 'admin' ? '管理员' : '安装人员')); };
$('#printerToggle').onclick = () => {
  state.printerOffline = !state.printerOffline;
  $('#printerToggle').textContent = '打印机：' + (state.printerOffline ? '离线（模拟故障）' : '在线');
};

// ---------- 目录 ----------
async function loadCatalog() {
  state.catalog = await api('/catalog');
  fillModelSelect();
  renderAdminStatic();
}
function fillModelSelect() {
  const sel = $('#newModel');
  sel.innerHTML = state.catalog.models.map(m => `<option value="${esc(m.code)}">${esc(m.code)} — ${esc(m.name)}</option>`).join('');
  fillRevSelect();
}
$('#newModel').onchange = fillRevSelect;
$('#newRev').onchange = fillVerSelect;
function fillRevSelect() {
  const m = state.catalog.models.find(x => x.code === $('#newModel').value);
  $('#newRev').innerHTML = (m?.hw_revs || []).map(h => `<option value="${esc(h.rev)}">Rev ${esc(h.rev)}${h.note ? '（' + esc(h.note) + '）' : ''}</option>`).join('');
  fillVerSelect();
}
function fillVerSelect() {
  const code = $('#newModel').value, rev = $('#newRev').value;
  const vs = state.catalog.versions.filter(v => v.model_code === code && v.hw_rev === rev);
  $('#newVer').innerHTML = vs.map(v => `<option value="${v.id}" ${vs.indexOf(v) === vs.length-1 ? '' : ''}>v${esc(v.version)} — ${esc(v.change_note)}</option>`).join('');
}

// ---------- 实例列表 ----------
$('#newInstance').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const inst = await api('/instances', { method: 'POST', body: {
      label: f.get('label'), model_code: f.get('model_code'), hw_rev: f.get('hw_rev'),
      migration_policy: f.get('migration_policy'),
      version_id: f.get('version_id') || null,
    } });
    state.currentId = inst.instance.id;
    await refreshInstanceList();
    await loadInstance();
    toast('已创建并钉住手册版本 ' + inst.instance.manual_version, 'ok');
  } catch (err) { toast(err.message, 'err'); }
};

async function refreshInstanceList() {
  state.instances = await api('/instances');
  $('#instanceList').innerHTML = state.instances.map(i => `
    <li data-id="${i.id}" class="${i.id === state.currentId ? 'active' : ''}">
      <div><b>${esc(i.label)}</b></div>
      <div class="meta">${esc(i.model_code)} / Rev ${esc(i.hw_rev)} · 手册 v${esc(i.manual_version)}
        ${i.open_reviews > 0 ? `<span style="color:var(--red)">· ${i.open_reviews} 复核</span>` : ''}</div>
      <div class="meta">状态：${statusText(i.status)}</div>
    </li>`).join('') || '<li class="hint">暂无实例</li>';
  $$('#instanceList li[data-id]').forEach(li => li.onclick = async () => {
    state.currentId = li.dataset.id; state.migration = null;
    await Promise.all([refreshInstanceList(), loadInstance()]);
  });
}
function statusText(s) {
  return { collecting: '条件采集中', ready: '就绪', in_progress: '进行中', blocked: '阻塞/待确认', complete: '可定稿', finalized: '已定稿' }[s] || s;
}

// ---------- 实例主面板 ----------
async function loadInstance() {
  if (!state.currentId) return;
  state.current = await api('/instances/' + state.currentId);
  renderInstance();
}
function renderInstance() {
  const p = state.current; if (!p) return;
  const i = p.instance;
  $('#instancePanel').innerHTML = `
    <div class="inst-head">
      <h2>${esc(i.label)}
        <button class="mini" id="btnExport">⬇ 导出安装记录</button>
        <button class="mini" id="btnPrint">🖨 打印勾选单</button>
        <button class="mini" id="btnFinalize" ${p.can_finalize ? '' : 'disabled'}>定稿</button>
      </h2>
      <div class="badges">
        <span class="badge">${esc(i.model_code)}</span>
        <span class="badge">硬件修订 Rev ${esc(i.hw_rev)}</span>
        <span class="badge">实际采用手册 <b>v${esc(i.manual_version)}</b>（实例钉住）</span>
        <span class="badge ${i.migration_policy}">${i.migration_policy === 'lock' ? '🔒 锁定旧手册' : '↪ 允许受控迁移'}</span>
        <span class="badge ${i.status === 'blocked' ? 'blocked' : i.status === 'complete' || i.status === 'finalized' ? 'done' : 'pending'}">${statusText(i.status)}</span>
      </div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${p.progress.pct ?? 0}%"></div></div>
      <div class="progress-note">适用步骤完成 ${p.progress.done}/${p.progress.applicable}（${p.progress.pct ?? 0}%）
        ${p.progress.unknown > 0 ? `· <b style="color:var(--amber)">${p.progress.unknown} 个步骤因条件未知停在待确认（不计入分母，不做百分比平移）</b>` : ''}</div>
      <div class="row" style="margin-top:8px">
        <button id="btnPolicy" class="mini">切换策略：${i.migration_policy === 'lock' ? '改为允许受控迁移' : '改为始终锁定旧手册'}</button>
        <button id="btnBranch" class="mini">🔀 分支切换（型号 / 硬件修订）</button>
      </div>
    </div>

    <div class="grid2">
      <div>
        ${reviewsHtml(p)}
        ${migrationHtml(p)}
        <div class="panel" style="margin-bottom:14px">
          <h3>① 分支条件确认（未知须停在待确认，禁止猜选相近型号）</h3>
          ${p.conditions.map(c => `
            <div class="cond-row">
              <label>${esc(c.label)} <span class="hint">[${esc(c.key)}]</span></label>
              ${conditionInput(c)}
              <span class="state ${c.answered ? 'answered' : 'pending'}">${c.answered ? '已确认' : '待确认'}</span>
            </div>`).join('')}
        </div>
        <div class="panel">
          <h3>② 逐步勾选（依赖为 DAG；警示紧邻适用步骤）</h3>
          <div class="steps">${p.steps.map(stepHtml).join('')}</div>
        </div>
      </div>
      <div>
        <div class="panel" style="margin-bottom:14px"><h3>完成凭证（绑定本实例）</h3><div id="evList">${evidenceListHtml(p)}</div></div>
        <div class="panel"><h3>事件审计</h3>
          ${p.events.map(e => `<div class="pill-event">${fmt(e.at)} · ${esc(e.actor)} · ${esc(e.type)} — ${esc(e.detail)}</div>`).join('')}
        </div>
      </div>
    </div>`;
  wireInstance();
}

function conditionInput(c) {
  const v = c.value ?? '';
  if (c.kind === 'choice') {
    return `<select data-cond="${c.id}"><option value="">— 未知 / 待确认 —</option>` +
      c.options_json.map(o => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('') + `</select>`;
  }
  return `<input data-cond="${c.id}" value="${esc(v)}" placeholder="未知请留空"/>`;
}

function reviewsHtml(p) {
  if (!p.reviews.length) return '';
  return `<div class="panel" style="margin-bottom:14px;border-color:#fca5a5">
    <h3 style="color:var(--red)">⚠ 待处理复核项（${p.reviews.length}）</h3>
    ${p.reviews.map(r => `
      <div class="review" data-review="${r.id}">
        <div class="reason">${reasonText(r.reason)}</div>
        <div>${esc(r.detail)}</div>
        <div class="row"><input class="rv-note" placeholder="复核处置说明（按现行资料）"/>
          <button class="primary mini rv-resolve">复核通过（保留旧证据）</button></div>
      </div>`).join('')}
  </div>`;
}
function reasonText(r) {
  return { drawing_upgraded: '图纸升级影响已执行步骤', drawing_withdrawn: '图纸撤回', migration_diff: '受控迁移差异', branch_switch_diff: '分支切换差异' }[r] || r;
}

function migrationHtml(p) {
  const m = state.migration;
  if (!m) return '';
  return `<div class="panel" style="margin-bottom:14px;border-color:#a5f3fc">
    <h3>受控迁移：逐项差异确认（旧证据保留，进度不平移）</h3>
    <p class="hint">当前实例钉住 <b>v${esc(p.instance.manual_version)}</b>，目标 <b>${esc(m.diff.to)}</b>。
      必须逐项勾选全部 ${m.diff.items.length} 项差异后才能确认迁移；否则可拒绝并继续锁定旧手册。</p>
    <table class="diff-table"><thead><tr><th></th><th>步骤</th><th>差异类型</th><th>变化字段</th></tr></thead><tbody>
      ${m.diff.items.map(d => `<tr>
        <td><input type="checkbox" class="diff-chk" data-code="${esc(d.code)}"/></td>
        <td>${esc(d.code)} ${esc(d.title || '')}</td><td>${d.kind}</td><td>${esc((d.fields || []).join(', '))}</td></tr>`).join('')}
    </tbody></table>
    <div class="row">
      <button class="primary" id="doMigrate">确认迁移（已逐项核对）</button>
      <button id="rejectMigrate">拒绝，继续锁定旧手册</button>
    </div>
  </div>`;
}

function stepHtml(s) {
  const locked = s.run_state === 'blocked' || s.run_state === 'blocked_unknown';
  const cls = s.state === 'done' ? 'done' : (s.state === 'recheck_open' ? 'recheck' : locked ? 'locked' : '');
  const lockNote = s.run_state === 'blocked_unknown' ? '🔒 前置/本步骤条件未知 —— 停在待确认'
    : s.run_state === 'blocked' ? '🔒 等待 DAG 前置完成' : '';
  const evs = state.current.evidence.filter(e => e.step_id === s.id);
  return `<div class="step ${cls}">
    <div class="step-head">
      <input type="checkbox" class="chk" data-step="${esc(s.id)}" ${s.state === 'done' ? 'checked' : ''}
        ${['blocked', 'blocked_unknown', 'not_applicable'].includes(s.run_state) && s.state !== 'done' ? 'disabled' : ''}/>
      <span class="code">${esc(s.code)}</span>
      <span class="title">${esc(s.title)}</span>
      <span class="appl ${s.applicability}">${s.applicability === 'applicable' ? '适用' : s.applicability === 'not_applicable' ? '不适用' : '适用性未知'}</span>
      ${s.state === 'done' ? `<button class="mini reopen" data-step="${esc(s.id)}">撤销(${s.reopened_count})</button>` : ''}
    </div>
    <div class="step-body">
      <div>${esc(s.body)}</div>
      ${lockNote ? `<div class="banner info">${lockNote}</div>` : ''}
      ${s.warnings.map(w => `<div class="warn ${w.severity}"><span>${w.severity === 'danger' ? '⛔' : w.severity === 'warning' ? '⚠️' : 'ℹ️'}</span><span>${esc(w.message)}</span></div>`).join('')}
      ${s.drawings.length ? `<div class="drawings">${s.drawings.map(d =>
        `<span class="dwg-chip ${d.status === 'withdrawn' ? 'withdrawn' : (d.has_upgrade && s.state === 'done' ? 'stale' : '')}"
           data-dwg="${encodeURIComponent(JSON.stringify(d))}">📐 ${esc(d.code)} <span class="v">v${esc(d.version)}</span>${d.status === 'superseded' ? '（旧版）' : ''}
           ${d.status === 'withdrawn' ? '⛔已撤回·禁止使用' : (d.has_upgrade && s.state === 'done' ? ` ⚠新版 v${esc(d.latest_version)}已发布→待复核` : '')}</span>`).join('')}</div>` : ''}
      ${s.required_evidence !== 'none' ? `<div class="evidence-box">
        <div class="tagreq">需要凭证：${esc(s.evidence_label || s.required_evidence)}${s.value_unit ? '（单位：' + esc(s.value_unit) + '）' : ''}
          <span class="hint">— 仅填写现场实测/给定资料值，缺失就挂待确认</span></div>
        ${s.state !== 'done' && !locked && s.applicability !== 'not_applicable' ? `
        <div class="ev-form">
          <input type="file" accept="image/*" data-photo="${esc(s.id)}" capture="environment"/>
          <input data-value="${esc(s.id)}" placeholder="现场实测值 / 资料原文（必填时）${s.value_unit ? ' [' + esc(s.value_unit) + ']' : ''}" style="flex:1;min-width:220px"/>
          <label class="hint"><input type="checkbox" data-latecap="${esc(s.id)}"/> 离线补拍（带拍摄时间）</label>
        </div>` : ''}
        ${evs.length ? evs.map(e => evItem(e)).join('') : '<div class="hint">尚无凭证</div>'}
        ${s.state === 'done' ? `<div class="ev-form"><input type="file" accept="image/*" data-latephoto="${esc(s.id)}"/>
          <label class="hint"><input type="checkbox" checked data-latecapdone="${esc(s.id)}"/> 离线迟到照片（归档但不改完成时间）</label></div>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}
function evItem(e) {
  if (e.kind === 'photo') return `<div class="ev-item">📷 照片凭证${e.late ? ' <span class="evidence-late">[离线迟到]</span>' : ''}${e.superseded ? ' [已被迁移后新证据替代·旧证据保留]' : ''}
    <br/><img src="${esc(e.object_url)}" data-full="${encodeURIComponent(JSON.stringify({ key: e.object_key, code: 'evidence', version: '' }))}" title="点击放大"/>
    <span class="hint">sha ${esc((e.content_sha || '').slice(0, 12))} · 上传 ${fmt(e.uploaded_at)}${e.captured_at ? ' · 拍摄 ' + fmt(e.captured_at) : ''}</span></div>`;
  return `<div class="ev-item">🔢 数值/记录凭证：<b>${esc(e.value_text)}</b>${e.superseded ? ' [旧证据保留]' : ''} <span class="hint">${fmt(e.uploaded_at)}</span></div>`;
}
function evidenceListHtml(p) {
  if (!p.evidence.length) return '<div class="hint">暂无凭证。凭证绑定具体实例步骤，不能跨实例复用。</div>';
  return p.evidence.map(evItem).join('');
}

// ---------- 交互接线 ----------
function wireInstance() {
  // 条件回答（失焦/变更即提交；空值 => 待确认）
  $$('[data-cond]').forEach(el => {
    const save = async () => {
      try { await api(`/instances/${state.currentId}/conditions`, { method: 'PUT', body: { answers: { [el.dataset.cond]: el.value || null } } }); await loadInstance(); }
      catch (e) { toast(e.message, 'err'); }
    };
    el.onchange = save;
  });

  // 勾选 / 重复勾选
  $$('input.chk[data-step]').forEach(chk => {
    chk.onclick = async (e) => {
      const sid = chk.dataset.step;
      if (chk.checked) {
        e.preventDefault();
        const photoInput = $(`[data-photo="${sid}"]`);
        const valueInput = $(`[data-value="${sid}"]`);
        try {
          const photos = [];
          if (photoInput?.files?.[0]) {
            const fd = new FormData(); fd.append('file', photoInput.files[0]);
            const lateCap = $(`[data-latecap="${sid}"]`)?.checked;
            const up = await api(`/instances/${state.currentId}/evidence`, { method: 'POST', body: fd,
              capturedAt: lateCap ? new Date(Date.now() - 3600_000).toISOString() : undefined });
            photos.push({ object_key: up.object_key, content_sha: up.content_sha, captured_at: up.captured_at, late: lateCap });
          }
          const values = valueInput?.value.trim() ? [{ value_text: valueInput.value.trim() }] : [];
          const res = await api(`/instances/${state.currentId}/steps/${sid}/complete`, { method: 'POST', body: { photos, values } });
          state.current = res; renderInstance();
          toast('步骤已完成并绑定凭证', 'ok');
        } catch (err) {
          toast(err.message, 'err');
          await loadInstance();
        }
      }
    };
  });
  $$('.reopen[data-step]').forEach(b => b.onclick = async () => {
    const reason = prompt('撤销原因（证据保留，记录 reopened 次数）') || '';
    try { await api(`/instances/${state.currentId}/steps/${b.dataset.step}/reopen`, { method: 'POST', body: { reason } }); await loadInstance(); }
    catch (e) { toast(e.message, 'err'); }
  });

  // 图纸
  $$('.dwg-chip[data-dwg]').forEach(chip => {
    chip.onclick = () => {
      if (chip.classList.contains('withdrawn')) return toast('图纸已撤回：新步骤禁止使用；已执行步骤请按复核项处理', 'err');
      openDrawer(JSON.parse(decodeURIComponent(chip.dataset.dwg)));
    };
  });
  $$('img[data-full]').forEach(img => img.onclick = () => openDrawer(JSON.parse(decodeURIComponent(img.dataset.full))));

  // 离线迟到照片（已完成步骤）
  $$('[data-latephoto]').forEach(inp => inp.onchange = async () => {
    if (!inp.files[0]) return;
    const fd = new FormData(); fd.append('file', inp.files[0]);
    try {
      await api(`/instances/${state.currentId}/steps/${inp.dataset.latephoto}/late-photo`, {
        method: 'POST', body: fd, capturedAt: new Date(Date.now() - 7200_000).toISOString(),
      });
      await loadInstance();
      toast('迟到照片已归档（late 标记），原完成时间与进度不变', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  // 复核
  $$('.rv-resolve').forEach(b => b.onclick = async () => {
    const box = b.closest('[data-review]');
    try {
      await api(`/instances/${state.currentId}/reviews/${box.dataset.review}/resolve`, { method: 'POST', body: { resolution: box.querySelector('.rv-note').value } });
      await loadInstance(); toast('复核已关闭', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  // 迁移
  const dm = $('#doMigrate');
  if (dm) dm.onclick = async () => {
    const codes = $$('.diff-chk').filter(c => c.checked).map(c => c.dataset.code);
    try {
      await api(`/instances/${state.currentId}/migrations/${state.migration.migrationId}/confirm`,
        { method: 'POST', body: { confirmed_codes: codes } });
      state.migration = null; await loadInstance();
      toast('受控迁移完成：差异已逐项确认，旧证据保留', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#rejectMigrate') && ($('#rejectMigrate').onclick = async () => {
    await api(`/instances/${state.currentId}/migrations/${state.migration.migrationId}/reject`, { method: 'POST' });
    state.migration = null; await loadInstance(); toast('已拒绝迁移，继续锁定旧手册');
  });

  $('#btnPolicy').onclick = async () => {
    const p = state.current.instance;
    const np = p.migration_policy === 'lock' ? 'controlled' : 'lock';
    await api(`/instances/${state.currentId}/policy`, { method: 'PUT', body: { policy: np } });
    if (np === 'controlled') await tryProposeMigration(); else { await loadInstance(); }
  };
  $('#btnBranch').onclick = branchSwitchDialog;
  $('#btnExport').onclick = () => { window.open('/api/instances/' + state.currentId + '/export', '_blank'); };
  $('#btnPrint').onclick = printChecklist;
  $('#btnFinalize').onclick = async () => {
    try { await api(`/instances/${state.currentId}/finalize`, { method: 'POST' }); await loadInstance(); toast('已定稿', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
}

async function tryProposeMigration() {
  // 找同型号同修订的更新已发布版本
  const inst = state.current.instance;
  const newer = state.catalog.versions.filter(v =>
    v.model_id === inst.model_id && v.hw_rev === inst.hw_rev && v.id !== inst.version_id);
  if (!newer.length) { toast('没有其它可迁移的同分支版本'); await loadInstance(); return; }
  try {
    state.migration = await api(`/instances/${state.currentId}/migrations`, { method: 'POST', body: { to_version_id: newer[0].id } });
    await loadInstance();
    if (state.migration.diff.items.length === 0) {
      toast('两版无步骤差异，仍需在差异表确认流程中处理（本演示无差异项）');
    }
  } catch (e) { toast(e.message, 'err'); await loadInstance(); }
}

async function branchSwitchDialog() {
  const choice = prompt('输入目标分支：型号代码 + 空格 + 硬件修订（例：AX-210 B；BX-300 A 是不同型号，外观相近也会要求重新确认）',
    state.current.instance.model_code + ' ' + (state.current.instance.hw_rev === 'A' ? 'B' : 'A'));
  if (!choice) return;
  const [code, rev] = choice.trim().split(/\s+/);
  try {
    const prev = await api(`/instances/${state.currentId}/branch-switch/preview`, { method: 'POST', body: { model_code: code, hw_rev: rev } });
    const n = prev.diff?.items?.length ?? 0;
    if (!confirm(`分支 ${code}/Rev ${rev}（手册 v${prev.version.version}）\n与当前分支存在 ${n} 项步骤差异。\n` +
      `注意：型号/硬件修订切换不会迁移勾选与证据（旧证据保留），所有条件须重新逐项确认。\n\n确认切换？`)) return;
    await api(`/instances/${state.currentId}/branch-switch/execute`, { method: 'POST', body: { model_code: code, hw_rev: rev } });
    await loadInstance();
    toast('分支已切换：旧执行记录保留为历史，条件待重新确认', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function printChecklist() {
  try {
    const r = await api(`/instances/${state.currentId}/print`, { method: 'POST', body: { kind: 'checklist', simulate_fail: state.printerOffline } });
    toast('打印任务已完成 ' + r.print_job_id, 'ok');
  } catch (e) {
    if (e.status === 502 && e.data?.retryable) {
      if (confirm('打印失败（打印机离线）。勾选记录不受影响。现在重试？')) {
        try {
          const r = await fetch('/api/print-jobs/' + e.data.print_job_id + '/retry', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor-Role': state.role },
            body: JSON.stringify({ simulate_fail: state.printerOffline }),
          }).then(x => x.json());
          if (state.printerOffline) toast('仍然失败：请先恢复打印机再重试（任务保留可重试）', 'err');
          else toast('重打成功 ' + r.print_job_id, 'ok');
        } catch { toast('重试失败', 'err'); }
      }
    } else toast(e.message, 'err');
  }
}

// ---------- 图纸缩放 ----------
function openDrawer(d) {
  $('#drawerTitle').textContent = `${d.code} · v${d.version || '?'}`;
  $('#drawerMeta').textContent = d.status ? `状态 ${d.status} · sha ${(d.sha256 || d.content_sha || '').slice(0, 16)}` : '凭证照片';
  const url = d.object_key ? '/api/objects/' + encodeURIComponent(d.object_key) : d.object_url;
  $('#drawerImg').src = url;
  const w = $('#drawerWarning');
  if (d.status === 'withdrawn') { w.hidden = false; w.textContent = '该图纸已撤回：不得用于新步骤，已执行内容须走复核。'; }
  else { w.hidden = true; }
  state.zoom = 1; applyZoom();
  $('#drawerDialog').showModal();
}
function applyZoom() { $('#drawerImg').style.transform = `scale(${state.zoom})`; $('#zoomReset').textContent = Math.round(state.zoom * 100) + '%'; }
$('#zoomIn').onclick = () => { state.zoom = Math.min(4, state.zoom * 1.2); applyZoom(); };
$('#zoomOut').onclick = () => { state.zoom = Math.max(0.4, state.zoom / 1.2); applyZoom(); };
$('#zoomReset').onclick = () => { state.zoom = 1; applyZoom(); };
$('#drawerClose').onclick = () => $('#drawerDialog').close();
$('#drawerStage').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); state.zoom = Math.min(4, Math.max(0.4, state.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); applyZoom(); } }, { passive: false });

// ---------- 管理端 ----------
function renderAdminStatic() {
  if (!state.catalog) return;
  $('#condList').innerHTML = state.catalog.conditions.map(c =>
    `<div class="cond-row"><label>${esc(c.label)} <span class="hint">[${esc(c.key)}]${c.scope_model ? ' · 型号专属' : ' · 通用'}</span></label>
     <span class="state answered">${c.kind}</span></div>`).join('');
  $('#dvCode').innerHTML = state.catalog.drawings.map(d => `<option value="${esc(d.code)}">${esc(d.code)} — ${esc(d.title)}</option>`).join('');
  $('#wdCode').innerHTML = state.catalog.drawings.map(d => `<option value="${esc(d.code)}">${esc(d.code)}</option>`).join('');
  $('#versionList').innerHTML = `<table class="diff-table"><thead><tr><th>型号</th><th>HW</th><th>版本</th><th>状态</th><th>说明</th></tr></thead><tbody>` +
    state.catalog.versions.map(v => `<tr><td>${esc(v.model_code)}</td><td>Rev ${esc(v.hw_rev)}</td><td>${esc(v.version)}</td><td>${esc(v.status)}</td><td>${esc(v.change_note)}</td></tr>`).join('') + '</tbody></table>';
}
async function renderAdmin() { renderAdminStatic(); }

$('#newCond').onsubmit = async e => {
  e.preventDefault();
  if (state.role !== 'admin') return toast('请先切换到管理员角色', 'err');
  const f = new FormData(e.target);
  let options = [];
  try { options = f.get('options') ? JSON.parse(f.get('options')) : []; } catch { return toast('选项 JSON 格式错误', 'err'); }
  try {
    await api('/admin/conditions', { method: 'POST', body: { key: f.get('key'), label: f.get('label'), kind: f.get('kind'), options } });
    await loadCatalog(); e.target.reset(); toast('条件已新增（后端管理）', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
$('#newDrawingVersion').onsubmit = async e => {
  e.preventDefault();
  if (state.role !== 'admin') return toast('请先切换到管理员角色', 'err');
  const f = new FormData(e.target);
  if (!f.get('file') || f.get('file').size === 0) return toast('请选择 SVG 图纸文件', 'err');
  const fd = new FormData();
  fd.append('file', f.get('file')); fd.append('change_note', f.get('change_note'));
  try {
    const r = await api(`/admin/drawings/${f.get('code')}/versions`, { method: 'POST', body: fd });
    await loadCatalog();
    if (state.currentId) await loadInstance();
    toast(`已发布 v${r.version}；为 ${r.review_items_generated} 个已执行实例生成复核项（进度未平移）`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
$('#withdrawBtn').onclick = async () => {
  if (state.role !== 'admin') return toast('请先切换到管理员角色', 'err');
  if (!confirm('撤回当前版本将阻断该图的新查看/新执行，并对已执行实例生成复核项。确认？')) return;
  try {
    await api(`/admin/drawings/${$('#wdCode').value}/withdraw`, { method: 'POST' });
    await loadCatalog(); if (state.currentId) await loadInstance();
    toast('图纸已撤回', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

// ---------- 启动 ----------
(async function boot() {
  try {
    await loadCatalog();
    await refreshInstanceList();
    if (state.currentId) await loadInstance();
  } catch (e) { toast('启动失败：' + e.message, 'err'); }
})();
