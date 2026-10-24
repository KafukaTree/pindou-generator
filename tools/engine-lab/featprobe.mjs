/**
 * 源图特征检测探针
 * ----------------
 * 只测 `src/lib/pattern/features.ts` 的 detectStructuralFeatures，
 * 输出每个候选特征的 role / 面积 / 对比 / 稳定度 / 置信度 / 配对，
 * 用来标定判据阈值（不改任何生产文件、不参与门禁）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(THIS_DIR, '../..');
const SRC_ROOT = path.join(ROOT, 'src');
const ts = require('typescript');

class ImageDataShim {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      this.width = a; this.height = b;
      this.data = c ?? new Uint8ClampedArray(a * b * 4);
    } else { this.data = a; this.width = b; this.height = c; }
  }
}
globalThis.ImageData = ImageDataShim;
globalThis.document = { createElement() { throw new Error('DOM'); } };

const IMPORT_RE = /(\bfrom\s*|\brequire\s*\(\s*)(['"])([^'"]+)\2/g;
const resolveSpec = (spec, from) =>
  spec.startsWith('@/') ? path.join(SRC_ROOT, spec.slice(2))
  : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
const resolveFile = (base) => {
  for (const c of [base, `${base}.ts`, `${base}.json`, path.join(base, 'index.ts')])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
};

function build(entryAbs) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pindou-feat-'));
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
    if (src.endsWith('.json')) { fs.writeFileSync(out, `module.exports = ${fs.readFileSync(src, 'utf8')};\n`); continue; }
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
  const mod = require(emitted.get(entryAbs));
  return { mod, cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) };
}

const feat = build(path.join(SRC_ROOT, 'lib/pattern/features.ts')).mod;
const resample = build(path.join(SRC_ROOT, 'lib/pattern/resample.ts')).mod;

async function loadImage(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return new ImageDataShim(new Uint8ClampedArray(data), info.width, info.height);
}

const SAMPLES = path.join(ROOT, 'public/samples');
const samples = ['duck', 'cat', 'leaf', 'turtle'];
const opts = process.argv[2] ? JSON.parse(process.argv[2]) : {};
for (const name of samples) {
  const img = await loadImage(path.join(SAMPLES, `${name}.png`));
  const t0 = performance.now();
  const list = feat.detectStructuralFeatures(img, null, opts);
  const ms = performance.now() - t0;
  // 主体裁剪后的坐标（引擎用 autoCrop）
  const b = resample.detectSubjectBounds(img, 0.10);
  console.log(`\n=== ${name} ${img.width}x${img.height} bounds=${b.x0},${b.y0},${b.x1},${b.y1} (${ms.toFixed(1)}ms) features=${list.length}`);
  list.sort((a, c) => c.confidence - a.confidence);
  for (const f of list.slice(0, 14)) {
    console.log(
      `  ${f.role.padEnd(5)} area=${String(f.area).padStart(6)} bbox=[${f.x0},${f.y0},${f.x1},${f.y1}] w=${f.x1 - f.x0 + 1} h=${f.y1 - f.y0 + 1}` +
      ` c=${f.contrast.toFixed(3)} stab=${f.stability.toFixed(2)} conf=${f.confidence.toFixed(2)}` +
      ` L=${f.lab.L.toFixed(3)} C=${Math.hypot(f.lab.a, f.lab.b).toFixed(3)} partner=${f.partner}`,
    );
  }
}
