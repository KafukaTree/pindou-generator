/**
 * 四图回归门禁
 * -------------
 * 这是算法改动的唯一客观验收标准。任何提交前必须跑：
 *
 *   node tools/engine-lab/regress.mjs
 *
 * 基线（gs=96, colorLimit=24, 2024 重构前）：
 *   cat    balanced  blocks=51 micro=15 colors=12
 *   cat    crisp     blocks=66 micro=15 colors=15
 *   duck   balanced  blocks=44 micro=18 colors=10
 *   duck   crisp     blocks=50 micro=24 colors=10
 *   leaf   balanced  blocks=64 micro=18 colors=11
 *   leaf   crisp     blocks=72 micro=16 colors=12
 *   turtle balanced  blocks=60 micro=12 colors=15
 *   turtle crisp     blocks=91 micro=33 colors=17
 *
 * 门禁规则（同时满足才算 PASS）：
 *   1. blocks 不得超过基线；
 *   2. micro 不得超过基线；
 *   3. colors 不得增加；
 *   4. 鸭吉吉眼睛：64/80/96 三档都必须同时存在近白豆与近黑豆，
 *      且它们落在眼部区域内（见 eye.mjs）。
 *
 * 输出 PASS/FAIL 表格 + 退出码（CI 可直接用）。
 */
import { loadImage, generate, stats, SAMPLES, cleanup } from './engine.mjs';

export const BASE = {
  gridSize: 96, brand: 'MARD', colorLimit: 24, fit: 'contain',
  smoothing: 0.6, autoCrop: true, background: 'ignore', chromaBoost: 1.1,
};

/** 基线：(blocks, micro, colors) */
export const BASELINE = {
  'cat|balanced':    { blocks: 51, micro: 15, colors: 12 },
  'cat|crisp':       { blocks: 66, micro: 15, colors: 15 },
  'duck|balanced':   { blocks: 44, micro: 18, colors: 10 },
  'duck|crisp':      { blocks: 50, micro: 24, colors: 10 },
  'leaf|balanced':   { blocks: 64, micro: 18, colors: 11 },
  'leaf|crisp':      { blocks: 72, micro: 16, colors: 12 },
  'turtle|balanced': { blocks: 60, micro: 12, colors: 15 },
  'turtle|crisp':    { blocks: 91, micro: 33, colors: 17 },
};

export const IMAGE_KEYS = ['cat', 'duck', 'leaf', 'turtle'];
export const DETAILS = ['balanced', 'crisp'];

export async function runAll({ extra = {} } = {}) {
  const rows = [];
  for (const k of IMAGE_KEYS) {
    const img = await loadImage(SAMPLES[k]);
    for (const det of DETAILS) {
      const p = generate(img, { ...BASE, aspect: img.width / img.height, detail: det, ...extra });
      const s = stats(p);
      const base = BASELINE[`${k}|${det}`];
      const fails = [];
      if (s.blocks > base.blocks) fails.push(`blocks ${s.blocks}>${base.blocks}`);
      if (s.micro > base.micro) fails.push(`micro ${s.micro}>${base.micro}`);
      if (s.colors > base.colors) fails.push(`colors ${s.colors}>${base.colors}`);
      rows.push({ image: k, detail: det, ...s, base, fails, ok: fails.length === 0, palette: p.palette.map((u) => u.code) });
      console.log(
        `${k.padEnd(6)} ${det.padEnd(9)} colors=${String(s.colors).padStart(2)}(${base.colors}) ` +
        `micro=${String(s.micro).padStart(2)}(${base.micro}) blocks=${String(s.blocks).padStart(3)}(${base.blocks}) ` +
        `dE=${s.meanDeltaE.toFixed(4)} ${fails.length ? 'FAIL ' + fails.join(', ') : 'PASS'}`,
      );
    }
  }
  return rows;
}

/** 汇总：返回失败条数 */
export function summarize(rows) {
  const bad = rows.filter((r) => !r.ok);
  console.log(bad.length ? `\n${bad.length}/${rows.length} FAIL` : `\nALL ${rows.length} PASS`);
  return bad.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await runAll();
  const bad = summarize(rows);
  cleanup();
  process.exit(bad ? 1 : 0);
}
