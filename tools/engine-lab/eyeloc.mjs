import { loadImage, generate, SAMPLES, cleanup } from './engine.mjs';
import fs from 'node:fs';
const cm = JSON.parse(fs.readFileSync('src/lib/colorMapping.json','utf8'));
const codeToHex = new Map(Object.entries(cm).map(([hex,c])=>[c.MARD,hex]));
const img = await loadImage(SAMPLES.duck);
const isWhite = (hex) => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return Math.min(r,g,b)>200 && Math.max(r,g,b)-Math.min(r,g,b)<40; };
// eye bbox in source: left eye dark comp bbox [226,124,248,139], right [272,112,303,136]
// source cropped bbox is (114,32)-(494,501) => local coords
const CX0=114, CY0=32, CW=381, CH=470;
function toCell(x0,y0,x1,y1,cols,rows){
  // contain fit: scale=min(gw/sw,gh/sh) on gw=cols... approximate: aspect cols/rows == CW/CH
  return {c0:Math.floor((x0-CX0)/CW*cols), c1:Math.ceil((x1-CX0)/CW*cols), r0:Math.floor((y0-CY0)/CH*rows), r1:Math.ceil((y1-CY0)/CH*rows)};
}
for (const gs of [64,80,96]) {
  const p = generate(img, {gridSize:gs,aspect:img.width/img.height,brand:'MARD',colorLimit:16,fit:'contain',smoothing:0.6,autoCrop:true,background:'ignore',chromaBoost:1.1});
  const le = toCell(226,124,248,139,p.cols,p.rows), re = toCell(272,112,303,136,p.cols,p.rows);
  console.log(`\n=== gs=${gs} ${p.cols}x${p.rows}  leftEyeCells c${le.c0}-${le.c1} r${le.r0}-${le.r1}  rightEyeCells c${re.c0}-${re.c1} r${re.r0}-${re.r1}`);
  const wIdx = p.palette.map((u,i)=>({u,i})).filter(o=>isWhite(o.u.hex));
  for (const o of wIdx) {
    const cells=[];
    for (let r=0;r<p.rows;r++)for(let c=0;c<p.cols;c++) if(p.cells[r*p.cols+c]===o.i) cells.push([c,r]);
    const inLe = cells.filter(([c,r])=>c>=le.c0&&c<=le.c1&&r>=le.r0&&r<=le.r1).length;
    const inRe = cells.filter(([c,r])=>c>=re.c0&&c<=re.c1&&r>=re.r0&&r<=re.r1).length;
    console.log(`  white ${o.u.code} #${o.u.hex} total=${cells.length} inLeftEye=${inLe} inRightEye=${inRe} cells=${JSON.stringify(cells.slice(0,20))}`);
  }
  const dIdx = p.palette.map((u,i)=>({u,i})).filter(o=>{const h=o.u.hex;const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return r+g+b<200;});
  for (const o of dIdx) {
    const cells=[];
    for (let r=0;r<p.rows;r++)for(let c=0;c<p.cols;c++) if(p.cells[r*p.cols+c]===o.i) cells.push([c,r]);
    const inLe = cells.filter(([c,r])=>c>=le.c0&&c<=le.c1&&r>=le.r0&&r<=le.r1).length;
    const inRe = cells.filter(([c,r])=>c>=re.c0&&c<=re.c1&&r>=re.r0&&r<=re.r1).length;
    console.log(`  dark  ${o.u.code} #${o.u.hex} total=${cells.length} inLeftEye=${inLe} inRightEye=${inRe}`);
  }
}
cleanup();
