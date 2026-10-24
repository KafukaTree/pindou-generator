/**
 * 源图结构特征检测
 * =================
 *
 * 为什么要在**源图**上单独做一层特征检测，而不是继续在池化结果上"事后救援"：
 *
 * 池化是 4×4=16 个超采样像素的众数表决，任何面积小于半格的高反差特征都
 * 必然被邻近的大面积颜色吃掉。之后再从格子里去"找"它，找到的其实是池化的
 * 残影 —— 判据只能依赖很脆弱的通道（本格均值偏了多少、核心团够不够大），
 * 而且每换一个网格档位，采样相位一变，同一条判据就时灵时不灵。
 * 实测鸭吉吉的眼睛在 64 / 80 / 96 三档走的是三条不同的失败路径：
 *   64：白活黑死（黑瞳被当作散块溶掉）
 *   80：黑活白死（白眼球在剪枝时保护位只剩 1 格，need=3 被剪）
 *   96：都活，但白用的是 H10 而不是源图上那颗纯白
 *
 * 真正稳定的量是**源图上这个结构有多大**。所以这里先在源图上把"必须存在于
 * 成品里的结构"找出来（`StructuralFeature`），算出它应该分到几颗豆子
 * （配额 `minBeads` 由 detect 之后的调用方按网格换算），再交给网格去解决
 * "摆在哪"。这样"某一档整块丢失"从设计上就不可能发生 —— 配额是先算的。
 *
 * 判据（全部实测标定）：
 *   1. 中性色：近白 L>0.86 且 C<0.055；近深 L<0.35 且 C<0.075。
 *      高彩度色（荧光绿 B02 C=0.242、纯黄 Q03 C=0.211）永远不是高光/瞳孔，
 *      它们是造型色 —— 这是旧实现最大的漏洞（L>0.82 会放行 120 个色，
 *      其中 38 个高彩度）。
 *   2. 面积小：占画面 5e-5 ～ 6e-3。太大的是主体（猫的白脸 12905px、
 *      龟壳亮面 5782px），它们本来就由大面积色承担，不需要配额保护。
 *   3. 与实际连通区边界强对比：2px 邻域色差的 75% 分位 ≥ 0.30。实测鸭吉吉白眼球 0.478-0.595、
 *      瞳孔 0.562-0.623；而猫白脸只有 0.088-0.201，自动排除。
 *   4. 多尺度稳定：在规范副本上使用 sigma=0 / 0.6 / 1.2，以质心漂移
 *      检查支持度，避免输入尺寸改变就使用不同的物理尺度。
 *   5. 配对：亮暗质心距离默认 ≤16 个检测像素且 |L̄亮 − L̄暗| ≥ 0.35
 *      —— 显式表达"亮色紧邻深色"这个眼睛的结构定义。
 *
 * 性能：检测在长边 ≤512 的副本上做（512×512 的样图完全不降采样），
 * 三道高斯 + 连通域都是 O(N)，320 格时也不会在 5120×5120 的超采样缓冲上跑。
 */
import { srgbToLinear, type Oklab } from '@/lib/color/oklab';
import type { BeadColor } from '@/lib/color/palette';

export type FeatureRole = 'light' | 'dark';

export interface StructuralFeature {
  role: FeatureRole;
  /** 核心平均色（OKLab，源图坐标系） */
  lab: Oklab;
  /** 包围盒（源图像素，闭区间） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 质心（源图像素） */
  cx: number;
  cy: number;
  /** 面积（源图像素） */
  area: number;
  /** 实际连通区边界邻域的稳健反差（OKLab 距离） */
  contrast: number;
  /** 多尺度稳定度；连续窄线改用双侧前景支持率，范围 0..1。 */
  stability: number;
  /** 采信度：面积、对比、稳定的合成，用于配额取舍 */
  confidence: number;
  /** 配对的反极性特征下标，-1 = 无 */
  partner: number;
  /** 连通区实际像素中心（交错 x/y，源图坐标）；缺省时兼容 bbox 投影。 */
  sourcePixels?: Float32Array;
  /** 一个检测像素在源图上的边长。 */
  sourcePixelSize?: number;
  /** 窄线采用一格宽的路径预算，普通亮暗块仍用面积预算。 */
  stroke?: boolean;
}

export interface DetectOptions {
  /** 检测副本的长边上限（性能护栏） */
  maxEdge?: number;
  /** 最小面积占画面比例 */
  minAreaFrac?: number;
  /** 最大面积占画面比例（超过就认为是主体而不是小特征） */
  maxAreaFrac?: number;
  /** 与外围环的最小对比 */
  minContrast?: number;
  /** 显式值按源图像素；缺省按检测副本 16px 换算，保持尺度一致。 */
  pairRadius?: number;
  /** 配对要求的最小明度差 */
  pairMinDeltaL?: number;
  /** 配对两块面积的比值上限（超过就不是"同一只眼的亮暗两半"） */
  pairMaxAreaRatio?: number;
}

