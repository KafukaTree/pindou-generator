/**
 * edits.ts 断言脚本（可直接 `node src/lib/pattern/edits.test.mjs`）
 * ===============================================================
 * 为什么不直接 import .ts：
 *   - 项目用 `@/` 路径别名 + JSON import，Node 无法原生解析；
 *   - 用 `--experimental-strip-types` 也解决不了别名，还会要求显式扩展名。
 *
 * 所以这里自己做一次极轻量的"按需编译"：从 edits.ts 出发，递归收集它
 * 真正依赖的模块（edits.ts / palette.ts / oklab.ts / colorMapping.json），
 * 用项目自带的 typescript 的 `transpileModule` 逐个转成 CommonJS 写进系统
 * 临时目录，再把 `@/` 与相对说明符改写成该目录内的真实文件名，最后 require
 * 进来做断言。**不经过 generate.ts**，所以不需要 ImageData / canvas。
 *
 * 只要 node + 项目 node_modules 就能跑；不写任何 UI、不改任何已有文件。
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(THIS_DIR, '../..'); // src/
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 迷你构建：src/**.ts → 临时目录里的 .cjs
// ---------------------------------------------------------------------------

const IMPORT_RE = /(\bfrom\s*|\brequire\s*\(\s*)(['"])([^'"]+)\2/g;

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('@/')) return path.join(SRC_ROOT, spec.slice(2));
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  return null; // node builtin / npm 包：原样保留
}

function resolveFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.json`, path.join(base, 'index.ts')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function buildModuleGraph(entryAbs, outDir) {
  const emitted = new Map(); // 源绝对路径 -> 输出 .cjs 绝对路径
  const queue = [entryAbs];

  // 先给每个源文件分配输出路径（扁平化，避免目录结构问题）
  while (queue.length) {
    const src = queue.pop();
    if (emitted.has(src)) continue;
    const out = path.join(outDir, `m${emitted.size}.cjs`);
    emitted.set(src, out);
    const source = fs.readFileSync(src, 'utf8');
    for (const m of source.matchAll(IMPORT_RE)) {
      const resolved = resolveSpec(m[3], src);
      if (!resolved) continue;
      const file = resolveFile(resolved);
      if (!file) throw new Error(`无法解析 ${m[3]} (来自 ${src})`);
      if (!emitted.has(file)) queue.push(file);
    }
  }

  // 逐个转译，把说明符改写成输出目录内的相对文件名 / 真实 json 路径
  for (const [src, out] of emitted) {
    if (src.endsWith('.json')) {
      // JSON 不能走 transpileModule，包一层 CommonJS 即可
      fs.writeFileSync(out, `module.exports = ${fs.readFileSync(src, 'utf8')};\n`);
      continue;
    }
    const source = fs.readFileSync(src, 'utf8');
    const rewrite = source.replace(IMPORT_RE, (whole, head, quote, spec) => {
      const resolved = resolveSpec(spec, src);
      if (!resolved) return whole;
      const file = resolveFile(resolved);
      if (!file) return whole;
      if (file.endsWith('.json')) {
        // require 绝对路径的 json 在 CJS 下可直接工作
        return `${head}${quote}${file}${quote}`;
      }
      const target = path.relative(outDir, emitted.get(file)).replace(/\\/g, '/');
      return `${head}${quote}${target.startsWith('.') ? target : `./${target}`}${quote}`;
    });
    const { outputText } = ts.transpileModule(rewrite, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        isolatedModules: true,
      },
      fileName: src,
    });
    fs.writeFileSync(out, outputText);
  }

  return { entryOut: emitted.get(entryAbs), emitted };
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✔ PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✘ FAIL  ${label}${extra === undefined ? '' : `  →  ${extra}`}`);
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, `期望 ${e}，实际 ${a}`);
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pindou-edits-test-'));

/** 从已构建的模块图里按**源文件路径**取编译产物的 require 句柄 */
function loadBySrc(emitted, srcAbs) {
  const out = emitted.get(srcAbs);
  if (!out) throw new Error(`模块图里没有 ${srcAbs}`);
  return require(out);
}

