/**
 * 超采样与边缘保留滤波
 * ---------------------------------------------------------------
 * 拼豆图案之所以"碎"，根因是**在目标分辨率上逐格取色**。
 * 一旦降到 50×50，每格只能看到一小块信息，边缘处相邻两格会分别
 * 抓到"前景一点"和"背景一点"，量化后就成了频繁切换的杂色。
 *
 * 这里改成：
 *   1. 先超采样到 SS 倍（默认 4×）分辨率，得到 200×200 的细致网格；
 *   2. 在这个高分辨率上做**边缘保留的双边滤波**，把平坦区压平、
 *      只在真实轮廓处保留跳变；
 *   3. 之后所有量化、优化都在这个高分辨率上做，最后才 mode-pool 回
 *      目标网格（多数表决），杂色天然被投票掉。
 *
 * 全部计算在 OKLab 感知空间进行 —— 在 sRGB 里算"颜色差异"会低估
 * 暗部差、高估绿色差，导致轮廓处判错边。
 */

import { srgbToLinear, rgbToOklab, type Oklab } from '@/lib/color/oklab';

export interface Supersampled {
  /** 目标网格列/行数 */
  cols: number;
  rows: number;
  /** 超采样倍数，gw = cols * ss */
  ss: number;
  gw: number;
  gh: number;
  /** OKLab 逐像素，长度 gw*gh*3；alpha=0 处为 0 */
  lab: Float32Array;
  /** 覆盖度 0-1：源图之外的区域为 0 */
  alpha: Float32Array;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 把源图按 fit 方式映射到 gw×gh 的超采样网格。
 * 每个网格像素用**精确面积权重**对源像素做箱式平均（在线性光下累加），
 * 避免 sRGB 直接平均的偏亮、偏灰。
 */
export function supersample(
  img: ImageData,
  cols: number,
  rows: number,
  fit: 'contain' | 'cover',
  ss = 4,
  mask?: Float32Array | null,
): Supersampled {
  const gw = cols * ss;
  const gh = rows * ss;
  const { width: sw, height: sh, data } = img;

  const scale =
    fit === 'cover' ? Math.max(gw / sw, gh / sh) : Math.min(gw / sw, gh / sh);
  const drawW = sw * scale;
  const drawH = sh * scale;
  const offX = (gw - drawW) / 2;
  const offY = (gh - drawH) / 2;

  const lab = new Float32Array(gw * gh * 3);
  const alpha = new Float32Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    // 该网格行覆盖的源图 y 区间
    const y0 = (gy - offY) / scale;
    const y1 = (gy + 1 - offY) / scale;
    const sy0 = Math.max(0, Math.floor(y0));
    const sy1 = Math.min(sh, Math.ceil(y1));
    const areaTotal = Math.max(1e-6, (y1 - y0) * 1);

    for (let gx = 0; gx < gw; gx++) {
      const x0 = (gx - offX) / scale;
      const x1 = (gx + 1 - offX) / scale;
      const sx0 = Math.max(0, Math.floor(x0));
      const sx1 = Math.min(sw, Math.ceil(x1));

      let lr = 0;
      let lg = 0;
      let lb = 0;
      let fsum = 0;
      let areaSum = 0;

      for (let sy = sy0; sy < sy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = sx0; sx < sx1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          const a = data[i + 3] / 255;
          areaSum += w;
          if (a <= 0.004) continue;
          /*
           * 前景权重 f：有遮罩时只用"属于主体"的那部分面积参与混色。
           *
           * 这是修掉"光晕杂色"的关键。原先按整格面积做箱式平均，
           * 物体轮廓上的一格若是 33% 棕色头发 + 67% 白色背景，平均色
           * 就成了灰粉色，再吸附到豆色往往落到一个完全不存在的
           * 中间色上（实测头发顶端因此长出一个孤立浅红点，
           * 每条轮廓也都镶了一圈脏边）。
           * 有了前景权重后，颜色只由主体像素决定（纯棕），
           * 覆盖率单独记为 alpha，交给后面的"空白判定"处理。
           */
          const f = mask ? mask[sy * sw + sx] * a : a;
          if (f <= 0.002) continue;
          lr += srgbToLinear(data[i]) * w * f;
          lg += srgbToLinear(data[i + 1]) * w * f;
          lb += srgbToLinear(data[i + 2]) * w * f;
          fsum += w * f;
        }
      }

      const gi = gy * gw + gx;
      if (fsum <= 1e-9) {
        // 整格都是背景 / 落在源图之外
        alpha[gi] = 0;
        continue;
      }
      // 还原为 sRGB 再转 OKLab
      const r = linearToSrgb255(lr / fsum);
      const g = linearToSrgb255(lg / fsum);
      const b = linearToSrgb255(lb / fsum);
      const o = rgbToOklab(r, g, b);
      lab[gi * 3] = o.L;
      lab[gi * 3 + 1] = o.a;
      lab[gi * 3 + 2] = o.b;
      alpha[gi] = clamp01(fsum / Math.max(1e-6, areaSum));
    }
    void areaTotal;
  }

  return { cols, rows, ss, gw, gh, lab, alpha };
}

