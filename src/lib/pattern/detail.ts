/**
 * 精细度算法（Detail Profile）
 * ===============================================================
 *
 * 用户需要能"选算法"，而不是只拖一个 0–100 的平滑滑杆。原因是
 * 不同用途对"精细"的定义是**相反**的：
 *
 *   - 做小挂件（10cm 以内）：豆子少，需要**大色块、少色号**，
 *     细节多了反而糊、还难拼；
 *   - 做人物头像：眼睛、嘴、腮红这些 1–2 格的小特征是全部神韵所在，
 *     必须**保住小面积强对比色**；
 *   - 做卡通/精灵立绘：要**强轮廓 + 高彩度**，色块边界要干脆；
 *   - 做照片：只能靠**抖动**去骗过眼睛，否则一定断层。
 *
 * 一个滑杆无法同时表达这四种取向 —— 它只能在一个轴（平滑度）上移动，
 * 而真正的差异是多个轴（超采样倍数、调色板最小间隔、小特征保护强度、
 * 碎片合并门槛、弱色剪枝门槛）。所以这里把"算法"显式化：每个档位
 * 是一整组协同的管线参数，不是单一数值的别名。
 *
 * 每个参数为什么这么取值，都写在各字段注释里 —— 它们都是实测调出来的，
 * 凭直觉改很容易把某类图弄坏（比如把 crisp 的 AA_MIN 调高，眼睛
 * 高光立刻消失；把 chunky 的 MIN_SEP 调低，色号又会爆炸）。
 */

/** 可选的精细度算法 */
export type DetailAlgorithm = 'balanced' | 'crisp' | 'chunky' | 'chibi';

export const DETAIL_ALGORITHMS: DetailAlgorithm[] = [
  'balanced',
  'crisp',
  'chunky',
  'chibi',
];

export const DETAIL_META: Record<
  DetailAlgorithm,
  { label: string; short: string; blurb: string; best: string }
> = {
  balanced: {
    label: '均衡',
    short: '均衡',
    blurb: '默认档。抗锯齿、压噪点，色块成片但不丢五官。',
    best: '绝大多数图先用它',
  },
  crisp: {
    label: '保细节',
    short: '保细节',
    blurb: '超采样更细、允许更多相近色，小特征几乎不放过。',
    best: '人物头像、五官多的小图',
  },
  chunky: {
    label: '大色块',
    short: '大色块',
    blurb: '合并更狠、色号更少、边界更方，最好拼。',
    best: '小挂件、给新手拼',
  },
  chibi: {
    label: 'Q 萌卡通',
    short: 'Q 萌',
    blurb: '提彩度、护轮廓、强留高光与腮红，专治"没神韵"。',
    best: '精灵、宠物、二次元立绘',
  },
};

/**
 * 一整组协同的管线参数。
 *
 * 全部是"相对默认管线"的显式值，而不是增量 —— 便于逐项比对与复现。
 */
export interface DetailProfile {
  /** 超采样倍数：越大越能看清 1–2px 的小特征，代价是 O(n²) 时间 */
  ss: number;
  /** 单像素有效样本门槛：低于它视为抗锯齿/描边碎片，不参与调色板统计 */
  aaMin: number;
  /** 整格落豆门槛：覆盖不足此比例就留空（拼豆是实物，不能半颗悬空） */
  cellMin: number;
  /** 调色板最小间隔：新色必须与已选色差这么远，防止同色系重复占位 */
  minSep: number;
  /** 调色板近重复归并阈值 */
  coalesceD: number;
  /** ICM 平滑强度倍率 */
  lambdaScale: number;
  /** ICM 边缘核宽度倍率（越大越不把真实轮廓当边缘） */
  sigmaScale: number;
  /** 强调色最多补几个 */
  accentAdds: number;
  /** 强调色最小面积（weight^0.55 后的量纲） */
  accentMinWeight: number;
  /** 小特征（高光/瞳孔）判定：主色最多允许占多少 ss 像素（16 格的 75% = 12） */
  accentVoteMax: number;
  /** 小特征判定：与主色最小感知距离 */
  accentMinD: number;
  /**
   * 小特征放行强度（0..1）。
   *
   * 上面那两个门槛（accentVoteMax / accentMinD）只调"松紧"，但
   * `enforceAccents` 里还有两道**写死**的安全阀：
   *   - 深色格以外、主色铺满整格 → 直接跳过（防止把实心色块里的
   *     轻微起伏当高光）；
   *   - 亮/暗候选至少要 2 个超采样像素。
   * 这两道是所有档位共享的，于是"保细节"笔刷刷在眼睛上也几乎
   * 没有可见变化（实测：刷与不刷都是 9 色 1494 颗，逐格完全相同）。
   *
   * 这个字段专门松开它们：1.0 表示在该格的判定里**完全取消**
   * 亮度闸门与像素数门槛，只要"明度差够 + 被主体包围"就钉。
   * 只在用户明确刷过的区域生效，所以不会毁掉大面积平涂区。
   */
  accentRelax: number;
  /** 碎片合并的面积门槛倍率 */
  mergeAreaScale: number;
  /** 碎片合并的对比度豁免门槛：高于它的小块视为造型而非噪点 */
  mergeContrast: number;
  /** 弱色剪枝比例门槛倍率 */
  pruneRatioScale: number;
  /** 弱色剪枝的绝对下限：低于这么多格一律剪（独特也不免死） */
  pruneAbsolute: number;
  /** 双边滤波色彩核倍率：越小越保细节，越大越平滑 */
  sigmaColorScale: number;
  /** 彩度增强附加量（在用户滑杆之上再叠一点） */
  chromaBonus: number;
}

