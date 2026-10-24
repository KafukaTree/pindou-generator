/**
 * 局部精细度区域（Region Detail）
 * ===============================================================
 *
 * 需求原文：「用户可以选择精细度算法，还可以选择某些区域（只要鼠标或者
 * 手指覆盖到），精细度就可以变化，重新算区域的（重新算的区域的要和周围
 * 的有渐变，不能太生硬）」
 *
 * 拆成两个能力：
 *   1. 全局精细度算法 —— 见 detail.ts，选一整套协同的管线参数；
 *   2. 局部精细度笔刷 —— 在图上刷一块区域，这块用**更细/更粗**的算法。
 *
 * 这里的难点不是"让区域变细"，而是**边界不能生硬**。
 *
 * 生硬的来源有两层：
 *   a) 几何上：硬边掩码会让区域边界出现一条笔直的"算法断层"，
 *      两侧的平滑度、碎块合并门槛突变，视觉上就是一条不自然的接缝；
 *   b) 颜色上：区域的调色板更丰富、外面的更稀疏，边界两侧相邻两格
 *      很容易落在不同色号上，出现一圈突兀的色阶。
 *
 * 对应两条对策：
 *   a) **羽化（feather）**：笔刷权重不是 0/1，而是从中心到边缘按
 *      smoothstep 平滑降到 0。所有按格生效的参数（ICM 平滑强度、
 *      碎块合并门槛、剪枝比例、小特征判定宽容度）都用这个权重在
 *      "全局档"与"区域档"之间插值 —— 于是从区域中心走到外部，
 *      参数是**连续变化**的，不存在断层。
 *   b) **同源取色**：区域和外部共用同一份超采样数据（ssData），
 *      所以颜色差异只来自参数差异，不会引入新的假色。再配合
 *      ICM 本身的空间一致性（它会把孤立异色格拉回邻域主导色），
 *      边界处的色阶会被自然抹平。
 *
 * 注意：羽化是**按格**做的，不是按像素。目标网格只有几十格，
 * 羽化带取 1.5–4 格比较合适 —— 太窄看不出渐变，太宽等于整张图
 * 都变细了，失去"局部"的意义。
 */

import type { DetailAlgorithm, DetailProfile } from './detail';
import { DETAIL_ALGORITHMS, getDetailProfile } from './detail';

/**
 * 一支精细度笔刷。
 *
 * 坐标全部用**归一化图案空间**（0..1，左上角为原点），而不是格子下标。
 * 原因：用户是在画布上刷的，而画布的格子数会随"网格密度/颜色数/裁切"
 * 变化。若存格子下标，改一次参数就全部错位；存归一化坐标则永远跟着
 * 图案走，刷在哪块内容上就一直钉在那块内容上。
 */
export interface DetailBrush {
  /** 归一化 x（0..1） */
  x: number;
  /** 归一化 y（0..1） */
  y: number;
  /** 归一化半径：相对图案**长边**的比例，0.05 ≈ 二十等分之一 */
  radius: number;
  algorithm: DetailAlgorithm;
}

