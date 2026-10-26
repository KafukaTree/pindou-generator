/**
 * 拼豆底板规格 —— 「成品要几块板、怎么拼」的唯一真相源。
 *
 * ===========================================================================
 * 为什么需要这个模块（用户 m11918）
 * ===========================================================================
 * 用户原话：「为什么现在只是长边的？有点奇怪，不知道实际拼的过程是什么样子
 * 的板子，怎么定义才有助于用户？」
 *
 * 这是两个问题叠在一起：
 *
 *   1. `gridSize` 的定义是「**长边**上的格数」，短边按原图比例算出来的。
 *      定义本身没错（正方形图以外没有别的选法），但界面上只写「格/长边」
 *      四个字，用户没法把它对上现实 —— 他的动作不是「我要 64 格」，而是
 *      「我这块 29×29 的板放不放得下」。
 *
 *   2. 站内**一个数都没有**说板子。成品尺寸是按 5mm 豆算的（而且写死在
 *      两处），但 MARD 体系的主力是 **2.6mm 小豆** —— 同样 64 格，
 *      5mm 是 32cm、2.6mm 是 16.6cm，差了将近一倍。尺寸算错，后面
 *      「买几块板、豆子够不够、相框买多大」全部跟着错。
 *
 * 所以本模块负责：给定格数与豆径，算出成品边长、需要什么规格的板、要几块、
 * 并且**用拼缝**把「一块板放不下要拼」这件事变成可看见的。
 *
 * ===========================================================================
 * 实测调研的硬事实（2026-10，中文站 mypindou / beadpatternapp / 千岛拼豆）
 * ===========================================================================
 *  - 成品边长 = 豆径 × 格数。豆与豆之间**没有缝隙**（摆满钉板），所以不需要
 *    加任何间隙余量。这条是维基百科对 fuse beads 的通行定义推出来的。
 *  - 5mm 标准豆（midi）：主流板是 **29×29（841 钉，约 14.5cm）**，小板 14×14。
 *    52/78/104 格**没有**对应的 5mm 单板，必须拼。
 *  - 2.6mm 迷你豆（mini）：常见 **52×52 / 78×78 / 104×104** 三种板，
 *    52/78/104 都能单块放下。「大板」「小板」是品牌叫法不是尺寸，
 *    买板要同时认豆径和钉数；2.6mm 这一档 50/52/57 钉距不同、**不能互拼**。
 *  - 板子四周有一圈边框和卡扣，所以外形尺寸总比钉数大 1–2cm（29×29 的
 *    5mm 板实际在 16–17cm），商品页只写「16.5cm 大底板」判断不了能放几格。
 *  - 熨烫会收缩：2.6mm 线性收缩 5.8–7.7%，5mm 约 4–6%。所以成品**比图纸
 *    格子算出来的尺寸小一圈**，本模块给的是熨烫前（图纸尺寸）。
 *
 * ===========================================================================
 * 为什么只做这两个豆径
 * ===========================================================================
 * 色卡是 MARD/COCO/漫漫/盼盼/咪小窝 五家共 291 色，这五家都是 2.6mm 与 5mm
 * 两档（1.2mm 微型豆的生产厂家与色号体系都不同，接不上本站色卡）。硬塞一档
 * 用不上的规格进界面，只会让用户多点一次才找到自己的豆子。
 */

import type { Brand } from '@/lib/color/palette';

/** 豆径规格。字符串而不是毫米数：它要进 localStorage 和 PDF 请求体，可读性优先。 */
export type BeadSize = 'mini' | 'midi';

export interface BeadSpec {
  id: BeadSize;
  /** 界面上的一行标题 */
  label: string;
  /** 单颗豆的中心距，毫米 */
  mm: number;
  /** 这一档常见的底板钉数（边长），从大到小排好、去重 */
  plates: readonly number[];
  /**
   * 最常见、最该在界面上报出来的那块板。
   *
   * 不能简单取 `plates` 的首位或末位：2.6mm 的 `plates` 是 [52,78,104]，
   * 首位 52 对、末位 104 错；5mm 的是 [29,14]，首位 29 对、末位 14 错。
   * 两档的"对"落在一头一尾，所以必须显式写出来。
   */
  commonPlate: number;
  /** 熨烫线性收缩率区间（百分比），只用于提示，不参与计算 */
  shrink: readonly [number, number];
  /** 一句话说明这档适合什么 */
  hint: string;
}

/**
 * 两档豆径的实测规格。
 *
 * `plates` 的顺序有意义：**先按「能一块放下就不要再拼」找最小能容纳的板，
 * 都放不下时用最大那块去拼**。所以顺序不必是升序，真正用的是筛选逻辑。
 */