function linearToSrgb255(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
  const c = Math.round(s * 255);
  return c < 0 ? 0 : c > 255 ? 255 : c;
}

/**
 * 双边滤波（bilateral filter），在 OKLab 里做。
 *
 * 空间核压平平坦区域（消除源图噪点、JPEG 块、抗锯齿过渡），
 * 色彩核在颜色差异大处把权重降到 0 —— 所以轮廓不会被糊掉。
 *
 * 复杂度 O(N · (2r+1)²)，r=2 时每像素 25 次比较，200×200 约 1M 次，
 * 完全够快。
 */
export function bilateralLab(
  ss: Supersampled,
  radius = 2,
  sigmaSpace = 1.6,
  sigmaColor = 0.09,
): void {
  const { gw, gh, lab, alpha } = ss;

  // 预计算空间权重
  const r = radius;
  const size = 2 * r + 1;
  const sw = new Float32Array(size * size);
  const s2 = 2 * sigmaSpace * sigmaSpace;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      sw[(dy + r) * size + (dx + r)] = Math.exp(-(dx * dx + dy * dy) / s2);
    }
  }
  const c2 = 2 * sigmaColor * sigmaColor;

  const out = new Float32Array(lab.length);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const gi = y * gw + x;
      if (alpha[gi] <= 0.004) continue;

      const cL = lab[gi * 3];
      const cA = lab[gi * 3 + 1];
      const cB = lab[gi * 3 + 2];

      let sL = 0;
      let sA = 0;
      let sB = 0;
      let wsum = 0;

      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= gw) continue;
          const ni = ny * gw + nx;
          const a = alpha[ni];
          if (a <= 0.004) continue;

          const nL = lab[ni * 3];
          const nA = lab[ni * 3 + 1];
          const nB = lab[ni * 3 + 2];
          const dL = cL - nL;
          const dA = cA - nA;
          const dB = cB - nB;
          const dc = dL * dL + dA * dA + dB * dB;

          const w = sw[(dy + r) * size + (dx + r)] * Math.exp(-dc / c2) * Math.min(1, a);
          sL += nL * w;
          sA += nA * w;
          sB += nB * w;
          wsum += w;
        }
      }

      if (wsum > 1e-9) {
        out[gi * 3] = sL / wsum;
        out[gi * 3 + 1] = sA / wsum;
        out[gi * 3 + 2] = sB / wsum;
      } else {
        out[gi * 3] = cL;
        out[gi * 3 + 1] = cA;
        out[gi * 3 + 2] = cB;
      }
    }
  }

  ss.lab = out;
}

/**
 * 检测主体包围盒：从四边估背景色，找出所有明显不同于背景的像素的 bbox。
 * 用于自动裁掉大片空白 —— 原实现不管内容多小都塞进整个网格，
 * 实测 2500 颗里 1674 颗是多余白豆。
 */