/** 按格解算出来的区域参数场 */
export interface RegionField {
  /** cols*rows，区域权重 0..1（已羽化） */
  w: Float32Array;
  /** cols*rows，该格生效的区域算法下标（-1 = 不受区域影响） */
  algo: Int8Array;
  /** 每格参数：在基础档与区域档之间按 w 插值后的实际值 */
  lambdaScale: Float32Array;
  mergeAreaScale: Float32Array;
  /** 碎块合并的对比豁免门槛：高于它的小块视为"造型"而非噪点 */
  mergeContrast: Float32Array;
  pruneRatioScale: Float32Array;
  accentVoteMax: Float32Array;
  accentMinD: Float32Array;
  /** 每格的小特征放行强度 0..1（见 DetailProfile.accentRelax） */
  accentRelax: Float32Array;
  /**
   * 羽化带权重峰值：`4·w·(1-w)`，在 w=0.5 处取 1，区域中心与纯外部为 0。
   *
   * 这条曲线标记的正是"参数在变化"的那一圈 —— 也就是接缝最容易
   * 出现的位置。管线在这圈里会把 ICM 的空间一致性惩罚临时加大，
   * 让两侧的色号尽量统一，从而把接缝抹平。
   */
  seam: Float32Array;
  /** 是否存在任何有效区域（无区域时整条管线走基础档，零开销） */
  active: boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const smoothstep = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/** 没有区域时的空场：所有格都等于基础档 */
export function emptyRegionField(cols: number, rows: number): RegionField {
  const n = cols * rows;
  return {
    w: new Float32Array(n),
    algo: new Int8Array(n).fill(-1),
    lambdaScale: new Float32Array(n).fill(1),
    mergeAreaScale: new Float32Array(n).fill(1),
    mergeContrast: new Float32Array(n).fill(0.1),
    pruneRatioScale: new Float32Array(n).fill(1),
    accentVoteMax: new Float32Array(n).fill(12),
    accentMinD: new Float32Array(n).fill(0.13),
    accentRelax: new Float32Array(n).fill(0.35),
    seam: new Float32Array(n),
    active: false,
  };
}

/**
 * 把笔刷解算成按格参数场。
 *
 * @param feather 羽化比例（0.15–1.2）。羽化带宽 = 半径 × feather，
 *                并夹在 1.5–5 格之间 —— 低于 1.5 格看不出过渡，
 *                高于 5 格在 40 格的小图上等于没分区。
 */
export function buildRegionField(
  cols: number,
  rows: number,
  brushes: DetailBrush[] | undefined,
  baseProfile: DetailProfile,
  feather = 0.55,
): RegionField {
  const field = emptyRegionField(cols, rows);
  if (!brushes || !brushes.length) return field;

  const n = cols * rows;
  const algoIdx = new Map<DetailAlgorithm, number>();
  DETAIL_ALGORITHMS.forEach((a, i) => algoIdx.set(a, i));

  // 每个算法一张权重图，取最大者决定该格归哪档（多笔刷叠加时不互相打架）
  const weights: Float32Array[] = DETAIL_ALGORITHMS.map(() => new Float32Array(n));
  let anyHit = false;

  const longest = Math.max(cols, rows);

  for (const brush of brushes) {
    const ai = algoIdx.get(brush.algorithm);
    if (ai === undefined) continue;

    // 归一化坐标 → 格子坐标
    const cx = brush.x * cols;
    const cy = brush.y * rows;
    const radiusCells = Math.max(1.2, brush.radius * longest);
    /*
     * 羽化带宽度 = 半径 × feather，夹在 [1.2 格, 半径] 之间。
     *
     * 上限取"等于半径"而不是固定 5 格：大笔刷（覆盖半个身体）半径可能
     * 有 15 格，固定 5 格羽化相对太窄，用户拉大 feather 也感觉不到变化
     * （实测 feather=0.55 与 1.0 的结果完全相同，因为两者都被 5 格夹死）。
     * 现在 feather=1 意味着从笔刷中心一路渐变到边缘 —— 几乎不可见的边界；
     * feather=0.2 意味着只有最外 20% 半径在过渡 —— 接近硬边。
     */
    const bandCells = Math.min(
      radiusCells,
      Math.max(1.2, radiusCells * Math.max(0.12, feather)),
    );
    const reach = radiusCells + bandCells;

    const x0 = Math.max(0, Math.floor(cx - reach));
    const x1 = Math.min(cols - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(rows - 1, Math.ceil(cy + reach));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > reach) continue;
        /*
         * 权重曲线：半径内为 1，半径外按 smoothstep 衰减到 0。
         * 用 smoothstep 而不是线性，是因为线性羽化在两端有折角，
         * 参数场会出现一圈能看出来的"棱"。smoothstep 的两端导数为 0，
         * 过渡带看起来才是融化进去的。
         */
        const t = 1 - (d - radiusCells) / bandCells;
        const w = smoothstep(t);
        if (w <= 0.002) continue;
        const i = y * cols + x;
        if (w > weights[ai][i]) weights[ai][i] = w;
        anyHit = true;
      }
    }
  }

  if (!anyHit) return field;

  field.active = true;
  const profiles = DETAIL_ALGORITHMS.map((a) => getDetailProfile(a));

  for (let i = 0; i < n; i++) {
    let bestA = -1;
    let bestW = 0;
    for (let a = 0; a < weights.length; a++) {
      if (weights[a][i] > bestW) {
        bestW = weights[a][i];
        bestA = a;
      }
    }
    if (bestA < 0 || bestW <= 0.002) {
      field.algo[i] = -1;
      field.w[i] = 0;
      continue;
    }
    const p = profiles[bestA];
    const w = bestW;
    field.algo[i] = bestA;
    field.w[i] = w;
    // 按权重在基础档与区域档之间插值 —— 参数连续，边界才不生硬
    field.lambdaScale[i] = lerp(baseProfile.lambdaScale, p.lambdaScale, w);
    field.mergeAreaScale[i] = lerp(baseProfile.mergeAreaScale, p.mergeAreaScale, w);
    field.mergeContrast[i] = lerp(baseProfile.mergeContrast, p.mergeContrast, w);
    field.pruneRatioScale[i] = lerp(baseProfile.pruneRatioScale, p.pruneRatioScale, w);
    field.accentVoteMax[i] = lerp(baseProfile.accentVoteMax, p.accentVoteMax, w);
    field.accentMinD[i] = lerp(baseProfile.accentMinD, p.accentMinD, w);
    field.accentRelax[i] = lerp(baseProfile.accentRelax, p.accentRelax, w);
    field.seam[i] = 4 * w * (1 - w);
  }

  return field;
}

/** 区域里出现过的算法（去重），用于统计与文案 */
export function regionAlgorithms(field: RegionField): DetailAlgorithm[] {
  const seen = new Set<number>();
  for (let i = 0; i < field.algo.length; i++) {
    if (field.algo[i] >= 0) seen.add(field.algo[i]);
  }
  return [...seen].map((i) => DETAIL_ALGORITHMS[i]);
}

/** 区域覆盖率（0..1，按格计），UI 用来说明"已覆盖约 X%" */
export function regionCoverage(field: RegionField): number {
  if (!field.active) return 0;
  let sum = 0;
  for (let i = 0; i < field.w.length; i++) sum += field.w[i];
  return field.w.length ? sum / field.w.length : 0;
}