let mod;
let paletteMod;
let oklabMod;
try {
  const entryAbs = path.join(THIS_DIR, 'edits.ts');
  const { entryOut, emitted } = buildModuleGraph(entryAbs, outDir);
  mod = await import(pathToFileURL(entryOut).href);
  // palette / oklab 没被 edits.ts re-export，按源路径单独取（同一份实例）
  paletteMod = loadBySrc(emitted, path.join(SRC_ROOT, 'lib/color/palette.ts'));
  oklabMod = loadBySrc(emitted, path.join(SRC_ROOT, 'lib/color/oklab.ts'));
} catch (err) {
  console.error('构建/加载被测模块失败：', err);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(2);
}

const {
  EMPTY_EDITS,
  applyEdits,
  cellColorAt,
  floodFill,
  pickCodeAt,
  nearestBrandCode,
  makeDelta,
  applyDelta,
  invertDelta,
  editCount,
  editedCodes,
} = mod;

const { getBrandPalette, nearestBead } = paletteMod;
const { rgbToOklab } = oklabMod;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BRAND = 'MARD';
const BRAND_PALETTE = getBrandPalette(BRAND);

/** 造一个 base PatternResult（模拟引擎输出，含 4 色、严格统计） */
function makeBase(cols, rows, codes) {
  const beads = codes.map((code) => {
    const bead = BRAND_PALETTE.find((b) => b.code === code);
    if (!bead) throw new Error(`品牌色卡里没有 ${code}`);
    return bead;
  });
  const cells = new Int16Array(cols * rows);
  const counts = new Array(beads.length).fill(0);
  for (let i = 0; i < cells.length; i++) {
    // 竖条纹分配，保证每色都有面积，且区域连通（便于测 floodFill）
    const c = i % beads.length;
    cells[i] = c;
    counts[c]++;
  }
  const total = cells.length;
  const palette = beads
    .map((bead, i) => ({
      index: i,
      hex: bead.hex,
      rgb: { ...bead.rgb },
      code: bead.code,
      count: counts[i],
      ratio: counts[i] / total,
    }))
    .sort((a, b) => b.count - a.count)
    .map((u, i) => ({ ...u, index: i }));

  return {
    cols,
    rows,
    cells,
    palette,
    totalBeads: total,
    meanDeltaE: 0.0421,
    meta: {
      brand: BRAND,
      colorLimit: 8,
      fit: 'contain',
      smoothing: 0.6,
      autoCrop: true,
      background: 'ignore',
      dither: false,
      chromaBoost: 1.1,
      detail: 'balanced',
      regionAlgorithms: [],
      regionCoverage: 0,
      sizeCm: { w: cols * 0.5, h: rows * 0.5 },
    },
  };
}

/** 逐格校验：cells 的每个值都能在 palette 里找到且色号一致 */
function assertPaletteConsistent(label, result) {
  let bad = 0;
  for (let i = 0; i < result.cells.length; i++) {
    const c = result.cells[i];
    if (c < -1 || c >= result.palette.length) bad++;
  }
  ok(`${label}：所有 cells 下标落在 palette 范围内`, bad === 0, `${bad} 格越界`);

  const idxOk = result.palette.every((u, i) => u.index === i);
  ok(`${label}：palette.index 连续重排`, idxOk);

  const codes = result.palette.map((u) => u.code);
  ok(`${label}：无色号重复`, new Set(codes).size === codes.length);

  ok(
    `${label}：无 0 颗的色号`,
    result.palette.every((u) => u.count > 0),
    result.palette.filter((u) => u.count <= 0).map((u) => u.code).join(','),
  );

  const sum = result.palette.reduce((s, u) => s + u.count, 0);
  ok(`${label}：count 之和 == totalBeads`, sum === result.totalBeads, `${sum} vs ${result.totalBeads}`);

  // 用 counters 独立重算一遍，交叉验证
  const recount = new Array(result.palette.length).fill(0);
  for (const c of result.cells) if (c >= 0) recount[c]++;
  ok(
    `${label}：每色 count 与 cells 实际一致`,
    recount.every((n, i) => n === result.palette[i].count),
  );

  const ratioOk = result.palette.every(
    (u) => Math.abs(u.ratio - u.count / result.totalBeads) < 1e-9,
  );
  ok(`${label}：ratio == count/totalBeads`, ratioOk);
}

const C = BRAND_PALETTE.map((b) => b.code);
const codes4 = [C[0], C[7], C[40], C[120]];
// 找一个肯定不在 base.palette 里的真实色号
const extraCode = C[200];

console.log('拼豆编辑层断言测试');
console.log(`品牌 ${BRAND}，色号样本 ${codes4.join(', ')}，新增色号 ${extraCode}`);

