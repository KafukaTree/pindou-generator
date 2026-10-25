/**
 * 原生像素网格识别
 * ===============================================================
 * 为什么需要它
 * ---------------------------------------------------------------
 * 普通管线是为**照片**设计的：超采样 → 双边滤波 → 量化 → 众数池化。
 * 那套流程对照片是对的（照片的像素本身没有"格"，必须先在目标分辨率上
 * 重建信息），但对**本身就已经是像素画**的输入是有害的：
 *
 *   - 原图已经是 N×M 的色块棋盘，每块 B×B 像素；
 *   - 再按目标网格重新超采样，等于对同一个格子做二次取样，
 *     落点只要偏离半个格，就会同时抓到相邻两色 → 边缘长出一圈过渡杂色；
 *   - 双边滤波进一步把这些过渡色抹成中间色，量化后锚到色卡里
 *     根本不该出现的中间色号。
 *
 * 实测（7 张 AI 直出像素画，1280×1280，原生 96×96 格）：
 *   旧管线 边界脏边率 0.30–0.55，色号数比原生多 1.6–2.4 倍；
 *   按原生网格直接提取，脏边率降到接近 0。
 *
 * 判据（怎么区分像素画和照片）
 * ---------------------------------------------------------------
 * 试过的失败判据（留档，别再走一遍）：
 *   - 量化后 unique 色数：像素画 459–1576，照片 1002–1576 → 重叠；
 *   - 相邻差分双峰性：能分，但余量不如峰度；
 *   - 块内方差/块纯度扫描：块越小方差必然越小，判据有偏，
 *     而且强行全局刚性拟合会被 r1/r2/r7 的**非均匀格宽**带崩；
 *   - 边缘解释率：B→最小值时覆盖率必然 1.0，无区分力。
 *
 * 真正有效的是**边缘柱峰度**：像素画的边缘永远落在同样那几条
 * 栅格线上，所以"每列有多少强梯度像素"的分布极度尖峰；照片的边缘
 * 逐行漂移，分布接近均匀。
 *
 *   实测 peakRatio（峰值 / 均值）：
 *     像素画 6.8 – 23.8   照片 3.2 – 5.3
 *   → 阈值 6.0，两侧余量都 ≥ 0.8。
 *
 * 再配合**自相关基音**定格宽：边缘柱的自相关在真实格宽处出现
 * 第一个显著峰；倍频（2B、3B）也高，所以取**最小的**显著峰即可
 * 天然避开谐波。最后在基音 ±15% 内用相位集中度 R(B) 做亚像素精修。
 *
 * 实测精度（1280×1280 原生 96 格 → B = 1280/96 = 13.33333）：
 *   r3 B=13.340/13.335，r4 13.335/13.335，r5 13.335/13.330，
 *   r6 B=26.670/26.665（原生 48 格，正确识别为"2 块 1 格"）
 */

import { deltaE2, rgbToOklab, type Oklab } from '@/lib/color/oklab';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 单轴的检测结果 */
export interface AxisGrid {
  /** 每格的像素宽/高（亚像素精度，可为非整数） */
  block: number;
  /** 格边界相对图像左上角的相位偏移，落在 [0, block) */
  phase: number;
  /** 该轴能排下的格数 */
  count: number;
  /** 相位集中度 0–1（软边重采样过的图天然偏低，只作信度参考） */
  concentration: number;
  /** 边缘柱峰度 = 峰值列梯度计数 / 均值；照片 3.2–5.3，像素画 6.8–23.8 */
  peakRatio: number;
  /** 块纯度 0–1：沿晶格切块后，块内像素贴合块中位色的比例 */
  purity: number;
}

/** 原生网格检测结果 */
export interface NativeGrid {
  /** 两个轴都通过门禁才是 true */
  detected: boolean;
  /** 总信度 0–1，低于 gate 的候选已被判为 detected=false */
  confidence: number;
  /** 水平方向格宽（像素） */
  blockX: number;
  /** 垂直方向格宽（像素） */
  blockY: number;
  /** 原生网格的列数 = round(width / blockX) */
  cols: number;
  /** 原生网格的行数 = round(height / blockY) */
  rows: number;
  /** 水平轴细节（调试/UI 用） */
  x: AxisGrid;
  /** 垂直轴细节 */
  y: AxisGrid;
  /** 该轴没通过门禁时的原因，便于自检 */
  reason?: string;
}

/** 一块原生网格的整块颜色（sRGB 0–255）+ 覆盖率 */
export interface NativeCell {
  r: number;
  g: number;
  b: number;
  /** 该格中属于"主体"（非背景）的面积占比 0–1 */
  cover: number;
}

/** 居中校准的结果 */
export interface CanvasShift {
  cols: number;
  rows: number;
  /** cells，-1 = 空；与 generate.ts 的 PatternResult.cells 同约定 */
  cells: Int16Array;
  /** 实际平移量（格）。正 = 向右/向下 */
  dx: number;
  dy: number;
  /** 是否真的动了 */
  moved: boolean;
  /** 平移前 / 后四边的最小余量 */
  marginBefore: number;
  marginAfter: number;
}

/** 画板尺寸变化时重映射已有图案的结果 */
export interface PatternResize {
  cols: number;
  rows: number;
  /** 新网格上的 cells；-1 = 空 */
  cells: Int16Array;
  /** 是否真的动了（尺寸没变或空图时为 false） */
  resized: boolean;
  /** 落在新网格之外的源豆数（源图比画板大时会被裁掉） */
  clippedCells: number;
  /** 新网格里由源空格填充的格数（保持透明，不会凭空长豆） */
  emptyCells: number;
  /** 长宽比变化幅度：1 = 完全等比。差得多时图案会被"拉扁/拉长" */
  aspectDistort: number;
  /**
   * 源格下标 → 新格下标（长度 cols*rows，-1 = 该源格没落到新网格里）。
   *
   * 给**手工编辑层**用的：编辑记录是按"行优先下标"存的（见 edits.ts 的
   * EditMap），画板一换尺寸，旧下标全部失效。拿这张表把键过一遍，
   * 用户之前改过的格子就能跟着图案一起搬过去，不用重画。
   */
  indexMap: Int32Array;
}

