import { loadImage, generate, SAMPLES, cleanup } from './engine.mjs';
const img = await loadImage(SAMPLES.duck);
const isWhite = (hex) => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return Math.min(r,g,b)>200 && Math.max(r,g,b)-Math.min(r,g,b)<40; };
for (const gs of [64,80,96]) {
  const p = generate(img, {gridSize:gs,aspect:img.width/img.height,brand:'MARD',colorLimit:16,fit:'contain',smoothing:0.6,autoCrop:true,background:'ignore',chromaBoost:1.1});
  const cnt = new Array(p.palette.length).fill(0);
  for (const c of p.cells) if (c>=0) cnt[c]++;
  const wIdx = p.palette.map((u,i)=>({u,i})).filter(o=>isWhite(o.u.hex));
  const whiteBeads = wIdx.reduce((s,o)=>s+cnt[o.i],0);
  const cellArea = (381*470)/(p.cols*p.rows);
  console.log(`gs=${gs} ${p.cols}x${p.rows} colors=${p.palette.length} cellArea=${cellArea.toFixed(1)}px² theoryWhite=${(156/cellArea).toFixed(2)} actualWhiteBeads=${whiteBeads} :: ${wIdx.map(o=>`${o.u.code}=${cnt[o.i]}`).join(' ') || '(none)'}`);
  // dark beads
  const dIdx = p.palette.map((u,i)=>({u,i})).filter(o=>{const r=parseInt(o.u.hex.slice(1,3),16),g=parseInt(o.u.hex.slice(3,5),16),b=parseInt(o.u.hex.slice(5,7),16);return r+g+b<180;});
  console.log(`   dark: ${dIdx.map(o=>`${o.u.code}#${o.u.hex}=${cnt[o.i]}`).join(' ') || '(none)'}`);
}
cleanup();
