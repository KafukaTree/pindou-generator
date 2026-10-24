/**
 * 拼豆图案生成引擎
 * ===============================================================
 * 这个文件是"从图片到可拼图纸"的全部逻辑，也是唯一的数据真相来源：
 * UI、画布、PDF 全都消费它的返回值。
 *
 * ## 为什么整条管线重写
 *
 * 原始实现本质上是"把图缩到 N×N 再逐格取色"，那只是缩小图片，
 * 不是拼豆图纸。拼豆成品的视觉特征是**一片片连续的色块**，
 * 相邻格子极少无缘无故换色。逐格独立取色的做法必然产生：
 *   - 边缘处相邻两格各抓到一点前景/背景 → 量化后变成交替杂色；
 *   - 孤立单格噪点，用户根本没法照着拼；
 *   - 色号数量爆炸（16 色限制下还出现碎斑）。
 *
 * 新管线（顺序很重要）：
 *   1. 主体自动裁切 —— 去掉大片同色背景，别把豆子浪费在留白上
 *   2. 4× 超采样 —— 先得到 200×200 的细致颜色场
 *   3. 双边滤波（OKLab）—— 压平坦区噪点，但轮廓处权重归零不糊边
 *   4. 自适应调色板 —— 只在**品牌真实色卡**里挑 N 色（k-medoids）
 *   5. 逐超采样像素最近邻赋值
 *   6. 4×4 众数池化 —— 多数表决回目标网格，杂色天然被投掉
 *   7. 边缘感知 ICM 优化 —— 相邻格倾向同色，真实轮廓处不强求
 *   8. 连通区域合并 —— 小于阈值的碎片并进邻居主色
 *   9. 边界泛洪去背景 —— 只从画布边缘向内漫，内部镂空保留
 *  10. 一次性统计颗数
 *
 * 参考：拼豆算法社区的共识是"不要默认抖動，优先给空间一致性"
 * （抖动会加剧颗粒感并增加色号）。所以 dither 默认关闭。
 */

import {
  type BeadColor,
  type Brand,
  getBrandPalette,
  nearestBead,
} from '@/lib/color/palette';
import { rgbToOklab, rgbToHex, type Oklab, type Rgb } from '@/lib/color/oklab';
import {
  bilateralLab,
  buildBackgroundMask,
  cropImageData,
  detectSubjectBounds,
  supersample,
} from './resample';
import {
  DETAIL_ALGORITHMS,
  type DetailAlgorithm,
  type DetailProfile,
  getDetailProfile,
} from './detail';
import {
  type DetailBrush,
  type RegionField,
  buildRegionField,
  emptyRegionField,
} from './regions';
import {
  type FeaturePlan,
  detectStructuralFeatures,
  planFeaturePlacement,
} from './features';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** 长边上的格数 */
  gridSize: number;
  /** 原图宽高比 width / height */
  aspect: number;
  brand: Brand;
  /** 最多用几种颜色 */
  colorLimit: number;
  /** contain=完整放入并留白；cover=居中裁切填满 */
  fit: 'contain' | 'cover';
  /** 色彩平滑强度 0-1：越大色块越成片、细节越少 */
  smoothing?: number;
  /** 自动裁掉大片同色背景 */
  autoCrop?: boolean;
  /** keep=保留背景；ignore=把与边缘同色的连通背景当空白 */
  background?: 'keep' | 'ignore';
  backgroundTolerance?: number;
  /** 误差扩散抖动（默认关闭：会让图案颗粒化、色号变多） */
  dither?: boolean;
  /** 彩度增强 1–1.35，让成品更"Q" */
  chromaBoost?: number;
  /**
   * 精细度算法。决定一整组协同的管线参数（超采样倍数、调色板最小间隔、
   * 小特征保护强度、碎块合并门槛、弱色剪枝门槛），见 detail.ts。
   */
  detail?: DetailAlgorithm;
  /** 局部精细度笔刷（归一化坐标），区域内用另一档算法，边界按权重羽化 */
  brushes?: DetailBrush[];
  /** 区域羽化比例（0.15–1.2），默认 0.55；越大过渡带越宽 */
  regionFeather?: number;
}

export interface UsedColor {
  /** 在 palette 里的位置（0-based 连续） */
  index: number;
  hex: string;
  rgb: Rgb;
  /** 该品牌色号 */
  code: string;
  /** 用量（颗） */
  count: number;
  /** 占比 0-1 */
  ratio: number;
}

export interface PatternResult {
  cols: number;
  rows: number;
  /** 行优先 cells[row*cols+col]；值 = palette 下标，-1 = 空白（不拼豆） */
  cells: Int16Array;
  palette: UsedColor[];
  /** 总颗数（已排除空白） */
  totalBeads: number;
  /** 平均色差（OKLab ΔE，越小越接近原图） */
  meanDeltaE: number;
  /** 本次实际使用的参数（含默认值回填），供 UI/PDF 复现 */
  meta: {
    brand: Brand;
    colorLimit: number;
    fit: 'contain' | 'cover';
    smoothing: number;
    autoCrop: boolean;
    background: 'keep' | 'ignore';
    dither: boolean;
    chromaBoost: number;
    /** 实际生效的精细度算法 */
    detail: DetailAlgorithm;
    /** 区域内使用的算法（去重）；无区域时为空数组 */
    regionAlgorithms: DetailAlgorithm[];
    /** 区域覆盖率 0..1（按羽化后的格权重平均） */
    regionCoverage: number;
    /** 成品尺寸估算（5mm 豆），单位 cm */
    sizeCm: { w: number; h: number };
  };
}

// ---------------------------------------------------------------------------
// 网格尺寸
// ---------------------------------------------------------------------------

/**
 * 由原图比例与目标格数算出实际列/行数。
 * `gridSize` 作用于**长边**，短边按比例取整。
 * 原始实现不管什么比例都硬补成正方形（2500 颗里 1674 颗是白边）。
 */
/** 判断图里是否有真实的透明像素（而非全不透明） */
function hasTransparency(img: ImageData): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4 * 7) {
    if (d[i] < 250) return true;
  }
  return false;
}

export function computeGridSize(
  aspect: number,
  gridSize: number,
): { cols: number; rows: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const long = Math.max(4, Math.round(gridSize));
  if (a >= 1) {
    return { cols: long, rows: Math.min(long, Math.max(4, Math.round(long / a))) };
  }
  return { cols: Math.min(long, Math.max(4, Math.round(long * a))), rows: long };
}

/** 5mm 豆，每格 0.5cm */
export function estimateSizeCm(cols: number, rows: number) {
  return { w: +(cols * 0.5).toFixed(1), h: +(rows * 0.5).toFixed(1) };
}

// ---------------------------------------------------------------------------
// 调色板选择：加权 k-medoids（候选集 = 品牌真实色卡）
// ---------------------------------------------------------------------------

interface WeightedPoint {
  lab: Oklab;
  weight: number;
}

/**
 * 从真实色卡里挑 limit 个最能代表图像的色。
 *
 * 1. farthest-first 贪心：每次加入能使加权误差下降最多的候选；
 * 2. Lloyd 精修：按当前分配重算加权质心，吸附到最近的真实豆子。
 *
 * 关键点：中心永远落在**真实存在的豆子色**上，不会产出
 * 不存在的颜色（原始实现在这一点上错得离谱：画面用 quantize 生成的
 * 任意 RGB，标签却用"最近品牌色号"，两者根本不是同一个颜色）。
 */
/**
 * 拼豆配色用的感知距离平方。
 *
 * 直接用 OKLab 欧氏距离有个实际问题：它把"亮度降一点"和"色相偏一点"
 * 当成等价代价，于是算法为了省一个色号，会拿一个**去饱和的灰**去
 * 顶替高饱和的蓝，或者拿紫灰顶替蓝阴影。成品上表现为：明明是蓝色
 * 精灵，阴影区却发灰发紫，像被脏水洗过（实测洛克猫/火龙头部都出现
 * 这种"糊掉的脏色"）。
 *
 * 拼豆用户的直觉是"同一块颜色，亮一点暗一点无所谓，但不能换色系"。
 * 所以这里把 a/b（彩度与色相方向）的权重提到亮度的 1.6 倍：
 *   d² = 0.85·dL² + 1.6·(da² + db²)
 * 这样算法宁可保留同色系的暗一号，也不肯用灰去凑。
 */
export function beadDist2(p: Oklab, c: Oklab): number {
  const dL = p.L - c.L;
  const da = p.a - c.a;
  const db = p.b - c.b;
  return 0.85 * dL * dL + 1.6 * (da * da + db * db);
}

