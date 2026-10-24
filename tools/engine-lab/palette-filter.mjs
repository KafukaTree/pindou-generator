/**
 * 检验 rescueCoherentFeatures 里那个"只救极端明度色"的闸门
 *   if (beadL < 0.82 && beadL > 0.16) continue;
 *
 * 结论（直接跑就知道）：这道闸门两头都错。
 *   - 亮侧 L>0.82 放进 121/291 个色，其中大量是高彩度（B06 薄荷绿
 *     L=0.826 C=0.142 也算"高光"），于是猫/草叶兽的饱和色碎块被当
 *     特征救出 —— 这正是 micro 15→22 的来源。
 *   - 暗侧 L<0.16 只放过 1 个色（H07 #000000）。真正当瞳孔用的
 *     H16 #1D1414 明度是 0.203，**过不了闸门** → 暗侧救援形同不存在，
 *     所以 64 格有眼白却没有黑瞳。
 */
import fs from 'node:fs';

const cm = JSON.parse(fs.readFileSync(new URL('../../src/lib/colorMapping.json', import.meta.url), 'utf8'));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function lab(hex) {
  const R = lin(parseInt(hex.slice(1, 3), 16)), G = lin(parseInt(hex.slice(3, 5), 16)), B = lin(parseInt(hex.slice(5, 7), 16));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}
const swatches = Object.entries(cm).map(([hex, c]) => {
  const o = lab(hex);
  return { hex, code: c.MARD, L: o.L, C: Math.hypot(o.a, o.b) };
});

const lightPass = swatches.filter((s) => s.L > 0.82);
const darkPass = swatches.filter((s) => s.L < 0.16);
console.log(`色卡共 ${swatches.length} 颗`);
console.log(`亮侧 L>0.82 放行: ${lightPass.length} 颗`);
console.log(`  其中真中性(C<0.06): ${lightPass.filter((s) => s.C < 0.06).length} 颗`);
console.log(`  其中高彩度(C>0.10): ${lightPass.filter((s) => s.C > 0.10).length} 颗  ← 这些被当"高光"救出就是噪点`);
console.log(`  最彩的 5 颗: ${lightPass.slice().sort((a, b) => b.C - a.C).slice(0, 5).map((s) => `${s.code}${s.hex} L=${s.L.toFixed(3)} C=${s.C.toFixed(3)}`).join(' | ')}`);
console.log(`暗侧 L<0.16 放行: ${darkPass.length} 颗  [${darkPass.map((s) => `${s.code}${s.hex} L=${s.L.toFixed(3)}`).join(', ')}]`);
const nearDark = swatches.filter((s) => s.L < 0.30).sort((a, b) => a.L - b.L);
console.log(`全卡 L<0.30 只有 ${nearDark.length} 颗: ${nearDark.map((s) => `${s.code}${s.hex} L=${s.L.toFixed(3)}`).join(', ')}`);
console.log(`  → 实战当瞳孔用的 H16 明度 0.203，过不了 L<0.16，暗侧救援等于没有`);