/** 放大校准的结果 */
export interface CanvasScale {
  cols: number;
  rows: number;
  cells: Int16Array;
  /** 实际采用的放大倍率；1 = 未改动 */
  appliedScale: number;
  /** 缩放后变空的格数（原本有豆、缩放后没豆）—— 空洞 */
  holeCells: number;
  /** 缩放后宽度不一致的格数 —— 「锯齿」。整数倍缩放恒为 0 */
  raggedCells: number;
  /** 实际采用的模式 */
  mode: 'none' | 'integer' | 'nearest';
}

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const EDGE_THRESHOLD = 18;
const MIN_BLOCK = 6;
const MAX_BLOCK = 72;
const ACF_MIN_HEIGHT = 0.3;
const ACF_MIN_PROMINENCE = 0.08;
const PEAK_RATIO_MIN = 6.0;
const PURITY_MIN = 0.82;
/** 原生格数上限：再多就超出拼豆常用规格，按照片处理 */
const MAX_NATIVE_COLS = 256;

/* ------------------------------------------------------------------ *
 * 单轴检测
 * ------------------------------------------------------------------ */

/** 强梯度计数投影：每列（或每行）有多少像素是陡峭边缘 */
function edgeCountProfile(
  img: ImageData,
  axis: 'x' | 'y',
  threshold: number,
): Float64Array {
  const { width: w, height: h, data } = img;
  const len = axis === 'x' ? w : h;
  const prof = new Float64Array(len);
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const o = (y * w + x) * 4;
      const p = o - 4;
      const u = o - w * 4;
      const d =
        axis === 'x'
          ? Math.abs(data[o] - data[p]) +
            Math.abs(data[o + 1] - data[p + 1]) +
            Math.abs(data[o + 2] - data[p + 2])
          : Math.abs(data[o] - data[u]) +
            Math.abs(data[o + 1] - data[u + 1]) +
            Math.abs(data[o + 2] - data[u + 2]);
      if (d > threshold) {
        if (axis === 'x') prof[x]++;
        else prof[y]++;
      }
    }
  }
  return prof;
}

/** 归一化自相关（无偏修正），用于找基音周期 */
function autocorrelation(prof: Float64Array): Float64Array {
  const n = prof.length;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += prof[i] * prof[i];
  const maxLag = Math.min(96, Math.floor(n / 3));
  const A = new Float64Array(maxLag + 1);
  if (e0 <= 0) return A;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    const cnt = n - lag;
    for (let i = 0; i < cnt; i++) s += prof[i] * prof[i + lag];
    A[lag] = (s / e0) * (n / Math.max(1, cnt));
  }
  return A;
}

/** 相位集中度 R(B)：把边缘位置当复平面上的单位向量，看它们是否落进同一相位 */
function concentration(
  prof: Float64Array,
  block: number,
): { R: number; phase: number } {
  let re = 0;
  let im = 0;
  let sw = 0;
  for (let i = 1; i < prof.length; i++) {
    const w = prof[i];
    if (w <= 0) continue;
    const th = (2 * Math.PI * i) / block;
    re += w * Math.cos(th);
    im += w * Math.sin(th);
    sw += w;
  }
  if (sw <= 0) return { R: 0, phase: 0 };
  let phase = (Math.atan2(im, re) / (2 * Math.PI)) * block;
  phase %= block;
  if (phase < 0) phase += block;
  /*
   * 相位恰好落在块边界上时，`phase` 会算成 block 而不是 0。
   *
   * 这不是理论情况 —— 合成图 / 无损像素画上 100% 命中：真值相位 0 时
   * 实测 phase=15.999999999994191、block=16.000000000000373，于是
   * `15.999999999994191 % 16.000000000000373` 不取模、原样返回，差那
   * 4e-13 就让后面所有取样窗口整体后移**一整块**：输出满足
   * out[r][c] == truth[r+1][c+1]，最后一行/列落到图外被钳到边界。
   *
   * 判据用「到 block 的距离 < 1e-3」而不是精确相等：偏差来自三角函数
   * 的浮点残差，量级 1e-12，而真正要区分的两种相位至少差半个像素
   * （像素画的块宽 ≥ 3），所以这个阈值不会误合并。
   */
  if (block - phase < 1e-3) phase = 0;
  return { R: Math.hypot(re, im) / sw, phase };
}

/**
 * 自适应容差：软边图（被重采样过的）块内会有 2–3px 渐变，
 * 容差必须放宽，否则会把正确的格宽判死。
 */
function edgeSoftness(prof: Float64Array): number {
  let mx = 0;
  for (const v of prof) if (v > mx) mx = v;
  if (mx <= 0) return 1;
  let sum = 0;
  let cnt = 0;
  for (const v of prof) {
    if (v > mx * 0.35) {
      sum += v;
      cnt++;
    }
  }
  return cnt ? sum / (mx * cnt) : 1;
}

/**
 * 块纯度：按晶格切块，在每块内部取若干点，看它们是否都接近块的中位色。
 *
 * 用**中位数**而不是均值：JPEG 在硬边两侧会有振铃，均值会被拉偏，
 * 中位数不受影响。
 */