// ---------------------------------------------------------------------------
section('1) 涂一格新色号 → palette 增加一条、totalBeads 不变、该格色号正确');
{
  const base = makeBase(10, 10, codes4);
  const baseCount = base.palette.length;
  const edits = { [7]: extraCode };
  const out = applyEdits(base, edits, BRAND);

  eq('palette 条数 +1', out.palette.length, baseCount + 1);
  eq('totalBeads 不变', out.totalBeads, base.totalBeads);
  eq('该格色号正确', pickCodeAt(out, edits, 7), extraCode);
  const color = cellColorAt(out, edits, 7);
  const bead = BRAND_PALETTE.find((b) => b.code === extraCode);
  eq('该格 hex 来自品牌真实色卡', color.hex, bead.hex);
  eq('该格 blank=false', color.blank, false);
  assertPaletteConsistent('新色号', out);
  eq('原 base 未被修改（cells 长度内的原值）', base.cells[7], 7 % baseCount);
  eq('原 base palette 未被修改', base.palette.length, baseCount);
  eq('原 base 未被修改（cells 引用不同）', out.cells === base.cells, false);
  eq('原 base palette 元素未共享', out.palette[0] === base.palette[0], false);
}

// ---------------------------------------------------------------------------
section('2) 涂一格为已有色号 → palette 不重复');
{
  const base = makeBase(8, 8, codes4);
  const existing = base.palette[0].code;
  const edits = { [5]: existing };
  const out = applyEdits(base, edits, BRAND);
  eq('palette 条数不变', out.palette.length, base.palette.length);
  eq(
    '色号集合不变',
    out.palette.map((u) => u.code).sort(),
    base.palette.map((u) => u.code).sort(),
  );
  eq('totalBeads 不变', out.totalBeads, base.totalBeads);
  eq('该格色号正确', pickCodeAt(out, edits, 5), existing);
  assertPaletteConsistent('已有色号', out);
}

// ---------------------------------------------------------------------------
section('3) 擦除一格 → totalBeads -1、该色 count -1');
{
  const base = makeBase(10, 10, codes4);
  const at = 13; // 4 色条纹，13 % 4 = 1
  const targetCode = pickCodeAt(base, EMPTY_EDITS, at);
  const beforeCount = base.palette.find((u) => u.code === targetCode).count;
  const edits = { [at]: '' };
  const out = applyEdits(base, edits, BRAND);

  eq('totalBeads -1', out.totalBeads, base.totalBeads - 1);
  const afterColor = out.palette.find((u) => u.code === targetCode);
  eq('该色 count -1', afterColor.count, beforeCount - 1);
  eq('该格现在是空白', pickCodeAt(out, edits, at), '');
  eq('空白格 blank=true', cellColorAt(out, edits, at).blank, true);
  eq('该格 cells 值为 -1', out.cells[at], -1);
  eq('色号条数不变（其他色还在）', out.palette.length, base.palette.length);
  assertPaletteConsistent('擦除一格', out);
}