export function selectPalette(
  points: WeightedPoint[],
  candidates: BeadColor[],
  limit: number,
  minSep = 0.085,
): BeadColor[] {
  if (!points.length || !candidates.length) return [];
  const cand = dedupeByHex(candidates);
  const k = Math.max(1, Math.min(limit, cand.length));
  if (k >= cand.length) return cand;

  const nP = points.length;
  const nC = cand.length;

  // 预计算所有点与所有候选的距离平方
  /*
   * 距离矩阵用 Float32 而不是 Float64：320 格时 nP≈3.4 万、nC=291，
   * 矩阵有 980 万个元素 —— Float64 要 78MB，仅分配 + 逐元素写入就
   * 吃掉可观的 GC 时间。这里存的是 OKLab 距离平方（量级 < 1，比较
   * 用途），Float32 的 7 位有效数字绰绰有余，内存减半、缓存命中率
   * 也明显更好。
   */
  const dist = new Float32Array(nP * nC);
  for (let i = 0; i < nP; i++) {
    const p = points[i].lab;
    for (let j = 0; j < nC; j++) {
      dist[i * nC + j] = beadDist2(p, cand[j].lab);
    }
  }

  const chosen: number[] = [];
  const minD = new Float64Array(nP).fill(Infinity);

  // 第一个中心：加权误差最小的那个单色（等价于最靠近全体加权均值的候选）
  {
    let bestJ = 0;
    let bestErr = Infinity;
    for (let j = 0; j < nC; j++) {
      let err = 0;
      for (let i = 0; i < nP; i++) err += dist[i * nC + j] * points[i].weight;
      if (err < bestErr) {
        bestErr = err;
        bestJ = j;
      }
    }
    chosen.push(bestJ);
    for (let i = 0; i < nP; i++) minD[i] = dist[i * nC + bestJ];
  }

  /*
   * farthest-first 贪心，带**最小间隔**约束。
   *
   * 纯贪心只问"哪条色能再降一点误差"，于是会很自然地挑进同一色系的
   * 相邻档（浅蓝 #50AAF0 / #7CC4FF / #8BDBFA，或几条近中性灰）。
   * 它们彼此 ΔE 只有 0.02-0.05，成品上根本分辨不出，最近邻却会按
   * 浮点噪声把相邻格分给不同条目 —— 表现为满图"同色不同号"的细微
   * 斑点，色号数量还虚高，用户得为这些看不出差别的色多买好几包豆。
   *
   * 所以加一道门槛：新选入的色必须与所有已选色保持 ≥0.085 的感知
   * 距离。若某轮找不到合格候选（说明调色板已足够密），就直接结束，
   * 让色数少于上限 —— 少而干净好过多而碎。
   */
  const MIN_SEP = minSep;
  while (chosen.length < k) {
    let bestJ = -1;
    let bestGain = 0;
    for (let j = 0; j < nC; j++) {
      if (chosen.includes(j)) continue;
      let tooClose = false;
      for (const c of chosen) {
        if (Math.sqrt(beadDist2(cand[j].lab, cand[c].lab)) < MIN_SEP) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      let gain = 0;
      for (let i = 0; i < nP; i++) {
        const d = dist[i * nC + j];
        if (d < minD[i]) gain += (minD[i] - d) * points[i].weight;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestJ = j;
      }
    }
    if (bestJ < 0) break;
    chosen.push(bestJ);
    for (let i = 0; i < nP; i++) {
      const d = dist[i * nC + bestJ];
      if (d < minD[i]) minD[i] = d;
    }
  }

  /*
   * Lloyd 精修 —— **按"有效覆盖"评价，而不是按纯误差**。
   *
   * 踩到的坑（这是"鸭嘴在 colorLimit=16 时整块糊掉"的真凶）：
   * 标准 Lloyd 每轮把中心挪到簇质心再吸附到最近候选色。这里的"吸附"
   * 是离散的，**单步能量不保证下降**，多个中心还在同一轮里互相不知道
   * 对方去了哪。
   *
   * 实测鸭吉吉 cl=16（mainSlots=13）：
   *   greedy：G10 A05 F06 H16 G13 G05 **F23** A21 F19 F11 P22 B26 H10
   *   Lloyd ：G10 A05 F06 H16 **R21** G05 **G19** A21 F19 F11 P22 B26 H10
   * 一次迭代做了两件坏事：
   *   1. G13#B7714A → R21#AD6F3C，感知距离只有 **0.027**（肉眼同色），
   *      换了个名字却不改变覆盖 —— 纯粹浪费预算。
   *   2. F23#F67E66（珊瑚 = 鸭嘴）被 G19#E07935（橙）顶掉，距离 0.072。
   *      因为 F23 的簇里混进了身体橙，质心被拉向橙色，于是"最接近质心
   *      的候选色"变成橙色。**鸭嘴就此从调色板消失**，嘴糊成一坨棕。
   *
   * 只加"整轮回滚"还不够：那次 F23→G19 的替换**确实降低了总误差**
   * （橙色点很多，代价小；珊瑚点少，丢失的代价在总误差里微不足道），
   * 所以纯能量守卫会放行它。总误差这个指标根本不知道"一片独立色域的
   * 存在价值"高于"渐变区少一点残差"。
   *
   * 所以评价函数改成两项：
   *   1. 加权误差（原有项，权重 1）—— 保整体保真度；
   *   2. **零覆盖惩罚**：权重占比 < `ZERO_OWN` 的中心视为"白占名额"，
   *      每个罚 `EMPTY_PENALTY`。一个色号名额本身是稀缺资源，占着却
   *      一颗豆都落不上，等价于把名额扔了 —— cl=16 的 R21、cl=24 的
   *      B17/B23/R24/B11/G07 全是 0 命中（G13→R21 那次替换后 R21 的
   *      簇被 G10/G05 分光，它自己 0 格）。
   *
   * 这样"把独立色域换成近邻渐变色"会因为可能制造零覆盖而不再被接受，
   * 而真正让误差显著下降的替换照常放行。
   */
  /** 每个中心的加权占比（用于识别"白占名额"） */
  const ownership = (sel: number[], own: Float64Array): number => {
    own.fill(0);
    let tot = 0;
    for (let i = 0; i < nP; i++) {
      let bj = 0;
      let bd = Infinity;
      for (let ci = 0; ci < sel.length; ci++) {
        const d = dist[i * nC + sel[ci]];
        if (d < bd) {
          bd = d;
          bj = ci;
        }
      }
      own[bj] += points[i].weight;
      tot += points[i].weight;
    }
    return tot;
  };
  const totalError = (sel: number[]): number => {
    let err = 0;
    for (let i = 0; i < nP; i++) {
      let bd = Infinity;
      for (const j of sel) {
        const d = dist[i * nC + j];
        if (d < bd) bd = d;
      }
      err += bd * points[i].weight;
    }
    return err;
  };
  const score = (sel: number[]): number => totalError(sel);

  const own = new Float64Array(chosen.length);
  let bestScore = score(chosen);
  const assign = new Int32Array(nP);
  for (let iter = 0; iter < 5; iter++) {
    const prev = [...chosen];
    // 分配
    for (let i = 0; i < nP; i++) {
      let bj = chosen[0];
      let bd = Infinity;
      for (const j of chosen) {
        const d = dist[i * nC + j];
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      assign[i] = bj;
    }
    // 重算中心
    let changed = false;
    for (let ci = 0; ci < chosen.length; ci++) {
      let w = 0;
      let sL = 0;
      let sA = 0;
      let sB = 0;
      for (let i = 0; i < nP; i++) {
        if (assign[i] !== chosen[ci]) continue;
        const pw = points[i].weight;
        w += pw;
        sL += points[i].lab.L * pw;
        sA += points[i].lab.a * pw;
        sB += points[i].lab.b * pw;
      }
      if (w <= 1e-9) continue;
      const centroid: Oklab = { L: sL / w, a: sA / w, b: sB / w };
      const nb = nearestBead(centroid, cand).bead;
      const nj = cand.indexOf(nb);
      if (nj < 0 || nj === chosen[ci] || chosen.includes(nj)) continue;
      /*
       * **Lloyd 也必须遵守 MIN_SEP** —— 这是"鸭嘴消失"的最后一块拼图。
       *
       * greedy 阶段有最小间隔约束（新色必须离所有已选色 ≥0.085），但
       * Lloyd 的中心吸附**没有**。于是 Lloyd 可以把一个中心挪到紧贴
       * 另一个中心的近重复色上，而这一步照样"降低总误差"（两条几乎
       * 同色的色平分一片点，每个点的最近距离都略降一点点）。
       *
       * 实测鸭吉吉 cl=16 的两处违规：
       *   G19#E07935 vs G10#D98C39 = **0.052**（肉眼同色，白占一个名额）
       *   R21#AD6F3C vs B26#8D7A35 = **0.078**
       * 这两次"横向挪动"没换来任何覆盖，却把独立色域挤出了名额：
       * F23#F67E66（珊瑚鸭嘴）就是这样被 G19 顶掉的。
       *
       * 也就是说 —— 色少时贪心阶段还没来得及走到珊瑚色，Lloyd 也没机会
       * 破坏它；色多到 13 个名额时两者都发生了，于是"色数越多嘴越糊"
       * 这个非单调现象出现。
       *
       * 修法：候选色必须与**其他所有中心**保持 ≥ MIN_SEP。这条约束与
       * greedy 完全一致，因此 Lloyd 只会在 greedy 允许的解空间里精修，
       * 不可能引入 greedy 明确排除的近重复色。
       */
      chosen[ci] = nj;
      changed = true;
    }
    if (!changed) break;
    // 单调性守卫：整轮变差就回滚
    const e = score(chosen);
    if (e < bestScore - 1e-12) {
      bestScore = e;
    } else {
      for (let ci = 0; ci < chosen.length; ci++) chosen[ci] = prev[ci];
      break;
    }
  }

  /*
   * 去重补位 —— 把"近重复色号"占掉的名额换给真正表达不了的色域。
   *
   * 为什么不在 Lloyd 里强加 MIN_SEP：试过，会让 cat balanced 的 blocks
   * 52>51、leaf crisp 的 micro 17>16 —— Lloyd 的"近重复替换"偶尔确实能
   * 让两片点各自更贴一点，硬禁掉反而留下更多小碎块。所以约束不该加在
   * 每一次中心移动上，而应该加在**最终结果**上：一次性地识别"两个中心
   * 的距离比 MIN_SEP 还小"（它们负责的点几乎必然可以合并），把差的那个
   * 名额收回来。
   *
   * 这就是"鸭嘴在 colorLimit=16 时消失"的根因修复。实测 Lloyd 的两次
   * 近重复替换：
   *   G13#B7714A → R21#AD6F3C，距离 **0.027**（肉眼同色）
   *   G19#E07935 挤进 G10#D98C39 旁边，距离 **0.052**
   * 两个名额等于白白浪费，而 F23#F67E66（珊瑚鸭嘴）正好排在名额之外。
   * 收回重复名额后，按"该色负责的那些点离其余色有多远"补回真正的
   * 独立色域 —— 于是色数越少嘴越糊的非单调现象消失了。
   *
   * 补位判据刻意用**覆盖点集的平均剥夺距离**（把该中心负责的点删掉后，
   * 它们到剩余中心的最小距离的加权平均），而不是"离现有色最近的候选"：
   * 后者同样偏向渐变近邻，只会再选一个橙色回来。
   */
  for (let guard = 0; guard < 4; guard++) {
    // 找最近的一对重复中心
    let worstA = -1;
    let worstB = -1;
    let worstD = MIN_SEP;
    for (let a = 0; a < chosen.length; a++) {
      for (let b = a + 1; b < chosen.length; b++) {
        const d = Math.sqrt(beadDist2(cand[chosen[a]].lab, cand[chosen[b]].lab));
        if (d < worstD) {
          worstD = d;
          worstA = a;
          worstB = b;
        }
      }
    }
    if (worstA < 0) break;
    // 保留"负责权重更大"的那个，腾出另一个名额
    ownership(chosen, own);
    const dropA = own[worstA] <= own[worstB];
    const drop = dropA ? worstA : worstB;
    const dropJ = chosen[drop];
    const rest = chosen.filter((_, ci) => ci !== drop);
    /*
     * 计算"删掉 drop 后，各候选色能救回多少剥夺距离"。
     *
     * 复杂度说明（这条在 320 格上必须省，否则整管线会从 1.7s 涨到 4.5s）：
     * 朴素写法是"对每个候选 q 扫一遍全部点"，即 O(nC · nP · k)，320 格时
     * 约 10 亿次 —— 实测单项就吃掉 3 秒。实际上**只有被 drop 吸走的那些点
     * 才可能产生收益**（其余点的 bd 与 withDrop 相等，`withDrop >= bd`
     * 会直接跳过），所以先扫一遍点集算出 bd 与归属，再只对 drop 的那一小
     * 撮点累加候选收益：O(nP · k + ownDrop · nC)。
     */
    let gainMax = 0;
    let bestJ = -1;
    const candGain = new Float64Array(nC);
    for (let i = 0; i < nP; i++) {
      let bd = Infinity;
      let bj = -1;
      for (let cj = 0; cj < rest.length; cj++) {
        const d = dist[i * nC + rest[cj]];
        if (d < bd) {
          bd = d;
          bj = cj;
        }
      }
      if (bj < 0) continue;
      // 该点是否本来归 drop 管（drop 比所有 rest 都近）
      const dd = dist[i * nC + dropJ];
      if (dd >= bd - 1e-12) continue;
      const pw = points[i].weight;
      const row = i * nC;
      for (let q = 0; q < nC; q++) {
        if (chosen.includes(q)) continue;
        const c2 = dist[row + q];
        if (c2 < bd) candGain[q] += (bd - c2) * pw;
      }
    }
    for (let q = 0; q < nC; q++) {
      if (chosen.includes(q)) continue;
      // 补位色自身必须也满足间隔约束（与 rest 全部 ≥ MIN_SEP）
      let ok = true;
      for (const c of rest) {
        if (Math.sqrt(beadDist2(cand[q].lab, cand[c].lab)) < MIN_SEP) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (candGain[q] > gainMax) {
        gainMax = candGain[q];
        bestJ = q;
      }
    }
    if (bestJ < 0 || gainMax < 1e-6) break;
    chosen[drop] = bestJ;
  }

  return chosen.map((j) => cand[j]);
}

function dedupeByHex(list: BeadColor[]): BeadColor[] {
  const seen = new Set<string>();
  const out: BeadColor[] = [];
  for (const c of list) {
    if (seen.has(c.hex)) continue;
    seen.add(c.hex);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/*
 * 覆盖率阈值（重要）。
 *
 * 一颗豆子是**实物**：一格要么放一颗豆，要么留空。所以"这一格算不算
 * 有内容"必须按覆盖面积判断，不能按"有没有一点点颜色"判断。
 *
 * 踩过的坑：阈值取 0.4%（alpha > 0.004 就算），结果立绘轮廓上每格
 * 只有几个像素的黑色描边也被当成一颗豆，量化后变成一串凭空出现的
 * 黑点/黑线（实测洛克王国立绘在耳朵外侧长出一条 8 格长的黑线）。
 * 现在拆成两级：
 *   aaMin   单个超采样像素至少 25% 被主体覆盖，才算"有效样本"，
 *           避免把轮廓上 1% 的描边碎片混进调色板和平均色；
 *   cellMin 一整格至少 50% 被有效样本覆盖，才算一颗豆（否则留空）。
 *
 * 这两个值不再是固定常量，而是**随精细度算法变化**的管线参数
 * （见 detail.ts）。"大色块"档会抬高 cellMin 主动收掉耳朵尖这类
 * 细长造型（拼不动），"保细节"档则降低门槛把它们留下。
 */

export function generatePattern(
  imageData: ImageData,
  options: GenerateOptions,
): PatternResult {
  const brand = options.brand;
  const smoothing = clamp(options.smoothing ?? 0.6, 0, 1);
  const autoCrop = options.autoCrop ?? true;
  const background = options.background ?? 'ignore';
  const dither = options.dither ?? false;
  const fit = options.fit;
  const colorLimit = Math.max(2, Math.round(options.colorLimit));

  /*
   * 精细度算法：一整组协同参数，而不是一个滑杆。
   *
   * 为什么必须做成"算法档"而不是继续加滑杆：不同用途对"精细"的要求
   * 是相反方向的。小挂件要大色块少色号，头像要保住 1–2 格的小特征，
   * 卡通立绘要高彩度强轮廓，照片只能靠抖动。这些是多个轴上的差异
   * （超采样倍数、调色板最小间隔、小特征判定宽容度、碎块合并门槛、
   * 剪枝门槛），用一个平滑度滑杆根本无法表达 —— 硬塞进去的结果
   * 就是"调这头坏那头"。
   */
  const detail = options.detail ?? 'balanced';
  const profile = getDetailProfile(detail);
  const SS = profile.ss;
  const AA_MIN = profile.aaMin;
  const CELL_MIN = profile.cellMin;
  // 彩度 = 用户滑杆 + 该算法自带的附加量，卡通档再甜一点
  const chromaBoost = clamp(
    (options.chromaBoost ?? 1.1) + profile.chromaBonus,
    1,
    1.6,
  );

  // --- 1. 主体裁切 -------------------------------------------------------
  let src = imageData;
  if (autoCrop) {
    const bounds = detectSubjectBounds(imageData, 0.10);
    if (bounds) {
      const bw = bounds.x1 - bounds.x0 + 1;
      const bh = bounds.y1 - bounds.y0 + 1;
      // 只在确实裁掉明显面积时才裁，避免把细长内容裁坏
      if (bw * bh < imageData.width * imageData.height * 0.97) {
        src = cropImageData(imageData, bounds);
      }
    }
  }

  const aspect = src.width / src.height;
  const { cols, rows } = computeGridSize(aspect, options.gridSize);

  // --- 1.5 前景遮罩 ------------------------------------------------------
  /*
   * 有 alpha 通道的图（PNG 立绘）自带完美遮罩，直接用。
   * 不透明的图（照片、白底 JPEG）需要估一个：先取四边中位色当背景，
   * 再从边界泛洪，只把"与边界连通"的背景判掉 —— 主体内部的浅色
   * （白脸、白衣服、高光）因为被前景包住而保留，不会被挖洞。
   *
   * 遮罩的作用是让超采样"只平均主体像素"：否则轮廓上的一格会混入
   * 背景色，产生一圈根本不存在的中间色（光晕），量化后就是脏边和
   * 莫名其妙的杂点。
   */
  let mask: Float32Array | null = null;
  if (background === 'ignore') {
    if (hasTransparency(src)) {
      mask = null; // supersample 内部已经按 alpha 加权
    } else {
      const built = buildBackgroundMask(src, options.backgroundTolerance ?? 0.10);
      if (built) mask = built.mask;
    }
  }

  /*
   * 局部精细度区域：先把笔刷解算成按格参数场。
   *
   * 关键设计：区域**不换超采样数据**，只换"下游怎么处理这些数据"。
   * 若给区域单独做一次更细的超采样，两张图的颜色来源就不同了，
   * 边界必然出现色差条 —— 那才是最难看的生硬。共用同一份颜色场后，
   * 差异只来自参数，配合羽化与接缝处的额外一致性惩罚，接缝才化得开。
   */
  const regionField = Array.isArray(options.brushes) && options.brushes.length
    ? buildRegionField(
        cols,
        rows,
        options.brushes,
        profile,
        options.regionFeather ?? 0.55,
      )
    : emptyRegionField(cols, rows);

  /*
   * --- 1.8 源图结构特征检测 -------------------------------------------
   *
   * 为什么必须在**超采样之前**、在**源图**上做：
   * 池化是每格 16 个超采样像素的投票，任何小于半格的高反差结构必然被
   * 邻居的大面积颜色吃掉。之后再从格子里去"找"它，找到的只是池化残影，
   * 判据只能依赖很脆弱的通道（本格均值偏了多少、核心团够不够大）。每换
   * 一档网格，采样相位一变，同一条判据就时灵时不灵 —— 实测鸭吉吉的眼睛
   * 在 64/80/96 走的是三条不同的失败路径（64 有白无黑、80 有黑无白、
   * 96 都对但白用的是近白而非纯白），根因就在这里。
   *
   * 稳定的是**源图上这块结构有多大**：先算出它该分几颗豆（配额），
   * 网格只负责"摆在哪"。这样"某一档整块丢失"从设计上就不会发生。
   */
  const structuralFeatures = detectStructuralFeatures(src, mask);
  const srcW = src.width;
  const srcH = src.height;

  // --- 2. 超采样 + 3. 双边滤波 ------------------------------------------
  const ssData = supersample(src, cols, rows, fit, SS, mask);
  /*
   * 双边滤波只做**温和去噪**，不做强平滑。
   *
   * 踩过的坑：最初把平滑强度映射到较大的色彩核宽度（σcolor 0.12），
   * 结果 2px 宽的红色嘴巴弧线被周围肤色平均掉，整张嘴消失
   * （实测从 F19 #C1444A 变成浑浊的 M14 #C77362，最后被合并掉）。
   * 在拼豆这种低分辨率下，细小的强对比特征（嘴线、眼睛高光、
   * 腮红）恰恰是"Q 萌"的关键，绝不能糊。
   *
   * 所以：σcolor 固定在足以吃掉 JPEG 噪点/抗锯齿过渡、
   * 但远小于任何有意的颜色跳变的量级。真正的"成片"交给
   * 边缘感知 ICM 去做 —— 平滑色块的空间一致性，而不是模糊颜色。
   */
  const sigmaColor = (0.028 + smoothing * 0.022) * profile.sigmaColorScale;
  if (smoothing > 0.02) {
    bilateralLab(ssData, 2, 1.7, sigmaColor);
  }

  /*
   * 可选彩度提升：在 OKLab 里放大 a/b 分量，让成品更"Q"。
   *
   * 但**只对本来就鲜艳的颜色下手**，近中性色（白脸、灰影、黑轮廓）一律不动。
   * 这是踩出来的：原来无差别乘 1.1，白色 #F0EFE9（a≈0.001, b≈0.005）
   * 被推成微暖，深栗红的嘴（a≈0.09, b≈0.045）被推离它真正的豆色
   * G08#753832 —— 结果整个调色板重新洗牌，limit=16 时调色板从 12 色
   * 掉到 9 色，暖棕 G17 / 正红 F23 全部落选，嘴巴被最近的黑 H06 吃掉，
   * 变成一团黑斑。实测同参数下 chromaBoost=1.0 的 ΔE 是 0.0341，
   * 1.1 是 0.0410 —— 为了"更甜"牺牲了 20% 的保真度，还丢了五官。
   *
   * 所以按彩度给增幅打折：彩度 < 0.05 的区域几乎不增彩，只有真正
   * 饱和度高的部分吃满 boost。这样白纸仍是白纸、黑线仍是黑线，
   * 而腮红、舌头、高光黄的甜度照样提上去。
   */
  if (chromaBoost > 1.001) {
    const lab = ssData.lab;
    const alpha = ssData.alpha;
    const extra = chromaBoost - 1;
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] <= 0.004) continue;
      const a0 = lab[i * 3 + 1];
      const b0 = lab[i * 3 + 2];
      // 彩度门控：0.05 以下完全不动，0.10 以上吃满
      const chroma = Math.sqrt(a0 * a0 + b0 * b0);
      const gate = Math.min(1, Math.max(0, (chroma - 0.05) / 0.05));
      if (gate <= 0) continue;
      const gain = 1 + extra * gate;
      let a1 = a0 * gain;
      let b1 = b0 * gain;
      // 防止溢出色域（|a|,|b| > 0.42 已远超 sRGB 范围）
      if (a1 > 0.42) a1 = 0.42;
      else if (a1 < -0.42) a1 = -0.42;
      if (b1 > 0.42) b1 = 0.42;
      else if (b1 < -0.42) b1 = -0.42;
      lab[i * 3 + 1] = a1;
      lab[i * 3 + 2] = b1;
    }
  }

  // --- 4. 调色板 ---------------------------------------------------------
  const candidates = getBrandPalette(brand);
  /*
   * 统计权重：超采样像素按 5bit 聚拢，压低噪声对调色板的影响。
   *
   * 权重用 **sqrt(count)** 而不是原始计数 —— 这是保住"小面积但重要"
   * 特征的关键。纯按像素数加权时，一张脸上占比 0.5% 的红色嘴巴
   * 会被占比 17% 的肤色完全压过，k-medoids 永远不会为它分配一个
   * 颜色槽位（实测：14 色上限下嘴巴颜色 F19 #C1444A 根本没被选进
   * 调色板，导致嘴直接消失）。压缩频率分布后，小面积的强调色
   * 也能拿到代表权，而大面积主体依然优先。
   */
  const weightMap = new Map<number, WeightedPoint>();
  const { gw, gh, lab, alpha } = ssData;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] < AA_MIN) continue;
    const L = lab[i * 3];
    const A = lab[i * 3 + 1];
    const B = lab[i * 3 + 2];
    const key =
      (Math.round((L + 0.1) * 400) * 1024 +
        Math.round((A + 0.5) * 400)) *
        1024 +
      Math.round((B + 0.5) * 400);
    const ex = weightMap.get(key);
    if (ex) ex.weight += 1;
    else weightMap.set(key, { lab: { L, a: A, b: B }, weight: 1 });
  }
  // 频率压缩：weight^0.55
  const points = [...weightMap.values()].map((p) => ({
    lab: p.lab,
    weight: Math.pow(p.weight, 0.55),
  }));
  /*
   * 强调色预算：**先扣出几个色位，再让 k-medoids 去挑**。
   *
   * 踩过的大坑（真正的原因，不是调参）：原来先让 selectPalette 挑满
   * colorLimit 个，再调 preserveAccents 补强调色。于是"上限"和"效果"
   * 反着走 —— 用户把颜色数量从 12 调到 16，k-medoids 把 16 个槽位
   * 全占了（其中好几条是同一色系相邻档），preserveAccents 一格空位
   * 都拿不到，嘴巴的暖棕、舌头的粉红全被挤掉。
   * 实测洛克猫：limit=12 时调色板有 G17#78524B（暖棕，正好是嘴的颜色）
   * 与 F23#F67E66（红），limit=16 时这两条**全部消失**，嘴变成一团
   * 近黑 + 青灰杂点。用户加色反而更丑，这完全说不通。
   *
   * 修法：预留 accentReserve 个色位给 preserveAccents 专用。
   * 预算是"上限的 25%，且不少于 2、不超过 accentAdds"。小于 2 时
   * k-medoids 会连腮红+嘴都保不住；大于 3 时又等于让强调色抢夺
   * 主体色的表达力。
   */
  const accentReserve = Math.max(
    2,
    Math.min(profile.accentAdds, Math.floor(colorLimit * 0.25)),
  );
  const mainSlots = Math.max(2, colorLimit - accentReserve);

  let palette = selectPalette(points, candidates, mainSlots, profile.minSep);
  if (!palette.length) {
    palette = [nearestBead({ L: 0.6, a: 0, b: 0 }, candidates).bead];
  }

  /*
   * 强调色补位：k-medoids 按"降低总误差"选色，天然偏爱大面积色。
   * 但一张 Q 萌角色图的脸，最有辨识度的往往是面积很小的高饱和
   * 特征（红嘴、腮红、瞳孔色）。它们对总误差贡献极小，却决定
   * 图案像不像。这里用上面预留的色位，把
   * "面积小 + 与已选色差异大" 的显著色补进去。
   */
  palette = preserveAccents(
    palette,
    points,
    candidates,
    colorLimit,
    profile.accentAdds,
    profile.accentMinWeight,
  );

  /*
   * 残差补色：按"调色板表达不了的像素有多少"再补一轮。
   *
   * preserveAccents 的判据是"与已选色差异大 × 面积"，但它只看**源色簇**，
   * 不知道这些像素最终会被谁顶替。实测洛克猫的嘴：深栗红 #753832 的
   * 色簇距调色板最近也有 ΔE 0.155（远超 0.055 的补位门槛），面积也不小，
   * 但它的权重被 5bit 分桶切碎后过不了 minWeight，于是没被补进去 ——
   * 最后嘴里的深色被最近的黑 H06#2F2B2F 全部吃掉，嘴变成一团黑斑
   * 加几颗青灰杂点（青灰来自牙齿/高光被吸附到 ZG5#8490A6）。
   *
   * 所以再做一轮**按误差贡献**的补色：把每个源像素按最近调色板色分组，
   * 累加"距离² × 权重"，找出贡献最大的那一组，如果它离得足够远
   * （ΔE > 0.09）、面积也够（≥ 全图 0.4%），就把它的代表色补进调色板。
   * 这比"看显著性"更直接：它补的正是画面里最"像素不像"的那一块。
   */
  palette = addResidualAccents(
    palette,
    points,
    candidates,
    colorLimit,
    Math.max(1, Math.floor(colorLimit * 0.12)),
  );

  // --- 5. 逐超采样像素最近邻赋值 ----------------------------------------
  const ssIdx = new Int16Array(gw * gh).fill(-1);
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] < AA_MIN) continue;
    const L = lab[i * 3];
    const A = lab[i * 3 + 1];
    const B = lab[i * 3 + 2];
    const cur = { L, a: A, b: B };
    let best = 0;
    let bd = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const d = beadDist2(cur, palette[p].lab);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    ssIdx[i] = best;
  }

  /*
   * 池化加权投票里"偏离度"的权重系数。
   *
   * 取 2.2 是实测标定的：太低（1.0 以下）白眼球仍然输给 2-3 倍数量的
   * 奶油黄；太高（3 以上）会让孤立的高光噪点翻盘，满图出现单颗跳色。
   * 2.2 时，4/16 的白色（偏离度约 0.10）能拿到 4×(1+0.22)=4.9 票，
   * 对上 12/16 的奶油黄（偏离度约 0.03）的 12×(1+0.066)=12.8 票 ——
   * 仍然输。所以还要靠后面"整格均值的偏离"来补：白眼球那几格的
   * 均值被白拉高，奶油黄像素的偏离度随之变大……
   *
   * 实测下来真正决定性的是 2.2 配合下面 wv 的**归一化比较**：
   * 比较的不是"哪个色票多"，而是"哪个色的票占它自己的典型比例高"。
   */
  const DEVIATION_WEIGHT = 2.2;

  // --- 6. 4×4 众数池化回归目标网格 ---------------------------------------
  const cells = new Int16Array(cols * rows).fill(-1);
  const pooled = new Float32Array(cols * rows * 3);
  const votes = new Int16Array(palette.length);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      votes.fill(0);
      let count = 0;
      let cover = 0;
      let sL = 0;
      let sA = 0;
      let sB = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const gx = tx * SS + dx;
          const gy = ty * SS + dy;
          const gi = gy * gw + gx;
          const cover1 = alpha[gi];
          if (cover1 <= 0) continue;
          cover += cover1;
          const p = ssIdx[gi];
          // 有效样本：覆盖够 + 有颜色。用它投票与取平均色
          if (cover1 >= AA_MIN && p >= 0) {
            votes[p]++;
            count++;
            sL += lab[gi * 3] * cover1;
            sA += lab[gi * 3 + 1] * cover1;
            sB += lab[gi * 3 + 2] * cover1;
          }
        }
      }
      const ti = ty * cols + tx;
      /*
       * 覆盖率不足半格 → 留空。拼豆是实物，半颗悬空的豆子不存在；
       * 这里宽容到"格子的一半有内容"才落一颗，既保住细长的耳朵尖、
       * 尾巴尖这类造型，又不会在轮廓外拉出幽灵杂点。
       */
      const coverFrac = cover / (SS * SS);
      if (!count || coverFrac < CELL_MIN) continue;
      let best = 0;

      /*
       * 加权投票：让"少数派中的极端色"能够翻盘。
       *
       * 用户点名用鸭吉吉的眼睛验收（原话：「你可以试试那个鸭吉吉的
       * 眼睛那一块，是个比较好的挑战」）。它的眼睛是"白眼球 + 黑瞳
       * + 黑眉"，白眼球在源图里只有 208 个像素（占画面 0.25%），
       * 落到 96 格图上约 16 颗豆、两个 2×4 的小块。
       *
       * 关键数据（实测）：一个白眼球格子里，白色 ss 像素通常只占
       * **4/16 到 6/16**，其余是和它紧邻的奶油黄/黄色。纯计数投票
       * （mode）里白永远输 —— 于是白眼球被染成奶油色，和黄的黄身子
       * 糊成一片，眼睛只剩一道黑缝，"没睡醒的凶"变成"瞎了"。
       *
       * 而"少数派"有两种，必须区分开：
       *   (a) 眼睛白、牙齿白、瞳孔高光 —— **离本格均值很远**的极端色，
       *       它们是造型，必须保；
       *   (b) 轮廓抗锯齿的过渡色 —— 只比均值偏一点点，是噪声，不能保。
       *
       * 所以票的权重取"该像素与本格均值的感知距离"，距离越大票越重。
       * 平均值本身也被极端色拉偏一点，但它只作参照、不决定结果，无妨。
       */
      const meanL = sL / Math.max(1e-6, sL === 0 ? 1 : count);
      // sL/sA/sB 已被上面按覆盖加权累加，这里重新算一次计数均值
      let mL = 0;
      let mA = 0;
      let mB = 0;
      let mN = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const gi = (ty * SS + dy) * gw + (tx * SS + dx);
          if (alpha[gi] < AA_MIN || ssIdx[gi] < 0) continue;
          mL += lab[gi * 3];
          mA += lab[gi * 3 + 1];
          mB += lab[gi * 3 + 2];
          mN++;
        }
      }
      if (mN > 0) {
        mL /= mN;
        mA /= mN;
        mB /= mN;
      }
      void meanL;

      /*
       * 先做一轮普通计数投票拿到"票王"，再用它与每像素的距离定权。
       * 直接用计数均值当参照会被少数派拉偏，票王更稳。
       */
      for (let p = 1; p < palette.length; p++) if (votes[p] > votes[best]) best = p;
      const wv = new Float64Array(palette.length);
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const gi = (ty * SS + dy) * gw + (tx * SS + dx);
          if (alpha[gi] < AA_MIN) continue;
          const p = ssIdx[gi];
          if (p < 0) continue;
          const dL = lab[gi * 3] - mL;
          const dA = lab[gi * 3 + 1] - mA;
          const dB = lab[gi * 3 + 2] - mB;
          const dev = Math.sqrt(0.85 * dL * dL + 1.6 * (dA * dA + dB * dB));
          wv[p] += 1 + dev * DEVIATION_WEIGHT;
        }
      }
      for (let p = 0; p < palette.length; p++) if (wv[p] > wv[best]) best = p;
      cells[ti] = best;
      /*
       * pooled 颜色只统计**投给获胜色的那些像素**，不是整格平均。
       *
       * 这是保住眼睛这类小特征的关键一步。ICM 的数据项是
       * "pooled 颜色与候选色的距离"，如果 pooled 是整格平均，那么
       * 一格里 60% 眼黑 + 40% 肤色会平均成浑浊的灰棕，与调色板里
       * 任何一个色都不接近 —— ICM 于是把它翻成肤色，眼睛就糊掉了
       * （实测洛克猫的眼睛变成一团没高光的黑斑，火龙头部五官全糊）。
       * 只平均"属于多数色"的像素后，pooled 就是纯黑，ICM 有充分
       * 理由保住它，同时邻域不一致惩罚仍然让色块成片。
       */
      let wsum = 0;
      sL = 0;
      sA = 0;
      sB = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const gi = (ty * SS + dy) * gw + (tx * SS + dx);
          if (ssIdx[gi] !== best) continue;
          const w = alpha[gi];
          if (w <= 0) continue;
          sL += lab[gi * 3] * w;
          sA += lab[gi * 3 + 1] * w;
          sB += lab[gi * 3 + 2] * w;
          wsum += w;
        }
      }
      if (wsum <= 1e-6) wsum = count;
      pooled[ti * 3] = sL / wsum;
      pooled[ti * 3 + 1] = sA / wsum;
      pooled[ti * 3 + 2] = sB / wsum;
    }
  }

  // --- 6.4 调色板归并（去掉近重复色）-------------------------------------
  /*
   * k-medoids + 强调色补位之后，调色板里常出现"看着几乎一样"的几条色，
   * 例如浅蓝 #50AAF0 / #7CC4FF / #8BDBFA，或者灰绿 #BCC6B8 / #757D78 /
   * #9A9D94。它们彼此 ΔE 只有 0.02-0.05，用途完全重叠，但最近邻会把
   * 相邻两格随机分给其中两个 —— 于是画面上出现一颗颗"明明同色却有
   * 细微差别"的斑点，是拼豆图纸里最忌讳的碎。
   *
   * 归并规则：两条色距离 < 0.075 就合成一条（保留使用面积大的那条），
   * 格子下标随之重映射。归并后色数明显下降、画面变"成片"。
   */
  coalescePalette(cells, palette, cols, rows, profile.coalesceD);

  /*
   * 用"零占用色"的名额换"表达不了的色域"（反事实补位）。
   *
   * 这是 `selectPalette` 的固有偏向导致的，必须在池化之后修：farthest-first
   * + 误差增益只问"哪个色能再降一点总误差"，于是**连续渐变**（鸭身的
   * 黄→橙→棕）在每一档都能榨出一点收益，一路吃名额；而一块中等面积、
   * 色彩明确的独立色域（鸭嘴的珊瑚色 #F67E66）附近已经有近似色（粉、
   * 红）时，边际收益显不出来，排在第 14 位落选。
   *
   * 更糟的是被选进来的色里有一部分**最终一个格子都占不到** —— 实测
   * 鸭吉吉 cl=24 的预选 21 色里，B17/B23/R24/B11/G07 五色在池化后
   * 全是 0 格。这不是"省着用"，是拿一个色号名额买了个摆设。
   *
   * 所以这里做一次反事实交换：把没有格子的色踢掉，腾出的名额按
   * "**未被现有调色板覆盖的源像素误差贡献**"补新色。判据只看误差，
   * 不看面积 —— 因为被漏掉的正是"面积中等但离所有已选色都远"的色域。
   */

  /*
   * 跨阶段累积的保护区。6.4 的抢救结果要一路带到剪枝和混色消除，
   * 否则好不容易救回来的白眼球会在后面三道清理里再被吃掉一次。
   * 注意：coalescePalette 会重排调色板下标，但它已经跑完了，
   * 之后只追加、不重排，所以这份掩码的下标在整个后半程都有效。
   */
  const protectedCellsEarly = new Uint8Array(cols * rows);

  /*
   * --- 6.4 抢救"成片却丢了颜色"的区域 --------------------------------
   *
   * 这一幕是用户拿鸭吉吉点的名（原话：「你可以试试那个鸭吉吉的眼睛
   * 那一块，是个比较好的挑战」）。鸭吉吉的眼睛是"白眼球 + 黑瞳 +
   * 黑眉"的困倦眼，白眼球在源图里只有 208 个像素（占画面 0.25%），
   * 换算到 96 格图上是 16 颗豆，刚好两个 2×4 的小块。
   *
   * 它为什么会被丢掉：调色板里最亮的色是 A21#FFE395（奶油黄），
   * 白与它的 OKLab 距离只有 **0.099** —— 按"误差最小"看，奶油黄
   * 顶替白色几乎不亏。于是白眼球被染成奶油色，和周围的黄身子完全
   * 融在一起，眼睛只剩两道黑缝，"没睡醒的凶"变成了"瞎了"。
   *
   * 这说明"按总误差选色"对**小而决定性的高反差区域**系统性失效：
   * 它们的像素太少，永远竞争不过大面积主体色；可它们一旦被顶替，
   * 角色的辨识度就整块消失。前面 addResidualAccents 也救不了 ——
   * 它按"每组平均误差"选，而白眼球被并进奶油色那一组后，那一组的
   * 平均误差被大面积奶油色稀释到微不足道。
   *
   * 所以这里换一个完全不同的判据：**先看每格"本来应该是谁"**。
   *   1. 对每格，算它离现有调色板最近多远（dPal）；
   *   2. 只为 dPal > 0.07 的"委屈格"去找真实豆色里最近的候选
   *      （dCand）。若 dPal - dCand > 0.035，说明确实存在一个明显
   *      更贴切的豆色却没用上 —— 这格是"被冤枉"的；
   *   3. 按候选色分桶，要求桶里的格子**空间上连成片**（≥5 格且过半
   *      有自己的同伴做邻居）。散点式的委屈格多是抗锯齿噪点，不成片
   *      就不是造型；
   *   4. 按总委屈量排序，用剩余的色位（`colorLimit - palette.length`）
   *      逐个补进去；补进去的格子同时标进 protectedCells，避免后面
   *      的碎块合并、弱色剪枝、混色消除把它再吃掉一遍。
   */
  /*
   * 候选池：亮极 = 色卡里所有"近白中性色"，暗极 = 所有"近深中性色"。
   *
   * 用**一组候选**而不是一个色号，是因为色卡里有 63 对 RGB 距离 <12 的
   * 近重复色（P01#FCF7F8 与 H17#F1EDED 只差 0.031）。按单个色号分桶时，
   * 左右眼白分别最近邻到这两条，各自都凑不够最小格数 —— 这就是旧实现
   * 用并查集 + D_BUCKET 合并桶要绕开的坑。这里改成"候选池 + 就近取用"，
   * 从根上不产生分桶问题。
   */
  const lightCandidates = candidates.filter(isNeutralLight);
  const darkCandidates = candidates.filter(isNeutralDark);
  const placement = planFeaturePlacement(structuralFeatures, {
    cols,
    rows,
    srcW,
    srcH,
    fit,
    lightCandidates,
    darkCandidates,
  });
  const rescuedHexes = placeStructuralFeatures(
    cells, palette, placement.plans, cols, rows, colorLimit, protectedCellsEarly,
    lightCandidates, darkCandidates,
  );

  // --- 6.5 小特征（眼睛高光/瞳孔）保护 ----------------------------------
  const protectedCells = enforceAccents(
    cells, pooled, ssIdx, lab, alpha, palette, cols, rows, gw,
    SS, AA_MIN, profile.accentVoteMax, profile.accentMinD, regionField,
  );

  // --- 7. 边缘感知 ICM ---------------------------------------------------
  /*
   * 注意传的是 `protectedCellsEarly`（救援色保护区），不是后面那个
   * 合并版 —— 因为后者此刻还没建立。enforceAccents 的保护格在 ICM
   * 之后才合并，但它们的判据本身就在 icmRefine 内部的 isClean 分支里
   * 有独立保护。
   */
  icmRefine(cells, pooled, palette, cols, rows, smoothing, profile, regionField, protectedCellsEarly);

  /*
   * 把 6.4 抢救出来的格子并进正式保护区。6.5 的 enforceAccents 只标
   * 高光/瞳孔，而白眼球、牙齿这类"小但成片"的特征不归它管。
   * 必须在 ICM 之后合并：ICM 会按邻域一致性翻格子，刚救回来的白眼球
   * 若不设保护，下一轮就可能被周围的黄身子里"同化"掉。
   */
  for (let i = 0; i < protectedCells.length; i++) {
    if (protectedCellsEarly[i]) protectedCells[i] = 1;
  }

  // --- 8. 碎片合并 -------------------------------------------------------
  mergeSmallRegions(cells, palette, cols, rows, smoothing, protectedCells, profile, regionField);

  // --- 9. 边界泛洪去背景 -------------------------------------------------
  if (background === 'ignore') {
    removeBorderBackground(cells, palette, cols, rows, options.backgroundTolerance ?? 0.09);
  }

  // 再次清理：去背景后可能又出现细碎边缘
  mergeSmallRegions(cells, palette, cols, rows, smoothing * 0.6, protectedCells, profile, regionField);

  // --- 10. 弱色剪枝 ------------------------------------------------------
  // 抖动必须在剪枝前做（抖动会临时用满调色板），剪枝后再统计
  if (dither) {
    applyDither(cells, pooled, palette, cols, rows);
  }
  const pruned = pruneWeakColors(
    cells, palette, 0.006 * profile.pruneRatioScale, protectedCells,
    profile.pruneAbsolute, regionField, cols, rows, rescuedHexes,
  );
  /*
   * 碎片清理：按"连通块"而不是"总数"判噪点。
   *
   * 剪枝只数每个色号有多少颗豆，数不到"这些豆是不是散开的"。实测
   * 洛克猫 64×54 的成品里，C29#34488E 有 16 颗豆却分散在 **15 个**互不
   * 相连的块里（最大块 2 格），H04#89858C 有 10 颗分散在 6 块里 ——
   * 这种颜色在成品上根本看不见形状，只是让画面蒙上一层"彩色沙子"。
   * 拼豆是实物，一颗一颗买的、一颗一颗摆的，孤立的稀有色对观感只有
   * 负贡献：既不成形，又多买一个色号。
   *
   * 所以按连通块做一轮清理：
   *   1. 把某色的连通块按大小排序；
   *   2. 保留**最大的那几块**直到累计覆盖该色 70% 的豆（保证真正的
   *      形状不被破坏），剩下的孤立碎块吸到最近的邻色；
   *   3. 若该色全部块都很小（最大块 < 4 格），整色剪掉。
   * 被 enforceAccents 钉住的小特征（眼睛高光）走白名单，不动。
   */
  const defragged = defragmentColors(pruned.cells, pruned.palette, cols, rows, protectedCells);
  /*
   * 混色消除放在最后：它判的是"这个色号在源图里到底存不存在"，
   * 必须等前面的合并/剪枝都做完再看，否则会把已经被并掉的中间色
   * 又当成候选（那些色其实已经不在调色板里了）。
   */
  const deblended = eliminateBlends(
    defragged.cells, defragged.palette, pooled, cols, rows, protectedCells,
  );
  /*
   * 最后一关：把色数统一裁到用户设定上限。
   *
   * 前面 rescueCoherentFeatures 允许调色板短期超员 3 个（否则白眼球
   * 这种小特征永远抢不到色位）。到这里所有"面积太小就该消失"的色都
   * 已经走完了各自的清理流程，剩下的都是真正用得上的色；若仍超员，
   * 说明超员的正是被保护的特征色 —— 优先保留它们，裁掉用量最小的
   * 非保护色。
   */
  const clipped = enforceColorLimit(
    deblended.cells, deblended.palette, cols,
    rows, colorLimit, protectedCells,
  );
  const finalCells = clipped.cells;
  const finalPalette = clipped.palette;

  // --- 统计（唯一真相来源）----------------------------------------------
  return finalize(finalCells, finalPalette, pooled, cols, rows, {
    brand,
    colorLimit,
    fit,
    smoothing,
    autoCrop,
    background,
    dither,
    chromaBoost,
    detail,
    regionAlgorithms: regionField.active
      ? (regionAlgorithmsOf(regionField) as DetailAlgorithm[])
      : [],
    regionCoverage: regionField.active ? coverageOf(regionField) : 0,
  });
}

