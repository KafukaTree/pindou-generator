import { loadImage, generate, SAMPLES, cleanup } from './engine.mjs';
import sharp from 'sharp';
const img = await loadImage(SAMPLES.duck);
for (const [gs, cl] of [[64,16],[64,24],[80,16],[96,16],[96,24]]) {
  const p = generate(img, {gridSize:gs,aspect:1,brand:'MARD',colorLimit:cl,fit:'contain',smoothing:0.6,autoCrop:true,background:'ignore',chromaBoost:1.1});
  const hasWhite = p.palette.some(u => { const r=parseInt(u.hex.slice(1,3),16),g=parseInt(u.hex.slice(3,5),16),b=parseInt(u.hex.slice(5,7),16); return Math.min(r,g,b)>200 && Math.max(r,g,b)-Math.min(r,g,b)<40; });
  console.log(`gs=${gs} cl=${cl} ${p.cols}x${p.rows} colors=${p.palette.length} white=${hasWhite?'YES':'no '} [${p.palette.map(u=>u.code).join(',')}]`);
}
cleanup();
