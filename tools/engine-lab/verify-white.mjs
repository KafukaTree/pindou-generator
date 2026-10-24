import sharp from 'sharp';
const buf = await sharp('public/samples/duck.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
const {data,info} = buf;
const W=info.width,H=info.height;
function srgbToLin(c){c/=255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);}
function px(x,y){const i=(y*W+x)*4;return {r:data[i],g:data[i+1],b:data[i+2],a:data[i+3]};}
function lab(x,y){
  const {r,g,b}=px(x,y);
  const R=srgbToLin(r),G=srgbToLin(g),B=srgbToLin(b);
  const l=Math.cbrt(0.4122214708*R+0.5363325363*G+0.0514459929*B);
  const m=Math.cbrt(0.2119034982*R+0.6806995451*G+0.1073969566*B);
  const s=Math.cbrt(0.0883024619*R+0.2817188376*G+0.6299787005*B);
  return {L:0.2104542553*l+0.7936177850*m-0.0040720468*s,
          a:1.9779984951*l-2.4285922050*m+0.4505937099*s,
          b:0.0259040371*l+0.7827717662*m-0.8086757660*s};
}
const mask = new Uint8Array(W*H);
let n=0;
for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const p=lab(x,y);
  const C=Math.hypot(p.a,p.b);
  if(p.L>0.925 && C<0.055 && px(x,y).a>0.9*255){mask[y*W+x]=1;n++;}
}
console.log(`near-white (L>0.925, C<0.055, a>0.9): ${n} px  of ${W*H} (${(n/(W*H)*100).toFixed(3)}%)`);
// connected components 4-conn
const seen=new Uint8Array(W*H);
const comps=[];
for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const i=y*W+x;
  if(!mask[i]||seen[i])continue;
  let stack=[i],cnt=0,minx=W,maxx=0,miny=H,maxy=0;
  seen[i]=1;
  while(stack.length){
    const j=stack.pop();cnt++;
    const jx=j%W,jy=(j-jx)/W;
    if(jx<minx)minx=jx; if(jx>maxx)maxx=jx; if(jy<miny)miny=jy; if(jy>maxy)maxy=jy;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx=jx+dx,ny=jy+dy;
      if(nx<0||ny<0||nx>=W||ny>=H)continue;
      const k=ny*W+nx;
      if(mask[k]&&!seen[k]){seen[k]=1;stack.push(k);}
    }
  }
  comps.push({cnt,bbox:[minx,miny,maxx,maxy]});
}
comps.sort((a,b)=>b.cnt-a.cnt);
console.log(`components: ${comps.length}`);
comps.slice(0,8).forEach((c,i)=>console.log(`  #${i+1} ${c.cnt}px bbox=${JSON.stringify(c.bbox)}`));
// dark mask
const dmask=new Uint8Array(W*H);let dn=0;
for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const p=lab(x,y);const C=Math.hypot(p.a,p.b);
  if(p.L<0.35&&C<0.075&&px(x,y).a>0.9*255){dmask[y*W+x]=1;dn++;}
}
console.log(`\nnear-dark (L<0.35, C<0.075): ${dn} px`);
const dseen=new Uint8Array(W*H);const dcomps=[];
for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const i=y*W+x;if(!dmask[i]||dseen[i])continue;
  let stack=[i],cnt=0,minx=W,maxx=0,miny=H,maxy=0;dseen[i]=1;
  while(stack.length){const j=stack.pop();cnt++;const jx=j%W,jy=(j-jx)/W;
    if(jx<minx)minx=jx;if(jx>maxx)maxx=jx;if(jy<miny)miny=jy;if(jy>maxy)maxy=jy;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=jx+dx,ny=jy+dy;
      if(nx<0||ny<0||nx>=W||ny>=H)continue;const k=ny*W+nx;
      if(dmask[k]&&!dseen[k]){dseen[k]=1;stack.push(k);}}}
  dcomps.push({cnt,bbox:[minx,miny,maxx,maxy]});
}
dcomps.sort((a,b)=>b.cnt-a.cnt);
console.log(`dark components: ${dcomps.length}`);
dcomps.slice(0,6).forEach((c,i)=>console.log(`  #${i+1} ${c.cnt}px bbox=${JSON.stringify(c.bbox)}`));