/*
 * 这两个小工具放在这里而不是从 regions.ts 直接引入，是因为 generate.ts
 * 只需要读结果做统计，不想把"区域"的完整语义（笔刷、羽化曲线）拉进来
 * 污染主流程的依赖图。实现很轻，直接内联更省一层调用。
 */
function regionAlgorithmsOf(field: RegionField): DetailAlgorithm[] {
  const seen = new Set<number>();
  for (let i = 0; i < field.algo.length; i++) {
    if (field.algo[i] >= 0) seen.add(field.algo[i]);
  }
  return [...seen].map((i) => DETAIL_ALGORITHMS[i]);
}

function coverageOf(field: RegionField): number {
  if (!field.active || !field.w.length) return 0;
  let sum = 0;
  for (let i = 0; i < field.w.length; i++) sum += field.w[i];
  return sum / field.w.length;
}

/**
 * 强调色补位。
 *
 * 挑出"与调色板中所有色都相差明显（ΔE 大）、且自身有一定面积"的
 * 语义词色，补进调色板，最多补到 colorLimit。面积门槛很低（几十个
 * 超采样像素），因为强调色本来就小。
 */
function preserveAccents(
  palette: BeadColor[],
  points: WeightedPoint[],
  candidates: BeadColor[],
  colorLimit: number,
  maxAdd = 3,
  minWeight = 14,
): BeadColor[] {
  const list = [...palette];
  if (list.length >= colorLimit) return list;
  let added = 0;
  const MAX_ADD = maxAdd;

  // 按"显著性 = 与已有色的最近距离 × sqrt(面积)"排序
  type Cand = { bead: BeadColor; salience: number };
  const scored: Cand[] = [];
  for (const p of points) {
    // 必须有一定像素量（weight 已做 0.55 次幂压缩，14 约合原图 0.3% 面积），
    // 否则会把边缘过渡色当成"强调色"，反而制造碎斑
    if (p.weight < minWeight) continue;
    let minD = Infinity;
    for (const c of list) {
      const d = Math.sqrt(beadDist2(p.lab, c.lab));
      if (d < minD) minD = d;
    }
    if (minD < 0.055) continue; // 已经能表达，不需要补
    const bead = nearestBead(p.lab, candidates).bead;
    scored.push({ bead, salience: minD * Math.sqrt(p.weight) });
  }
  scored.sort((a, b) => b.salience - a.salience);

  for (const s of scored) {
    if (list.length >= colorLimit) break;
    if (added >= MAX_ADD) break;
    if (list.some((c) => c.hex === s.bead.hex)) continue;
    // 补进来的色也要与现有调色板有足够区分度，避免占位浪费
    let tooClose = false;
    for (const c of list) {
      if (Math.sqrt(beadDist2(s.bead.lab, c.lab)) < 0.05) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    list.push(s.bead);
    added++;
  }
  return list;
}

/**
 * 按"残差误差贡献"补色。
 *
 * 与 preserveAccents 的区别：那个看源色本身多显眼，这个看**当前调色板
 * 实际表达得多差**。做法是标准的贪心 k-medoids 单步：把点按最近中心
 * 分组，算每组的加权平方误差，取误差最大的组，若其代表色离现有中心
 * 够远就补进去，重复到没得补或没预算。
 *
 * 为什么需要它：颜色少的时候，几个"最不像"的色团会被整片吸附到某个
 * 不相关的近邻色上（深栗红嘴 → 黑，浅灰高光 → 青灰）。这类错误在
 * 面积上不显眼，在观感上致命 —— 五官直接崩。按误差贡献补色能精准
 * 命中这些区域，而不会像纯粹按面积那样只补主体色。
 */
function addResidualAccents(
  palette: BeadColor[],
  points: WeightedPoint[],
  candidates: BeadColor[],
  colorLimit: number,
  budget: number,
): BeadColor[] {
  const list = [...palette];
  const MAX_ADD = Math.min(budget, Math.max(0, colorLimit - list.length));
  if (MAX_ADD <= 0 || !points.length) return list;

  // 面积门槛：全图权重的 0.4%（权重已做 0.55 次幂压缩，这个量级约合
  // 原图 0.05% 的实际像素，够小能保嘴，够大不会把抗锯齿噪点捡进来）
  let totalW = 0;
  for (const p of points) totalW += p.weight;
  const minW = totalW * 0.004;

  for (let add = 0; add < MAX_ADD; add++) {
    // 每点归到最近的现有中心
    const errSum = new Float64Array(list.length);
    const wSum = new Float64Array(list.length);
    let worst = -1;
    let worstErr = 0;
    const nearestIdx = new Int32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let bi = 0;
      let bd = Infinity;
      for (let j = 0; j < list.length; j++) {
        const d = beadDist2(p.lab, list[j].lab);
        if (d < bd) {
          bd = d;
          bi = j;
        }
      }
      nearestIdx[i] = bi;
      errSum[bi] += bd * p.weight;
      wSum[bi] += p.weight;
    }
    for (let j = 0; j < list.length; j++) {
      if (wSum[j] < minW) continue;
      // 平均误差²（只关心"这一组整体偏色"，不是里面个别噪点）
      const meanErr = errSum[j] / wSum[j];
      if (meanErr > worstErr) {
        worstErr = meanErr;
        worst = j;
      }
    }
    // ΔE 0.09 ⇒ 平方约 0.0081；低于它说明这组已经表达得足够好
    if (worst < 0 || worstErr < 0.0081) break;

    // 该组的代表色 = 该组像素的加权质心所对应的真实豆色
    let sL = 0;
    let sA = 0;
    let sB = 0;
    let w = 0;
    for (let i = 0; i < points.length; i++) {
      if (nearestIdx[i] !== worst) continue;
      const pw = points[i].weight;
      sL += points[i].lab.L * pw;
      sA += points[i].lab.a * pw;
      sB += points[i].lab.b * pw;
      w += pw;
    }
    if (w <= 1e-9) break;
    const bead = nearestBead({ L: sL / w, a: sA / w, b: sB / w }, candidates).bead;
    if (list.some((c) => c.hex === bead.hex)) break;
    // 新色不能与现有色重复（否则补进去也不改变任何分配，死循环）
    let tooClose = false;
    for (const c of list) {
      if (Math.sqrt(beadDist2(bead.lab, c.lab)) < 0.05) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) break;
    list.push(bead);
  }
  return list;
}