function blockPurity(
  img: ImageData,
  axis: 'x' | 'y',
  block: number,
  phase: number,
  tolerance: number,
  lines = 48,
): number {
  const { width: w, height: h, data } = img;
  const along = axis === 'x' ? w : h;
  const cross = axis === 'x' ? h : w;
  // 块边界向内缩一圈，避开抗锯齿过渡带
  const inset = Math.max(1, Math.round(block * 0.18));
  const step = Math.max(1, Math.floor(cross / lines));
  let hit = 0;
  let total = 0;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  for (let c = step >> 1; c < cross; c += step) {
    const maxK = Math.ceil(along / block) + 1;
    for (let k = -2; k <= maxK; k++) {
      const a = Math.max(0, Math.ceil(phase + k * block + inset));
      const b = Math.min(along - 1, Math.floor(phase + (k + 1) * block - inset));
      if (b - a < 1) continue;
      const samples = Math.min(9, b - a + 1);
      rs.length = 0;
      gs.length = 0;
      bs.length = 0;
      for (let t = 0; t < samples; t++) {
        const q = a + Math.round((t * (b - a)) / Math.max(1, samples - 1));
        const px = axis === 'x' ? q : c;
        const py = axis === 'x' ? c : q;
        const o = (py * w + px) * 4;
        rs.push(data[o]);
        gs.push(data[o + 1]);
        bs.push(data[o + 2]);
      }
      const mr = median(rs);
      const mg = median(gs);
      const mb = median(bs);
      let ok = true;
      for (let t = 0; t < samples; t++) {
        if (
          Math.abs(rs[t] - mr) + Math.abs(gs[t] - mg) + Math.abs(bs[t] - mb) >
          tolerance
        ) {
          ok = false;
          break;
        }
      }
      if (ok) hit++;
      total++;
    }
  }
  return total ? hit / total : 0;
}

function median(arr: number[]): number {
  const n = arr.length;
  if (!n) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[n >> 1];
}

/** 检测单轴原生格宽 */
export function detectAxisGrid(img: ImageData, axis: 'x' | 'y'): AxisGrid {
  const prof = edgeCountProfile(img, axis, EDGE_THRESHOLD);

  let peak = 0;
  let sum = 0;
  for (const v of prof) {
    if (v > peak) peak = v;
    sum += v;
  }
  const mean = sum / Math.max(1, prof.length);
  const peakRatio = mean > 0 ? peak / mean : 0;
  const softness = edgeSoftness(prof);

  // 自相关最小显著峰 = 基音（天然避开 2B/3B 谐波）
  const A = autocorrelation(prof);
  const maxLag = A.length - 1;
  let fundamental = 0;
  for (let lag = MIN_BLOCK; lag <= Math.min(MAX_BLOCK, maxLag); lag++) {
    if (!(A[lag] >= A[lag - 1] && A[lag] >= A[lag + 1])) continue;
    let lm = Infinity;
    let rm = Infinity;
    const lo = Math.max(2, lag - Math.round(lag * 0.45));
    const hi = Math.min(maxLag, lag + Math.round(lag * 0.6));
    for (let i = lo; i < lag; i++) if (A[i] < lm) lm = A[i];
    for (let i = lag + 1; i <= hi; i++) if (A[i] < rm) rm = A[i];
    const base = Math.max(lm === Infinity ? 0 : lm, rm === Infinity ? 0 : rm);
    if (A[lag] >= ACF_MIN_HEIGHT && A[lag] - base >= ACF_MIN_PROMINENCE) {
      fundamental = lag;
      break;
    }
  }

  if (!fundamental) {
    return {
      block: 0,
      phase: 0,
      count: 0,
      concentration: 0,
      peakRatio,
      purity: 0,
    };
  }

  // 亚像素精修：基音 ±15% 内最大化相位集中度
  let best = { block: fundamental, R: -1, phase: 0 };
  for (let B = fundamental * 0.85; B <= fundamental * 1.15; B += 0.005) {
    if (B < MIN_BLOCK) continue;
    const c = concentration(prof, B);
    if (c.R > best.R) best = { block: B, R: c.R, phase: c.phase };
  }

  const tolerance = Math.max(20, Math.round(softness * 26));
  const purity = blockPurity(img, axis, best.block, best.phase, tolerance);
  const len = axis === 'x' ? img.width : img.height;

  return {
    block: best.block,
    phase: best.phase,
    count: Math.round(len / best.block),
    concentration: best.R,
    peakRatio,
    purity,
  };
}

/* ------------------------------------------------------------------ *
 * 主检测入口
 * ------------------------------------------------------------------ */

/**
 * 识别输入图的原生像素网格。
 *
 * 返回 `detected=false` 时调用方**必须**退回普通管线 —— 低置信度的
 * 格宽比普通管线更糟（用户会用手机拍屏，那种输入不该走这里）。
 */
export function detectNativePixelGrid(
  img: ImageData,
  opts: { minBlock?: number; maxBlock?: number } = {},
): NativeGrid {
  const minBlock = opts.minBlock ?? MIN_BLOCK;
  const maxBlock = opts.maxBlock ?? MAX_BLOCK;

  const x = detectAxisGrid(img, 'x');
  const y = detectAxisGrid(img, 'y');

  const fail = (reason: string): NativeGrid => ({
    detected: false,
    confidence: 0,
    blockX: x.block,
    blockY: y.block,
    cols: x.count,
    rows: y.count,
    x,
    y,
    reason,
  });

  if (!x.count || !y.count) return fail('no-periodicity');
  if (x.block < minBlock || x.block > maxBlock) return fail('block-out-of-range');
  if (y.block < minBlock || y.block > maxBlock) return fail('block-out-of-range');
  // 两轴格宽不该差太多（像素画的格是正方形；差 2 倍以上是误检）
  const ratio = Math.max(x.block, y.block) / Math.min(x.block, y.block);
  if (ratio > 1.8) return fail('anisotropic');
  if (x.count > MAX_NATIVE_COLS || y.count > MAX_NATIVE_COLS) {
    return fail('too-many-blocks');
  }
  if (x.peakRatio < PEAK_RATIO_MIN || y.peakRatio < PEAK_RATIO_MIN) {
    return fail(
      `not-pixel-art(peakRatio=${x.peakRatio.toFixed(1)},${y.peakRatio.toFixed(1)})`,
    );
  }
  if (x.purity < PURITY_MIN || y.purity < PURITY_MIN) {
    return fail(`impure(purity=${x.purity.toFixed(2)},${y.purity.toFixed(2)})`);
  }

  // 信度：峰度余量 × 纯度余量
  const conf =
    Math.min(1, Math.max(0, (Math.min(x.peakRatio, y.peakRatio) - 5) / 8)) *
    Math.min(1, Math.max(0, (Math.min(x.purity, y.purity) - 0.75) / 0.2));

  return {
    detected: true,
    confidence: conf,
    blockX: x.block,
    blockY: y.block,
    cols: x.count,
    rows: y.count,
    x,
    y,
  };
}