const NEAR_WHITE = (L: number, C: number) => L > 0.86 && C < 0.055;
const NEAR_DARK = (L: number, C: number) => L < 0.35 && C < 0.075;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 可分离高斯模糊（3 通道 Float32，边界钳制）。
 * sigma 以检测副本的像素为单位。
 */
function blur3(
  src: Float32Array,
  w: number,
  h: number,
  sigma: number,
): Float32Array {
  if (sigma <= 0.01) return src;
  const r = Math.max(1, Math.ceil(sigma * 2.6));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        const o = (row + xx) * 3;
        const wgt = k[i + r];
        a0 += src[o] * wgt;
        a1 += src[o + 1] * wgt;
        a2 += src[o + 2] * wgt;
      }
      const d = (row + x) * 3;
      tmp[d] = a0;
      tmp[d + 1] = a1;
      tmp[d + 2] = a2;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        const o = (yy * w + x) * 3;
        const wgt = k[i + r];
        a0 += src[o] * wgt;
        a1 += src[o + 1] * wgt;
        a2 += src[o + 2] * wgt;
      }
      const d = (y * w + x) * 3;
      out[d] = a0;
      out[d + 1] = a1;
      out[d + 2] = a2;
    }
  }
  return out;
}

interface RawComp {
  area: number;
  cx: number;
  cy: number;
  lab: Oklab;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels?: number[];
}

/** 默认 4 邻域；窄线可选 8 邻域并保留像素支持集。 */
function components(
  lab: Float32Array,
  alpha: Float32Array,
  w: number,
  h: number,
  test: (L: number, C: number, index: number) => boolean,
  minArea: number,
  retainPixels = false,
  diagonal = false,
): RawComp[] {
  const n = w * h;
  const seen = new Uint8Array(n);
  const out: RawComp[] = [];
  const stack: number[] = [];
  const member: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || alpha[i] < 0.9) continue;
    const L0 = lab[i * 3];
    const A0 = lab[i * 3 + 1];
    const B0 = lab[i * 3 + 2];
    if (!test(L0, Math.hypot(A0, B0), i)) continue;
    member.length = 0;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    let sx = 0;
    let sy = 0;
    let sL = 0;
    let sA = 0;
    let sB = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const k = stack.pop()!;
      member.push(k);
      const x = k % w;
      const y = (k / w) | 0;
      sx += x;
      sy += y;
      sL += lab[k * 3];
      sA += lab[k * 3 + 1];
      sB += lab[k * 3 + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const push = (kk: number) => {
        if (seen[kk] || alpha[kk] < 0.9) return;
        const L = lab[kk * 3];
        const A = lab[kk * 3 + 1];
        const B = lab[kk * 3 + 2];
        if (!test(L, Math.hypot(A, B), kk)) return;
        seen[kk] = 1;
        stack.push(kk);
      };
      if (x > 0) push(k - 1);
      if (x + 1 < w) push(k + 1);
      if (y > 0) push(k - w);
      if (y + 1 < h) push(k + w);
      if (diagonal) {
        if (x > 0 && y > 0) push(k - w - 1);
        if (x + 1 < w && y > 0) push(k - w + 1);
        if (x > 0 && y + 1 < h) push(k + w - 1);
        if (x + 1 < w && y + 1 < h) push(k + w + 1);
      }
    }
    if (member.length < minArea) continue;
    const m = member.length;
    out.push({
      area: m,
      cx: sx / m,
      cy: sy / m,
      lab: { L: sL / m, a: sA / m, b: sB / m },
      x0,
      y0,
      x1,
      y1,
      ...(retainPixels ? { pixels: member.slice() } : {}),
    });
  }
  return out;
}

const oklabDist = (p: Oklab, c: Oklab): number => {
  const dL = p.L - c.L;
  const dA = p.a - c.a;
  const dB = p.b - c.b;
  return Math.sqrt(0.85 * dL * dL + 1.6 * (dA * dA + dB * dB));
};

/**
 * 在源图上提取"必须在成品里存在"的结构特征。
 *
 * `mask` 可选（不透明图的外景遮罩），与 alpha 相乘。返回值坐标全部是
 * **源图像素**，调用方负责按 supersample 的同一套映射投影到网格。
 */