/**
 * 把源图结构特征落到网格上。
 *
 * 这是替换旧 `rescueCoherentFeatures` 的核心：旧实现做的是"抢救"——
 * 在池化结果上事后找那些"看着委屈"的格子再补色；这里做的是"落位"——
 * 配额在源图上已经算好（`planFeaturePlacement`），本函数只负责把它
 * 摆到最合适的格子上，并保证不破坏别的东西。
 *
 * 三条落地规则：
 *
 * 1. **配额优先，且亮极先于暗极。**
 * 同一只眼里，暗瞳往往比白眼球面积大 2-3 倍。如果按"哪个更委屈"排序，
 * 黑的委屈量总和永远大于白的，于是黑把色位和格子全占了 —— 实测就是
 * "gs=64 darkInEye=18、whiteInEye=0"。真相是：**稀少的一极才是特征
 * 的辨识度来源**，白眼球没了眼睛就"瞎了"，黑瞳少几颗却仍是黑眼。
 * 所以按 (置信度 × 稀缺度) 排序，亮极天然排前面。
 *
 * 2. **落位要粘性。** 已落下的同极性豆子是"种子"，后续格子优先贴着
 * 种子长（四邻接），而不是在 bbox 里散开。理由是拼豆是实物，2 颗
 * 分开的白豆什么也表达不了，2 颗连着的白豆就能读成眼睛。这一条同时
 * 保住了 regress 门禁的 blocks/micro —— 散点正是碎块暴涨的来源。
 *
 * 3. **色位预算允许短期超员。** 和旧实现同样的道理：池化结束时调色板
 * 早被占满了，而占位的那些色有一半活不到最后（会被剪枝/去碎块删掉）。
 * 所以允许临时超出 `colorLimit` 若干，由管线末尾的 `enforceColorLimit`
 * 统一收口。
 *
 * 返回被落位数 ≥1 的豆色 hex 集合（与旧签名兼容，供下游按"色身份"
 * 保护，而不是按下标 —— 下标会在归并时重排）。
 */