/* ------------------------------------------------------------------ *
 * 取色
 * ------------------------------------------------------------------ */

/**
 * 按原生网格逐格取色。
 *
 * 每格用**中位数**取色，不用平均：
 *   - JPEG 在硬边两侧有振铃（一边偏亮一边偏暗），平均会被拉成中间色；
 *   - 中位数对 10–20% 的离群像素免疫，取到的就是真实色块色。
 *
 * 每格只用内侧 `inset` 比例的像素，避开块边界的抗锯齿过渡带。
 */
export function sampleNativeCells(
  img: ImageData,
  grid: NativeGrid,
  bgMask?: Float32Array | null,
  inset = 0.18,
): NativeCell[] {
  const { width: w, height: h, data } = img;
  const { blockX, blockY, cols, rows, x, y } = grid;
  const cells: NativeCell[] = new Array(cols * rows);
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  for (let r = 0; r < rows; r++) {
    const ya = y.phase + r * blockY;
    const yb = y.phase + (r + 1) * blockY;
    const y0 = Math.max(0, Math.ceil(ya + blockY * inset));
    const y1 = Math.min(h, Math.floor(yb - blockY * inset));
    for (let c = 0; c < cols; c++) {
      const xa = x.phase + c * blockX;
      const xb = x.phase + (c + 1) * blockX;
      const x0 = Math.max(0, Math.ceil(xa + blockX * inset));
      const x1 = Math.min(w, Math.floor(xb - blockX * inset));
      const idx = r * cols + c;

      if (x1 <= x0 || y1 <= y0) {
        // 图外 / 退化：退回整块中心一个点
        const px = Math.min(w - 1, Math.max(0, Math.round((xa + xb) / 2)));
        const py = Math.min(h - 1, Math.max(0, Math.round((ya + yb) / 2)));
        const o = (py * w + px) * 4;
        cells[idx] = { r: data[o], g: data[o + 1], b: data[o + 2], cover: 1 };
        continue;
      }

      rs.length = 0;
      gs.length = 0;
      bs.length = 0;
      let total = 0;
      let fg = 0;
      // 采样步长：大块时限流，避免 O(像素) 开销
      const stepY = Math.max(1, Math.floor((y1 - y0) / 12));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 12));
      for (let py = y0; py < y1; py += stepY) {
        for (let px = x0; px < x1; px += stepX) {
          total++;
          const f = bgMask ? bgMask[py * w + px] : 1;
          if (f <= 0.5) continue;
          fg++;
          const o = (py * w + px) * 4;
          rs.push(data[o]);
          gs.push(data[o + 1]);
          bs.push(data[o + 2]);
        }
      }

      if (fg === 0) {
        // 整格都是背景：仍取中位色，但 cover=0，交给上层判空
        let rr = 0;
        let gg = 0;
        let bb = 0;
        let n = 0;
        for (let py = y0; py < y1; py += stepY) {
          for (let px = x0; px < x1; px += stepX) {
            const o = (py * w + px) * 4;
            rr += data[o];
            gg += data[o + 1];
            bb += data[o + 2];
            n++;
          }
        }
        cells[idx] =
          n > 0
            ? {
                r: Math.round(rr / n),
                g: Math.round(gg / n),
                b: Math.round(bb / n),
                cover: 0,
              }
            : { r: 0, g: 0, b: 0, cover: 0 };
        continue;
      }

      cells[idx] = {
        r: median(rs),
        g: median(gs),
        b: median(bs),
        cover: total > 0 ? fg / total : 1,
      };
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ *
 * 原生网格 → 目标网格
 * ------------------------------------------------------------------ */

/**
 * 原生格 → 目标网格的**多数表决**降采样。
 *
 * 这是整条原生路径的核心：目标网格的每一格，去问"你覆盖了哪些原生格"，
 * 然后**按面积加权投票**选出现最多的那个原生色，而不是把颜色混在一起。
 * 混色会造出原图不存在的中间色，投票不会。
 *
 * 注意原生网格可能比目标网格**细**（例如原生 96 格、目标 58 格时
 * 每格覆盖 1.66 个原生格），也可能**粗**（原生 48 格、目标 96 格时
 * 每格只覆盖 0.5 个原生格 —— 这时就是放大，直接复制最近的原生格）。
 */
export function downsampleNative(
  cells: NativeCell[],
  grid: NativeGrid,
  targetCols: number,
  targetRows: number,
): { rgba: Float32Array; cover: Float32Array } {
  const { cols, rows } = grid;
  const rgba = new Float32Array(targetCols * targetRows * 3);
  const cover = new Float32Array(targetCols * targetRows);

  for (let tr = 0; tr < targetRows; tr++) {
    // 目标格覆盖的原生格区间（用中心坐标映射，保持"格"的语义）
    const sy0 = (tr * rows) / targetRows;
    const sy1 = ((tr + 1) * rows) / targetRows;
    for (let tc = 0; tc < targetCols; tc++) {
      const sx0 = (tc * cols) / targetCols;
      const sx1 = ((tc + 1) * cols) / targetCols;

      // 面积加权投票
      const votes = new Map<number, number>();
      let coverSum = 0;
      let areaSum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        if (sy < 0 || sy >= rows) continue;
        const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          if (sx < 0 || sx >= cols) continue;
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
          if (wx <= 0) continue;
          const a = wx * wy;
          const src = cells[sy * cols + sx];
          areaSum += a;
          coverSum += a * src.cover;
          // 量化到 6 bit/通道做投票键，避免同色微差被拆成多票
          const key =
            ((src.r >> 2) << 12) | ((src.g >> 2) << 6) | (src.b >> 2);
          votes.set(key, (votes.get(key) ?? 0) + a);
        }
      }

      const ti = tr * targetCols + tc;
      if (areaSum <= 0) {
        rgba[ti * 3] = 0;
        rgba[ti * 3 + 1] = 0;
        rgba[ti * 3 + 2] = 0;
        cover[ti] = 0;
        continue;
      }

      // 胜出的量化键 → 用该键下所有源格的面积加权均值还原精确颜色
      let bestKey = 0;
      let bestW = -1;
      for (const [key, wgt] of votes) {
        if (wgt > bestW) {
          bestW = wgt;
          bestKey = key;
        }
      }
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let wsum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        if (sy < 0 || sy >= rows) continue;
        const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          if (sx < 0 || sx >= cols) continue;
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
          if (wx <= 0) continue;
          const src = cells[sy * cols + sx];
          const key =
            ((src.r >> 2) << 12) | ((src.g >> 2) << 6) | (src.b >> 2);
          if (key !== bestKey) continue;
          const a = wx * wy;
          rr += a * src.r;
          gg += a * src.g;
          bb += a * src.b;
          wsum += a;
        }
      }
      if (wsum <= 0) {
        rgba[ti * 3] = 0;
        rgba[ti * 3 + 1] = 0;
        rgba[ti * 3 + 2] = 0;
        cover[ti] = 0;
        continue;
      }
      rgba[ti * 3] = rr / wsum;
      rgba[ti * 3 + 1] = gg / wsum;
      rgba[ti * 3 + 2] = bb / wsum;
      cover[ti] = coverSum / areaSum;
    }
  }
  return { rgba, cover };
}