export const BEAD_SPECS: Record<BeadSize, BeadSpec> = {
  mini: {
    id: 'mini',
    label: '2.6mm 小豆',
    mm: 2.6,
    plates: [52, 78, 104],
    commonPlate: 52,
    shrink: [5.8, 7.7],
    hint: 'MARD 体系主力，细节多、成品小，适合挂件和相框画；摆的时候费眼',
  },
  midi: {
    id: 'midi',
    label: '5mm 大豆',
    mm: 5,
    plates: [29, 14],
    commonPlate: 29,
    shrink: [4, 6],
    hint: '新手主力，格子大好夹、熨烫容错高；同样的格数成品大一倍',
  },
};

/** 默认豆径。跟历史行为一致（原来写死 5mm），避免老用户的数字突然变一半。 */
export const DEFAULT_BEAD_SIZE: BeadSize = 'midi';

export const BEAD_SIZES: readonly BeadSize[] = ['mini', 'midi'];

export function isBeadSize(v: unknown): v is BeadSize {
  return v === 'mini' || v === 'midi';
}

/** 豆径（mm）。非法值退回默认，避免 PDF/会话里存了脏数据时算出 NaN。 */
export function beadMm(size: BeadSize | undefined | null): number {
  return BEAD_SPECS[isBeadSize(size) ? size : DEFAULT_BEAD_SIZE].mm;
}

/**
 * 成品尺寸（**熨烫前**，也就是图纸摆满钉板时的尺寸）。
 *
 * 保留一位小数：0.1mm 精度对拼豆没意义，但一位小数能让 2.6mm × 63 格
 * 显示成 16.4 而不是被四舍五入成 16 —— 相框内径差 4mm 就塞不进去了。
 */
export function finishedSizeCm(
  cols: number,
  rows: number,
  size: BeadSize | undefined | null,
): { w: number; h: number } {
  const mm = beadMm(size);
  return {
    w: +((cols * mm) / 10).toFixed(1),
    h: +((rows * mm) / 10).toFixed(1),
  };
}

export interface BoardPlan {
  /** 用哪种钉数的板 */
  plate: number;
  /** 横向需要几块 */
  across: number;
  /** 纵向需要几块 */
  down: number;
  /** 总块数 */
  total: number;
  /** true = 一块板放得下，这组数就是「买一块 xx×xx 板」 */
  single: boolean;
  /** 拼起来的总钉位（可能比图案大，多出来的格子空着） */
  spanCols: number;
  spanRows: number;
  /**
   * 有更省事的单块大板时给出它 —— 只在「本来要拼、但某块大板能一次放下」时
   * 出现。比如 2.6mm 的 78 格图，用 52 板要 2×2 四块，用 78 板一块就够。
   */
  betterSingle?: { plate: number; total: number };
}

/**
 * 算「需要什么板、几块」。
 *
 * 规则只有两条，但顺序不能反：
 *   1. **能一块放下就用一块**（取能容纳的最小钉数）—— 拼板意味着接缝，
 *      接缝意味着摆到一半要挪板、熨烫时接缝处容易翘。能不拼就不拼。
 *   2. 一块都放不下，用这一档**最大**的板去拼（块数最少、接缝最少）。
 *
 * 注意「容纳」是横纵**各自**独立判定的：29×29 的板放 40×20 的图放不下
 * （40 > 29），哪怕面积够。
 */
export function planBoards(
  cols: number,
  rows: number,
  size: BeadSize | undefined | null,
  /**
   * 用户手上有具体规格的板时（例如只有 14×14 小板），用这个钉数代替该
   * 豆径的默认板目录。给了它就不再尝试"换块更大的板一次放下"—— 用户
   * 说了手上是什么板，就不该再给他推荐别的尺寸。
   */
  plateOverride?: number,
): BoardPlan {
  const spec = BEAD_SPECS[isBeadSize(size) ? size : DEFAULT_BEAD_SIZE];
  const c = Math.max(1, Math.round(cols));
  const r = Math.max(1, Math.round(rows));

  const pinned =
    typeof plateOverride === 'number' && Number.isFinite(plateOverride)
      ? Math.max(2, Math.round(plateOverride))
      : null;
  if (pinned !== null) {
    const across = Math.ceil(c / pinned);
    const down = Math.ceil(r / pinned);
    return {
      plate: pinned,
      across,
      down,
      total: across * down,
      single: across === 1 && down === 1,
      spanCols: across * pinned,
      spanRows: down * pinned,
    };
  }

  const sorted = [...spec.plates].sort((a, b) => a - b);
  const fitting = sorted.find((p) => p >= c && p >= r);
  if (fitting !== undefined) {
    return {
      plate: fitting,
      across: 1,
      down: 1,
      total: 1,
      single: true,
      spanCols: fitting,
      spanRows: fitting,
    };
  }

  const biggest = sorted[sorted.length - 1];
  const across = Math.ceil(c / biggest);
  const down = Math.ceil(r / biggest);

  /*
   * 拼出来的总钉位会大于图案。若某块更大的板恰好能一次放下，就把它作为
   * 「更省事的选择」一并给出来 —— 用户拿到的不是「你必须拼 4 块」，而是
   * 「拼 4 块 52，或者买一块 78 一次摆完」。
   */
  const betterSingle = sorted
    .filter((p) => p >= c && p >= r)
    .sort((a, b) => a - b)[0];

  return {
    plate: biggest,
    across,
    down,
    total: across * down,
    single: false,
    spanCols: across * biggest,
    spanRows: down * biggest,
    ...(betterSingle !== undefined
      ? { betterSingle: { plate: betterSingle, total: 1 } }
      : {}),
  };
}