export function detectStructuralFeatures(
  img: ImageData,
  mask?: Float32Array | null,
  opts: DetectOptions = {},
): StructuralFeature[] {
  const maxEdge = opts.maxEdge ?? 512;
  const minAreaFrac = opts.minAreaFrac ?? 5e-5;
  const maxAreaFrac = opts.maxAreaFrac ?? 6e-3;
  const minContrast = opts.minContrast ?? 0.3;
  const pairRadius = opts.pairRadius;
  const pairMinDeltaL = opts.pairMinDeltaL ?? 0.35;
  const pairMaxAreaRatio = opts.pairMaxAreaRatio ?? 8;

  const sw = img.width;
  const sh = img.height;
  const data = img.data;
  const f = Math.max(1, Math.ceil(Math.max(sw, sh) / maxEdge));
  const dw = Math.max(2, Math.round(sw / f));
  const dh = Math.max(2, Math.round(sh / f));

  /* ---- 1. 降采样到检测副本（线性光下箱式平均）---- */
  const lab = new Float32Array(dw * dh * 3);
  const alpha = new Float32Array(dw * dh);
  const accL = new Float64Array(dw * dh * 3);
  const accA = new Float64Array(dw * dh);
  for (let sy = 0; sy < sh; sy++) {
    const dy = Math.min(dh - 1, (sy / f) | 0);
    for (let sx = 0; sx < sw; sx++) {
      const dx = Math.min(dw - 1, (sx / f) | 0);
      const si = (sy * sw + sx) * 4;
      let a = data[si + 3] / 255;
      if (a <= 0.004) continue;
      if (mask) a *= mask[sy * sw + sx];
      if (a <= 0.002) continue;
      const di = dy * dw + dx;
      accL[di * 3] += srgbToLinear(data[si]) * a;
      accL[di * 3 + 1] += srgbToLinear(data[si + 1]) * a;
      accL[di * 3 + 2] += srgbToLinear(data[si + 2]) * a;
      accA[di] += a;
    }
  }
  for (let i = 0; i < dw * dh; i++) {
    const a = accA[i];
    if (a <= 1e-9) continue;
    const o = linearToOklabComponent(accL[i * 3] / a, accL[i * 3 + 1] / a, accL[i * 3 + 2] / a);
    lab[i * 3] = o[0];
    lab[i * 3 + 1] = o[1];
    lab[i * 3 + 2] = o[2];
    alpha[i] = clamp01(a / (f * f));
  }

  /* ---- 2. 多尺度连通域 ---- */
  const sigmas = [0, 0.6, 1.2];
  const minAreaDet = 8;
  const perScale: { light: RawComp[]; dark: RawComp[] }[] = [];
  for (const sg of sigmas) {
    const blurred = blur3(lab, dw, dh, sg);
    perScale.push({
      light: components(blurred, alpha, dw, dh, NEAR_WHITE, minAreaDet, sg === 0),
      dark: components(blurred, alpha, dw, dh, NEAR_DARK, minAreaDet, sg === 0),
    });
  }

  /* ---- 3. 跨尺度聚类 + 过滤 ---- */
  const imgArea = sw * sh;
  const features: StructuralFeature[] = [];
  const take = (role: FeatureRole, idx: number): number => {
    // 以 sigma=0 的形状为准，其余尺度只用来验证稳定性
    const base = perScale[0][role][idx];
    if (!base) return -1;
    const areaSrc = base.area * f * f;
    const areaFrac = areaSrc / imgArea;
    if (areaFrac < minAreaFrac || areaFrac > maxAreaFrac) return -1;

    // 使用真实连通区周围的反差，眼白包围盒内部的黑瞳也计入邻域。
    const contrast = ringContrastComponent(lab, alpha, dw, dh, base, (L, C) =>
      role === 'light' ? NEAR_WHITE(L, C) : NEAR_DARK(L, C),
    );
    if (contrast < minContrast) return -1;

    // 多尺度稳定：另两个尺度里存在质心接近的组件
    let hits = 1;
    for (let s = 1; s < perScale.length; s++) {
      const list = perScale[s][role];
      for (const c of list) {
        if (Math.hypot(c.cx - base.cx, c.cy - base.cy) <= 3.5) {
          hits++;
          break;
        }
      }
    }
    const stability = hits / perScale.length;

    const confidence =
      clamp01(Math.min(1, base.area / 40)) * clamp01((contrast - minContrast) / 0.25) * stability;

    const sourcePixels = new Float32Array((base.pixels?.length ?? 0) * 2);
    for (let i = 0; i < (base.pixels?.length ?? 0); i++) {
      const p = base.pixels![i];
      sourcePixels[i * 2] = (p % dw + 0.5) * f;
      sourcePixels[i * 2 + 1] = (((p / dw) | 0) + 0.5) * f;
    }
    features.push({
      sourcePixels, sourcePixelSize: f,
      role,
      lab: base.lab,
      x0: base.x0 * f,
      y0: base.y0 * f,
      x1: Math.min(sw - 1, base.x1 * f + f - 1),
      y1: Math.min(sh - 1, base.y1 * f + f - 1),
      cx: base.cx * f,
      cy: base.cy * f,
      area: areaSrc,
      contrast,
      stability,
      confidence,
      partner: -1,
    });
    return features.length - 1;
  };
  for (let i = 0; i < perScale[0].light.length; i++) take('light', i);
  for (let i = 0; i < perScale[0].dark.length; i++) take('dark', i);

  /* ---- 4. 配对：亮结构 + 邻近暗结构 ---- */
  for (let i = 0; i < features.length; i++) {
    if (features[i].role !== 'light') continue;
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < features.length; j++) {
      if (features[j].role !== 'dark') continue;
      const d = Math.hypot(features[j].cx - features[i].cx, features[j].cy - features[i].cy);
      if (d > (pairRadius ?? 16 * f)) continue;
      if (Math.abs(features[i].lab.L - features[j].lab.L) < pairMinDeltaL) continue;
      /*
       * 面积要**可比**（相差 ≤8 倍）。
       *
       * 一只瞳孔和它的眼白是同一量级的两块；而"猫身上一大片深色毛
       * + 旁边一颗浅色高光"面积能差 30 倍，那不是眼的复合结构。
       * 实测洛克猫两个深色块 901px / 474px 各自配上了一颗 27px 白点，
       * 于是被误判成 2 只眼、白拿 58 颗配额 —— cat balanced 的
       * blocks 从 51 涨到 60。鸭吉吉的真眼是 306:106、158:50，都在
       * 3-7 倍内，这条判据不伤它。
       */
      const ratio = features[i].area > features[j].area
        ? features[i].area / features[j].area
        : features[j].area / features[i].area;
      if (ratio > pairMaxAreaRatio) continue;
      /*
       * 太弱的配不上"结构"二字，两端都要够硬。
       *
       * 门槛 0.30 是实测标定的：鸭吉吉三对复合特征的置信度是
       * (0.84,1.00) / (1.00,1.00) / (0.50,0.47)，全都过；而龟壳上
       * "一块亮反光 (0.69) + 一条深色纹路 (0.17)"这种误配对会被挡掉 ——
       * 它不是眼睛，给它配额反而把龟的 blocks 从 60 顶到 62。
       */
      if (features[i].confidence < 0.30 || features[j].confidence < 0.30) continue;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best >= 0) {
      features[i].partner = best;
      features[best].partner = i;
    }
  }

  // 单独的细线没有亮暗配对，模糊后也可能消失；改用连续性和双侧对比验证。
  features.push(...detectThinDarkStrokes(lab, alpha, dw, dh, f, maxAreaFrac, minContrast, features));
  features.push(...detectMidtoneStrokes(lab, alpha, dw, dh, f, maxAreaFrac, minContrast, features));
  return features;
}