/* ------------------------------------------------------------------ *
 * 画板校准
 * ------------------------------------------------------------------ */

/**
 * 画板校准 · 第一步：**居中**。
 *
 * 用户画的图常常偏在画板一角（鼠标起始点随手一点就开画），
 * 画板本身没被用满。这一步只做**平移**，不缩放：
 *
 *   - 纯平移不可能产生空洞，也不可能改变连通性（每颗豆的相对位置不变），
 *     所以这一步是绝对安全的，可以无条件给用户用；
 *   - 内容本来就已经居中/铺满时不动（省得每点一次都微调一格）。
 *
 * `minMargin` 是"已经够居中"的容差：四边余量差 ≥ 2 格才值得动手，
 * 否则用户点两次会看到图案被一格一格地推来推去。
 */
export function centerPattern(
  cells: Int16Array,
  cols: number,
  rows: number,
  opts: { minMargin?: number } = {},
): CanvasShift {
  const minMargin = opts.minMargin ?? 1;
  let minC = cols;
  let maxC = -1;
  let minR = rows;
  let maxR = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] < 0) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  const unchanged: CanvasShift = {
    cols,
    rows,
    cells,
    dx: 0,
    dy: 0,
    moved: false,
    marginBefore: 0,
    marginAfter: 0,
  };
  if (maxC < 0) return unchanged;

  const marginBefore = Math.min(minC, minR, cols - 1 - maxC, rows - 1 - maxR);
  // 目标：左右余量相等、上下余量相等（居中）
  const dx = Math.round((cols - 1 - maxC - minC) / 2);
  const dy = Math.round((rows - 1 - maxR - minR) / 2);
  if (Math.abs(dx) < minMargin && Math.abs(dy) < minMargin) {
    return { ...unchanged, marginBefore, marginAfter: marginBefore };
  }

  const out = new Int16Array(cols * rows).fill(-1);
  for (let r = minR; r <= maxR; r++) {
    const nr = r + dy;
    if (nr < 0 || nr >= rows) continue;
    for (let c = minC; c <= maxC; c++) {
      const nc = c + dx;
      if (nc < 0 || nc >= cols) continue;
      out[nr * cols + nc] = cells[r * cols + c];
    }
  }
  const marginAfter = Math.min(
    minC + dx,
    minR + dy,
    cols - 1 - (maxC + dx),
    rows - 1 - (maxR + dy),
  );
  return {
    cols,
    rows,
    cells: out,
    dx,
    dy,
    moved: true,
    marginBefore,
    marginAfter,
  };
}

/**
 * 画板校准 · 第二步：**等比放大**。
 *
 * 按 lead 的要求，优先级是：
 *   1) 不产生新空洞、不破坏连通性；
 *   2) 其次才是"铺满"。
 *
 * 所以 `integer` 模式只接受 2/3/4 倍**整数**放大：源格 → k×k 块，
 * 每颗豆变成 k×k 颗同色豆。零空洞、零锯齿、连通性只增不减。
 *
 * `nearest` 模式允许任意比例（比如 1.4 倍），但 1.4 倍时一半源列
 * 映射到 1 列、一半映射到 2 列 —— 实物上一眼就看得出是坏的。
 * 所以这里会算 `raggedCells`，超过 `maxRaggedFrac` 就自动退回
 * 上一个可用的整数倍。
 *
 * 已经铺满（四边余量 < minMargin）时返回原样：不为"铺满"去动一张
 * 本来就已经铺满的图。
 */