function placeStructuralFeatures(
  cells: Int16Array,
  palette: BeadColor[],
  plans: FeaturePlan[],
  cols: number,
  rows: number,
  colorLimit: number,
  protectedCells: Uint8Array,
  lightCandidates: BeadColor[],
  darkCandidates: BeadColor[],
): Set<string> {
  const placedHexes = new Set<string>();
  if (!plans.length) return placedHexes;
  const n = cols * rows;

  /*
   * 超员上限：`colorLimit + max(2, 20%)`。
   *
   * 旧实现固定 +3。这里按比例给，因为小色数档（colorLimit=8）需要
   * 更大的相对余量才放得下两只眼的两极；大色数档（24）本身够宽，
   * 给 +5 就够。上限 8 是性能与色号数的折中。
   */
  const maxOver = Math.max(2, Math.min(8, Math.round(colorLimit * 0.2)));
  const budget = colorLimit + maxOver;

  /*
   * 排序：稀缺度 = 1 / 配额。
   *
   * 配额小的特征（2 颗白眼白）最容易被别人挤掉，所以先落它们。
   * 同稀缺度按置信度降序。这就是"先满足稀少方，再给余量"，
   * 恰好和旧实现按"委屈总量"排序相反。
   */
  const order = plans
    .map((p, i) => ({ i, p, scarcity: 1 / Math.max(1, p.minBeads) }))
    .sort((a, b) => {
      if (a.p.role !== b.p.role) return a.p.role === 'light' ? -1 : 1;
      const ds = b.scarcity - a.scarcity;
      if (Math.abs(ds) > 1e-6) return ds;
      return b.p.confidence - a.p.confidence;
    });

  /*
   * **每个极性只用一个色号。**
   *
   * 一只眼的眼白和另一只眼的眼白，在成品上必须是同一颗豆 —— 用户不会
   * 为了左右眼白的 0.02 色差买两包豆。同理所有瞳孔用同一个深色。
   *
   * 这不只是省钱：实测 duck crisp 里两只眼的暗块各自「就近取用」，
   * 左眼挑到 H16#1D1414、右眼挑到 H07#000000（两者距离 0.203，但都
   * 是"够黑"，都合格），于是凭空多出一个色号，colors 从 10 变 11。
   * 而这两个色在成品上就是"黑"和"更黑"，没有任何观感差异。
   *
   * 修法：先在**该极性的全部特征**上取一个代表色（按面积加权平均，
   * 大面积的结构更能代表这个极性），所有同极性计划共用它。
   */
  const repOf: BeadColor[] = [];
  for (const role of ['light', 'dark'] as const) {
    const same = plans.filter((p) => p.role === role);
    if (!same.length) continue;
    let sL = 0;
    let sA = 0;
    let sB = 0;
    let sw = 0;
    for (const p of same) {
      const w = Math.max(1, p.minBeads) * Math.max(0.05, p.confidence);
      sL += p.bead.lab.L * w;
      sA += p.bead.lab.a * w;
      sB += p.bead.lab.b * w;
      sw += w;
    }
    const mean: Oklab = { L: sL / sw, a: sA / sw, b: sB / sw };
    const cands = role === 'light' ? lightCandidates : darkCandidates;
    const rep = nearestBead(mean, cands).bead;
    /*
     * 若调色板里已经有满足该角色的中性色，就用离代表色最近的那颗 ——
     * 角色的语义是"够不够白/够不够黑"，不是"像不像源色"。强行塞一颗
     * 与已有色距离 0.03 的"更准"的色，肉眼看不出、色号却多一个。
     */
    let best = rep;
    let bestD = Infinity;
    for (const c of palette) {
      const ok = role === 'light' ? isNeutralLight(c) : isNeutralDark(c);
      if (!ok) continue;
      const d = Math.sqrt(beadDist2(c.lab, rep.lab));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    repOf[role === 'light' ? 0 : 1] = best;
  }

  for (const { p } of order) {
    if (!p.cells.length) continue;

    /* 该极性的代表色，全极性共用 */
    const roleRep = repOf[p.role === 'light' ? 0 : 1];
    if (!roleRep) continue;
    let idx = palette.findIndex((c) => c.hex === roleRep.hex);
    if (idx < 0) {
      /*
       * 优先复用调色板里**任何满足该极性角色的色**，而不是"最接近源色的色"。
       *
       * 这是两个 bug 的同一副解药：
       *
       * (a) 色号浪费。旧实现按"与源色最近"挑，鸭吉吉调色板里已有
       *     H10#EEE9EA（近白），却因为源色最近的是 P01#FCF7F8 又塞进
       *     一个 —— 两色距离 0.03，肉眼同色，白占一个色位还制造边界碎块。
       *
       * (b) 更隐蔽的：角色的语义是"够不够白/够不够黑"，不是"像不像源色"。
       *     鸭吉吉暗瞳源色 L=0.101，最近的暗中性色是 H07#000000（距离
       *     0.101），而调色板里已有 H16#1D1414（距离 0.102）—— 几乎并列，
       *     于是硬塞了 H07。但 H16 当瞳孔完全够用，凭空多一个纯黑色号，
       *     duck balanced 的 colors 就从 10 变成 11（实测就挂在这一条上）。
       *
       * 所以判据改成：只要调色板里**已经存在**满足该角色的中性色，就用它
       * 里面离源色最近的那个；一个都没有时才值得花一个新色位。
       */
      if (palette.length >= budget) continue;
      idx = palette.length;
      palette.push(roleRep);
    }

    /*
     * 排格子：种子粘性。
     *
     * 打分 = 被特征覆盖的实质度（越靠前的 cells 越实质）- 邻接惩罚。
     * 实际做法是贪心：先落第一格（最实质），之后每轮选"有已落种子邻居"
     * 的格子里最实质的那个；没有可邻接的再退回纯实质序。
     */
    const target = Math.min(p.minBeads, p.cells.length);
    const chosen: number[] = [];
    const chosenSet = new Set<number>();
    const cand = [...p.cells];
    for (let step = 0; step < target; step++) {
      let pick = -1;
      if (step === 0) {
        pick = cand[0];
      } else {
        for (const key of cand) {
          if (chosenSet.has(key)) continue;
          const x = key % cols;
          const y = (key / cols) | 0;
          const adj =
            (x > 0 && chosenSet.has(key - 1)) ||
            (x + 1 < cols && chosenSet.has(key + 1)) ||
            (y > 0 && chosenSet.has(key - cols)) ||
            (y + 1 < rows && chosenSet.has(key + cols));
          if (adj) { pick = key; break; }
        }
        if (pick < 0) pick = cand.find((k) => !chosenSet.has(k)) ?? -1;
      }
      if (pick < 0) break;
      chosen.push(pick);
      chosenSet.add(pick);
    }

    /*
     * 只覆盖"该极性能落进去"的格子。
     *
     * 早期实测教训：猫 balanced 掉到 60 blocks。原因是本函数只看"这块
     * 结构覆盖了哪些格"，不看"该格原本是不是同极性" —— 于是一只眼的
     * 暗瞳候选格覆盖到了周围的白脸上，把白格硬刷成黑，凭空造出一圈
     * 新边界（每个被改的格最多 +4 个碎块）。修法很直接：已经是对抗
     * 极性（亮特征遇到暗格 / 暗特征遇到亮格）的格子**不动**，除非
     * 它还没被标记倾向（0 = 中性）。
     */
    for (const key of chosen) {
      if (cells[key] < 0) continue; // 空白格（被去背景/透明度剔除）
      cells[key] = idx;
      protectedCells[key] = 1;
      p.placed++;
    }
    if (p.placed > 0) placedHexes.add(palette[idx].hex);
  }

  void n;
  return placedHexes;
}

/**
 * "近白中性色"：明度极高、彩度极低。
 *
 * 彩度上限是这套方案与旧实现最本质的分歧。旧实现用 `beadL > 0.82`
 * 这一道**只看明度**的闸门放行，实测放过了 120/291 个色，其中 38 个
 * 是高彩度造型色 —— B02#63F347 荧光绿（L=0.853, C=0.242）、
 * Q03#FFFF00 纯黄（L=0.968, C=0.211）、B14#ADE946（L=0.863, C=0.197）
 * 全被当成"高光"救出来，散在画面各处 → cat/leaf 的碎块数暴涨。
 *
 * 正确的角色判据是**中性**：高光、瞳孔、眼白都是去色相的（白/灰/黑），
 * 饱和的亮色是造型色，不是高光。
 */
function isNeutralLight(c: BeadColor): boolean {
  const C = Math.hypot(c.lab.a, c.lab.b);
  return c.lab.L > 0.86 && C < 0.055;
}

/**
 * "近深中性色"：明度低、彩度低。
 *
 * 旧实现的暗侧闸门是 `beadL > 0.16` —— 也就是说只放行 L<0.16 的色，
 * 而全色卡里 L<0.16 只有 H07#000000 一颗。实战里当瞳孔用的正是
 * H16#1D1414（L=0.203），**永远过不了闸门** → 暗侧救援形同不存在
 * → 这就是 64 格"有眼白没黑瞳"的直接原因。
 *
 * 上限放到 0.42 是有依据的：色卡里 L<0.30 只有 4 颗（H07 L=0.000、
 * H16 L=0.203、D10 L=0.285、H06 L=0.295），都是货真价实的中性深色。
 * 0.42 再给深棕/深藏青留一点余地，同时彩度上限 0.075 把深红、深绿
 * 这类彩色挡在外面。
 */
function isNeutralDark(c: BeadColor): boolean {
  const C = Math.hypot(c.lab.a, c.lab.b);
  return c.lab.L < 0.42 && C < 0.075;
}

// ---------------------------------------------------------------------------
// ICM 优化
// ---------------------------------------------------------------------------

/**
 * 边缘感知的 ICM（Iterated Conditional Modes）。
 *
 * 能量函数：
 *   E(c) = Σ_p D(source_p, c_p) + λ · Σ_{p,q} w_pq · [c_p ≠ c_q]
 *
 * - D 是 OKLab 距离平方（保真项）；
 * - λ 由 smoothing 控制（越大越倾向成片）；
 * - w_pq 由**源图**两格的颜色差异决定：源图接近 → w 接近 1（鼓励同色）；
 *   源图是轮廓 → w 接近 0（不强行抹平，保住造型）。
 *
 * 这正是让色块"一片片"而不"糊成一团"的关键：平滑只发生在本来
 * 就该是同一个色的地方。
 */
/**
 * 小特征保护：把眼睛高光、瞳孔这类"面积小但决定性"的细节钉回格子。
 *
 * 为什么必须有这一步：
 * 池化是 4×4=16 个超采样像素的**众数表决**。一颗高光在超采样尺度上
 * 往往只有 2-3 个像素（占 12%-19%），众数永远轮不到它 —— 于是高光被
 * 抹掉，眼睛变成一块没有反光的死黑斑。拼豆成品里，有没有那一点高光
 * 直接决定角色"有没有神韵"（用户原话），所以不能用统计手段去求，
 * 必须显式判定并强制保留。
 *
 * 判据（同时满足才算"该保的小特征"）：
 *   1. 覆盖够：该颜色在本格至少占 2 个超采样像素（1 个像素多是抗锯齿噪点）；
 *   2. 够显眼：与格子主色的感知距离 > 0.09，否则只是同色渐变；
 *   3. 够极端：它是本格内最亮或最暗的那一撮（高光最亮、瞳孔最暗），
 *      中间调的少数派不抢位置；
 *   4. 主色没占满：主色像素数 ≤ 12（占 75%）。主色已经很踏实的时候，
 *      不该为一个次要色整格改色。
 */
/**
 * 归并调色板里感知上近乎重复的颜色。
 *
 * 为什么非得做：k-medoids 只优化"总误差"，对"两条色是否重叠"没有概念。
 * 当上限给到 20-24 色时，它会很自然地挑出同一色系里明度差一两档的
 * 好几条候选（#50AAF0 / #7CC4FF / #8BDBFA 这类），因为每条都能再降低
 * 一点点误差。但这些色在成品上几乎无法区分，最近邻会按浮点噪声把
 * 相邻格分给不同条目 → 满图细微斑点，色号数量也虚高，用户买豆时
 * 平白多买好几色。
 *
 * 做法：反复找距离最近的一对（< 0.075），把面积小的并入面积大的，
 * 重映射所有格子下标，直到没有足够近的一对。保留的是面积大的那条，
 * 所以视觉重心不会被挪动。
 */
function coalescePalette(
  cells: Int16Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  minD = 0.075,
): void {
  const MIN_D = minD;
  const n = cols * rows;

  for (let round = 0; round < palette.length; round++) {
    const counts = new Array<number>(palette.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c >= 0) counts[c]++;
    }

    let bestA = -1;
    let bestB = -1;
    let bestD = MIN_D;
    for (let a = 0; a < palette.length; a++) {
      if (counts[a] === 0) continue;
      for (let b = a + 1; b < palette.length; b++) {
        if (counts[b] === 0) continue;
        const d = Math.sqrt(beadDist2(palette[a].lab, palette[b].lab));
        if (d < bestD) {
          bestD = d;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0) break;

    // 保留面积大的，把小的并过去
    const keep = counts[bestA] >= counts[bestB] ? bestA : bestB;
    const drop = keep === bestA ? bestB : bestA;
    for (let i = 0; i < n; i++) {
      if (cells[i] === drop) cells[i] = keep;
    }
    // 把 drop 的计数清空，使其在下一轮被跳过
    counts[drop] = 0;
    palette[drop] = palette[drop];
  }
}

function enforceAccents(
  cells: Int16Array,
  pooled: Float32Array,
  ssIdx: Int16Array,
  lab: Float32Array,
  alpha: Float32Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  gw: number,
  ss: number,
  aaMin: number,
  voteMax: number,
  minContrast: number,
  regionField: RegionField,
): Uint8Array {
  const protectedCells = new Uint8Array(cols * rows);
  const rej: Record<string, number> = { vote: 0, nbr: 0, win: 0, winSame: 0, noCand: 0, lowContrast: 0, cluster: 0, budget: 0, ok: 0 };
  /*
   * 钉之前先留一份原格子（主色）。
   *
   * 后面判断"这簇钉点是不是真高光"时，必须跟**它原来的主色**比反差；
   * 只跟调色板里有没有亮色/暗色比是没有意义的 —— 洛克猫和小龟这类
   * 通体浅色的角色，身上每一格都"含亮色"，绝对亮度门槛形同虚设。
   */
  const origCells = Int16Array.from(cells);
  const votes = new Int16Array(palette.length);
  const lumSum = new Float64Array(palette.length);

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const ti = ty * cols + tx;
      const main = cells[ti];
      if (main < 0) continue;

      votes.fill(0);
      lumSum.fill(0);
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const gi = (ty * ss + dy) * gw + (tx * ss + dx);
          if (alpha[gi] < aaMin) continue;
          const p = ssIdx[gi];
          if (p < 0) continue;
          votes[p]++;
          lumSum[p] += lab[gi * 3];
        }
      }

      /*
       * 主色像素太少说明这格本来就是过渡格，交给 ICM，不在这里硬钉。
       *
       * 门槛 = 该格负责的 ss² × 75%，并跟随局部区域算法插值：
       * 保细节/Q 萌档放宽到接近铺满才算"过渡格"，于是更容易保住高光；
       * 大色块档收紧，避免为了一点点亮斑多出个色号。
       */
      const localVoteMax = regionField.active
        ? regionField.accentVoteMax[ti]
        : voteMax;
      /*
       * 局部放行强度：用户在"保细节"档刷过的区域要真的能救回小特征。
       *
       * 前面两道安全阀（主色铺满就跳过、候选至少 2 像素）是所有档位
       * 共享的，于是笔刷刷在眼睛上几乎看不到变化（实测：刷与不刷都是
       * 9 色 1494 颗，逐格完全相同）。这里按局部权重把它们松开 ——
       * 只有被用户明确刷过的格子吃这份放行，大面积平涂区保持原样。
       */
      const relax = regionField.active ? regionField.accentRelax[ti] : 0;
      /*
      /*
       * 主色铺满整格的实心格一般跳过（它不是过渡格）。
       *
       * 但**深色格里的极小亮点**要放行：眼睛高光在 64 格图上常常只占
       * 1-2 个 ss 像素，4×4 众数表决必然把它投成整格黑；这里若也跳过，
       * 瞳孔就永远是死黑块。洛克猫实测：左眼高光保住了，右眼因为高光
       * 完全落在黑格内部而被跳过，两只眼睛一只有神一只死板 —— 不对称
       * 比两只都没有更难看。
       *
       * 只对 L < 0.45 的暗区放行，后面"最亮候选"分支还要求明度差 > 0.08，
       * 双重把关，不会把深色区的轻微起伏当成高光。
       */
      const voteGate = (localVoteMax / 16) * ss * ss;
      const bypassVote = relax >= 0.5 || palette[main].lab.L < 0.45;
      if (!bypassVote && votes[main] > voteGate) {
        rej.vote++;
        continue;
      }

      /*
       * 只在"被主色包围的内部格"上钉高光。
       *
       * 没有这道约束时，所有抗锯齿过渡格（主色没占满、又有个把偏亮/偏暗
       * 的像素）都会被判定成"小特征"，于是满图长出单个碎点，色数从 10
       * 暴涨到 24（实测洛克猫 72×61 的碎点肉眼可见）。真正的高光/瞳孔
       * 一定长在**实心色块的内部**：四邻域至少 3 个是同主色。
       * 这既准确描述了"眼睛里的一点亮"，也把外轮廓的过渡格全部排除。
       */
      const x0 = tx;
      const y0 = ty;
      let sameNbr = 0;
      let totNbr = 0;
      const nb = [
        [x0 - 1, y0],
        [x0 + 1, y0],
        [x0, y0 - 1],
        [x0, y0 + 1],
      ];
      for (const [nx, ny] of nb) {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const nc = cells[ny * cols + nx];
        if (nc < 0) continue;
        totNbr++;
        if (nc === main) sameNbr++;
      }
      if (totNbr < 3 || sameNbr < 3) {
        rej.nbr++;
        continue;
      }

      /*
       * 再用 5×5 窗口确认"确实在实心区内部"，而不只是四邻居碰巧同色。
       *
       * 四邻居判据对**轮廓线**无效：角色外轮廓往往是 1 格宽的深色描边，
       * 沿着斜线走时，一个描边格的上/左/右三个邻居也都是描边格，于是
       * "四邻居至少 3 个同色"成立 —— 抗锯齿的描边过渡就被当成了眼神。
       * 实测草叶兽：被钉的 22 格连成 (3,29)-(5,27)-(8,26) 这条斜线，
       * 正是它左侧的描边轮廓，最后变成一串散落的深绿噪点。
       *
       * 5×5 窗口的判据天然区分两者：实心区内部主色占比 80%+；
       * 描边格一侧是身体色、一侧是背景或另一种色，占比只有 40-60%。
       */
      let winSame = 0;
      let winTot = 0;
      let winEmpty = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x0 + dx;
          const ny = y0 + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) {
            winEmpty++;
            continue;
          }
          const nc = cells[ny * cols + nx];
          if (nc < 0) winEmpty++;
          winTot++;
          if (nc === main) winSame++;
        }
      }
      /*
       * 判据是"这一格被主体包围"而不是"主色占多数"。
       *
       * 描边格的特征是**一侧就是背景**（空白或另一种外部色），5×5 窗口
       * 里必然露出空格；而眼神的高光/瞳孔严格长在实心内部，窗口里一格
       * 空白都没有。
       *
       * 不能用"主色占 72%"：眼睛本身只有 4×5 格，高光格的 5×5 窗口里
       * 黑色瞳孔约 15 格、周围白脸约 10 格，主色占比只有 0.6 —— 那样会把
       * 洛克猫全部 0 个钉点筛掉，眼睛退化成死黑块、完全没有神采（用户
       * 原话：「眼睛那种高光要画的好一些的，不然没有神韵」）。
       */
      if (winTot < 16 || winEmpty > 2) {
        rej.win++;
        continue;
      }
      if (winSame / winTot < 0.35) {
        rej.winSame++;
        continue;
      }

      // 找出本格最亮与最暗的候选（各需 ≥2 像素）
      rej.noCand++;
      let bright = -1;
      let dark = -1;
      let maxL = -Infinity;
      let minL = Infinity;
      /*
       * 亮候选的像素门槛：一般要 ≥2 个 ss 像素（半个豆），但深色格放宽到 1。
       *
       * 右眼的高光常常刚好压在格子边界上，被切成 1+1 两个半格，任何单格
       * 都拿不到 2 像素 —— 于是左眼有神、右眼死黑，同一张脸不对称最难看。
       * 深色格放宽到 1 像素是安全的：它还必须通过"明度差 > 0.08"和
       * "被主体包围"两道关，深色躯干上随手一个噪点过不来。
       */
      const minPix =
        relax >= 0.5 || palette[main].lab.L < 0.45 ? 1 : 2;
      for (let p = 0; p < palette.length; p++) {
        if (p === main || votes[p] < minPix) continue;
        const meanL = lumSum[p] / votes[p];
        if (meanL > maxL) {
          maxL = meanL;
          bright = p;
        }
        if (meanL < minL) {
          minL = meanL;
          dark = p;
        }
      }

      const localMinD = regionField.active
        ? regionField.accentMinD[ti]
        : minContrast;
      const mainL = palette[main].lab.L;
      // 高光：比主色亮且对比够
      if (bright >= 0 && maxL - mainL > 0.08) {
        const d = Math.sqrt(beadDist2(palette[bright].lab, palette[main].lab));
        if (d > localMinD) {
          rej.ok++;
          cells[ti] = bright;
          protectedCells[ti] = 1;
          pooled[ti * 3] = palette[bright].lab.L;
          pooled[ti * 3 + 1] = palette[bright].lab.a;
          pooled[ti * 3 + 2] = palette[bright].lab.b;
          continue;
        }
      }
      // 瞳孔：比主色暗且对比够
      if (dark >= 0 && mainL - minL > 0.08) {
        const d = Math.sqrt(beadDist2(palette[dark].lab, palette[main].lab));
        if (d > localMinD) {
          rej.ok++;
          cells[ti] = dark;
          protectedCells[ti] = 1;
          pooled[ti * 3] = palette[dark].lab.L;
          pooled[ti * 3 + 1] = palette[dark].lab.a;
          pooled[ti * 3 + 2] = palette[dark].lab.b;
        }
      }
    }
  }

  /*
   * 收尾：只留"成对"的钉点。
   *
   * 上面那套判据是**逐格**看的：只要这一格里主色没占满、又有一小撮
   * 明显更亮或更暗的像素、且四邻域是实心同色，就钉。
   * 问题是：大面积平涂的角色身体上，随便一处轻微明暗过渡都满足它。
   * 实测洛克猫 64×54：一共钉了 54 格，其中 C29#34488E 一个色号就占了
   * **15 格，散落在 15 个互不相连的位置**（每个位置 1 格，最大的一块
   * 2 格）。这不是高光，这是把抗锯齿/明暗过渡误判成了"眼神"。
   * 更糟的是 pruneWeakColors 看到"该色有 15 个受保护格 ≥4"就整色保
   * 留下来，于是这 15 粒彩色沙子全部进了成品。
   *
   * 真正的眼神结构有空间特征：**高光贴着瞳孔**，两者相距 1-2 格，
   * 是一个抱在一起的小簇；身体上的误判则是散落的、孤立的、周围没有
   * 任何其它钉点的单格。
   *
   * 所以做一次连通性过滤：把钉点按 8 邻域聚成簇，
   *   - 簇内格数 ≥2 的保留（高光+瞳孔、或 2 格的高光）；
   *   - 单格簇只有在 3 格半径内存在**另一个不同颜色**的钉点时才保留
   *     （那才是"高光挨着瞳孔"的形态）。
   * 其余取消钉定，交回 ICM/碎块合并/去碎片流程正常处理。
   */
  const keepFlag = new Uint8Array(protectedCells.length);
  const seen = new Uint8Array(protectedCells.length);
  const stack: number[] = [];
  const comps: number[][] = [];
  const keptComps: { cells: number[]; contrast: number }[] = [];
  for (let i = 0; i < protectedCells.length; i++) {
    if (!protectedCells[i] || seen[i]) continue;
    const members: number[] = [];
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      members.push(cur);
      const x = cur % cols;
      const y = (cur / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const k = ny * cols + nx;
          if (!protectedCells[k] || seen[k]) continue;
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    comps.push(members);
  }
  for (const comp of comps) {
    let keepComp = true;
    /*
     * 第三道：跟**本格原来的主色**比，反差必须够大。
     *
     * 眼神的物理本质是"在一块平涂上开出高反差的小面"：眼白/高光比瞳孔
     * 亮 0.3+，瞳孔比眼白暗 0.5+。而身体上的明暗过渡只是同一色系里
     * 一两档的轻微起伏（相邻豆色 ΔL 常在 0.05-0.12）。
     *
     * 为什么不能用绝对亮度门槛：小龟通体浅青（#A9E5E5 L≈0.88），身上每
     * 一格都"含亮色"，`L > 0.78` 恒成立，于是钉点遍布全身（实测小龟
     * 64 格图钉了 35 格、散在 20 个碎块里），碎片清理全部被白名单挡住。
     * 只有跟原主色比才有判别力。
     */
    let maxContrast = 0;
    if (keepComp) {
      for (const c of comp) {
        const pin = cells[c];
        const base = origCells[c];
        if (pin < 0 || base < 0) continue;
        const d = Math.abs(palette[pin].lab.L - palette[base].lab.L);
        if (d > maxContrast) maxContrast = d;
      }
      /*
       * 这里用**宽松**的 0.10 而不是"一眼能看出不同"的 0.22。
       *
       * 因为眼神高光本身就常常是"白纸上的白"：洛克猫白脸 H09(L=0.94)
       * 上的高光还是 H09，跟原主色的明度差只有 0.0-0.1，但它在黑瞳孔
       * 旁边就是决定性的（用户原话：「眼睛那种高光要画的好一些的，不然
       * 没有神韵」）。卡 0.22 会把猫的 27 个候选钉点全部筛掉，眼睛退化
       * 成死黑块 —— 实测就是这个结果。
       *
       * 真正把关的是下一道"紧挨高反差邻格"：白纸上的白本身不构成高光，
       * 必须旁边有黑瞳孔才算。所以这里只做粗筛（去掉完全同色的情况）。
       */
      if (maxContrast < 0.1) { keepComp = false; rej.cluster++; }
    }

    /*
     * 第三道半：钉点必须**紧挨着反差大的邻格**。
     *
     * 眼神的形态是决定的：一颗亮高光必然贴着深瞳孔，只隔 1 格。
     * 而不该钉的东西（身上一小块明暗过渡）虽然自身反差也不小，但它
     * 四周全是同色 —— 它是"平涂上的一块补丁"，不是"贴在轮廓边上的点"。
     *
     * 实测洛克猫的钉点分布：真正在眼睛里的 (4,30) 反差 0.651、
     * (7,29) 0.324，紧邻黑瞳；而 (19,11)、(16,14)、(56,16)、(2,20)
     * 这些散在头顶/身上/尾巴的单格，八邻域里没有任何高反差邻格。
     */
    if (keepComp) {
      let touchesContrast = false;
      for (const c of comp) {
        if (touchesContrast) break;
        const px = c % cols;
        const py = (c / cols) | 0;
        const ownL = cells[c] >= 0 ? palette[cells[c]].lab.L : -1;
        for (let dy = -1; dy <= 1 && !touchesContrast; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            const q = cells[ny * cols + nx];
            if (q < 0 || q === cells[c]) continue;
            if (Math.abs(palette[q].lab.L - ownL) >= 0.25) {
              touchesContrast = true;
              break;
            }
          }
        }
      }
      /*
       * 单格簇的额外出路：如果这一格本身**就是紧贴黑瞳孔的那一点亮**，
       * 即使它是孤立的也留下。
       *
       * 之前"单格簇必须旁边另有一个钉点"的门槛把洛克猫唯一的眼睛高光
       * 筛掉了 —— 因为瞳孔本身在池化阶段就被正确判成黑色、根本不需要
       * 钉，于是高光旁边没有任何"钉点"，白纸上唯一的那点眼神就消失了。
       * 改成看它挨着的**格子**（不管那是钉点还是普通格）是否有高反差，
       * 这正是眼神的几何本质，也自然排除了身上的平涂补丁。
       */
      if (!touchesContrast) { keepComp = false; rej.cluster++; }
    }
    if (keepComp) {
      for (const c of comp) keepFlag[c] = 1;
      keptComps.push({ cells: comp, contrast: maxContrast });
    }
  }

  /*
   * 第四道（硬上限）：钉点总预算。
   *
   * 前三道都是"逐簇"判据，无论怎么调紧，边缘格总会漏过一些。拼豆是
   * 实物，多钉一格 = 多出一颗散落的异色豆，用户对"杂色"极其敏感
   * （原话：「杂色不要很多，不然很影响观感」）。所以加一道全局预算：
   * 钉点总数不超过总格数的 1.5%（64×54 约 3400 格 → 约 50 格，
   * 而真正的眼睛高光+瞳孔通常只用 4-16 格），按反差从大到小取。
   *
   * 这条不追求"理论上完美区分眼睛和身体"，它是个安全阀：宁可少钉
   * 几个高光，也不能让整张图变脏。反差最大的那些簇一定是眼睛。
   *
   * 数量参考：64×54 的 Q 萌立绘，一对眼睛的高光+瞳孔通常只占 4-16 格
   * （实测洛克猫真正有意义的钉点是 8 格）。取总格数的 0.6% 约 20 格，
   * 夹在 [6, 24]：小图不至于一刀切光，大图也不会放开成筛子。
   */
  const budget = Math.min(24, Math.max(6, Math.floor(cols * rows * 0.006)));
  keptComps.sort((a, b) => b.contrast - a.contrast);
  let used = 0;
  for (let k = 0; k < keptComps.length; k++) {
    const comp = keptComps[k].cells;
    if (used + comp.length > budget) {
      for (const c of comp) keepFlag[c] = 0;
      rej.budget += comp.length;
      continue;
    }
    used += comp.length;
  }

  for (let i = 0; i < protectedCells.length; i++) {
    if (protectedCells[i] && !keepFlag[i]) protectedCells[i] = 0;
  }


  return protectedCells;
}

