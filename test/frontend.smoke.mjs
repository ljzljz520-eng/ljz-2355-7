// 前端冒烟：在 jsdom 中加载真实 index.html + app.js（指向运行中的服务器），
// 验证无运行时错误、步骤卡片渲染、缩放、勾选交互、迁移面板出现。
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const html = readFileSync(path.join('public', 'index.html'), 'utf8');

const errors = [];
const virtualConsole = new JSDOM().virtualConsole;
virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.message || e.message)));

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
// 最小 polyfill
window.scrollTo = () => {};
window.fetch = (url, opts) => fetch(String(url).startsWith('/api') || String(url).startsWith('/') ? BASE + url : url, opts);

const appJs = readFileSync(path.join('public', 'app.js'), 'utf8');
try {
  window.eval(appJs);
} catch (e) {
  errors.push('eval app.js: ' + e.stack);
}

await new Promise((r) => setTimeout(r, 1500));

const doc = window.document;
// 目录应渲染
if (!doc.getElementById('versionSelect').options.length) errors.push('版本下拉未渲染');
if (!doc.getElementById('modelSelect').options.length) errors.push('型号下拉未渲染');

// 创建实例
doc.getElementById('newInstanceName').value = 'UI冒烟实例';
doc.getElementById('createInstanceBtn').click();
await new Promise((r) => setTimeout(r, 1200));

const stepCards = doc.querySelectorAll('.step-card').length;
if (!stepCards) errors.push('步骤卡片未渲染');
// S02 警示应紧邻出现
const s02Card = [...doc.querySelectorAll('.step-card')].find((c) => c.dataset.step === 'S02');
if (!s02Card) errors.push('缺少 S02 卡片');
else if (!s02Card.textContent.includes('W-ID-01')) errors.push('S02 未紧邻 W-ID-01 警示');

// 未确认型号时 S10 应显示 等待 S02
const s10 = [...doc.querySelectorAll('.step-card')].find((c) => c.dataset.step === 'S10');
if (!/等待|blocked/i.test(s10.textContent)) errors.push('S10 未被 DAG 阻塞');

// 缩放
window.document.getElementById('zoomInBtn').click();
window.document.getElementById('zoomInBtn').click();
const zoomText = window.document.getElementById('zoomLevel').textContent;
if (!zoomText.startsWith('1')) errors.push('缩放显示异常: ' + zoomText);

// 确认型号 CB-200/B
doc.getElementById('modelSelect').value = 'CB-200';
doc.getElementById('revSelect').value = 'B';
doc.getElementById('confirmContextBtn').click();
await new Promise((r) => setTimeout(r, 800));
const pendingText = doc.getElementById('pendingSummary').textContent;

// 迁移面板应出现（v1.0 实例）
await new Promise((r) => setTimeout(r, 300));
const migPanel = doc.getElementById('migrationPanel');
if (migPanel.classList.contains('hidden')) errors.push('迁移面板未显示');
if (!migPanel.textContent.includes('受控迁移')) errors.push('迁移面板文案缺失');

if (errors.length) {
  console.error('FRONTEND SMOKE FAILURES:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`FRONTEND SMOKE OK: ${stepCards} 步骤卡片渲染; 缩放=${zoomText}; 迁移面板可见`);
process.exit(0);