/**
 * 只接纳有端点、局部约一像素宽、两侧均有不透明高对比前景的暗线。
 * 闭合轮廓、粗色块、透明剪影边和孤立噪点均不获得这条配额。
 * 检测仍在 ≤512 的副本上运行；8 邻域让一像素斜线保持同一身份。
 */
function detectThinDarkStrokes(
  lab: Float32Array,
  alpha: Float32Array,
  w: number,
  h: number,
  sourceScale: number,
  maxAreaFrac: number,
  minContrast: number,
  paired: StructuralFeature[],
): StructuralFeature[] {
  const out: StructuralFeature[] = [];
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < dark.length; i++) {
    if (alpha[i] >= 0.9 && NEAR_DARK(lab[i * 3], Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]))) dark[i] = 1;
  }
  const comps = components(lab, alpha, w, h, NEAR_DARK, 16, true, true);
  const across = [[2, 0], [0, 2], [2, 2], [2, -2]];
  for (const c of comps) {
    if (Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1) < 24 || c.area > w * h * maxAreaFrac) continue;
    // 已配对的瞳孔继续由原有面积预算负责，避免同一结构被重复增宽。
    if (paired.some((p) => p.partner >= 0 && p.role === 'dark' &&
      p.x0 <= c.x1 * sourceScale && p.x1 >= c.x0 * sourceScale &&
      p.y0 <= c.y1 * sourceScale && p.y1 >= c.y0 * sourceScale)) continue;
    const pixels = c.pixels!;
    let endpoints = 0;
    let degreeSum = 0;
    let supported = 0;
    let contrastSum = 0;
    for (const i of pixels) {
      const x = i % w;
      const y = (i / w) | 0;
      let degree = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
        degree += dark[(y + dy) * w + x + dx];
      }
      if (degree === 1) endpoints++;
      degreeSum += degree;
      let contrast = 0;
      for (const [dx, dy] of across) {
        const ax = x - dx, ay = y - dy, bx = x + dx, by = y + dy;
        if (ax < 0 || ax >= w || ay < 0 || ay >= h || bx < 0 || bx >= w || by < 0 || by >= h) continue;
        const a = ay * w + ax, b = by * w + bx;
        if (alpha[a] < 0.9 || alpha[b] < 0.9 || dark[a] || dark[b]) continue;
        const distance = (j: number) => oklabDist(c.lab, { L: lab[j * 3], a: lab[j * 3 + 1], b: lab[j * 3 + 2] });
        contrast = Math.max(contrast, Math.min(distance(a), distance(b)));
      }
      if (contrast >= minContrast) {
        supported++;
        contrastSum += contrast;
      }
    }
    const support = supported / c.area;
    if (endpoints < 2 || endpoints > 8 || degreeSum / c.area > 2.6 || support < 0.85) continue;
    const contrast = contrastSum / supported;
    const strokePixels = new Float32Array(c.area * 2);
    for (let i = 0; i < pixels.length; i++) {
      strokePixels[i * 2] = (pixels[i] % w + 0.5) * sourceScale;
      strokePixels[i * 2 + 1] = (((pixels[i] / w) | 0) + 0.5) * sourceScale;
    }
    out.push({
      role: 'dark', lab: c.lab, x0: c.x0 * sourceScale, y0: c.y0 * sourceScale,
      x1: (c.x1 + 1) * sourceScale - 1, y1: (c.y1 + 1) * sourceScale - 1,
      cx: c.cx * sourceScale, cy: c.cy * sourceScale, area: c.area * sourceScale * sourceScale,
      contrast, stability: support, confidence: support * clamp01((contrast - minContrast) / 0.25),
      partner: -1, sourcePixels: strokePixels, sourcePixelSize: sourceScale, stroke: true,
    });
  }
  return out;
}