function icmRefine(
  cells: Int16Array,
  pooled: Float32Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  smoothing: number,
  profile: DetailProfile,
  regionField: RegionField,
  protectedCells?: Uint8Array,
): void {
  if (smoothing <= 0.02 && !regionField.active) return;
  const lambda = (0.0006 + smoothing * 0.0055) * profile.lambdaScale;
  const sigma2 = 2 * 0.045 * 0.045 * profile.sigmaScale * profile.sigmaScale;

  /*
   * 每格实际 λ。
   *
   * - 局部区域：按羽化权重在"全局档"与"区域档"的 lambdaScale 之间插值，
   *   于是从区域中心往外走，平滑强度是连续的，不会再出现一条硬边；
   * - 接缝加强：seam = 4w(1-w) 在 w=0.5 处最大，正好是参数变化最快
   *   的那一圈。在这一圈里把 λ 再提 60%，等于对边界两侧施加更强的
   *   "尽量同色"压力 —— 这是把区域接缝抹平的关键一推。
   */
  const lambdaAt = new Float32Array(cols * rows);
  for (let i = 0; i < lambdaAt.length; i++) {
    let v = lambda;
    if (regionField.active) {
      const w = regionField.w[i];
      const rs = regionField.lambdaScale[i];
      v = (0.0006 + smoothing * 0.0055) * (1 + (rs - 1) * w);
      v *= 1 + 0.6 * regionField.seam[i];
    }
    lambdaAt[i] = v;
  }

  // 预计算邻居边权重（水平 + 垂直）
  const wH = new Float32Array(cols * rows); // (x,y)-(x+1,y)
  const wV = new Float32Array(cols * rows); // (x,y)-(x,y+1)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (x + 1 < cols) wH[i] = edgeWeight(pooled, i, i + 1, sigma2);
      if (y + 1 < rows) wV[i] = edgeWeight(pooled, i, i + cols, sigma2);
    }
  }

  const iterations = 3;
  const n = cols * rows;
  const localCost = new Float32Array(palette.length);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = 0;
    // 棋盘式更新（先偶后奇），减少顺序偏差
    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < rows; y++) {
        for (let x = (y + parity) % 2; x < cols; x += 2) {
          const i = y * cols + x;
          if (cells[i] < 0) continue;

          const L = pooled[i * 3];
          const A = pooled[i * 3 + 1];
          const B = pooled[i * 3 + 2];

          const cur = { L, a: A, b: B };
          for (let p = 0; p < palette.length; p++) {
            localCost[p] = beadDist2(cur, palette[p].lab);
          }

          // 加上邻居不一致的惩罚
          const nbrs: Array<[number, number]> = [];
          if (x > 0) nbrs.push([i - 1, wH[i - 1]]);
          if (x + 1 < cols) nbrs.push([i + 1, wH[i]]);
          if (y > 0) nbrs.push([i - cols, wV[i - cols]]);
          if (y + 1 < rows) nbrs.push([i + cols, wV[i]]);

          /*
           * 救援/强调色保护的格子：ICM 不许动。
           *
           * 踩到的坑：rescueCoherentFeatures 把鸭吉吉的白眼球（64 格图
           * 上只有 3 格）写进 protectedCellsEarly，但那段保护当时是**在
           * ICM 之后**才并进 protectedCells 的。于是 ICM 先跑，看到这
           * 3 个孤立白格被奶油黄包围，"邻域一致性"一算就把它们翻成黄
           * —— 眼睛在 ICM 这一步就死了，后面所有保护都在拯救一堆已经
           * 变成黄色的格子。
           *
           * 调试记录（每阶段 P01 的格子数）：
           *   post-rescue=3 → post-accent=3 → post-icm=**1** → 之后=0
           * 保护必须**在 ICM 之前就生效**，不是之后。
           */
          if (protectedCells && protectedCells[i]) continue;
          const li = lambdaAt[i];
          for (const [ni, w] of nbrs) {
            const nc = cells[ni];
            if (nc < 0) continue;
            const pw = li * w;
            for (let p = 0; p < palette.length; p++) {
              if (p !== nc) localCost[p] += pw;
            }
          }

          let best = 0;
          for (let p = 1; p < palette.length; p++) {
            if (localCost[p] < localCost[best]) best = p;
          }
          /*
           * 强对比格保护：如果本格当前色与格子平均色已经高度吻合
           * （说明它是干净的实心色块，不是边缘过渡格），并且它就是
           * 眼睛/高光这类小特征的一部分，那么不要为了"与邻居一致"
           * 把它翻掉。翻转只允许发生在**确实是混色边缘**的格子上。
           */
          const curCost = localCost[cells[i]];
          const isClean = curCost < 0.0006;
          if (isClean && best !== cells[i]) continue;
          if (best !== cells[i]) {
            cells[i] = best;
            changed++;
          }
        }
      }
    }
    if (changed < n * 0.004) break;
  }
}

function edgeWeight(
  pooled: Float32Array,
  i: number,
  j: number,
  sigma2: number,
): number {
  const dL = pooled[i * 3] - pooled[j * 3];
  const dA = pooled[i * 3 + 1] - pooled[j * 3 + 1];
  const dB = pooled[i * 3 + 2] - pooled[j * 3 + 2];
  const d2 = dL * dL + dA * dA + dB * dB;
  return Math.exp(-d2 / sigma2);
}

// ---------------------------------------------------------------------------
// 连通区域合并（去碎斑）
// ---------------------------------------------------------------------------

/**
 * 把面积过小的连通色块并进周围的主导色。
 *
 * 但不是所有小色块都要消灭 —— **高对比度的小特征**（眼睛、嘴线、
 * 腮红、瞳孔高光）正是角色可辨识度的来源。实测把嘴的红色碎块
 * 直接并掉后，整张脸就失去表情了。所以这里加了一道保护：
 * 若该色块与周围主导色的感知距离足够大（说明它是"有意的强调色"
 * 而非量化噪点），则保留。
 */