// ---------------------------------------------------------------------------
section('4) 把一个色号全擦掉 → 该色消失、下标压缩后颜色仍正确（最关键）');
{
  const base = makeBase(12, 12, codes4);
  const victimCode = base.palette[1].code;
  const victimIdx = base.palette.findIndex((u) => u.code === victimCode);
  eq('被擦色号属于 palette', victimIdx >= 0, true);

  // 期望值：擦除后每格应显示的色号
  const expected = new Array(base.cells.length);
  for (let i = 0; i < base.cells.length; i++) {
    expected[i] = base.cells[i] === victimIdx ? '' : base.palette[base.cells[i]].code;
  }
  const victimCount = base.palette[victimIdx].count;

  const edits = {};
  for (let i = 0; i < base.cells.length; i++) {
    if (base.cells[i] === victimIdx) edits[i] = '';
  }
  ok('擦除编辑覆盖了整色', Object.keys(edits).length === victimCount, `${Object.keys(edits).length} vs ${victimCount}`);

  const out = applyEdits(base, edits, BRAND);

  eq('palette 条数 -1', out.palette.length, base.palette.length - 1);
  ok('该色号已从 palette 消失', !out.palette.some((u) => u.code === victimCode));
  eq('totalBeads 减少 victimCount', out.totalBeads, base.totalBeads - victimCount);
  assertPaletteConsistent('整色擦除', out);

  // 最关键的错位检查：逐格色号必须与期望完全一致
  let mismatch = 0;
  let firstBad = null;
  for (let i = 0; i < expected.length; i++) {
    const got = pickCodeAt(out, edits, i);
    if (got !== expected[i]) {
      mismatch++;
      if (firstBad === null) firstBad = `${i}: ${got} != ${expected[i]}`;
    }
  }
  ok('压缩下标后逐格色号仍正确', mismatch === 0, `${mismatch} 格错位，首个 ${firstBad}`);

  // 逐格 hex 也要对（防止"色号对但颜色对不上"）
  let hexBad = 0;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === '') continue;
    const bead = BRAND_PALETTE.find((b) => b.code === expected[i]);
    if (cellColorAt(out, edits, i).hex !== bead.hex) hexBad++;
  }
  ok('压缩下标后逐格 hex 仍正确', hexBad === 0, `${hexBad} 格颜色错`);

  // 追加一个新色号后又整色擦掉，新的也应当消失
  {
    const out2 = applyEdits(out, { [0]: extraCode }, BRAND);
    ok('追加新色号后 palette +1', out2.palette.length === out.palette.length + 1);
    const edits3 = { ...edits, [0]: '' };
    const out3 = applyEdits(base, edits3, BRAND);
    eq('新色号被擦掉后 palette 回到 -1 条', out3.palette.length, out.palette.length);
    ok('新色号不再出现', !out3.palette.some((u) => u.code === extraCode));
    assertPaletteConsistent('追加后擦除', out3);
  }
}

// ---------------------------------------------------------------------------
section('5) floodFill：同色区面积一致 / 已同色返回空 / 橡皮桶 / 考虑 edits');
{
  const cols = 10;
  const rows = 10;
  const base = makeBase(cols, rows, codes4);

  // 造一个明确的纯色区：左半 5 列全是 palette[0]，右半是 palette[2]
  const c0 = base.palette[0].code;
  const c2 = base.palette[2].code;
  const edits0 = {};
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      edits0[y * cols + x] = x < 5 ? c0 : c2;
    }
  }
  const painted = applyEdits(base, edits0, BRAND);
  const leftRegion = floodFill(painted, edits0, 0, c2);
  eq('左半同色区面积 = 50', leftRegion.length, 50);
  ok('返回下标都在左半', leftRegion.every((i) => i % cols < 5));

  eq('起点已经是目标色 → 返回空', floodFill(painted, edits0, 0, c0).length, 0);
  eq('起点已经是目标色（右侧）→ 返回空', floodFill(painted, edits0, 9, c2).length, 0);

  // 4 邻域不穿角：把左半对角相邻的两格设为异色，仍应连通（不测角，只测基本连通性）
  const edits1 = { ...edits0, [12]: '' }; // 左半内部挖一个空格
  const painted1 = applyEdits(base, edits1, BRAND);
  eq('挖掉一格后仍连通（49 格）', floodFill(painted1, edits1, 0, c2).length, 50 - 1);
  ok('被挖的格子不在返回里', !floodFill(painted1, edits1, 0, c2).includes(12));

  // 橡皮桶：code = '' 擦掉一整片
  const eraseRegion = floodFill(painted, edits0, 0, '');
  eq('橡皮桶返回整片同色区', eraseRegion.length, 50);

  // 考虑 edits：先在左半涂一格异色，再倒桶，应当排除那一格
  const edits2 = { ...edits0, [3]: c2 };
  const painted2 = applyEdits(base, edits2, BRAND);
  eq('倒桶考虑编辑覆盖（49 格）', floodFill(painted2, edits2, 0, c2).length, 49);

  // 边界安全
  eq('floodFill 越界 index → 空数组', floodFill(painted, edits0, 99999, c2).length, 0);
  eq('floodFill 负 index → 空数组', floodFill(painted, edits0, -3, c2).length, 0);
  eq('floodFill 空网格 → 空数组', floodFill(makeEmpty(), EMPTY_EDITS, 0, c0).length, 0);
}

function makeEmpty() {
  return {
    cols: 0,
    rows: 0,
    cells: new Int16Array(0),
    palette: [],
    totalBeads: 0,
    meanDeltaE: 0,
    meta: { brand: BRAND },
  };
}