/**
 * 中间调的细长凹线（嘴线、衣褶）：两侧都必须更亮，并以局部谷底确定中心。
 * 这类信号允许低于黑墨线的反差，因此另要求长宽比 ≥6，排除弯曲色块边缘。
 */
function detectMidtoneStrokes(
  lab: Float32Array,
  alpha: Float32Array,
  w: number,
  h: number,
  sourceScale: number,
  maxAreaFrac: number,
  minContrast: number,
  paired: StructuralFeature[],
): StructuralFeature[] {
  const ridge = new Uint8Array(w * h);
  const contrasts = new Float32Array(w * h);
  const axes = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const L = lab[i * 3];
      if (alpha[i] < 0.9 || L < 0.30 || L > 0.65 || Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]) > 0.13) continue;
      const center = { L, a: lab[i * 3 + 1], b: lab[i * 3 + 2] };
      let best = 0;
      for (const [dx, dy] of axes) {
        const sides: { distance: number; contrast: number }[] = [];
        for (const sign of [-1, 1]) {
          let distance = 0;
          let contrast = 0;
          for (let d = 1; d <= 6; d++) {
            const xx = x + dx * d * sign;
            const yy = y + dy * d * sign;
            if (xx < 0 || xx >= w || yy < 0 || yy >= h || alpha[yy * w + xx] < 0.9) break;
            const j = yy * w + xx;
            const delta = oklabDist(center, { L: lab[j * 3], a: lab[j * 3 + 1], b: lab[j * 3 + 2] });
            if (!distance && lab[j * 3] - L > 0.10 && delta > 0.16) distance = d;
            if (distance) contrast = Math.max(contrast, delta);
          }
          sides.push({ distance, contrast });
        }
        const [left, right] = sides;
        if (left.distance && right.distance && left.distance <= right.distance &&
          right.distance - left.distance <= 1 && left.distance + right.distance <= 12) {
          best = Math.max(best, Math.min(left.contrast, right.contrast));
        }
      }
      if (best >= 0.22) {
        ridge[i] = 1;
        contrasts[i] = best;
      }
    }
  }

  const out: StructuralFeature[] = [];
  for (const c of components(lab, alpha, w, h, (_L, _C, i) => ridge[i] === 1, 16, true, true)) {
    const spanX = c.x1 - c.x0 + 1;
    const spanY = c.y1 - c.y0 + 1;
    if (Math.max(spanX, spanY) < 24 || c.area > w * h * maxAreaFrac || c.lab.L < 0.35 ||
      Math.hypot(c.lab.a, c.lab.b) > 0.10 || Math.max(spanX, spanY) / Math.min(spanX, spanY) < 6) continue;
    if (paired.some((p) => p.partner >= 0 && p.role === 'dark' &&
      p.x0 <= c.x1 * sourceScale && p.x1 >= c.x0 * sourceScale &&
      p.y0 <= c.y1 * sourceScale && p.y1 >= c.y0 * sourceScale)) continue;

    let endpoints = 0;
    let degreeSum = 0;
    let contrast = 0;
    for (const i of c.pixels!) {
      const x = i % w;
      const y = (i / w) | 0;
      let degree = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
          degree += ridge[(y + dy) * w + x + dx];
        }
      }
      if (degree === 1) endpoints++;
      degreeSum += degree;
      contrast += contrasts[i];
    }
    contrast /= c.area;
    if (endpoints < 2 || endpoints > 8 || degreeSum / c.area > 3.2 || contrast < Math.max(0.24, minContrast * 0.8)) continue;

    const strokePixels = new Float32Array(c.area * 2);
    for (let i = 0; i < c.pixels!.length; i++) {
      const p = c.pixels![i];
      strokePixels[i * 2] = (p % w + 0.5) * sourceScale;
      strokePixels[i * 2 + 1] = (((p / w) | 0) + 0.5) * sourceScale;
    }
    out.push({
      role: 'dark', lab: c.lab,
      x0: c.x0 * sourceScale, y0: c.y0 * sourceScale,
      x1: (c.x1 + 1) * sourceScale - 1, y1: (c.y1 + 1) * sourceScale - 1,
      cx: c.cx * sourceScale, cy: c.cy * sourceScale,
      area: c.area * sourceScale * sourceScale,
      contrast, stability: 1, confidence: clamp01((contrast - 0.16) / 0.3),
      partner: -1, sourcePixels: strokePixels, sourcePixelSize: sourceScale, stroke: true,
    });
  }
  return out;
}