const BASE: DetailProfile = {
  ss: 4,
  aaMin: 0.25,
  cellMin: 0.5,
  minSep: 0.085,
  coalesceD: 0.075,
  lambdaScale: 1,
  sigmaScale: 1,
  accentAdds: 3,
  accentMinWeight: 14,
  accentVoteMax: 12,
  accentMinD: 0.13,
  accentRelax: 0.35,
  mergeAreaScale: 1,
  mergeContrast: 0.1,
  pruneRatioScale: 1,
  pruneAbsolute: 8,
  sigmaColorScale: 1,
  chromaBonus: 0,
};

const PROFILES: Record<DetailAlgorithm, DetailProfile> = {
  balanced: BASE,

  /*
   * 保细节：SS 提到 6 —— 一颗 1.5px 的高光在 SS=4 下只覆盖 2-3 个
   * 超采样像素，众数表决必输；SS=6 时有 6-9 个，才可能被保住。
   * MIN_SEP 降到 0.055：允许同一色系里多一档，用来表达阴影过渡。
   * AA_MIN 降到 0.18：轮廓上的半透明抗锯齿也算样本，边缘更贴形。
   * 代价很实在：时间约 2.25×（6²/4²），色号也会多 2-4 个。
   */
  crisp: {
    ...BASE,
    ss: 6,
    aaMin: 0.18,
    cellMin: 0.42,
    minSep: 0.055,
    coalesceD: 0.05,
    lambdaScale: 0.55,
    sigmaColorScale: 0.62,
    sigmaScale: 0.85,
    accentAdds: 5,
    accentMinWeight: 9,
    accentVoteMax: 13,
    accentMinD: 0.1,
    accentRelax: 1,
    mergeAreaScale: 0.7,
    mergeContrast: 0.08,
    pruneRatioScale: 0.6,
    pruneAbsolute: 5,
    chromaBonus: 0,
  },

  /*
   * 大色块：MIN_SEP 抬到 0.13，调色板天然稀疏；lambda 加大让 ICM
   * 更倾向成片；合并门槛抬高、对比豁免收紧 —— 宁可少一根头发丝，
   * 也要保证"一眼能数清有几种颜色"。CELL_MIN 抬到 0.62 会把
   * 耳朵尖、尾巴尖这类细长造型收掉，这是刻意的：它们拼不动。
   */
  chunky: {
    ...BASE,
    ss: 4,
    aaMin: 0.3,
    cellMin: 0.62,
    minSep: 0.13,
    coalesceD: 0.11,
    lambdaScale: 1.9,
    sigmaColorScale: 1.5,
    sigmaScale: 1.15,
    accentAdds: 1,
    accentMinWeight: 26,
    accentVoteMax: 10,
    accentRelax: 0,
    mergeAreaScale: 2.1,
    mergeContrast: 0.14,
    pruneRatioScale: 2.2,
    pruneAbsolute: 14,
    chromaBonus: 0.02,
  },

  /*
   * Q 萌卡通：彩度 +0.08（在用户滑杆之上再叠，卡通风格吃这个），
   * 双边滤波色彩核收到 0.75 —— 腮红、嘴线这类 2px 强对比特征必须活着。
   * 小特征保护放宽（voteMax 14、minD 0.11），因为 Q 版角色的眼睛
   * 往往占 2×2 格，比真实系更"大块"，用严格判据会漏掉。
   * 碎块合并收紧（mergeContrast 0.075）以保住瞳孔和腮红的边界。
   */
  chibi: {
    ...BASE,
    ss: 4,
    aaMin: 0.22,
    cellMin: 0.48,
    minSep: 0.075,
    coalesceD: 0.065,
    lambdaScale: 0.85,
    sigmaColorScale: 0.75,
    sigmaScale: 0.9,
    accentAdds: 4,
    accentMinWeight: 10,
    accentVoteMax: 14,
    accentMinD: 0.11,
    accentRelax: 0.8,
    mergeAreaScale: 0.85,
    mergeContrast: 0.075,
    pruneRatioScale: 0.8,
    pruneAbsolute: 6,
    chromaBonus: 0.08,
  },
};

export function getDetailProfile(a: DetailAlgorithm | undefined): DetailProfile {
  return PROFILES[a ?? 'balanced'] ?? BASE;
}

/** 供 UI 展示：这一档相对均衡档"更费时间/更费色"的量级提示 */
export function describeDetailCost(a: DetailAlgorithm): string {
  switch (a) {
    case 'crisp':
      return '约 2.3× 用时 · 色号偏多';
    case 'chunky':
      return '最快 · 色号最少';
    case 'chibi':
      return '约 1.1× 用时 · 色号适中';
    default:
      return '标准用时';
  }
}