// ---------------------------------------------------------------------------
section('6) delta 正反应用 → EditMap 回到原样');
{
  const start = { 1: codes4[0], 2: codes4[1] };
  const cells = [2, 3, 4, 4, -1, 99999]; // 含重复、负下标、越界下标
  const delta = makeDelta(start, cells, extraCode);

  // makeDelta 拿不到网格尺寸，只能剔除"不可能是下标"的值（负数/小数）；
  // 越界（>= cols*rows）由 applyEdits 负责忽略，所以 99999 会被保留在 delta 里。
  eq('delta 去重后格数（重复与负下标已剔除）', delta.cells.length, 4);
  eq('delta 保留了越界下标（由 applyEdits 兜底）', delta.cells.includes(99999), true);
  eq('负下标被剔除', delta.cells.includes(-1), false);
  eq('delta.before 保留旧值', delta.before, [codes4[1], undefined, undefined, undefined]);
  eq('delta.after 全为新值', delta.after, [extraCode, extraCode, extraCode, extraCode]);

  const applied = applyDelta(start, delta);
  eq('正应用后 2 格是新色号', applied[2], extraCode);
  eq('正应用后新增 2 格', applied[3], extraCode);
  eq('正应用后没动 1 格', applied[1], codes4[0]);
  eq('applyDelta 未改入参', start[2], codes4[1]);
  eq('editCount（越界键也在 EditMap 里）', editCount(applied), 5);

  const back = applyDelta(applied, invertDelta(applied, delta));
  eq('反应用后回到原样', back, start);
  eq('回到原样后键已删除', Object.prototype.hasOwnProperty.call(back, 3), false);

  // 反向可以重复应用（幂等性靠 base 传当前状态保证）
  const again = applyDelta(applied, invertDelta(applied, delta));
  eq('反向 delta 可重复得到同样结果', again, start);

  // 整格回到引擎值（after === undefined）应当删除键
  const toBase = makeDelta(applied, [2], undefined);
  const cleared = applyDelta(applied, toBase);
  eq('after=undefined 删除键', Object.prototype.hasOwnProperty.call(cleared, 2), false);
  eq('其余键保留', cleared[1], codes4[0]);
}

// ---------------------------------------------------------------------------
section('7) 越界 / 非法 index 不崩');
{
  const base = makeBase(10, 10, codes4);
  const edits = {
    [999999]: extraCode,
    [-1]: extraCode,
    1.5: extraCode,
  };
  let out;
  try {
    out = applyEdits(base, edits, BRAND);
    ok('applyEdits 处理越界编辑不抛错', true);
  } catch (err) {
    ok('applyEdits 处理越界编辑不抛错', false, String(err));
    out = base;
  }
  eq('越界编辑未改变 totalBeads', out.totalBeads, base.totalBeads);
  eq('越界编辑未新增色号', out.palette.length, base.palette.length);

  eq('cellColorAt 越界 → blank', cellColorAt(base, EMPTY_EDITS, 999999).blank, true);
  eq('cellColorAt 负数 → blank', cellColorAt(base, EMPTY_EDITS, -5).blank, true);
  eq('pickCodeAt 越界 → ""', pickCodeAt(base, EMPTY_EDITS, 999999), '');
  eq('未知色号被忽略（不污染调色板）', applyEdits(base, { [0]: 'ZZZ-NOT-A-COLOR' }, BRAND).palette.length, base.palette.length);
  eq('未知色号的格子仍是原色', pickCodeAt(applyEdits(base, { [0]: 'ZZZ-NOT-A-COLOR' }, BRAND), EMPTY_EDITS, 0), pickCodeAt(base, EMPTY_EDITS, 0));
  eq('空 EditMap 应用后 totalBeads 不变', applyEdits(base, EMPTY_EDITS, BRAND).totalBeads, base.totalBeads);
  eq('空 EditMap 应用后 palette 不变', applyEdits(base, EMPTY_EDITS, BRAND).palette.length, base.palette.length);
}