function ringContrastComponent(
  lab: Float32Array,
  alpha: Float32Array,
  w: number,
  h: number,
  comp: RawComp,
  isSamePolarity: (L: number, C: number) => boolean,
): number {
  const band = new Set<number>();
  for (const i of comp.pixels ?? []) {
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      const j = yy * w + xx;
      if (alpha[j] < 0.9 || isSamePolarity(lab[j * 3], Math.hypot(lab[j * 3 + 1], lab[j * 3 + 2]))) continue;
      band.add(j);
    }
  }
  const distances = [...band].map((j) => oklabDist(comp.lab, {
    L: lab[j * 3], a: lab[j * 3 + 1], b: lab[j * 3 + 2],
  }));
  distances.sort((a, b) => a - b);
  return distances.length ? distances[Math.floor(distances.length * 0.75)] : 0;
}

/** 线性光 RGB(0..1) → OKLab，避免为了降采样再导入一次转换 */
function linearToOklabComponent(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

/**
 * 源图像素坐标 → 网格坐标的映射，与 `supersample(fit='contain')` 完全一致。
 *
 * 返回闭区间 [c0,c1]×[r0,r1] 的格子范围，供配额落位时圈定候选格。
 */
export function projectFeatureToGrid(
  feat: StructuralFeature,
  srcW: number,
  srcH: number,
  cols: number,
  rows: number,
): { c0: number; c1: number; r0: number; r1: number } {
  const k = Math.min(cols / srcW, rows / srcH);
  const cellX = (sx: number) => (cols - srcW * k) / 2 + sx * k;
  const cellY = (sy: number) => (rows - srcH * k) / 2 + sy * k;
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  return {
    c0: clamp(Math.floor(cellX(feat.x0)), cols - 1),
    c1: clamp(Math.ceil(cellX(feat.x1)), cols - 1),
    r0: clamp(Math.floor(cellY(feat.y0)), rows - 1),
    r1: clamp(Math.ceil(cellY(feat.y1)), rows - 1),
  };
}

export { oklabDist };

// ---------------------------------------------------------------------------
// 特征 → 豆子配额 → 网格落位
// ---------------------------------------------------------------------------

/**
 * 一个源图特征在目标网格上的"占位计划"。
 *
 * 这是整条特征链路的交付物：不是一个"要救的色 hex"，而是
 * "这块结构占哪几格、每格该是亮还是暗、至少几颗"。下游的清理
 * （剪枝/去碎块/混色消除）只看这份计划，不再各自理解
 * `protectedCells` / `protectedHexes` / `protectedUse` 三套概念。
 */
export interface FeaturePlan {
  role: FeatureRole;
  /** 亮/暗两极里应该用的豆色（由调用方按 brand 提供） */
  bead: BeadColor;
  /** 允许用的候选豆色（近重复色都在里面，避免下标分桶凑不够数） */
  allowed: BeadColor[];
  /** 覆盖到的格子（长边顺序扁平下标，去重） */
  cells: number[];
  /** 同一条窄线的边界覆盖格；路径已表达后，不再把混色残影当独立强调色。 */
  strokeFringe?: number[];
  /** 配额：至少要有几颗豆 */
  minBeads: number;
  /** 已实际落下的豆数 */
  placed: number;
  /** 采信度 */
  confidence: number;
  /** 复合特征 id：同一只眼的亮+暗共享同一个 groupId */
  groupId: number;
}

export interface PlanOptions {
  cols: number;
  rows: number;
  /** 目标网格覆盖的源图区域（与 supersample 的 fit 一致） */
  srcW: number;
  srcH: number;
  fit: 'contain' | 'cover';
  /** 亮极候选（全部近白豆色） */
  lightCandidates: BeadColor[];
  /** 暗极候选（全部近深豆色） */
  darkCandidates: BeadColor[];
  strokeCandidates?: BeadColor[];
  /** 该极性至少几颗 —— 由面积预算算出，小于 1 按 1 算 */
  minBeadsFor?: (f: StructuralFeature, cellArea: number) => number;
}

/**
 * 源图像素 → 网格格子的映射，与 `resample.ts` 的 `supersample` 严格一致。
 *
 * `contain` 时源图等比缩进网格并居中（左右/上下留边），`cover` 时铺满
 * 并裁掉溢出。这里只算"某源点落在哪一格"，用于把特征投影成格集合。
 */
function mapper(srcW: number, srcH: number, cols: number, rows: number, fit: 'contain' | 'cover') {
  const scale = fit === 'cover' ? Math.max(cols / srcW, rows / srcH) : Math.min(cols / srcW, rows / srcH);
  const offX = (cols - srcW * scale) / 2;
  const offY = (rows - srcH * scale) / 2;
  return { scale, offX, offY };
}

/**
 * 把源图特征投影成网格上的「占位计划」。
 *
 * 关键点（这是与旧 `rescueCoherentFeatures` 的本质区别）：
 *   - 旧实现是网格池化完之后，逐格问"你委不委屈"，再按候选色分桶。
 *     采样相位一变（64/80/96），同一只眼走的路径完全不同，于是出现
 *     "64 有白无黑、80 有黑无白"这种荒诞结果。
 *   - 这里先把**源图上这块结构占了多少面积**算成配额，落到网格上时
 *     只解决"摆在哪"。取样相位只影响形状细节，不影响"它是否存在"。
 *
 * 还返回一份按格的极性标记 `polarity`（0=无、1=亮、2=暗），下游的
 * 约束求解和清理阶段直接读它，不需要再按下标去猜。
 */
export function planFeaturePlacement(
  features: StructuralFeature[],
  opts: PlanOptions,
): { plans: FeaturePlan[]; polarity: Uint8Array; groupOf: Int16Array } {
  const { cols, rows, srcW, srcH, fit, lightCandidates, darkCandidates } = opts;
  const n = cols * rows;
  const polarity = new Uint8Array(n);
  const groupOf = new Int16Array(n).fill(-1);
  const plans: FeaturePlan[] = [];
  if (!features.length) return { plans, polarity, groupOf };

  const { scale, offX, offY } = mapper(srcW, srcH, cols, rows, fit);
  /*
   * 单格覆盖的源图像素面积 = (1/scale)²。
   * `scale` 是"源图 1px 占多少格"，所以一格边长覆盖 1/scale 个源像素。
   * 面积预算是这套方案的核心：`k_f ≈ 特征面积 / cellSrcArea`。
   */
  const cellSrcArea = 1 / (scale * scale);

  // 亮/暗按对分组，一只眼 = 一个 group，共享 groupId
  const groupIdOf = new Int16Array(features.length).fill(-1);
  let nextGroup = 0;
  for (let i = 0; i < features.length; i++) {
    if (groupIdOf[i] >= 0) continue;
    groupIdOf[i] = nextGroup;
    const p = features[i].partner;
    if (p >= 0 && groupIdOf[p] < 0) groupIdOf[p] = nextGroup;
    nextGroup++;
  }

  for (let fi = 0; fi < features.length; fi++) {
    const f = features[fi];
    /*
     * **亮暗小块只给"成对"特征分配面积配额；连续窄线使用路径配额。**
     *
     * 这是整套方案能否不伤回归门禁的关键。单个孤立的高光不是眼睛 ——
     * 龟壳上的反光（实测 17 个亮特征、面积 142-257px、对比 0.41-0.52）
     * 全部通过面积/对比/稳定三重检验，但它们本来就被大面积色很好地
     * 表达了，不需要配额。给它们配额反而会把大色块切碎。
     *
     * 而"亮紧邻暗、且明度差 ≥0.35"正是眼睛/牙齿/高光的结构定义 ——
     * 用户原话要的就是这个：「如果鸭吉吉的眼睛你能保持细节很充分，
     * 那么这个算法也能过关」。实测鸭吉吉两只眼各是 (白,黑) 复合对，
     * 猫有 2 对，叶/龟 0 对 —— 判据自动把"不该救的"排除掉了。
     */
    if (f.partner < 0 && !f.stroke) continue;
    const isLight = f.role === 'light';
    const cands = f.stroke ? opts.strokeCandidates ?? darkCandidates : isLight ? lightCandidates : darkCandidates;
    if (!cands.length) continue;
    const bead = nearestOf(f.lab, cands);

    /*
     * 配额：`k_f ≈ 面积 / 单格面积`。
     *
     * 这是整套方案最值钱的一步 —— 一只眼该分几颗白豆是**先算出来的**，
     * 然后再解决摆在哪。实测鸭吉吉白核心 156px：gs=64 (53.8px²/格) → 2.9 颗、
     * gs=80 → 4.5 颗、gs=96 → 6.5 颗。三档都 ≥2，所以三档都该有白。
     * 旧实现里 64/80 全丢，纯粹是因为它没算过这个预算。
     *
     * 下限 1：只要特征通过了检测（面积/对比/稳定三重检验），它就值得
     * 占一颗豆。上限 48：再大的特征已经是主体色的事，配额再多没意义。
     */
    const kRaw = f.area * f.confidence / Math.max(1e-6, cellSrcArea);
    let minBeads = opts.minBeadsFor
      ? opts.minBeadsFor(f, cellSrcArea)
      : Math.round(kRaw);
    if (minBeads < 1) minBeads = 1;
    if (minBeads > 48) minBeads = 48;

    // 优先投影实际支持像素；仅对没有支持集的旧调用者使用 bbox。
    const x0 = Math.max(0, f.x0 - 1);
    const y0 = Math.max(0, f.y0 - 1);
    const x1 = Math.min(srcW - 1, f.x1 + 1);
    const y1 = Math.min(srcH - 1, f.y1 + 1);
    const tally = new Map<number, number>();
    const strokeTouched = new Set<number>();
    const supportPixels = f.sourcePixels;
    if (supportPixels) {
      for (let i = 0; i < supportPixels.length; i += 2) {
        const gx = offX + supportPixels[i] * scale;
        const gy = offY + supportPixels[i + 1] * scale;
        const cx = Math.floor(gx);
        const cy = Math.floor(gy);
        if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
        const key = cy * cols + cx;
        tally.set(key, (tally.get(key) ?? 0) + (f.sourcePixelSize ?? 1) ** 2);
        if (!f.stroke) continue;
        const half = (f.sourcePixelSize ?? 1) * scale / 2;
        for (let r = Math.max(0, Math.floor(gy - half)); r <= Math.min(rows - 1, Math.ceil(gy + half) - 1); r++) {
          for (let c = Math.max(0, Math.floor(gx - half)); c <= Math.min(cols - 1, Math.ceil(gx + half) - 1); c++) {
            strokeTouched.add(r * cols + c);
          }
        }
      }
    } else {
      for (let sy = y0; sy <= y1; sy++) {
        const cy = Math.floor(offY + sy * scale);
        if (cy < 0 || cy >= rows) continue;
        for (let sx = x0; sx <= x1; sx++) {
          const cx = Math.floor(offX + sx * scale);
          if (cx < 0 || cx >= cols) continue;
          const key = cy * cols + cx;
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
      }
    }
    /*
     * 只保留"被这块特征实质覆盖"的格子。
     *
     * 阈值 0.12 格面积：特征 bbox 里往往还混着主体色，若把 bbox 全部
     * 算进去，一个 3px 的眼白会被摊成 20 格"候选"，配额就失去意义了。
     * 0.12 是实测标定 —— 鸭吉吉的眼白在 gs=64 时刚好留下 3-4 格，
     * gs=96 时 7-8 格，与理论配额同量级。
     */
    const cells: number[] = [];
    const needPix = cellSrcArea * 0.12;
    for (const [key, cnt] of tally) {
      if (f.stroke || cnt >= needPix) cells.push(key);
    }
    /*
     * 按"被该特征覆盖的源像素数"降序排。落位时从前往后取，于是豆子
     * 优先落在特征最实质覆盖的格子上 —— 一只只有 2-3 颗配额的眼白，
     * 就应该落在亮带的正中，而不是 bbox 边缘的过渡格。
     */
    if (!cells.length && tally.size) cells.push([...tally].sort((a,b)=>b[1]-a[1])[0][0]);
    cells.sort((a, b) => (tally.get(b) ?? 0) - (tally.get(a) ?? 0));
    // 一像素线缩小后面积预算往往不足一整条线；以投影路径的一格宽覆盖作为
    // 几何下限。只落真实支持格，绝不把交叉线的整个 bbox 涂成黑块。
    if (f.stroke) minBeads = cells.length;

    const plan: FeaturePlan = {
      role: f.role,
      bead,
      allowed: cands,
      cells,
      ...(f.stroke ? { strokeFringe: [...strokeTouched].filter((key) => !tally.has(key)) } : {}),
      minBeads,
      placed: 0,
      confidence: f.confidence,
      groupId: groupIdOf[fi],
    };
    const pi = plans.length;
    plans.push(plan);
    /*
     * polarity 按"置信度优先"落标记：高置信度的特征先占格，
     * 低置信度的不许覆盖它。这样细亮带与相邻黑区不会互相抢同一格。
     */
    for (const key of cells) {
      const want = isLight ? 1 : 2;
      const have = polarity[key];
      if (have === 0) {
        polarity[key] = want;
        groupOf[key] = plan.groupId;
      } else if (have === want) {
        if (groupOf[key] < 0) groupOf[key] = plan.groupId;
      } else {
        // 冲突：保留置信度更高的那个
        const prev = plans.findIndex((p) => p.groupId === groupOf[key] && ((p.role === 'light') === (have === 1)));
        if (prev >= 0 && plan.confidence > plans[prev].confidence) {
          polarity[key] = want;
          groupOf[key] = plan.groupId;
        }
      }
    }
    void pi;
  }

  return { plans, polarity, groupOf };
}

/** 在一组候选里找与 `lab` 最近的（候选含近重复色，避免下标分桶） */
function nearestOf(lab: Oklab, cands: BeadColor[]): BeadColor {
  let best = cands[0];
  let bd = Infinity;
  for (const c of cands) {
    const d = oklabDist(lab, c.lab);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