export function scalePattern(
  cells: Int16Array,
  cols: number,
  rows: number,
  opts: {
    mode?: 'integer' | 'nearest';
    maxScale?: number;
    minMargin?: number;
    maxRaggedFrac?: number;
  } = {},
): CanvasScale {
  const mode = opts.mode ?? 'integer';
  const maxScale = opts.maxScale ?? 4;
  const minMargin = opts.minMargin ?? 2;
  const maxRaggedFrac = opts.maxRaggedFrac ?? 0.02;

  let minC = cols;
  let maxC = -1;
  let minR = rows;
  let maxR = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] < 0) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }

  const unchanged: CanvasScale = {
    cols,
    rows,
    cells,
    appliedScale: 1,
    holeCells: 0,
    raggedCells: 0,
    mode: 'none',
  };
  if (maxC < 0) return unchanged;

  // 已经铺满：不要为了"铺满"去动它
  const margin = Math.min(minC, minR, cols - 1 - maxC, rows - 1 - maxR);
  if (margin < minMargin) return unchanged;

  const contentW = maxC - minC + 1;
  const contentH = maxR - minR + 1;
  const rawScale = Math.min(cols / contentW, rows / contentH);

  const candidates: number[] = [];
  if (mode === 'integer') {
    for (let k = Math.min(maxScale, Math.floor(rawScale)); k >= 2; k--) {
      candidates.push(k);
    }
  } else {
    const ideal = Math.min(rawScale, maxScale);
    candidates.push(ideal);
    for (let k = Math.min(maxScale, Math.floor(rawScale)); k >= 2; k--) {
      if (Math.abs(k - ideal) > 0.05) candidates.push(k);
    }
  }
  if (!candidates.length) return unchanged;

  for (const scale of candidates) {
    const outW = Math.round(contentW * scale);
    const outH = Math.round(contentH * scale);
    if (outW > cols || outH > rows) continue;

    const offC = Math.floor((cols - outW) / 2);
    const offR = Math.floor((rows - outH) / 2);
    const out = new Int16Array(cols * rows).fill(-1);

    // 目标列 → 源列的映射（浮点步进；整数倍时恰好整除）
    const colMap = new Int32Array(outW);
    const rowMap = new Int32Array(outH);
    for (let tc = 0; tc < outW; tc++) {
      const src = minC + (tc + 0.5) / scale;
      colMap[tc] = Math.min(maxC, Math.max(minC, Math.floor(src)));
    }
    for (let tr = 0; tr < outH; tr++) {
      const src = minR + (tr + 0.5) / scale;
      rowMap[tr] = Math.min(maxR, Math.max(minR, Math.floor(src)));
    }
    for (let tr = 0; tr < outH; tr++) {
      const sr = rowMap[tr];
      for (let tc = 0; tc < outW; tc++) {
        out[(offR + tr) * cols + (offC + tc)] = cells[sr * cols + colMap[tc]];
      }
    }

    /*
     * 锯齿：源列映射到目标列后，各自占的宽度是否一致。
     * 1.4 倍时一半源列宽 1、一半宽 2 —— 实物上一眼就看得出是坏的。
     */
    const idealW = scale;
    let ragged = 0;
    let runStart = 0;
    for (let tc = 1; tc <= outW; tc++) {
      const ended = tc === outW || colMap[tc] !== colMap[runStart];
      if (!ended) continue;
      if (Math.abs(tc - runStart - idealW) > 0.51) ragged += tc - runStart;
      runStart = tc;
    }
    let runStartR = 0;
    for (let tr = 1; tr <= outH; tr++) {
      const ended = tr === outH || rowMap[tr] !== rowMap[runStartR];
      if (!ended) continue;
      if (Math.abs(tr - runStartR - idealW) > 0.51) ragged += tr - runStartR;
      runStartR = tr;
    }

    // 空洞：逐目标格赋值，外接框内不会出现未赋值格 → 恒 0
    if (ragged / Math.max(1, outW + outH) > maxRaggedFrac) continue;

    return {
      cols,
      rows,
      cells: out,
      appliedScale: scale,
      holeCells: 0,
      raggedCells: ragged,
      mode,
    };
  }

  return unchanged;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 原生块颜色与目标豆色的平均 ΔE，用于和旧路径比较 */
/**
 * 画板尺寸变化时，把**已有图案按新比例重映射**到新网格上。
 *
 * 用户把画板从 96×96 改成 120×90（或者切了宽高比），如果什么都不做，
 * 现有图案要么被裁掉一半、要么缩在左上角 —— 用户只能重画一遍。
 * 这里按比例把每颗豆搬到新位置：
 *
 *   - **按面积加权多数表决**取色号，不做颜色混插。色号是离散编号，
 *     取平均毫无意义（3 号色和 7 号色的平均不是 5 号色）。
 *   - 空格保持空：源格多数是空的，目标格就留空。不会凭空长出新豆。
 *   - 长宽比变化**不保持等比**（用户要的就是铺满新画板），但比值差
 *     超过 `maxAspectDistort` 时给出提示字段，让上层自己决定要不要
 *     改用等比 + 两侧留白。
 *
 * 这是 `scalePattern` 的泛化：`scalePattern` 是"画板不变、图案变大"，
 * 这里是"画板变了、图案跟着变"，两者都靠同一套多数表决搬运。
 */
