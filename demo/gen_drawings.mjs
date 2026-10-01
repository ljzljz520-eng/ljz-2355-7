// 生成演示图纸 SVG（对象库存图）。纯演示图，不含真实尺寸/针脚参数。
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = [];
function svg(name, title, ver, body, stamp) {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560" font-family="sans-serif">
<rect width="900" height="560" fill="#fafafa"/>
<rect x="20" y="20" width="860" height="520" fill="none" stroke="#333" stroke-width="2"/>
<text x="40" y="60" font-size="24" font-weight="bold">${title}</text>
<text x="40" y="90" font-size="14" fill="#555">控制箱硬件安装演示手册 · DEMO 资料 · ${ver} · 非受控图纸，禁止用于实际施工</text>
${body}
<text x="40" y="510" font-size="13" fill="#b00">${stamp}</text>
<text x="760" y="510" font-size="13" fill="#555">图号见文件名 · ${ver}</text>
</svg>`;
  const sha = createHash('sha256').update(s).digest('hex');
  writeFileSync(new URL(`../data/objects/demo/${ver}/${name}`, import.meta.url), s);
  out.push({ name: `demo/${ver}/${name}`, sha, size: Buffer.byteLength(s) });
}

const v1 = 'v1.0', v2 = 'v1.1';

svg('ctrl-dwg-01-v1.svg', 'CTRL-DWG-01 箱体开孔图（演示）', v1, `
<rect x="120" y="150" width="420" height="300" fill="#fff" stroke="#333" stroke-width="2"/>
<text x="150" y="190" font-size="14">箱体轮廓（孔位尺寸【演示占位·未给定】）</text>
<circle cx="160" cy="180" r="8" fill="none" stroke="#333"/><circle cx="500" cy="180" r="8" fill="none" stroke="#333"/>
<circle cx="160" cy="420" r="8" fill="none" stroke="#333"/><circle cx="500" cy="420" r="8" fill="none" stroke="#333"/>
`, 'v1.0 初版开孔图');

svg('ctrl-dwg-01-v2.svg', 'CTRL-DWG-01 箱体开孔图（演示）', v2, `
<rect x="120" y="150" width="420" height="300" fill="#fff" stroke="#333" stroke-width="2"/>
<text x="150" y="190" font-size="14">箱体轮廓（孔位尺寸【演示占位·未给定】）</text>
<circle cx="170" cy="190" r="8" fill="none" stroke="#c00" stroke-width="2"/><circle cx="490" cy="190" r="8" fill="none" stroke="#c00" stroke-width="2"/>
<circle cx="170" cy="410" r="8" fill="none" stroke="#c00" stroke-width="2"/><circle cx="490" cy="410" r="8" fill="none" stroke="#c00" stroke-width="2"/>
<rect x="600" y="200" width="240" height="120" fill="#fff4f4" stroke="#c00"/>
<text x="616" y="230" font-size="14" fill="#c00">v1.1 变更：安装孔位标注修订</text>
<text x="616" y="256" font-size="13" fill="#c00">（演示数据，具体尺寸仍未给定）</text>
`, 'v1.1：安装孔位标注已变更 —— 已执行 S10 需复核');

svg('ctrl-dwg-02-v1.svg', 'CTRL-DWG-02 接线图（演示）', v1, `
<rect x="80" y="140" width="220" height="120" fill="#fff" stroke="#333"/><text x="100" y="175" font-size="15">X1/X2 主电源</text><text x="100" y="205" font-size="12">线径/扭矩【未给定】</text>
<rect x="360" y="140" width="220" height="120" fill="#fff" stroke="#333"/><text x="380" y="175" font-size="15">J1 (修订A, 2件式)</text><text x="380" y="205" font-size="12">针脚表【未给定】</text>
<rect x="360" y="300" width="220" height="120" fill="#eee" stroke="#999" stroke-dasharray="6"/><text x="380" y="345" font-size="14" fill="#888">J1B (修订B) —— v1.0 未给出</text>
<rect x="640" y="140" width="180" height="120" fill="#eee" stroke="#999" stroke-dasharray="6"/><text x="656" y="185" font-size="14" fill="#888">X3 (CB-200)</text><text x="656" y="210" font-size="12" fill="#888">v1.0 未给出</text>
`, 'v1.0 初版接线图：仅含修订 A 的 J1');

svg('ctrl-dwg-02-v2.svg', 'CTRL-DWG-02 接线图（演示）', v2, `
<rect x="80" y="140" width="220" height="120" fill="#fff" stroke="#333"/><text x="100" y="175" font-size="15">X1/X2 主电源</text><text x="100" y="205" font-size="12">线径/扭矩【未给定】</text>
<rect x="360" y="140" width="220" height="120" fill="#fff" stroke="#333"/><text x="380" y="175" font-size="15">J1 (修订A, 2件式)</text><text x="380" y="205" font-size="12">针脚表【未给定】</text>
<rect x="360" y="300" width="220" height="120" fill="#f0fff0" stroke="#080" stroke-width="2"/><text x="380" y="340" font-size="14" fill="#060">J1B (修订B, 4件式)</text><text x="380" y="366" font-size="12" fill="#060">v1.1 新增 · 针脚表【未给定】</text>
<rect x="640" y="140" width="180" height="120" fill="#f0fff0" stroke="#080" stroke-width="2"/><text x="656" y="180" font-size="14" fill="#060">X3 (CB-200)</text><text x="656" y="206" font-size="12" fill="#060">v1.1 新增详图</text>
`, 'v1.1：新增 J1B/X3 详图 —— 已执行 S30/S21 需复核');

console.log(JSON.stringify(out, null, 2));