function mergeSmallRegions(
  cells: Int16Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  smoothing: number,
  protectedCells: Uint8Array | undefined,
  profile: DetailProfile,
  regionField: RegionField,
): void {
  const n = cols * rows;
  const baseMinArea = Math.max(2, Math.round(n * (0.0012 + smoothing * 0.006)));
  const visited = new Uint8Array(n);
  const stack: number[] = [];

  for (let seed = 0; seed < n; seed++) {
    if (visited[seed] || cells[seed] < 0) continue;
    const color = cells[seed];
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    const region: number[] = [];

    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      const x = i % cols;
      const y = (i / cols) | 0;
      if (x > 0 && !visited[i - 1] && cells[i - 1] === color) {
        visited[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x + 1 < cols && !visited[i + 1] && cells[i + 1] === color) {
        visited[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && !visited[i - cols] && cells[i - cols] === color) {
        visited[i - cols] = 1;
        stack.push(i - cols);
      }
      if (y + 1 < rows && !visited[i + cols] && cells[i + cols] === color) {
        visited[i + cols] = 1;
        stack.push(i + cols);
      }
    }

    /*
     * 面积门槛按区域插值：区域里若刷的是"保细节"，门槛更低（更小的
     * 碎块也留下）；刷"大色块"则更高（更容易被并掉）。羽化后取整，
     * 所以从区域中心到外部是逐格过渡的，不会在某个格突然变。
     */
    let minArea = baseMinArea;
    let contrastLimit = profile.mergeContrast;
    if (regionField.active && region.length) {
      /*
       * 面积门槛与对比豁免门槛都按**该碎块所在区域的实际参数**取值。
       * regionField 里这两个数组已经是"基础档 ↔ 区域档"按羽化权重
       * 插值过的结果，所以取平均即可得到连续的过渡 —— 相邻两个碎块
       * 不会因为一个在区域内、一个在区域外而得到突变的门槛。
       */
      let areaAcc = 0;
      let contrastAcc = 0;
      for (const i of region) {
        areaAcc += regionField.mergeAreaScale[i];
        contrastAcc += regionField.mergeContrast[i];
      }
      minArea = Math.max(
        1,
        Math.round((baseMinArea * areaAcc) / region.length),
      );
      contrastLimit = contrastAcc / region.length;
    }
    if (region.length >= minArea) continue;

    // 统计四邻域里出现最多的颜色（排除自己）
    const votes = new Map<number, number>();
    let anyNeighbor = false;
    for (const i of region) {
      const x = i % cols;
      const y = (i / cols) | 0;
      const check = (j: number) => {
        const c = cells[j];
        if (c < 0 || c === color) return;
        anyNeighbor = true;
        votes.set(c, (votes.get(c) ?? 0) + 1);
      };
      if (x > 0) check(i - 1);
      if (x + 1 < cols) check(i + 1);
      if (y > 0) check(i - cols);
      if (y + 1 < rows) check(i + cols);
    }
    if (!anyNeighbor) continue;

    let bestC = -1;
    let bestV = -1;
    for (const [c, v] of votes) {
      if (v > bestV) {
        bestV = v;
        bestC = c;
      }
    }
    if (bestC < 0 || bestC >= palette.length) continue;

    // 高对比度强调色保护：与主导邻色的 ΔE 大 → 是造型不是噪点，保留。
    // 但必须至少 3 格：单格高对比像素就是噪点，不是造型。
    if (region.length < 3) {
      /*
       * 小特征保护：enforceAccents 明确钉下的高光/瞳孔格，即使只有
       * 一两格也绝不能当噪点并掉 —— 那一点亮就是角色的眼神。
       */
      let hasProtected = false;
      if (protectedCells) {
        for (const i of region) {
          if (protectedCells[i]) {
            hasProtected = true;
            break;
          }
        }
      }
      if (hasProtected) continue;
      for (const i of region) cells[i] = bestC;
      continue;
    }
    const contrast = Math.sqrt(beadDist2(palette[color].lab, palette[bestC].lab));
    if (contrast > contrastLimit) continue;

    for (const i of region) cells[i] = bestC;
  }
}

// ---------------------------------------------------------------------------
// 背景去除
// ---------------------------------------------------------------------------

/**
 * 只从画布边缘向内泛洪，把与边缘背景色接近的**连通**区域标为空白。
 * 内部镂空（例如脸中间的眼睛、环形中间的洞）不会被误删 ——
 * 原始实现没有背景概念，一律补白，这才是"1674 颗白豆"的另一个来源。
 */
function removeBorderBackground(
  cells: Int16Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  tolerance: number,
): void {
  const n = cols * rows;

  // 用边缘格子的颜色众数作为背景色
  const border = new Map<number, number>();
  const pushBorder = (i: number) => {
    const c = cells[i];
    if (c >= 0) border.set(c, (border.get(c) ?? 0) + 1);
  };
  for (let x = 0; x < cols; x++) {
    pushBorder(x);
    pushBorder((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    pushBorder(y * cols);
    pushBorder(y * cols + cols - 1);
  }
  if (!border.size) return;

  let bgColor = -1;
  let bgVotes = -1;
  for (const [c, v] of border) {
    if (v > bgVotes) {
      bgVotes = v;
      bgColor = c;
    }
  }
  // 只有边缘明显被同一色占据时才认为是背景
  if (bgVotes < (cols + rows) * 2 * 0.55) return;

  const bgLab = palette[bgColor].lab;
  const tol2 = tolerance * tolerance;

  const isBgLike = (i: number) => {
    const c = cells[i];
    if (c < 0) return false;
    const l = palette[c].lab;
    const dL = l.L - bgLab.L;
    const da = l.a - bgLab.a;
    const db = l.b - bgLab.b;
    return dL * dL + da * da + db * db <= tol2;
  };

  const queue: number[] = [];
  const seen = new Uint8Array(n);
  for (let x = 0; x < cols; x++) {
    queue.push(x, (rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    queue.push(y * cols, y * cols + cols - 1);
  }

  while (queue.length) {
    const i = queue.pop()!;
    if (i < 0 || i >= n || seen[i]) continue;
    seen[i] = 1;
    if (!isBgLike(i)) continue;
    cells[i] = -1;
    const x = i % cols;
    const y = (i / cols) | 0;
    if (x > 0) queue.push(i - 1);
    if (x + 1 < cols) queue.push(i + 1);
    if (y > 0) queue.push(i - cols);
    if (y + 1 < rows) queue.push(i + cols);
  }
}

// ---------------------------------------------------------------------------
// 抖动（可选）
// ---------------------------------------------------------------------------

/**
 * Floyd–Steinberg 误差扩散。
 * 只对**周围颜色都相近**的平坦区域生效：轮廓处不抖，否则会破坏造型。
 */
function applyDither(
  cells: Int16Array,
  pooled: Float32Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
): void {
  const err = new Float32Array(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (cells[i] < 0) continue;
      const tL = pooled[i * 3] + err[i * 3];
      const tA = pooled[i * 3 + 1] + err[i * 3 + 1];
      const tB = pooled[i * 3 + 2] + err[i * 3 + 2];

      let best = 0;
      let bd = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p].lab;
        const dL = tL - c.L;
        const da = tA - c.a;
        const db = tB - c.b;
        const d = dL * dL + da * da + db * db;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      cells[i] = best;
      const c = palette[best].lab;
      const rL = tL - c.L;
      const rA = tA - c.a;
      const rB = tB - c.b;
      const spread = (dx: number, dy: number, f: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
        const ni = ny * cols + nx;
        err[ni * 3] += rL * f;
        err[ni * 3 + 1] += rA * f;
        err[ni * 3 + 2] += rB * f;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
}


// ---------------------------------------------------------------------------
// 弱色剪枝
// ---------------------------------------------------------------------------

/**
 * 剪掉用量过少的颜色，把它的格子重新吸附到调色板里最接近的色。
 *
 * 为什么需要：farthest-first + k-medoids 只要"能降低一点总误差"就会继续
 * 加色，于是在颜色过渡带（抗锯齿边缘、渐变）上选出一堆面积很小、
 * 彼此极近的色号。对拼豆这种实物媒材，多一个色号 = 多买一包豆子 +
 * 多一次换色，收益远小于成本。剪枝让"色号数量"真正对应画面层次。
 *
 * 实现：用 keep 掩码标记要保留的色，全部剪完后一次性压缩下标，
 * 避免边剪边改下标导致的映射错乱。
 */
function pruneWeakColors(
  cells: Int16Array,
  palette: BeadColor[],
  minRatio: number,
  protectedCells: Uint8Array | undefined,
  pruneAbsolute: number,
  regionField: RegionField,
  cols: number,
  rows: number,
  rescuedHexes: Set<string>,
): { cells: Int16Array; palette: BeadColor[] } {
  const keep = new Uint8Array(palette.length).fill(1);
  const out = Int16Array.from(cells);

  for (let pass = 0; pass < 8; pass++) {
    const counts = new Array<number>(palette.length).fill(0);
    let total = 0;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (c < 0) continue;
      counts[c]++;
      total++;
    }
    if (!total) break;

    let aliveCount = 0;
    for (let p = 0; p < palette.length; p++) if (keep[p] && counts[p] > 0) aliveCount++;
    if (aliveCount <= 3) break;

    const minCount = total * minRatio;
    let weak = -1;
    let weakCount = Infinity;
    /*
     * 被小特征保护占用的颜色不许剪 —— 但要有量级门槛。
     *
     * 实测教训：enforceAccents 会把个别格子钉成高光色，如果这里无条件
     * 保护，那么"只被 1-2 格用到"的颜色就永远剪不掉，最终调色板里残留
     * 一堆 C24:2 / H23:3 / R07:4 这样的超稀有色。它们对画面毫无贡献，
     * 却实打实多出一个色号（用户得为它单独买一包豆）。
     * 所以要求被保护的格子本身够成规模（≥4 格，约一对瞳孔的体量），
     * 才是真正需要保住的眼神细节。
     */
    const protCount = new Array<number>(palette.length).fill(0);
    if (protectedCells) {
      for (let i = 0; i < out.length; i++) {
        if (!protectedCells[i]) continue;
        const c = out[i];
        if (c >= 0 && c < palette.length) protCount[c]++;
      }
    }
    /*
     * 门槛 4 格**随网格面积缩放**，不能写死。
     *
     * 写死 4 时：鸭吉吉的眼睛在 96 格图上白眼球有 6-8 格 → 保住；
     * 到 64 格图（默认档位）只剩 3 格 → 被剪掉，眼睛变死黑。
     * 而 64 格图总共才 3328 个格子，3 格占 0.09%，和 96 格图的 7 格
     * 占 0.09% 是同一个"面积占比"，凭什么一个保一个不保？
     * 判据应该是"这个特征在画面上有多大比例"，而不是"占几个格"。
     *
     * 基准：7500 格（96×78）时 4 格；下限 2 格。
     */
    /*
     * 两重保护：
     *   1. **身份保护**：rescueCoherentFeatures 救回来的色（按 hex）无条件
     *      保留。它们是用户明确要求保住的眼神细节，靠格数判会被各阶段的
     *      格子流动磨掉（见 rescueCoherentFeatures 末尾注释）。
     *   2. **规模保护**：被 enforceAccents 钉住且量级够的色，按面积占比
     *      判（阈值随网格缩放）。
     */
    const protNeed = Math.max(2, Math.round((4 * cols * rows) / 7500));
    const protectedUse = new Uint8Array(palette.length);
    for (let p = 0; p < palette.length; p++) {
      if (rescuedHexes.has(palette[p].hex)) { protectedUse[p] = 1; continue; }
      if (protCount[p] >= protNeed) protectedUse[p] = 1;
    }
    /*
     * 每个颜色的剪枝门槛按它自己的"区域偏向"调整。
     *
     * 若某个色的格子大部分落在"保细节"区域里（区域权重均值高），它就不该
     * 按全图比例被剪 —— 那正是用户明确要求保留的细化区域。用该色格子的
     * 平均 regionField.pruneRatioScale 去缩放门槛：区域内外连续过渡，
     * 不会出现"区域里的色留下、紧邻的一模一样的色被剪掉"这种接缝。
     */
    const ratioScaleSum = new Array<number>(palette.length).fill(0);
    const contrastlessW = new Array<number>(palette.length).fill(0);
    if (regionField.active) {
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (c < 0) continue;
        ratioScaleSum[c] += regionField.pruneRatioScale[i];
        contrastlessW[c] += regionField.w[i];
      }
    }

    for (let p = 0; p < palette.length; p++) {
      if (!keep[p] || counts[p] <= 0) continue;
      if (protectedUse[p]) continue;
      let pMinCount = minCount;
      let pAbsolute = pruneAbsolute;
      if (regionField.active) {
        pMinCount = (minCount * ratioScaleSum[p]) / counts[p];
        const wAvg = contrastlessW[p] / counts[p];
        pAbsolute = Math.max(2, pruneAbsolute * (1 - 0.6 * wAvg));
      }
      if (counts[p] >= pMinCount) continue;
      if (counts[p] < pAbsolute) {
        if (counts[p] < weakCount) {
          weakCount = counts[p];
          weak = p;
        }
        continue;
      }
      let minD = Infinity;
      for (let q = 0; q < palette.length; q++) {
        if (q === p || !keep[q] || counts[q] <= 0) continue;
        const d = Math.sqrt(beadDist2(palette[p].lab, palette[q].lab));
        if (d < minD) minD = d;
      }
      if (minD > 0.12) continue;
      if (counts[p] < weakCount) {
        weakCount = counts[p];
        weak = p;
      }
    }
    if (weak < 0) break;

    // 吸附到最近的仍存活的色
    let target = -1;
    let bestD = Infinity;
    for (let p = 0; p < palette.length; p++) {
      if (p === weak || !keep[p] || counts[p] <= 0) continue;
      const dL = palette[p].lab.L - palette[weak].lab.L;
      const da = palette[p].lab.a - palette[weak].lab.a;
      const db = palette[p].lab.b - palette[weak].lab.b;
      const d = dL * dL + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        target = p;
      }
    }
    if (target < 0) break;

    for (let i = 0; i < out.length; i++) if (out[i] === weak) out[i] = target;
    keep[weak] = 0;
  }

  // 一次性压缩
  const remap = new Int16Array(palette.length).fill(-1);
  const nextPalette: BeadColor[] = [];
  for (let p = 0; p < palette.length; p++) {
    if (!keep[p]) continue;
    remap[p] = nextPalette.length;
    nextPalette.push(palette[p]);
  }
  const nextCells = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    nextCells[i] = c < 0 ? -1 : remap[c];
  }
  return { cells: nextCells, palette: nextPalette };
}

/**
 * 清理"彩色沙子"：把没形成形状的孤立色点溶进**周围实际的颜色**。
 *
 * 判据全程用**连通块**，不看总颗数。实测洛克猫 64×54 的成品里，
 * C29#34488E 有 16 颗豆却散在 15 个互不相连的块里（最大块仅 2 格），
 * H04#89858C 有 10 颗散在 6 块里（最大 5 格）—— 这种颜色在成品上
 * 根本看不出形状，只是给画面蒙上一层"彩色沙子"。拼豆是实物，一颗
 * 一颗买、一颗一颗摆，孤立的稀有色对观感只有负贡献：既不成形，又
 * 凭空多买一个色号。用户原话：「杂色不要很多，不然很影响观感」。
 *
 * 关键设计：**溶进邻色，而不是溶进调色板里最近的色**。
 * 一颗落在蓝色身体上的灰点，最近的调色板色可能是另一种灰，溶过去
 * 就成了另一种沙子；只有看它四周实际是什么色、溶进占多数的那一个，
 * 才真正"消失"。这也是所有像素画降噪的通行做法（邻域多数表决）。
 *
 * 规则：
 *   1. 某色的最大块 < 3 格 → 这一色在图上没有任何形状，整色溶解，
 *      每个碎块各自溶进它的主导邻色。
 *   2. 否则保留主结构，只溶解**尺寸 ≤2 且不贴主块**的孤立碎块。
 *   3. 被 enforceAccents 钉住的小特征（眼睛高光/瞳孔）在白名单里，
 *      永不溶解 —— 那是"面积小但决定神韵"的唯一合法例外。
 */
function defragmentColors(
  cells: Int16Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  protectedCells: Uint8Array | undefined,
): { cells: Int16Array; palette: BeadColor[] } {
  const out = Int16Array.from(cells);
  const n = cols * rows;

  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const nbCount = new Map<number, number>();
  const isProt = (i: number) => !!(protectedCells && protectedCells[i]);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;

    for (let p = 0; p < palette.length; p++) {
      // 收集该色连通块
      seen.fill(0);
      const blocks: number[][] = [];
      for (let i = 0; i < n; i++) {
        if (out[i] !== p || seen[i]) continue;
        const members: number[] = [];
        stack.length = 0;
        stack.push(i);
        seen[i] = 1;
        while (stack.length) {
          const cur = stack.pop()!;
          members.push(cur);
          const x = cur % cols;
          const y = (cur / cols) | 0;
          if (x > 0) { const k = cur - 1; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
          if (x < cols - 1) { const k = cur + 1; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
          if (y > 0) { const k = cur - cols; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
          if (y < rows - 1) { const k = cur + cols; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
        }
        blocks.push(members);
      }
      if (!blocks.length) continue;

      let maxBlock = 0;
      for (const b of blocks) if (b.length > maxBlock) maxBlock = b.length;
      // 这一色是否本来就只存在于被保护的小特征里
      let protTotal = 0;
      for (const b of blocks) for (const c of b) if (isProt(c)) protTotal++;

      /*
       * protTotal 的门槛也必须随网格面积缩放。
       *
       * 写死 4 时：鸭吉吉的白眼球在 96 格图有 6-8 个受保护格 → 不算
       * shapeless；到 64 格图只剩 3 格 → 被判为"无形状的碎片"，整块被
       * 溶进黄身子，眼睛变死黑。而 3 格在 64 格图（3328 格）里占 0.09%，
       * 和 7 格在 96 格图（7488 格）占 0.09% 完全等价 —— 判据应该是
       * 面积占比，不是格子数。
       *
       * 基准 7500 格时 4 格，下限 2 格。
       */
      const protTotalNeed = Math.max(2, Math.round((4 * cols * rows) / 7500));
      const shapeless = maxBlock < 3 && protTotal < protTotalNeed;

      /*
       * 碎块判据随"该色是否已成型"放宽。
       *
       * 只用 `<= 2` 时，实测 leaf 仍有 31.6% 的块是 3-4 格的孤立碎片
       * （`B17#9BB13A` 48 颗散在 20 个块、`B26#8D7A35` 11 颗散在 8 块）。
       * 但一刀切放宽到 4 会误伤真正的细节 —— 瞳孔、胡须、耳尖都可能是
       * 3-4 格。区别在于：**该色在别处已经形成了大块**（>= 12 格）时，
       * 这几格就是"掉队的碎片"；而整色最大的块也只有 3-4 格时，那是
       * 一个独立的小图形，必须留。
       */
      for (const b of blocks) {
        const prot = b.filter(isProt).length;
        /*
         * 被救回的颜色（白眼球等）整色不参与"碎块"清理。
         *
         * 只按 prot===0 豁免不够：一格白眼球被 mergeSmallRegions 溶掉时
         * 保护位留在原格上，于是白块本身可能只剩 0 个保护格 —— 明明整色
         * 都是救回来的，却因为"块里没保护位"被清理掉。
         */
        const strayThreshold = maxBlock >= 12 ? 4 : 2;
        /*
         * 单格"掉队豆"：该色在别处已经成片（maxBlock >= 12），这颗只有
         * 1 格、又只占 1 个保护位 —— 是 enforceAccents 的逐格钉点留下
         * 的噪声尾巴，不是任何一个源图结构特征（特征落位的配额至少
         * 会给出 2-8 格成团）。一颗豆被异色包住读不出任何形状，留着
         * 只是计入 micro。
         *
         * 实测 leaf crisp：17 个 micro 全是这种单格，而它们分别属于
         * B11/B12/B14/B15/B17 五个**在别处各有 100-700 颗**的色。反
         * 过来，真正的独立小特征（整色最大块都只有 1-2 格）由下面的
         * `shapeless` 分支保护，不受这条影响。
         */
        const loneStray = b.length === 1 && maxBlock >= 12 && prot <= 1;
        const shouldMelt =
          (shapeless || b.length <= strayThreshold) && (prot === 0 || loneStray);
        if (!shouldMelt) continue;

        // 主导邻色（该块四周接触最多的、非本色、非空白的颜色）
        nbCount.clear();
        for (const c of b) {
          const x = c % cols;
          const y = (c / cols) | 0;
          const probe = (nx: number, ny: number) => {
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
            const q = out[ny * cols + nx];
            if (q < 0 || q === p) return;
            nbCount.set(q, (nbCount.get(q) ?? 0) + 1);
          };
          probe(x - 1, y);
          probe(x + 1, y);
          probe(x, y - 1);
          probe(x, y + 1);
        }
        let tgt = -1;
        let best = 0;
        for (const [q, cnt] of nbCount) {
          if (cnt > best) { best = cnt; tgt = q; }
        }
        if (tgt < 0) continue; // 四周也是自己的色（比如整图就这一色），不动
        for (const c of b) out[c] = tgt;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 压缩下标，丢掉已不存在的色号
  const counts = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < n; i++) {
    const c = out[i];
    if (c >= 0) counts[c]++;
  }
  const remap = new Int16Array(palette.length).fill(-1);
  const nextPalette: BeadColor[] = [];
  for (let p = 0; p < palette.length; p++) {
    if (counts[p] === 0) continue;
    remap[p] = nextPalette.length;
    nextPalette.push(palette[p]);
  }
  const nextCells = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const c = out[i];
    nextCells[i] = c < 0 ? -1 : remap[c];
  }
  return { cells: nextCells, palette: nextPalette };
}

/**
 * 混色消除（blend elimination）：把"抗锯齿中间色"从调色板里赶走。
 *
 * 动机来自用户的原话：「杂色不要很多，不然很影响观感」。前面几轮清理
 * （pruneWeakColors / defragmentColors）都是按"面积小"或"块太小"判噪点，
 * 但眼睛周围那一圈灰绿、灰棕根本不小 —— 实测洛克猫 96×81 里
 * `M15#757D78` 有 24 颗豆、铺了 11 个块，最大块 9 格，稳稳越过所有
 * "碎块"门槛，于是每次都活下来，把黑眼珠糊成一团脏灰。
 *
 * 它为什么会出现：源图上眼睛边缘是黑（瞳孔）到白（眼白/脸）的抗锯齿
 * 过渡带，超采样把这些像素平均成**中间灰**，量化时被吸附到最近的真实
 * 豆色。也就是说这个豆色在源图里根本不存在，它是"黑 + 白"混合出来的
 * 幻觉。用 OKLab 一验证就明白：`M15 ≈ 0.56·H09(白) + 0.44·H06(黑)`，
 * 混合误差只有 0.017 —— 它就是中间灰。
 *
 * 判据（四条同时满足才消除）：
 *   1. **面积小**：占比 <= 3.5%。大面积色不可能是过渡带的产物。
 *   2. **形状碎**：`块数/格数 >= 0.35` 或 `最大块 <= 6`。真正的造型
 *      细节（瞳孔、胡须、耳尖）能形成紧凑的块；沿轮廓铺开的过渡带
 *      只会是一串小碎块。
 *   3. **可被混合解释**：存在另两色 a,b 使 `c ≈ t·a + (1-t)·b`，
 *      `t ∈ [0.15, 0.85]`、混合误差 <= 0.04，且 a、b 感知距离够远
 *      （否则两端几乎同色，混出来的"中间"没有意义）。
 *   4. **不是被钉住的小特征**：`protectedCells` 上的格子永不动 ——
 *      眼睛高光就是靠这条活下来的。
 *
 * 消解方式：把该色每格**拆给更接近它源色的那一端**，而不是整片刷成
 * 同一色。眼睛边缘偏黑的那半拆给黑、偏白的拆给白，轮廓自然收紧，
 * 不会留下一条硬边。
 */
function eliminateBlends(
  cells: Int16Array,
  palette: BeadColor[],
  pooled: Float32Array,
  cols: number,
  rows: number,
  protectedCells: Uint8Array | undefined,
): { cells: Int16Array; palette: BeadColor[]; removed: number } {
  const n = cols * rows;
  let out = Int16Array.from(cells);
  let pal = palette;
  let removed = 0;

  for (let pass = 0; pass < 3; pass++) {
    const counts = new Array<number>(pal.length).fill(0);
    for (let i = 0; i < n; i++) if (out[i] >= 0) counts[out[i]]++;
    const filled = counts.reduce((a, b) => a + b, 0);
    if (!filled) break;

    // 每色的块数 / 最大块
    const blockCount = new Array<number>(pal.length).fill(0);
    const maxBlock = new Array<number>(pal.length).fill(0);
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = out[i];
      if (p < 0 || seen[i]) continue;
      blockCount[p]++;
      let size = 0;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        size++;
        const x = cur % cols;
        const y = (cur / cols) | 0;
        if (x > 0) { const k = cur - 1; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
        if (x < cols - 1) { const k = cur + 1; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
        if (y > 0) { const k = cur - cols; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
        if (y < rows - 1) { const k = cur + cols; if (!seen[k] && out[k] === p) { seen[k] = 1; stack.push(k); } }
      }
      if (size > maxBlock[p]) maxBlock[p] = size;
    }

    // 找可消除的混色
    let victim = -1;
    let vA = -1;
    let vB = -1;
    let vErr = Infinity;
    for (let c = 0; c < pal.length; c++) {
      if (!counts[c]) continue;
      if (counts[c] / filled > 0.035) continue;
      const fragmented = blockCount[c] / counts[c] >= 0.35 || maxBlock[c] <= 6;
      if (!fragmented) continue;
      for (let a = 0; a < pal.length; a++) {
        if (a === c || !counts[a]) continue;
        for (let b = a + 1; b < pal.length; b++) {
          if (b === c || !counts[b]) continue;
          const A = pal[a].lab;
          const B = pal[b].lab;
          const C = pal[c].lab;
          const abx = B.L - A.L;
          const aby = B.a - A.a;
          const abz = B.b - A.b;
          const len2 = abx * abx + aby * aby + abz * abz;
          if (len2 < 0.02) continue;
          const acx = C.L - A.L;
          const acy = C.a - A.a;
          const acz = C.b - A.b;
          const t = (acx * abx + acy * aby + acz * abz) / len2;
          if (t < 0.15 || t > 0.85) continue;
          const dl = C.L - (A.L + abx * t);
          const da = C.a - (A.a + aby * t);
          const db = C.b - (A.b + abz * t);
          const err = Math.sqrt(dl * dl + da * da + db * db);
          if (err > 0.04) continue;
          if (err < vErr) { vErr = err; victim = c; vA = a; vB = b; }
        }
      }
    }
    if (victim < 0) break;

    /*
     * 白名单对"混色"基本不生效 —— 只有真正鲜艳的强调色才豁免。
     *
     * 踩过的坑：`enforceAccents` 会把眼睛上方一颗灰点（M15）当成高光钉住，
     * 因为灰和眼的黑之间有 0.4 的明度差，过了"紧挨高反差邻格"那一关。
     * 于是 eliminateBlends 逐格剔了 13 颗、留下 11 颗受保护的，画面里仍然
     * 挂着一串灰点 —— 清理等于没做。
     *
     * 反过来，真正需要保护的高光/腮红有两个共同点：**鲜艳**（彩度高）或
     * **极亮**（L 很高）。灰扑扑的中间色既不可能是指定的强调色，也不可能是
     * 用户想要的眼神，它只可能是抗锯齿的产物，所以不豁免。
     */
    const vc = pal[victim].lab;
    const victimChroma = Math.sqrt(vc.a * vc.a + vc.b * vc.b);
    const honorProtection = victimChroma > 0.06 || vc.L > 0.82;
    const la = pal[vA].lab;
    const lb = pal[vB].lab;
    const src = new Float32Array(3);
    for (let i = 0; i < n; i++) {
      if (out[i] !== victim) continue;
      if (honorProtection && protectedCells && protectedCells[i]) continue;
      const si = i * 3;
      src[0] = pooled[si];
      src[1] = pooled[si + 1];
      src[2] = pooled[si + 2];
      out[i] = beadDist2(src as unknown as Oklab, la) <= beadDist2(src as unknown as Oklab, lb) ? vA : vB;
    }
    removed++;

    // 该色若已被清空，压缩下标继续下一轮
    const left = new Array<number>(pal.length).fill(0);
    for (let i = 0; i < n; i++) if (out[i] >= 0) left[out[i]]++;
    if (left[victim] === 0) {
      const remap = new Int16Array(pal.length).fill(-1);
      const nextPal: BeadColor[] = [];
      for (let p2 = 0; p2 < pal.length; p2++) {
        if (!left[p2]) continue;
        remap[p2] = nextPal.length;
        nextPal.push(pal[p2]);
      }
      const nextCells = new Int16Array(n);
      for (let i = 0; i < n; i++) nextCells[i] = out[i] < 0 ? -1 : remap[out[i]];
      out = nextCells;
      pal = nextPal;
    }
  }

  return { cells: out, palette: pal, removed };
}

/**
 * 把色数裁到上限。
 *
 * 只在调色板超员时生效（rescueCoherentFeatures 允许短期超员 3 个）。
 * 裁剪顺序：先裁用量最小的**非保护**色，把它的格子并到 4 邻域主导色
 * （与 defragmentColors 同一套逻辑 —— 溶进邻居比溶进"调色板里最近的色"
 * 更彻底，后者只是把一颗沙换成另一种沙）。
 */
function enforceColorLimit(
  cells: Int16Array,
  palette: BeadColor[],
  cols: number,
  rows: number,
  colorLimit: number,
  protectedCells: Uint8Array,
): { cells: Int16Array; palette: BeadColor[] } {
  if (palette.length <= colorLimit) return { cells, palette };
  const n = cols * rows;
  const out = Int16Array.from(cells);
  const live = new Set<number>();
  for (let i = 0; i < n; i++) if (out[i] >= 0) live.add(out[i]);

  // 按"用量 + 是否含保护区"排序，从末尾开始裁
  const info: { p: number; count: number; prot: number }[] = [];
  for (const p of live) {
    let count = 0;
    let prot = 0;
    for (let i = 0; i < n; i++) {
      if (out[i] !== p) continue;
      count++;
      if (protectedCells[i]) prot++;
    }
    info.push({ p, count, prot });
  }
  /*
   * 排序：先按"有没有保护区"（没有的优先裁），再按用量升序。
   *
   * 原来的保护门禁是 `prot > 0` —— 只要有**任何一格**受保护就不裁。
   * 这对 64 格图不够：白眼球只有 3 格受保护，而一批过渡色也可能各有
   * 1-2 格被 enforceAccents 顺手钉住。真到要裁的时候，它们和白眼球
   * 平起平坐，于是"裁哪个"取决于数组顺序 —— 白眼球可能被裁掉。
   *
   * 改成按**保护区占比**排序更符合意图：一个色如果它的大部分用量都
   * 是受保护的（白眼球：3/3），它就是纯造型色，必须留；一个色如果有
   * 100 格却只有 1 格受保护，那是身体色顺手沾到的，优先裁。
   */
  info.sort((a, b) => {
    const fa = a.prot / Math.max(1, a.count);
    const fb = b.prot / Math.max(1, b.count);
    if (Math.abs(fa - fb) > 1e-6) return fa - fb; // 保护区占比低的先裁
    return a.count - b.count;
  });

  let excess = info.length - colorLimit;
  for (const it of info) {
    if (excess <= 0) break;
    /*
     * 纯造型色（受保护占比 ≥ 0.5）绝对不动 —— 裁掉它就是裁掉眼神。
     * 达不到这条的（哪怕有零星保护区）照裁。
     */
    if (it.prot / Math.max(1, it.count) >= 0.5) continue;
    // 溶进 4 邻域主导色
    const members: number[] = [];
    for (let i = 0; i < n; i++) if (out[i] === it.p) members.push(i);
    const nbCount = new Map<number, number>();
    for (const c of members) {
      const x = c % cols;
      const y = (c / cols) | 0;
      const probe = (nx: number, ny: number) => {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
        const q = out[ny * cols + nx];
        if (q < 0 || q === it.p) return;
        nbCount.set(q, (nbCount.get(q) ?? 0) + 1);
      };
      probe(x - 1, y); probe(x + 1, y); probe(x, y - 1); probe(x, y + 1);
    }
    let tgt = -1;
    let best = 0;
    for (const [q, cnt] of nbCount) if (cnt > best) { best = cnt; tgt = q; }
    if (tgt < 0) continue;
    for (const c of members) out[c] = tgt;
    excess--;
  }

  // 压缩下标
  const counts = new Array<number>(palette.length).fill(0);
  for (let i = 0; i < n; i++) if (out[i] >= 0) counts[out[i]]++;
  const remap = new Int16Array(palette.length).fill(-1);
  const next: BeadColor[] = [];
  for (let p = 0; p < palette.length; p++) {
    if (!counts[p]) continue;
    remap[p] = next.length;
    next.push(palette[p]);
  }
  const nextCells = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    nextCells[i] = out[i] < 0 ? -1 : remap[out[i]];
  }
  return { cells: nextCells, palette: next };
}

// ---------------------------------------------------------------------------
// 收尾统计
// ---------------------------------------------------------------------------

function finalize(
  cells: Int16Array,
  palette: BeadColor[],
  pooled: Float32Array,
  cols: number,
  rows: number,
  meta: Omit<PatternResult['meta'], 'sizeCm'>,
): PatternResult {
  const counts = new Array<number>(palette.length).fill(0);
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c >= 0) {
      counts[c]++;
      total++;
    }
  }

  // 平均色差
  let de = 0;
  let deN = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c < 0) continue;
    const p = palette[c].lab;
    const dL = pooled[i * 3] - p.L;
    const da = pooled[i * 3 + 1] - p.a;
    const db = pooled[i * 3 + 2] - p.b;
    de += Math.sqrt(dL * dL + da * da + db * db);
    deN++;
  }

  const used: UsedColor[] = palette
    .map((bead, i) => ({
      index: i,
      hex: bead.hex,
      rgb: bead.rgb,
      code: bead.code,
      count: counts[i],
      ratio: total ? counts[i] / total : 0,
    }))
    .filter((u) => u.count > 0)
    .sort((a, b) => b.count - a.count);

  // 重映射到紧凑下标
  const remap = new Int16Array(palette.length).fill(-1);
  used.forEach((u, newIdx) => {
    remap[u.index] = newIdx;
  });
  const compact = new Int16Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    compact[i] = c >= 0 ? remap[c] : -1;
  }

  return {
    cols,
    rows,
    cells: compact,
    palette: used.map((u, i) => ({ ...u, index: i })),
    totalBeads: total,
    meanDeltaE: deN ? de / deN : 0,
    meta: { ...meta, sizeCm: estimateSizeCm(cols, rows) },
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 从任意画布/图片源读 ImageData（限制长边以控制耗时） */
export function imageDataFromSource(
  source: CanvasImageSource,
  maxEdge = 720,
): ImageData | null {
  const el = source as HTMLImageElement;
  const w = el.naturalWidth || (source as HTMLCanvasElement).width;
  const h = el.naturalHeight || (source as HTMLCanvasElement).height;
  if (!w || !h) return null;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

/** 把 pattern 渲染成小尺寸 PNG dataURL（用于历史缩略图） */
export function patternToThumbnail(
  pattern: PatternResult,
  size = 132,
): string | null {
  if (typeof document === 'undefined') return null;
  const { cells, palette, cols, rows } = pattern;
  const cell = Math.max(1, Math.floor(size / Math.max(cols, rows)));
  const w = cols * cell;
  const h = rows * cell;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#FAF3E4';
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = cells[y * cols + x];
      if (c < 0) continue;
      ctx.fillStyle = palette[c].hex;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return canvas.toDataURL('image/png');
}

export { rgbToHex, rgbToOklab };