export function resizePattern(
  cells: Int16Array,
  cols: number,
  rows: number,
  newCols: number,
  newRows: number,
): PatternResize {
  const out = new Int16Array(newCols * newRows).fill(-1);
  if (newCols <= 0 || newRows <= 0 || cols <= 0 || rows <= 0) {
    return {
      cols: newCols,
      rows: newRows,
      cells: out,
      resized: false,
      clippedCells: 0,
      emptyCells: newCols * newRows,
      aspectDistort: 1,
      indexMap: new Int32Array(0),
    };
  }
  if (newCols === cols && newRows === rows) {
    return {
      cols,
      rows,
      cells,
      resized: false,
      clippedCells: 0,
      emptyCells: 0,
      aspectDistort: 1,
      // 尺寸没变：恒等映射
      indexMap: new Int32Array(cols * rows).map((_, i) => i),
    };
  }

  let clipped = 0;
  let empty = 0;
  const sx = cols / newCols;
  const sy = rows / newRows;
  // 源格 → 新格的正向映射（取该源格中心落在的新格）
  const indexMap = new Int32Array(cols * rows);
  for (let sr = 0; sr < rows; sr++) {
    const tr = Math.min(newRows - 1, Math.floor((sr + 0.5) / sy));
    for (let sc = 0; sc < cols; sc++) {
      const tc = Math.min(newCols - 1, Math.floor((sc + 0.5) / sx));
      indexMap[sr * cols + sc] = tr * newCols + tc;
    }
  }

  for (let tr = 0; tr < newRows; tr++) {
    const y0 = tr * sy;
    const y1 = (tr + 1) * sy;
    for (let tc = 0; tc < newCols; tc++) {
      const x0 = tc * sx;
      const x1 = (tc + 1) * sx;
      // 面积加权投票：颜色号 → 覆盖面积（-1 空格单独记）
      const votes = new Map<number, number>();
      let emptyArea = 0;
      let areaSum = 0;
      for (let sr = Math.floor(y0); sr < Math.ceil(y1); sr++) {
        if (sr < 0 || sr >= rows) continue;
        const wy = Math.min(y1, sr + 1) - Math.max(y0, sr);
        if (wy <= 0) continue;
        for (let sc = Math.floor(x0); sc < Math.ceil(x1); sc++) {
          if (sc < 0 || sc >= cols) continue;
          const wx = Math.min(x1, sc + 1) - Math.max(x0, sc);
          if (wx <= 0) continue;
          const a = wx * wy;
          areaSum += a;
          const v = cells[sr * cols + sc];
          if (v < 0) {
            emptyArea += a;
            continue;
          }
          votes.set(v, (votes.get(v) ?? 0) + a);
        }
      }
      const ti = tr * newCols + tc;
      if (areaSum <= 0) continue;
      // 空格占多数 → 保持空
      if (emptyArea >= areaSum - emptyArea) {
        empty++;
        continue;
      }
      let best = -1;
      let bestW = -1;
      for (const [k, w] of votes) {
        if (w > bestW) {
          bestW = w;
          best = k;
        }
      }
      out[ti] = best;
    }
  }

  // 源图比新画板大时，落在外面的豆被裁掉 —— 数出来给上层提示
  const inX0 = Math.min(cols, Math.round(newCols * sx));
  const inY0 = Math.min(rows, Math.round(newRows * sy));
  if (inX0 < cols || inY0 < rows) {
    for (let r = inY0; r < rows; r++) {
      for (let c = 0; c < cols; c++) if (cells[r * cols + c] >= 0) clipped++;
    }
    for (let r = 0; r < inY0; r++) {
      for (let c = inX0; c < cols; c++) if (cells[r * cols + c] >= 0) clipped++;
    }
  }

  return {
    cols: newCols,
    rows: newRows,
    cells: out,
    resized: true,
    clippedCells: clipped,
    emptyCells: empty,
    aspectDistort: (newCols / newRows) / (cols / rows),
    indexMap,
  };
}

export function meanDeltaEForCells(
  cells: NativeCell[],
  cellColorIndex: Int16Array,
  paletteLabs: Oklab[],
): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cellColorIndex[i];
    if (v < 0) continue;
    const lab = paletteLabs[v];
    if (!lab) continue;
    const src = rgbToOklab(cells[i].r, cells[i].g, cells[i].b);
    sum += Math.sqrt(Math.max(0, deltaE2(src, lab)));
    n++;
  }
  return n ? sum / n : 0;
}

/* ------------------------------------------------------------------ *
 * 原生网格 → 主体边界（用于裁掉大片背景）
 * ------------------------------------------------------------------ */

/** 主体裁切的块范围（原生格坐标，含端点） */
export interface NativeSubjectBounds {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  /** 主体占原生格总数的比例 0–1 */
  fill: number;
  /** 哪些原生格是背景（1 = 背景）。长度 cols*rows，供调用方直接把 cover 清零 */
  bg: Uint8Array;
}

/**
 * 在**原生格**层面找主体的包围盒，并标出背景格。
 *
 * ## 为什么需要这一步
 *
 * 原生路径原本**不裁切**（`generate.ts` 里 `autoCrop && !nativeProbe?.detected`
 * 刻意跳过），理由是"裁切会破坏网格相位"。那个理由本身是对的 ——
 * `detectSubjectBounds` 的边界是"第一列非背景像素"，跟原生块边界毫无
 * 对齐关系，先裁再探会得到一张边缘半块的图，相位错了整圈块都变混色。
 *
 * 但**不裁**的代价实测非常大：AI 直出图习惯把主体画在中间、四周留大片
 * 纯色底，实测 7 张参考图（默认 64 格）主体只占画板 38%–69% 宽：
 *
 *   r3  主体 24×37 / 板 64×64 → 占宽 38%
 *   r4  主体 33×48 / 板 64×64 → 占宽 52%
 *   r1  主体 27×50 / 板 48×64 → 占宽 56%
 *   r6  主体 44×56 / 板 64×64 → 占宽 69%
 *
 * 也就是说 64 格里有 30–60 格在画背景，用户的"64 格预算"实际只用了
 * 24–44 格画主体 —— 眼睛、腮红这些 1 格的东西当然没了。
 *
 * ## 为什么"裁在原生格边界上"就不破坏相位
 *
 * 相位是"格边界相对图像左上角的偏移"。裁切只丢整块、不移动任何保留的
 * 块，所以保留下来的每一格与原来那一块一一对应，采样窗口落在块内部的
 * 同一相对位置 —— 相位天然不变。这里返回**块**坐标，调用方在下标层面
 * 裁剪 `NativeCell[]`，连亚像素都不用碰。
 *
 * ## 为什么按"所有非背景"取框、但要排除水印
 *
 * 一开始用"最大连通块"，实测会把散在主体周围的高光星星（r4 的 ∬ 装饰）
 * 丢掉 —— 它们跟主体不连通，于是被当成独立小块排除。改成"所有非背景格
 * 的外接框"就都保住了。但 AI 直出图右下角常带一小块平台水印（实测面积
 * 0.4%–3.6%），它会把框一路拽到右下角，裁完等于没裁（实测 r4 的水印在
 * 第 93 块，而主体右边缘只到第 72 块）。所以水印框由调用方传进来排除。
 */
