/**
 * 引擎无头测试台
 * ----------------
 * 目标：不开浏览器、不开 dev server，直接 node 跑 generate.ts。
 *
 * 做法与 edits.test.mjs 同源（复用其迷你构建思路）：
 *   1. 从 generate.ts 出发收集依赖图，用项目自带 typescript 的
 *      transpileModule 转成 CJS 写进临时目录；
 *   2. 注入最小的 ImageData / document / canvas 垫片 —— generate.ts 只在
 *      imageDataFromSource 与 patternToThumbnail 里碰 DOM，纯计算路径不需要；
 *   3. 用 sharp 把 PNG 解成 RGBA 填进垫片 ImageData。
 *
 * 这样一次完整生成只要几十毫秒级启动 + 真实算法耗时，不再有 180ms
 * debounce、不再有 HMR 不确定性。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(THIS_DIR, '../..');
const SRC_ROOT = path.join(ROOT, 'src');
const ts = require('typescript');
const sharp = require('sharp');

/* ---------- ImageData 垫片 ---------- */
class ImageDataShim {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      this.width = a; this.height = b;
      this.data = c ?? new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a; this.width = b; this.height = c;
    }
  }
}
globalThis.ImageData = ImageDataShim;
/* 引擎里 createElement('canvas') 的两处都在 DOM-only 函数里，给个会报错的桩，
   一旦真的走到就立刻暴露（而不是静默返回奇怪结果） */
globalThis.document = {
  createElement() { throw new Error('engine.mjs: 这条路径需要 DOM，不该在无头测试里被调用'); },
};

/* ---------- 迷你构建 ---------- */
const IMPORT_RE = /(\bfrom\s*|\brequire\s*\(\s*)(['"])([^'"]+)\2/g;
const resolveSpec = (spec, from) =>
  spec.startsWith('@/') ? path.join(SRC_ROOT, spec.slice(2))
  : spec.startsWith('.') ? path.resolve(path.dirname(from), spec)
  : null;
const resolveFile = (base) => {
  for (const c of [base, `${base}.ts`, `${base}.json`, path.join(base, 'index.ts')])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
};

function build(entryAbs) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pindou-engine-'));
  const emitted = new Map();
  const queue = [entryAbs];
  while (queue.length) {
    const src = queue.pop();
    if (emitted.has(src)) continue;
    emitted.set(src, path.join(outDir, `m${emitted.size}.cjs`));
    for (const m of fs.readFileSync(src, 'utf8').matchAll(IMPORT_RE)) {
      const r = resolveSpec(m[3], src);
      if (!r) continue;
      const f = resolveFile(r);
      if (!f) throw new Error(`无法解析 ${m[3]} (来自 ${src})`);
      if (!emitted.has(f)) queue.push(f);
    }
  }
  for (const [src, out] of emitted) {
    if (src.endsWith('.json')) {
      fs.writeFileSync(out, `module.exports = ${fs.readFileSync(src, 'utf8')};\n`);
      continue;
    }
    const source = fs.readFileSync(src, 'utf8');
    const rewritten = source.replace(IMPORT_RE, (whole, head, q, spec) => {
      const r = resolveSpec(spec, src);
      if (!r) return whole;
      const f = resolveFile(r);
      if (!f) return whole;
      let rel = path.relative(path.dirname(out), emitted.get(f));
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `${head}${q}${rel}${q}`;
    });
    const { outputText } = ts.transpileModule(rewritten, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      },
      fileName: src,
    });
    fs.writeFileSync(out, outputText);
  }
  const entryOut = emitted.get(entryAbs);
  const mod = require(entryOut);
  return { mod, cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) };
}

const { mod: engine, cleanup } = build(path.join(SRC_ROOT, 'lib/pattern/generate.ts'));
const resample = build(path.join(SRC_ROOT, 'lib/pattern/resample.ts')).mod;
export const generate = engine.generatePattern;
export const supersample = resample.supersample;
export const bilateralLab = resample.bilateralLab;
export const detectSubjectBounds = resample.detectSubjectBounds;
export const cropImageData = resample.cropImageData;
export const computeGridSize = engine.computeGridSize;
const pn = build(path.join(SRC_ROOT, 'lib/pattern/pixel-native.ts')).mod;
export const detectNativePixelGrid = pn.detectNativePixelGrid;
export const sampleNativeCells = pn.sampleNativeCells;
export const findNativeSubjectBounds = pn.findNativeSubjectBounds;
export const estimateSizeCm = engine.estimateSizeCm;
export { cleanup };

/* ---------- 图片加载 ---------- */
export async function loadImage(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return new ImageDataShim(new Uint8ClampedArray(data), info.width, info.height);
}

/* ---------- 指标 ---------- */
export function stats(pattern) {
  const { cols, rows, cells } = pattern;
  const n = cols * rows;
  let isolated = 0, edge = 0, filled = 0;
  const used = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c, v = cells[i];
      if (v < 0) continue;
      filled++; used.add(v);
      let diff = 0, same = 0, nb = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const rr = r + dy, cc = c + dx;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const w = cells[rr * cols + cc];
          if (w < 0) continue;
          nb++; if (w !== v) diff++;
        }
      if (nb && diff === nb) isolated++;
      if (nb && diff > 0) edge++;
    }
  }
  // 连通块统计
  const seen = new Uint8Array(n);
  const stack = [];
  let blocks = 0, micro = 0, biggest = 0;
  for (let i = 0; i < n; i++) {
    if (seen[i] || cells[i] < 0) continue;
    const v = cells[i]; blocks++;
    let size = 0;
    seen[i] = 1; stack.push(i);
    while (stack.length) {
      const j = stack.pop(); size++;
      const r = (j / cols) | 0, c = j % cols;
      for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const rr = r + dy, cc = c + dx;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const k = rr * cols + cc;
        if (seen[k] || cells[k] !== v) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    if (size < 3) micro++;
    if (size > biggest) biggest = size;
  }
  return {
    cols, rows, filled, colors: used.size, blocks, micro, biggest,
    isolatedRate: filled ? isolated / filled : 0,
    edgeRate: filled ? edge / filled : 0,
    totalBeads: pattern.totalBeads,
    meanDeltaE: pattern.meanDeltaE,
  };
}

/* 把图案渲染成 PNG，用于目视对比 */
export async function renderPng(pattern, out, scale = 1) {
  const { cols, rows, cells, palette } = pattern;
  const px = Math.max(1, Math.round(scale));
  const buf = Buffer.alloc(cols * px * rows * px * 4);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c];
      let rr = 245, gg = 240, bb = 238, aa = 255;
      if (v >= 0) {
        const hex = palette[v].hex;
        rr = parseInt(hex.slice(1, 3), 16);
        gg = parseInt(hex.slice(3, 5), 16);
        bb = parseInt(hex.slice(5, 7), 16);
      }
      for (let y = 0; y < px; y++)
        for (let x = 0; x < px; x++) {
          const o = ((r * px + y) * cols * px + c * px + x) * 4;
          buf[o] = rr; buf[o + 1] = gg; buf[o + 2] = bb; buf[o + 3] = aa;
        }
    }
  await sharp(buf, { raw: { width: cols * px, height: rows * px, channels: 4 } }).png().toFile(out);
  return out;
}

export const SAMPLES = {
  cat: path.join(ROOT, 'public/samples/cat.png'),
  duck: path.join(ROOT, 'public/samples/duck.png'),
  leaf: path.join(ROOT, 'public/samples/leaf.png'),
  turtle: path.join(ROOT, 'public/samples/turtle.png'),
};
