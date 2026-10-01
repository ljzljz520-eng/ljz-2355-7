// 演示种子数据。
// 注意：系统本身不内置任何接线/扭矩“事实数值”。下列步骤文本均为占位说明，
// 仅引用“给定演示资料”这一来源；资料未给出的数值一律在现场由实测凭证填写。
import { initDb, query, one } from './index.js';
import { putObject } from '../store/objects.js';

async function q(ts, ps) { return query(ts, ps); }

async function seed() {
  await initDb();
  const existing = await one(`SELECT id FROM model WHERE code='AX-210'`);
  if (existing) { console.log('已存在种子数据，跳过。(如需重置：删除 pgdata 与 storage/drawings)'); return; }

  // ---------- 图纸（对象库存图，SVG，可缩放） ----------
  function rackSvg(rev) {
    const hot = rev >= 2;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520" font-family="sans-serif">
  <rect width="800" height="520" fill="#f7f8fa"/>
  <text x="24" y="40" font-size="20" font-weight="bold">RACK-OUTLINE ${rev === 1 ? 'v1' : 'v2（已升级）'}</text>
  <text x="24" y="66" font-size="13" fill="#555">对象库存图 · 内容哈希由系统计算 · 仅为给定演示资料，不含接线/扭矩数值</text>
  <rect x="80" y="100" width="640" height="360" fill="#fff" stroke="#333" stroke-width="3"/>
  <g stroke="#9aa5b1" stroke-width="1">
    ${Array.from({ length: 9 }, (_, i) => `<line x1="80" y1="${140 + i * 40}" x2="720" y2="${140 + i * 40}"/>`).join('')}
  </g>
  <rect x="110" y="150" width="180" height="60" fill="#dbeafe" stroke="#1d4ed8"/>
  <text x="130" y="186" font-size="14">PSU-A 槽位</text>
  <rect x="310" y="150" width="180" height="60" fill="#dbeafe" stroke="#1d4ed8"/>
  <text x="330" y="186" font-size="14">PSU-B 槽位</text>
  <rect x="510" y="150" width="160" height="60" fill="${hot ? '#fee2e2' : '#dcfce7'}" stroke="${hot ? '#b91c1c' : '#15803d'}"/>
  <text x="530" y="186" font-size="14">${hot ? '新增：线缆挡板（v2）' : '线缆管理区（v1）'}</text>
  <circle cx="${hot ? 590 : 190}" cy="320" r="18" fill="#fef3c7" stroke="#b45309" stroke-width="2"/>
  <text x="${hot ? 578 : 178}" y="326" font-size="13">P1</text>
  <text x="80" y="500" font-size="12" fill="#666">${hot ? 'v2 差异：线缆挡板结构不同，按 v1 完成的紧固步骤需复核。' : 'v1：初版外形图。'}</text>
</svg>`;
  }
  function harnessSvg() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420" font-family="sans-serif">
  <rect width="800" height="420" fill="#f7f8fa"/>
  <text x="24" y="40" font-size="20" font-weight="bold">HARNESS-PLAN v1</text>
  <text x="24" y="66" font-size="13" fill="#555">仅标示连接器位置；接线关系以“给定演示资料”为准，系统不提供也不推断接线参数</text>
  <rect x="120" y="120" width="200" height="120" rx="10" fill="#e0f2fe" stroke="#0369a1"/>
  <text x="160" y="185" font-size="15">控制板 J1</text>
  <rect x="480" y="120" width="200" height="120" rx="10" fill="#fef9c3" stroke="#a16207"/>
  <text x="520" y="185" font-size="15">配电板 P1</text>
  <line x1="320" y1="180" x2="480" y2="180" stroke="#64748b" stroke-width="3" stroke-dasharray="8 6"/>
  <text x="350" y="165" font-size="12" fill="#475569">具体针脚定义：资料未给出 → 现场以资料核对并拍照</text>
</svg>`;
  }
  const r1 = await putObject('drawings/rack-outline-v1.svg', Buffer.from(rackSvg(1)), 'image/svg+xml');
  const r2 = await putObject('drawings/rack-outline-v2.svg', Buffer.from(rackSvg(2)), 'image/svg+xml');
  const h1 = await putObject('drawings/harness-plan-v1.svg', Buffer.from(harnessSvg()), 'image/svg+xml');

  // ---------- 型号 / 硬件修订 / 条件 ----------
  await q(`INSERT INTO model(id,family,code,name) VALUES
    ('m-ax210','Axiom','AX-210','Axiom AX-210 控制单元'),
    ('m-bx300','Borex','BX-300','Borex BX-300 控制单元')`);
  await q(`INSERT INTO hardware_revision(id,model_id,rev,released_on,note) VALUES
    ('hr-a','m-ax210','A','2025-01-15','初版硬件'),
    ('hr-b','m-ax210','B','2025-09-01','线缆挡板变更，安装手册分支不同'),
    ('hr-bx','m-bx300','A','2025-03-10','外观相近但不可互换（用于演示“不得猜选相近型号”）')`);
  await q(`INSERT INTO condition_def(id,scope_model,key,label,kind,options_json) VALUES
    ('c-rack',NULL,'rack_unit','现场机柜 U 位规格','choice','[{"value":"2U","label":"2U"},{"value":"4U","label":"4U"}]'),
    ('c-psu',NULL,'psu_count','已安装电源模块数量','choice','[{"value":"1","label":"1（单电源）"},{"value":"2","label":"2（双电源冗余）"}]'),
    ('c-sn','m-ax210','serial_code','设备铭牌序列号前缀（用于核对型号，非近似选择）','text','[]'),
    ('c-bx','m-bx300','bx_key','BX-300 专用确认码（AX-210 现场无法获得 → 应停在待确认）','text','[]')`);

  // ---------- AX-210 / Rev A：手册 1.0.0 + 1.1.0（图纸升级） ----------
  await q(`INSERT INTO manual(id,model_id,hw_rev,title) VALUES
    ('man-axa','m-ax210','A','AX-210 Rev A 硬件安装手册'),
    ('man-axb','m-ax210','B','AX-210 Rev B 硬件安装手册')`);
  await q(`INSERT INTO manual_version(id,manual_id,version,status,published_at,change_note) VALUES
    ('mv-axa-10','man-axa','1.0.0','published','2025-02-01T00:00:00Z','初版发布'),
    ('mv-axa-11','man-axa','1.1.0','published','2025-09-20T00:00:00Z','RACK 外形图升级 v2；新增紧固后复检步骤'),
    ('mv-axb-10','man-axb','1.0.0','published','2025-09-05T00:00:00Z','Rev B 初版：线缆挡板结构不同')`);

  await q(`INSERT INTO drawing(id,code,title,model_id) VALUES
    ('dwg-rack','DWG-RACK','机柜外形与槽位图','m-ax210'),
    ('dwg-harness','DWG-HARNESS','连接器位置示意图','m-ax210')`);
  await q(`INSERT INTO drawing_version(id,drawing_id,version,object_key,content_sha,status,change_note) VALUES
    ('dv-rack-1','dwg-rack','1','$k1','$s1','superseded','初版'),
    ('dv-rack-2','dwg-rack','2','$k2','$s2','published','挡板结构变更'),
    ('dv-h-1','dwg-harness','1','$k3','$s3','published','仅位置示意')`.replace('$k1', r1.key).replace('$s1', r1.sha).replace('$k2', r2.key).replace('$s2', r2.sha).replace('$k3', h1.key).replace('$s3', h1.sha));

  // AX-210 Rev A v1.0.0 步骤
  const stepsA10 = [
    ['S10', 10, '开箱与铭牌核对', '按给定演示资料核对外包装与设备铭牌型号、硬件修订标识。铭牌不可读时停止并挂起待确认。', 'true', 'photo', '铭牌与硬件修订标识同框照片', null, null],
    ['S20', 20, '分支条件确认', '逐项确认机柜 U 位、电源数量、序列号前缀。任何一项未知必须停在“待确认”，不得按相近外观选择型号。', 'true', 'value', '条件确认记录（系统表单即为凭证）', null, null],
    ['S30', 30, '安装导轨', '按资料给定方式将导轨固定至机柜。资料未提供的扭矩等数值不得填写或猜测，按资料现场核对。', "rack_unit in ('2U','4U')", 'photo', '两侧导轨安装照片', null, null],
    ['S40', 40, '设备上架与紧固', '将设备滑入导轨并安装全部紧固件。紧固要求以给定资料为准；资料未给区间时如实记录现场值。', "rack_unit = '4U'", 'photo_and_value', '紧固点照片 + 现场实测/资料值记录', 'N·m', null],
    ['S50', 50, '电源模块安装', '安装电源模块（单/双数量按现场条件）。不得为通过步骤而虚构双电源。', "psu_count in ('1','2')", 'photo', '电源模块就位照片', null, null],
    ['S60', 60, '连接器位置核对', '对照连接器位置示意图，在资料指定位置完成核对；针脚定义资料未给出时，按资料现场核对并留存照片。', "psu_count = '2'", 'photo', '连接器核对照片（不含推断接线）', null, null],
    ['S70', 70, '完工检查', '逐项复核已完成步骤与警示，确认无未决项后完工。', 'true', 'none', '', null, null],
  ];
  for (const [code, seq, title, body, appl, ev, lbl, unit, rule] of stepsA10) {
    await q(`INSERT INTO step(id,version_id,code,seq,title,body,applicability,required_evidence,evidence_label,value_unit,evidence_rule)
      VALUES ('st-a10-${code}','mv-axa-10',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [code, seq, title, body, appl, ev, lbl, unit, rule]);
  }
  const deps = [['S10','S20'],['S20','S30'],['S30','S40'],['S30','S50'],['S50','S60'],['S40','S70'],['S60','S70']];
  for (const [a,b] of deps) await q(`INSERT INTO step_dep(version_id,from_step,to_step) VALUES ('mv-axa-10',$1,$2)`,
    [`st-a10-${a}`,`st-a10-${b}`]);
  await q(`INSERT INTO step_drawing(step_id,drawing_id,drawing_version_id) VALUES ('st-a10-S30','dwg-rack','dv-rack-1'),('st-a10-S40','dwg-rack','dv-rack-1'),('st-a10-S60','dwg-harness','dv-h-1')`);
  await q(`INSERT INTO step_warning(id,step_id,severity,message,condition_expr) VALUES
    ('w-a10-s40','st-a10-S40','danger','紧固参数仅以给定演示资料标注为准；资料未给出扭矩时，记录现场值并挂待确认，不得照抄其它型号。',NULL),
    ('w-a10-s50','st-a10-S50','warning','单电源现场不得勾选双电源；数量不符时停止安装并待确认。',NULL),
    ('w-a10-s60','st-a10-S60','caution','系统不提供接线针脚定义；严禁依据外观推测接线。',NULL)`);

  // AX-210 Rev A v1.1.0：复制 1.0.0，S40 关联升级图 + 新增 S45 复检；图不同 -> 旧实例产生复核项
  await q(`INSERT INTO step(id,version_id,code,seq,title,body,applicability,required_evidence,evidence_label,value_unit,evidence_rule)
    SELECT 'st-a11-'||code,'mv-axa-11',code,seq,title,body,applicability,required_evidence,evidence_label,value_unit,evidence_rule FROM step WHERE version_id='mv-axa-10'`);
  await q(`INSERT INTO step(id,version_id,code,seq,title,body,applicability,required_evidence,evidence_label)
    VALUES ('st-a11-S45','mv-axa-11','S45',45,'紧固后挡板复检','按 v2 外形图复核线缆挡板与紧固件与相对位置（新版新增步骤）。','rack_unit = ''4U''','photo','挡板复检照片')`);
  await q(`INSERT INTO step_dep(version_id,from_step,to_step)
    SELECT 'mv-axa-11','st-a11-'||substr(from_step,8),'st-a11-'||substr(to_step,8) FROM step_dep WHERE version_id='mv-axa-10'`);
  await q(`INSERT INTO step_dep(version_id,from_step,to_step) VALUES
    ('mv-axa-11','st-a11-S40','st-a11-S45'),('mv-axa-11','st-a11-S45','st-a11-S70')`);
  // v1.1 显式钉住 rack v2（升级图）
  await q(`INSERT INTO step_drawing(step_id,drawing_id,drawing_version_id) VALUES
    ('st-a11-S30','dwg-rack','dv-rack-2'),('st-a11-S40','dwg-rack','dv-rack-2'),('st-a11-S60','dwg-harness','dv-h-1')`);
  await q(`INSERT INTO step_warning(id,step_id,severity,message,condition_expr)
    SELECT 'w-a11-'||replace(step_id,'st-a10-',''), 'st-a11-'||replace(step_id,'st-a10-',''), severity,
      message||'（v1.1：图纸已升级）', condition_expr FROM step_warning WHERE step_id LIKE 'st-a10-%'`);

  // AX-210 Rev B v1.0.0：分支不同（挡板结构变；新增 S05，S40 文本不同）
  const stepsB = [
    ['S05', 5, 'Rev B 挡板确认', '硬件修订 B 在线缆挡板区域结构不同，安装前先确认挡板备件为 Rev B 规格。', 'true', 'photo', 'Rev B 挡板标识照片', null, null],
    ['S10', 10, '开箱与铭牌核对', '按给定演示资料核对铭牌型号与硬件修订必须为 B。', 'true', 'photo', '铭牌（含 Rev B 标识）照片', null, null],
    ['S20', 20, '分支条件确认', '逐项确认条件；序列号前缀不符或未知时停止，严禁沿用 Rev A 或猜选 BX-300。', 'true', 'value', '条件确认记录', null, null],
    ['S30', 30, '安装导轨', '按资料固定导轨（Rev B 机架接口一致，挡板不同）。', "rack_unit in ('2U','4U')", 'photo', '导轨照片', null, null],
    ['S40', 40, '设备上架与紧固（Rev B 挡板）', '按 Rev B v2 挡板结构上架紧固；参数仅以给定资料为准，缺失即待确认。', "rack_unit = '4U'", 'photo_and_value', '紧固照片+现场值', 'N·m', null],
    ['S50', 50, '电源模块安装', '安装电源模块并确认数量与现场一致。', "psu_count in ('1','2')", 'photo', '电源照片', null, null],
    ['S60', 60, '连接器位置核对', '按连接器位置示意图核对；系统不提供针脚定义。', "psu_count = '2'", 'photo', '连接器照片', null, null],
    ['S70', 70, '完工检查', '复核全部步骤、警示与未决项。', 'true', 'none', '', null, null],
  ];
  for (const [code, seq, title, body, appl, ev, lbl, unit, rule] of stepsB) {
    await q(`INSERT INTO step(id,version_id,code,seq,title,body,applicability,required_evidence,evidence_label,value_unit,evidence_rule)
      VALUES ('st-b10-${code}','mv-axb-10',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [code, seq, title, body, appl, ev, lbl, unit, rule]);
  }
  for (const [a,b] of [['S05','S10'],['S10','S20'],['S20','S30'],['S30','S40'],['S30','S50'],['S50','S60'],['S40','S70'],['S60','S70']])
    await q(`INSERT INTO step_dep(version_id,from_step,to_step) VALUES ('mv-axb-10',$1,$2)`,[`st-b10-${a}`,`st-b10-${b}`]);
  await q(`INSERT INTO step_drawing(step_id,drawing_id,drawing_version_id) VALUES ('st-b10-S30','dwg-rack','dv-rack-2'),('st-b10-S40','dwg-rack','dv-rack-2'),('st-b10-S60','dwg-harness','dv-h-1')`);
  await q(`INSERT INTO step_warning(id,step_id,severity,message,condition_expr) VALUES
    ('w-b10-s05','st-b10-S05','danger','Rev A/B 挡板不可互换；误用立即停工待确认。',NULL),
    ('w-b10-s40','st-b10-S40','danger','仅按给定资料的 Rev B 参数；未给出扭矩不得猜测。',NULL),
    ('w-b10-s60','st-b10-S60','caution','无针脚定义资料时严禁推测接线。',NULL)`);

  console.log('种子完成：2 型号 / 3 手册版本 / 2 图纸（rack 含 v1→v2 升级）');
}
export async function seedIfEmpty() {
  const existing = await one(`SELECT id FROM model WHERE code='AX-210'`);
  if (!existing) await seed();
}

// 允许 `npm run seed` 强制重灌（空库安全；非空会跳过）
const isMain = process.argv[1] && process.argv[1].endsWith('seed.js');
if (isMain) seed().catch(e => { console.error(e); process.exit(1); });
