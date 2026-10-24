/**
 * 鸭吉吉眼睛专项验收（用户指定的硬案例）
 * ---------------------------------------
 *   node tools/engine-lab/eye.mjs
 *
 * 用户的验收原话：「你可以试试那个鸭吉吉的眼睛那一块，是个比较好的挑战；
 * 如果鸭吉吉的眼睛你能保持细节很充分，那么这个算法也能过关差不多」
 *
 * 鸭吉吉的眼睛结构 = **白眼球 + 黑瞳孔 + 黑眉**。缺了白眼球，"困倦的凶"
 * 就变成"瞎了"，这是角色辨识度的全部。
 *
 * 源图实测（public/samples/duck.png, 512×512）：
 *   - 自动裁切后主体 381×470（源图坐标 x 114..494, y 32..501）
 *   - 近白像素（L>0.925, C<0.055, a>0.9）：**181 px = 0.069%**，4 个主要
 *     连通块 62 / 44 / 36 / 14 px，分别落在左右眼
 *   - 近黑像素（L<0.35, C<0.075）：528 px，两大块 306 px（右眼）、158 px（左眼）
 *
 * 面积预算：白眼球核心 156 px ÷ 单格覆盖面积 = 理论豆数
 *   gs=64 → 53.8 px²/格 → 2.9 颗
 *   gs=80 → 34.4 px²/格 → 4.5 颗
 *   gs=96 → 23.9 px²/格 → 6.5 颗
 * 三档都**足够表达**，不该有任何一档丢失。
 *
 * 判定：在眼部 bbox 内必须同时有 ≥1 颗近白豆与 ≥1 颗近黑豆。
 */
import { loadImage, generate, SAMPLES, cleanup } from './engine.mjs';

const isWhite = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return Math.min(r, g, b) > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
};
const isDark = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return r + g + b < 200;
};

/* 源图坐标系（未裁切）里两只眼的 bbox */
const EYES = {
  left:  { x0: 226, y0: 124, x1: 248, y1: 139 },
  right: { x0: 272, y0: 112, x1: 303, y1: 136 },
};
/* detectSubjectBounds(0.10) 在该图上实测得到的裁切框 */
const CROP = { x0: 114, y0: 32, x1: 494, y1: 501 };

function cellRanges(cols, rows) {
  const cw = CROP.x1 - CROP.x0 + 1, ch = CROP.y1 - CROP.y0 + 1;
  const out = {};
  for (const [name, b] of Object.entries(EYES)) {
    out[name] = {
      c0: Math.floor((b.x0 - CROP.x0) / cw * cols),
      c1: Math.ceil((b.x1 - CROP.x0) / cw * cols),
      r0: Math.floor((b.y0 - CROP.y0) / ch * rows),
      r1: Math.ceil((b.y1 - CROP.y0) / ch * rows),
    };
  }
  return out;
}

export async function checkEye(gridSize, colorLimit = 16) {
  const img = await loadImage(SAMPLES.duck);
  const p = generate(img, {
    gridSize, aspect: img.width / img.height, brand: 'MARD', colorLimit,
    fit: 'contain', smoothing: 0.6, autoCrop: true, background: 'ignore', chromaBoost: 1.1,
  });
  const ranges = cellRanges(p.cols, p.rows);
  const count = new Array(p.palette.length).fill(0);
  for (const c of p.cells) if (c >= 0) count[c]++;
  const grab = (pred) => p.palette
    .map((u, i) => ({ u, i }))
    .filter((o) => pred(o.u.hex))
    .map((o) => ({ code: o.u.code, hex: o.u.hex, total: count[o.i] }));
  const whites = grab(isWhite);
  const darks = grab(isDark);
  const inEye = (rec) => {
    const idx = p.palette.findIndex((u) => u.hex === rec.hex);
    let n = 0;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
      if (p.cells[r * p.cols + c] !== idx) continue;
      for (const rg of Object.values(ranges))
        if (c >= rg.c0 && c <= rg.c1 && r >= rg.r0 && r <= rg.r1) { n++; break; }
    }
    return n;
  };
  const whiteInEye = whites.reduce((s, r) => s + inEye(r), 0);
  const darkInEye = darks.reduce((s, r) => s + inEye(r), 0);
  const cellArea = (CROP.x1 - CROP.x0 + 1) * (CROP.y1 - CROP.y0 + 1) / (p.cols * p.rows);
  return {
    gridSize, cols: p.cols, rows: p.rows, colors: p.palette.length,
    theoreticalWhite: +(156 / cellArea).toFixed(2),
    whiteInEye, darkInEye,
    whites, darks,
    ok: whiteInEye >= 1 && darkInEye >= 1,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  for (const gs of [64, 80, 96]) {
    const r = await checkEye(gs);
    if (!r.ok) bad++;
    console.log(
      `gs=${String(gs).padStart(2)} ${String(r.cols)}x${String(r.rows)} colors=${String(r.colors).padStart(2)} ` +
      `theoryWhite=${r.theoreticalWhite} whiteInEye=${String(r.whiteInEye).padStart(2)} darkInEye=${String(r.darkInEye).padStart(2)} ` +
      `${r.ok ? 'PASS' : 'FAIL'}  ` +
      `white=[${r.whites.map((w) => `${w.code}#${w.hex}x${w.total}`).join(' ') || 'NONE'}] ` +
      `dark=[${r.darks.map((d) => `${d.code}#${d.hex}x${d.total}`).join(' ') || 'NONE'}]`,
    );
  }
  console.log(bad ? `\n${bad}/3 FAIL` : '\nALL 3 PASS');
  cleanup();
  process.exit(bad ? 1 : 0);
}