export function detectSubjectBounds(
  img: ImageData,
  tolerance = 0.10,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: w, height: h, data } = img;

  // 取四条边像素的中位数作为背景色估计
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 16) return;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  const med = (arr: number[]) => {
    if (!arr.length) return 255;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const bg = { r: med(rs), g: med(gs), b: med(bs) };
  const bgLab = rgbToOklab(bg.r, bg.g, bg.b);

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;

  // 步长为 2 采样即可，省一半时间
  const step = Math.max(1, Math.floor(Math.min(w, h) / 400));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 16) continue;
      const l = rgbToOklab(data[i], data[i + 1], data[i + 2]);
      const dL = l.L - bgLab.L;
      const da = l.a - bgLab.a;
      const db = l.b - bgLab.b;
      if (Math.sqrt(dL * dL + da * da + db * db) <= tolerance) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }

  if (x1 < 0 || y1 < 0) return null;
  // 外扩 3% 作为呼吸留白
  const padX = Math.round((x1 - x0 + 1) * 0.03);
  const padY = Math.round((y1 - y0 + 1) * 0.03);
  return {
    x0: Math.max(0, x0 - padX),
    y0: Math.max(0, y0 - padY),
    x1: Math.min(w - 1, x1 + padX),
    y1: Math.min(h - 1, y1 + padY),
  };
}

/**
 * 估计背景色，并生成前景遮罩（1 = 主体，0 = 背景）。
 *
 * 做法：把四条边的像素当背景候选，取中位色；然后按"与背景色的
 * OKLab 距离"给每个像素打标记，再从四条边做**泛洪填充**，只把
 * 与边界连通、且颜色接近背景的区域判为背景。
 *
 * 为什么要泛洪而不是全局阈值：主体内部经常有和背景同色的部分
 * （白衬衫、白眼球高光、浅色皮肤）。全局阈值会把它们一起挖空，
 * 出现黑洞；泛洪只清除"从外部能走到的"背景，主体里的同色块
 * 因为被前景包围而保留下来。
 */
export function buildBackgroundMask(
  img: ImageData,
  tolerance = 0.10,
): { mask: Float32Array; bg: { r: number; g: number; b: number } } | null {
  const { width: w, height: h, data } = img;
  const n = w * h;

  // 背景色估计：四边中位数
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 16) return;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  if (!rs.length) return null;
  const med = (arr: number[]) => {
    const s2 = [...arr].sort((a, b) => a - b);
    return s2[Math.floor(s2.length / 2)];
  };
  const bg = { r: med(rs), g: med(gs), b: med(bs) };
  const bgLab = rgbToOklab(bg.r, bg.g, bg.b);

  // "接近背景"标记
  const nearBg = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 16) {
        nearBg[y * w + x] = 1; // 透明像素视作背景
        continue;
      }
      const l = rgbToOklab(data[i], data[i + 1], data[i + 2]);
      const dL = l.L - bgLab.L;
      const da = l.a - bgLab.a;
      const db = l.b - bgLab.b;
      if (Math.sqrt(dL * dL + da * da + db * db) <= tolerance) {
        nearBg[y * w + x] = 1;
      }
    }
  }

  // 从四条边泛洪
  const isBg = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const i = y * w + x;
    if (!isBg[i] && nearBg[i]) {
      isBg[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) seed(x - 1, y);
    if (x + 1 < w) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y + 1 < h) seed(x, y + 1);
  }

  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = isBg[i] ? 0 : 1;
  return { mask, bg };
}

/** 把 ImageData 裁到指定包围盒 */
export function cropImageData(
  img: ImageData,
  b: { x0: number; y0: number; x1: number; y1: number },
): ImageData {
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  if (w === img.width && h === img.height && b.x0 === 0 && b.y0 === 0) return img;
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcStart = ((b.y0 + y) * img.width + b.x0) * 4;
    const dstStart = y * w * 4;
    out.data.set(img.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return out;
}

/** 在 OKLab 里按比例提升彩度（越饱和越"Q"） */
export function boostChroma(lab: Oklab, factor: number): Oklab {
  if (factor === 1) return lab;
  return { L: lab.L, a: lab.a * factor, b: lab.b * factor };
}