// ---------------------------------------------------------------------------
section('8) 附带导出的小工具');
{
  const base = makeBase(6, 6, codes4);
  const edits = { [0]: extraCode, [1]: extraCode, [2]: '', [3]: codes4[0] };
  eq('editCount', editCount(edits), 4);
  eq('editedCodes 去重且不含擦除', editedCodes(edits), [extraCode, codes4[0]]);
  eq('EMPTY_EDITS 是冻结空对象', Object.isFrozen(EMPTY_EDITS), true);
  eq('nearestBrandCode：白 → 某个真实色号', BRAND_PALETTE.some((b) => b.code === nearestBrandCode(BRAND, { r: 255, g: 255, b: 255 })), true);
  eq(
    'nearestBrandCode：与 nearestBead 结果一致',
    nearestBrandCode(BRAND, { r: 18, g: 120, b: 200 }),
    !BRAND_PALETTE.length
      ? ''
      : nearestBead(rgbToOklab(18, 120, 200), BRAND_PALETTE).bead.code,
  );
  eq('meanDeltaE 保持 base 值', applyEdits(base, { [0]: extraCode }, BRAND).meanDeltaE, base.meanDeltaE);
  eq('meta 传引用', applyEdits(base, { [0]: extraCode }, BRAND).meta, base.meta);
  eq('cols/rows 不变', [applyEdits(base, { [0]: '' }, BRAND).cols, applyEdits(base, { [0]: '' }, BRAND).rows], [6, 6]);
}

// ---------------------------------------------------------------------------
section('9) 性能：120×120 = 14400 格 + 3000 条编辑');
{
  const cols = 120;
  const rows = 120;
  // 用 20 色调色板（真实上限附近），比 4 色更接近线上实际情况
  const codes20 = [];
  for (let k = 0; k < 20; k++) codes20.push(C[(k * 13) % C.length]);
  const base = makeBase(cols, rows, codes20);
  // 3000 条编辑，混合四条路径：引擎已有色 / 未用过的品牌色 / 擦除 / 重复键
  const newCodes = [C[210], C[230], C[250]];
  const edits = {};
  for (let k = 0; k < 3000; k++) {
    const i = (k * 7919) % (cols * rows);
    edits[i] =
      k % 4 === 0
        ? newCodes[k % newCodes.length]
        : k % 4 === 1
          ? codes20[k % codes20.length]
          : k % 4 === 2
            ? ''
            : codes4[k % 4];
  }
  ok('构造了 3000 条编辑', Object.keys(edits).length === 3000, String(Object.keys(edits).length));

  const runs = [];
  for (let r = 0; r < 7; r++) {
    const t0 = process.hrtime.bigint();
    const out = applyEdits(base, edits, BRAND);
    const t1 = process.hrtime.bigint();
    runs.push(Number(t1 - t0) / 1e6);
    if (r === 0) {
      // 期望 palette = 用例里实际出现过的色号集合（擦除不算）
      const usedCodes = new Set(codes20);
      for (const code of Object.values(edits)) if (code) usedCodes.add(code);
      ok(
        `结果自洽（totalBeads=${out.totalBeads}, palette=${out.palette.length}/${usedCodes.size}）`,
        out.totalBeads > 0 && out.palette.length === usedCodes.size,
      );
      assertPaletteConsistent('14400 格性能用例', out);
    }
  }
  runs.sort((a, b) => a - b);
  const min = runs[0];
  const med = runs[Math.floor(runs.length / 2)];
  const max = runs[runs.length - 1];
  console.log(`     applyEdits 耗时：min ${min.toFixed(2)}ms / median ${med.toFixed(2)}ms / max ${max.toFixed(2)}ms`);
  ok('单次 applyEdits < 10ms（中位数）', med < 10, `${med.toFixed(2)}ms`);
  ok('单次 applyEdits < 25ms（最慢）', max < 25, `${max.toFixed(2)}ms`);

  // floodFill 在大图上的耗时（造一整片同色，测最坏情况：全图连通）
  const allOne = applyEdits(base, makeUniform(base, codes4[0]), BRAND);
  const t0 = process.hrtime.bigint();
  const region = floodFill(allOne, EMPTY_EDITS, 0, extraCode);
  const t1 = process.hrtime.bigint();
  const ffMs = Number(t1 - t0) / 1e6;
  console.log(`     floodFill（14400 格整片连通）耗时：${ffMs.toFixed(2)}ms，${region.length} 格`);
  ok('floodFill 覆盖满图', region.length === cols * rows);
  ok('floodFill < 50ms', ffMs < 50, `${ffMs.toFixed(2)}ms`);
}

/** 造一个"整张图都涂成同一个色号"的编辑层，用于 floodFill 最坏情况 */
function makeUniform(base, code) {
  const edits = {};
  for (let i = 0; i < base.cells.length; i++) edits[i] = code;
  return edits;
}

// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`结果：${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