export function findNativeSubjectBounds(
  cells: NativeCell[],
  grid: NativeGrid,
  opts: {
    tolerance?: number;
    margin?: number;
    /** 要排除的矩形（原生格坐标，含端点），通常给水印框 */
    exclude?: { c0: number; r0: number; c1: number; r1: number } | null;
  } = {},
): NativeSubjectBounds | null {
  const { cols, rows } = grid;
  const n = cols * rows;
  if (!n) return null;
  const tol = opts.tolerance ?? 0.075;
  const margin = opts.margin ?? 1;
  const ex = opts.exclude;

  // 1) 背景色 = 四条边上覆盖率最高的那格颜色（量化分桶投票，抗单点噪点）
  const votes = new Map<number, { r: number; g: number; b: number; w: number }>();
  const addVote = (idx: number) => {
    const c = cells[idx];
    if (!c || c.cover <= 0.5) return;
    const key =
      ((Math.round(c.r / 16) << 8) |
        (Math.round(c.g / 16) << 4) |
        Math.round(c.b / 16)) >>> 0;
    const v = votes.get(key);
    if (v) {
      v.r += c.r;
      v.g += c.g;
      v.b += c.b;
      v.w += 1;
    } else {
      votes.set(key, { r: c.r, g: c.g, b: c.b, w: 1 });
    }
  };
  for (let x = 0; x < cols; x++) {
    addVote(x);
    addVote((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    addVote(y * cols);
    addVote(y * cols + cols - 1);
  }
  if (!votes.size) return null;
  let bestVote: { r: number; g: number; b: number; w: number } | null = null;
  for (const v of votes.values()) {
    if (!bestVote || v.w > bestVote.w) bestVote = v;
  }
  if (!bestVote) return null;
  const bgR = bestVote.r / bestVote.w;
  const bgG = bestVote.g / bestVote.w;
  const bgB = bestVote.b / bestVote.w;
  const bgLab = rgbToOklab(bgR, bgG, bgB);
  const tol2 = tol * tol;

  // 2) 从四边泛洪：只把"与边界连通"的底色判为背景
  //    主体内部的浅色（白脸、白衣、高光）被前景包住，不会被挖洞。
  const bgLike = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (!c) continue;
    const lab = rgbToOklab(c.r, c.g, c.b);
    const dL = lab.L - bgLab.L;
    const da = lab.a - bgLab.a;
    const db = lab.b - bgLab.b;
    if (dL * dL + da * da + db * db <= tol2) bgLike[i] = 1;
  }
  const bg = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (bgLike[i] && !bg[i]) {
      bg[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < cols; x++) {
    seed(x);
    seed((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    seed(y * cols);
    seed(y * cols + cols - 1);
  }
  while (queue.length) {
    const i = queue.pop()!;
    const r = (i / cols) | 0;
    const c = i % cols;
    if (c > 0) seed(i - 1);
    if (c + 1 < cols) seed(i + 1);
    if (r > 0) seed(i - cols);
    if (r + 1 < rows) seed(i + cols);
  }

  /*
   * 3) 非背景格按连通块分组，只保留"够大"的块
   *
   * 一开始直接拿所有非背景格的外接框，实测 r4 会被 AI 随手撒的装饰
   * 高光星星（∬ 之类，每颗 8–10 格）一路撑到接近整图 —— 主体反而只
   * 值 52×74，裁完等于没裁。但也不能只留最大连通块：主体上真正脱离
   * 的部分（飘起的帽子、旁边的道具）会被丢掉。
   *
   * 折中：保留所有面积 ≥ 最大块 3% 的块。实测 7 张参考图里主体
   * 500–1800 格、星星 6–16 格（占比 < 1.5%）、真正要留的次要部件
   * 都在 5% 以上，3% 这条线两边都留足余量。
   */
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  let label = 0;
  const okCell = (i: number) => {
    if (bg[i] || comp[i] >= 0) return false;
    const cell = cells[i];
    if (!cell || cell.cover <= 0.15) return false;
    if (ex) {
      const c = i % cols;
      const r = (i / cols) | 0;
      if (c >= ex.c0 && c <= ex.c1 && r >= ex.r0 && r <= ex.r1) return false;
    }
    return true;
  };
  for (let i = 0; i < n; i++) {
    if (!okCell(i)) continue;
    const id = label++;
    let size = 0;
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const r = (k / cols) | 0;
      const c = k % cols;
      const go = (j: number) => {
        if (!okCell(j)) return;
        comp[j] = id;
        stack.push(j);
      };
      if (c > 0) go(k - 1);
      if (c + 1 < cols) go(k + 1);
      if (r > 0) go(k - cols);
      if (r + 1 < rows) go(k + cols);
    }
    sizes.push(size);
  }
  if (!sizes.length) return null;
  const maxSize = Math.max(...sizes);
  const MIN_COMP_FRAC = 0.03;
  const keep = sizes.map((v) => v >= maxSize * MIN_COMP_FRAC);

  // 4) 保留下来的块的外接框
  let c0 = cols;
  let r0 = rows;
  let c1 = -1;
  let r1 = -1;
  let content = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const id = comp[i];
      if (id < 0 || !keep[id]) continue;
      content++;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) return null;

  // 4) 留 1 格余量：主体最外圈常有 1 格宽的描边/高光，紧贴裁会切掉半格
  return {
    c0: Math.max(0, c0 - margin),
    r0: Math.max(0, r0 - margin),
    c1: Math.min(cols - 1, c1 + margin),
    r1: Math.min(rows - 1, r1 + margin),
    fill: content / n,
    bg,
  };
}
