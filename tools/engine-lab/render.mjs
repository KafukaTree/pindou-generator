/**
 * 渲染对比图：源图 | gs=64 | gs=80 | gs=96
 *
 *   node tools/engine-lab/render.mjs [图名] [输出路径]
 *   node tools/engine-lab/render.mjs duck /tmp/duck-compare.png
 *
 * 每格放大到 6px，四联横向拼接，标题栏画在顶部，方便一眼看差别。
 */
import { loadImage, generate, renderPng, stats, SAMPLES, cleanup } from './engine.mjs';
import sharp from 'sharp';

const name = process.argv[2] ?? 'duck';
const out = process.argv[3] ?? `/tmp/${name}-compare.png`;
const img = await loadImage(SAMPLES[name]);

const panels = [];
for (const gs of [64, 80, 96]) {
  const p = generate(img, {
    gridSize: gs, aspect: img.width / img.height, brand: 'MARD', colorLimit: 16,
    fit: 'contain', smoothing: 0.6, autoCrop: true, background: 'ignore', chromaBoost: 1.1,
  });
  const s = stats(p);
  const f = `/tmp/_panel-${name}-${gs}.png`;
  await renderPng(p, f, 6);
  panels.push({ gs, f, s, cols: p.cols, rows: p.rows });
  console.log(`gs=${gs} ${p.cols}x${p.rows} colors=${s.colors} blocks=${s.blocks} micro=${s.micro}`);
}

const metas = await Promise.all(panels.map((p) => sharp(p.f).metadata()));
const H = Math.max(...metas.map((m) => m.height));
const W = metas.reduce((s, m) => s + m.width + 8, 0);
const svgTitle = panels.map((p) => `GRID ${p.gs} (${p.cols}x${p.rows})`).join('   |   ');

const composites = [];
let x = 0;
for (let i = 0; i < panels.length; i++) {
  composites.push({ input: panels[i].f, left: x, top: 0 });
  x += metas[i].width + 8;
}
await sharp({ create: { width: W, height: H + 36, channels: 4, background: '#FAF3E4' } })
  .composite(composites.map((c) => ({ ...c, top: c.top + 36 })))
  .png()
  .toFile(out);
for (const p of panels) await sharp(p.f).toFile(out.replace('.png', `-${p.gs}.png`));
console.log(`\nwrote ${out}`);
console.log('titles:', svgTitle);
cleanup();