/**
 * 「几块板」的一行人话。给 UI 和 PDF 共用，避免两处各写一遍措辞。
 *
 * 单块时说得具体（「一块 29×29 板」），因为这时用户要做的就是去确认手上
 * 有没有这块板；多块时必须带上排列（「2×2 共 4 块」），因为他要按这个
 * 排列把板子拼起来摆。
 */
export function boardSummary(plan: BoardPlan): string {
  if (plan.single) return `1 块 ${plan.plate}×${plan.plate} 板`;
  const tiling = `${plan.across}×${plan.down} 共 ${plan.total} 块 ${plan.plate}×${plan.plate} 板`;
  if (plan.betterSingle) {
    return `${tiling}（或用 1 块 ${plan.betterSingle.plate}×${plan.betterSingle.plate} 板一次放下）`;
  }
  return tiling;
}

/**
 * 分板缝的格坐标。
 *
 * 返回**每条缝落在第几格之后**（0-based 的格下标边界），给画布叠层画线用。
 * 单板时返回空数组 —— 没有缝，一条线都不该画。
 *
 * 只在跨板方向给缝：29 板拼 2×1 时只有一条竖缝，横方向不画线，否则
 * 画面上会多出两条没有任何意义的横线。
 */
export function boardSeams(
  cols: number,
  rows: number,
  size: BeadSize | undefined | null,
  plateOverride?: number,
): { vertical: number[]; horizontal: number[] } {
  const plan = planBoards(cols, rows, size, plateOverride);
  if (plan.single) return { vertical: [], horizontal: [] };
  const vertical: number[] = [];
  for (let i = 1; i < plan.across; i++) {
    const at = i * plan.plate;
    if (at > 0 && at < cols) vertical.push(at);
  }
  const horizontal: number[] = [];
  for (let i = 1; i < plan.down; i++) {
    const at = i * plan.plate;
    if (at > 0 && at < rows) horizontal.push(at);
  }
  return { vertical, horizontal };
}

/** 品牌不过是色号体系，豆径是另一件事 —— 这行注释是给下一个维护者的提醒。 */
export type BoardBrand = Brand;

/**
 * 把短边向上取整到「整块底板铺满」。
 *
 * ===========================================================================
 * 为什么需要（用户 m12282）
 * ===========================================================================
 * 用户原话：「既然是拼豆格子，那么最好是整个格子整个格子的取，不然实在
 * 不好看，比如 64 就是整的，然后五十几就不整」。
 *
 * 64×54 这种数看着确实邋遢，但真正的问题不是"数字不好看"，而是
 * **它对应的现实是一块用不满的板**：64 列要 3 块 29 钉板（87 钉，
 * 用掉 64），54 行要 2 块（58 钉，用掉 54）—— 第二排每块板最后 4 行空着。
 * 摆的时候得数着行数停手，熨的时候空钉位还会让板子受热不均。
 *
 * 所以取整的规则不是"凑 4 的倍数"，而是**凑到下一块底板的边界**：
 * 29→29、30→58、54→58、58→58。这样每块板都用满，摆和熨都不用数。
 *
 * 只在短边上做。长边是用户指定的目标（他要 64 格就是 64 格），动它等于
 * 擅自改他的决定；短边本来就是"按比例算出来的派生值"，没有他自己的
 * 意图在里面，才是可以向上对齐的那一边。
 *
 * 返回的 `grown` 是"多补了几行/几列"，UI 要显式说出来 —— 用户看到 64×54
 * 变成 64×58，必须知道多的 4 行是他没画东西的空白格，否则会以为图被改了。
 */
export interface RoundToBoardResult {
  cols: number;
  rows: number;
  /** 实际补出来的行数（纵向）或列数（横向），0 = 本来就在边界上 */
  grown: number;
  /** 补之前的值，UI 用来写「54 → 58」 */
  before: number;
  /** 是否真的改了（已经对齐时 false，UI 不必提示） */
  changed: boolean;
}

/**
 * 把 `shortSide` 向上取整到当前豆径的底板钉数边界。
 *
 * 注意"边界"是**累计钉数**（n × plate），不是单块板的钉数：3 块 29 板
 * 的边界是 87，不是 29。`plate` 取 `commonPlate` 而不是最大的板 ——
 * 用户实际会去买的、以及 figma 里对得上 29×29 的就是它。
 */
export function roundToBoardEdge(
  shortSide: number,
  size: BeadSize | undefined | null,
  plateOverride?: number,
  /**
   * 长边格数。给了就能判断「这一档的某块板已经能一次放下整张图了吗」——
   * 能放下就**一格都不该补**（见下面的说明）。省略则退化为纯对齐。
   */
  longSide?: number,
): RoundToBoardResult {
  const spec = BEAD_SPECS[isBeadSize(size) ? size : DEFAULT_BEAD_SIZE];
  const v = Math.max(4, Math.round(shortSide));
  const L = typeof longSide === 'number' && Number.isFinite(longSide)
    ? Math.max(4, Math.round(longSide))
    : null;

  /*
   * 已经放得下就不要再补 —— 这条比"凑板边"优先。
   *
   * 踩过的坑（实测）：2.6mm 档 64×54 的图，一块 78×78 板能完整放下，
   * 但代码按 52 钉去对齐，把 54 补到 64。结果 64 既不是 52 的整数倍、
   * 也没让任何一块板用满，纯粹多出 10 行空白 —— 用户还得为这 10 行
   * 多买豆子。**补格的目的是让每块板用满，不是让数字看起来整齐。**
   *
   * 判定用这一档所有常见板（含用户指定的那块），只要有一块能横竖都
   * 容纳 `longSide × shortSide`，就不用补。
   */
  const candidates = (() => {
    const list = new Set<number>(spec.plates);
    if (typeof plateOverride === 'number' && Number.isFinite(plateOverride)) {
      list.add(Math.max(2, Math.round(plateOverride)));
    }
    return [...list];
  })();
  if (L !== null) {
    const fitsAlready = candidates.some((p) => p >= L && p >= v);
    if (fitsAlready) {
      return { cols: v, rows: v, grown: 0, before: v, changed: false };
    }
  }

  /*
   * 需要拼板时才凑边界。`plate` 用这一档的常用板（用户可覆盖），
   * "边界"是**累计钉数** n × plate，不是单块钉数。
   */
  const plate = Math.max(2, Math.round(plateOverride ?? spec.commonPlate));
  if (v % plate === 0) {
    return { cols: v, rows: v, grown: 0, before: v, changed: false };
  }
  const next = Math.ceil(v / plate) * plate;
  return { cols: next, rows: next, grown: next - v, before: v, changed: true };
}

/**
 * 长边 = `long` 并保持原图比例时，短边对齐到整块板之后的新比例。
 *
 * ===========================================================================
 * 为什么返回的是"比例"而不是直接返回 cols/rows
 * ===========================================================================
 * 因为 `computeGridSize(aspect, gridSize)` 的输入就是比例：把短边对齐后的
 * `rows/long` 反算成新比例喂给它，长边仍然由 `gridSize` 决定（用户说了算），
 * 短边则自然落到对齐值上。这样不需要在引擎里塞第二套尺寸逻辑 —— 引擎
 * 只有"比例 + 长边"一个入口，改完仍然只有一个入口。
 *
 * 边界：`as < 1` 说明原图是竖的、此时是**列**在短边上；调用方要按这个
 * 情况自己换手（本函数只做正方比例的归一化，不猜竖图）。
 */
export function aspectForRoundedShortSide(
  aspect: number,
  long: number,
  size: BeadSize | undefined | null,
  plateOverride?: number,
): { aspect: number; before: number; after: number; changed: boolean } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const L = Math.max(4, Math.round(long));
  const rawShort = Math.max(4, Math.round(a >= 1 ? L / a : L * a));
  const rounded = roundToBoardEdge(rawShort, size, plateOverride, L);
  if (!rounded.changed) {
    return { aspect: a, before: rawShort, after: rawShort, changed: false };
  }
  const nextAspect = a >= 1 ? L / rounded.cols : rounded.cols / L;
  return {
    aspect: +nextAspect.toFixed(6),
    before: rawShort,
    after: rounded.cols,
    changed: true,
  };
}
