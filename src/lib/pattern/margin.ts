/**
 * 画布边距策略（纯函数，零运行时依赖）
 * ===============================================================
 * 卡通黑边是往主体**外面**长一圈黑格：它长到相邻的空白格上，原主体一格不动。
 * 所以描边宽 1–3 格，就必须在主体四周留出对应数量的空格。而自动裁图沿主体
 * 裁得很紧（四周只留 1–3 格），网格小的时候黑边长不出去，会被画布边界切掉
 * 一截 —— 线条断在边界上比不画还难看。
 *
 * 三种策略是三种取舍，不能替用户选：
 *
 *   occupy  占原边   —— 不动数据，现状。黑边吃掉原有留白，可能被切。
 *   shrink  缩小留边 —— 画布尺寸不变（省豆、省板），代价是内容被降采样，
 *                       细节会丢。适合"必须放过现有板子"。
 *   expand  扩大画布 —— 内容一格不动（细节 100% 保留），代价是成品物理尺寸
 *                       变大、豆子变多。适合"细节比尺寸重要"。
 *
 * 实现位置很关键：这里是在**量化之后**改图纸，而不是给源图补透明边再重跑
 * 量化。量化是整条管线里最贵的一段（超采样 + 双边滤波 + k-medoids），换边距
 * 让用户重跑一遍要几秒；这里只是数组搬移，几十毫秒。代价是必须自己维护
 * cells / guide / palette / sizeCm 的一致性，也就是下面所有"为什么"的来源。
 *
 * 本模块刻意不 import 任何**运行时**符号：`generate.ts` 会连带拉进色卡 JSON、
 * resample、regions 一大串，而这里只需要两个接口类型。副作用是
 * `estimateSizeCm` 得复刻一份（见 `sizeCmOf`）；好处是测试脚本能直接
 * `node --experimental-strip-types` import 本文件，不必先搭 `@/` 别名解析。
 *
 * 坐标约定与引擎一致：行优先 `row * cols + col`，`-1` 是空白格。
 */
import type { PatternResult, UsedColor } from './generate';
import type { OutlineGuide } from './outline';
import type { EditMap } from './edits';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

export type MarginMode = 'occupy' | 'shrink' | 'expand';

/** 四周预留的格数。用户明确要求 3 格（够最粗一档黑边长完还有余量）。 */
export const MARGIN_CELLS = 3;

/**
 * 默认策略。
 *
 * 必须是 `occupy`：它等于"什么都不做"，也就是这个功能上线前的行为。默认值
 * 一旦改成 shrink/expand，所有老用户的图纸会在升级后**静默变样**（尺寸或
 * 细节），这种改动没法用一句提示弥补。想引导用户开新策略就靠文案，不要靠默认值。
 */
export const DEFAULT_MARGIN: MarginMode = 'occupy';

/**
 * UI 用的三种策略文案，**顺序即展示顺序**。
 *
 * 刻意把 `occupy` 放第一位：它既是默认值，也是当前状态，用户进来第一眼看到
 * 的应该是"你现在这样"。这样即便有人图省事写 `MARGIN_META[0].value` 当默认值，
 * 得到的也还是 occupy，不会悄悄改了所有人的出图。
 *
 * `hint` 说人话：用户关心的是"会不会变糊 / 会不会变大"，而不是"这里是最近邻
 * 降采样"。`shrink` 必须点明会丢细节，否则用户会以为白拿了 3 格留白。
 */
export const MARGIN_META: { value: MarginMode; label: string; hint: string }[] = [
  {
    value: 'occupy',
    label: '占原边',
    hint: '什么都不改，黑边用原有留白；留白不足时会被画布切掉',
  },
  {
    value: 'shrink',
    label: '缩小留边',
    hint: '画布不变，内容缩小、四周空出 3 格；细节会略糊',
  },
  {
    value: 'expand',
    label: '扩大画布',
    hint: '内容一格不动，四周各加 3 格；成品变大、豆子变多',
  },
];

export interface MarginResult {
  pattern: PatternResult;
  guide: OutlineGuide;
  /** 新网格下标 = 旧网格下标按「同一个 (col,row) 变换」得到；offset 仅 expand 非 0 */
  offset: number;
  /** cols/rows 是否变了（expand=true，shrink=false，occupy=false） */
  grew: boolean;
  /** 实际用的边距格数（shrink 在极小画布上会被夹小，可能为 0） */
  cells: number;
}

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/** 每格 0.5cm（5mm 标准豆） */
const GRID_CM = 0.5;

/**
 * 复刻 `generate.ts:175 estimateSizeCm` 的 `+(cols * 0.5).toFixed(1)`。
 *
 * 为什么不直接 import：见文件头，本模块零运行时依赖。两处必须保持一致的
 * 唯一原因是"PDF 上的尺寸标注"和"页面显示的尺寸"要是同一个数；改这里就得
 * 同时改 generate.ts，否则用户会看到两个尺寸。
 */
function sizeCmOf(cols: number, rows: number): { w: number; h: number } {
  return { w: +(cols * GRID_CM).toFixed(1), h: +(rows * GRID_CM).toFixed(1) };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function clampInt(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * shrink 实际能用几格边距。
 *
 * 内框至少要留 6 格才有意义：1 格内框等于把整张图压成一个色块。所以按
 * `(min - 6) / 2` 向下取整，再夹到 [0, MARGIN_CELLS]。
 *
 * 两个夹取顺序不能换：4×4 时 `(4-6)/2 = -1`，负的 n 会让 `cols - 2n` **变大**、
 * 循环越界写进相邻行，而且不报错 —— 只是图变成一团乱码，极难查。
 */
function shrinkCellsFor(cols: number, rows: number): number {
  const usable = Math.floor((Math.min(cols, rows) - 6) / 2);
  return Math.min(MARGIN_CELLS, Math.max(0, usable));
}

/** 调色板深拷贝：rgb 也要复制，否则返回值与入参共享可变对象 */
function clonePalette(palette: UsedColor[]): UsedColor[] {
  return palette.map((p) => ({ ...p, rgb: { ...p.rgb } }));
}

/**
 * 按 cells 重新统计 count/ratio，返回总颗数。
 *
 * 沿用旧值是这里最容易犯的错：`expand` 只加空格时旧 count 恰好还对，
 * `shrink` 降采样后数量必变。图例写"该色 12 颗"、用户实际数出 9 格，
 * 会一路数到怀疑人生。
 */
function recount(cells: Int16Array, palette: UsedColor[]): number {
  const counts = new Array<number>(palette.length).fill(0);
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c < 0) continue;
    total++;
    // c 越界说明上游数据已经坏了；仍计入 totalBeads（= 非 -1 格数），只是不进桶
    if (c < counts.length) counts[c]++;
  }
  for (let i = 0; i < palette.length; i++) {
    palette[i].count = counts[i];
    palette[i].ratio = total ? counts[i] / total : 0;
  }
  return total;
}

/**
 * guide 必须与 pattern 同网格。
 *
 * 为什么不静默兜底：下标一旦错位，描边会画在完全随机的格子上，而表现只是
 * "线条有点怪"，几乎不可能归因到边距这一层。宁可当场抛错。
 */
function assertGuide(guide: OutlineGuide, cols: number, rows: number): void {
  const n = cols * rows;
  const bad =
    guide.cols !== cols ||
    guide.rows !== rows ||
    guide.score.length !== n ||
    guide.sourceAlpha.length !== n ||
    // sourceLab 是每格 3 个分量，长度校验必须乘 3
    guide.sourceLab.length !== n * 3 ||
    guide.protectedCells.length !== n ||
    (guide.occlusionScore !== undefined && guide.occlusionScore.length !== n);
  if (bad) {
    throw new RangeError(
      `margin: guide 与 pattern 网格不一致（pattern ${cols}x${rows}，guide ${guide.cols}x${guide.rows}）`,
    );
  }
}

/**
 * `cells` 必须真的装得下 cols×rows。
 *
 * 这条独立于 guide 校验，因为 expand 用 `subarray` 搬数据：长度不够时
 * `subarray` **不抛错**，只静默返回一段短数组，`set` 之后那条带的内容就凭空
 * 少一截 —— 表现是"图右边少了一列"，程序却一路正常。生成器或手写测试数据
 * 都可能造出这种短数组，所以在这里当场拦住。
 */
function assertCells(pattern: PatternResult): void {
  const expect = pattern.cols * pattern.rows;
  if (pattern.cells.length !== expect) {
    throw new RangeError(
      `margin: cells 长度与网格不符（${pattern.cols}x${pattern.rows} 需要 ${expect}，实际 ${pattern.cells.length}）`,
    );
  }
}

/**
 * 正向上采样：内框第 j 列 → 源列（最近邻）。
 *
 * `innerLen === 1` 时分母为 0；此时内框只有一列，取源图中点，别让
 * `Math.round(0/0 * x)` 变成 NaN 再被 Int16Array 静默转成 0。
 */
function srcIndexForInner(j: number, srcLen: number, innerLen: number): number {
  if (innerLen <= 1) return clampInt(Math.round((srcLen - 1) / 2), 0, srcLen - 1);
  return clampInt(Math.round((j * (srcLen - 1)) / (innerLen - 1)), 0, srcLen - 1);
}

/**
 * 反向映射（只给 remapEdits 用）：源列 → 内框列。
 *
 * 这是**近似逆**，不是精确逆：正向是步长 > 1 的稀疏采样，会有源格一次都没
 * 被采到（12→6 时源列 5 就落空），所以 `forward(backward(s)) !== s` 是常态。
 * 用户画的格只需落到"最近的可见位置"，别指望精确往返。
 */
function innerIndexForSrc(s: number, srcLen: number, innerLen: number): number {
  if (srcLen <= 1 || innerLen <= 1) return 0;
  return clampInt(Math.round((s * (innerLen - 1)) / (srcLen - 1)), 0, innerLen - 1);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 按策略变换图纸与描边引导。
 *
 * `occupy` 返回**原对象引用**而不是副本：调用方（画布、图例、PDF）普遍用
 * `result.pattern === base` 判断"这一层没做事"，返回副本会让每帧多做一次
 * 全图重绘，也丢掉了"零开销"这个语义。
 */
export function applyMargin(
  pattern: PatternResult,
  guide: OutlineGuide,
  mode: MarginMode,
): MarginResult {
  const cols = pattern.cols;
  const rows = pattern.rows;

  if (mode === 'occupy') {
    // 不校验 guide：这条路径一根手指都不碰数据，校验会把"零开销"变成 O(n)
    return { pattern, guide, offset: 0, grew: false, cells: 0 };
  }

  assertGuide(guide, cols, rows);
  assertCells(pattern);

  if (mode === 'expand') {
    const n = MARGIN_CELLS;
    const newCols = cols + 2 * n;
    const newRows = rows + 2 * n;
    const newCount = newCols * newRows;

    // Int16Array 默认填 0，而 0 是**合法色号**。不 fill(-1) 的话，新边会被当成
    // "第 0 号色全部拼上"，图例里凭空多出一整圈豆子 —— 而且看起来毫不异常。
    const cells = new Int16Array(newCount).fill(-1);
    for (let y = 0; y < rows; y++) {
      cells.set(
        pattern.cells.subarray(y * cols, (y + 1) * cols),
        (y + n) * newCols + n,
      );
    }

    const score = new Float32Array(newCount);
    const sourceAlpha = new Float32Array(newCount);
    const sourceLab = new Float32Array(newCount * 3);
    const protectedCells = new Uint8Array(newCount);
    // occlusionScore 是可选的（outline.ts 用 `if (guide.occlusionScore)` 判断
    // 能力是否可用）。源里没有就别造一个全 0 的，那会误报"补线能力已就绪"。
    const occlusionScore = guide.occlusionScore
      ? new Float32Array(newCount)
      : undefined;

    for (let y = 0; y < rows; y++) {
      const dst = (y + n) * newCols + n;
      score.set(guide.score.subarray(y * cols, (y + 1) * cols), dst);
      sourceAlpha.set(guide.sourceAlpha.subarray(y * cols, (y + 1) * cols), dst);
      protectedCells.set(
        guide.protectedCells.subarray(y * cols, (y + 1) * cols),
        dst,
      );
      // sourceLab 每格 3 个分量：源偏移与目标偏移都要乘 3，本模块最易错的一处
      sourceLab.set(
        guide.sourceLab.subarray(y * cols * 3, (y + 1) * cols * 3),
        dst * 3,
      );
      if (occlusionScore && guide.occlusionScore) {
        occlusionScore.set(
          guide.occlusionScore.subarray(y * cols, (y + 1) * cols),
          dst,
        );
      }
    }

    const palette = clonePalette(pattern.palette);
    const totalBeads = recount(cells, palette);

    return {
      pattern: {
        cols: newCols,
        rows: newRows,
        cells,
        palette,
        totalBeads,
        // 平均色差是"与原图比"得来的；画布变大不会让它更准或更差
        meanDeltaE: pattern.meanDeltaE,
        // meta 其余字段原样浅拷贝（品牌、参数都是值语义），只重算 sizeCm
        meta: { ...pattern.meta, sizeCm: sizeCmOf(newCols, newRows) },
      },
      guide: {
        cols: newCols,
        rows: newRows,
        score,
        ...(occlusionScore ? { occlusionScore } : {}),
        sourceLab,
        sourceAlpha,
        protectedCells,
      },
      offset: n,
      grew: true,
      cells: n,
    };
  }

  // ---- mode === 'shrink' ----
  const n = shrinkCellsFor(cols, rows);
  if (n === 0) {
    /*
     * 画布太小，连 3 格留白都放不下 → 退化成 occupy 的行为。
     *
     * 这里刻意也返回**原引用**：这样"引用相等即未变换"的判断在三种模式下
     * 都成立，不会出现"UI 说没变、数据说变了"的不一致。remapEdits 里同样
     * 按 n === 0 短路，两处必须同进同退。
     */
    return { pattern, guide, offset: 0, grew: false, cells: 0 };
  }

  const innerW = cols - 2 * n;
  const innerH = rows - 2 * n;
  const count = cols * rows;

  // 同 expand：Int16Array 默认 0 是个坑，外框必须显式 -1
  const cells = new Int16Array(count).fill(-1);
  const score = new Float32Array(count);
  const sourceAlpha = new Float32Array(count);
  const sourceLab = new Float32Array(count * 3);
  const protectedCells = new Uint8Array(count);
  const occlusionScore = guide.occlusionScore ? new Float32Array(count) : undefined;

  for (let jy = 0; jy < innerH; jy++) {
    const sy = srcIndexForInner(jy, rows, innerH);
    for (let jx = 0; jx < innerW; jx++) {
      const sx = srcIndexForInner(jx, cols, innerW);
      const dst = (n + jy) * cols + (n + jx);
      const src = sy * cols + sx;

      // cells 与 guide 必须走**同一个** (sx, sy)：两套映射一旦不同步，描边用的
      // 梯度/色差会和格子错开一格，线条整体漂移，比不描边还怪
      cells[dst] = pattern.cells[src];
      score[dst] = guide.score[src];
      sourceAlpha[dst] = guide.sourceAlpha[src];
      protectedCells[dst] = guide.protectedCells[src];
      sourceLab[dst * 3] = guide.sourceLab[src * 3];
      sourceLab[dst * 3 + 1] = guide.sourceLab[src * 3 + 1];
      sourceLab[dst * 3 + 2] = guide.sourceLab[src * 3 + 2];
      if (occlusionScore && guide.occlusionScore) {
        occlusionScore[dst] = guide.occlusionScore[src];
      }
    }
  }

  /*
   * palette 只重算 count/ratio，**不删除也不用重排下标**。
   *
   * 为什么不删"降采样后一颗不剩"的色号：改下标会连带改掉 cells 里所有引用，
   * 而外部（编辑层、PDF、撤销栈）可能已经缓存了 palette 下标；保持下标稳定
   * 比图例干净更重要。代价是图例里可能出现 0 颗的色号 —— 消费方按
   * `count > 0` 过滤即可（与 edits.ts 的 compact 做法一致）。
   */
  const palette = clonePalette(pattern.palette);
  const totalBeads = recount(cells, palette);

  return {
    pattern: {
      cols,
      rows,
      cells,
      palette,
      totalBeads,
      meanDeltaE: pattern.meanDeltaE,
      // cols/rows 没变 → 成品尺寸也没变。sizeCm 复制一份，避免与入参共享引用
      meta: { ...pattern.meta, sizeCm: { ...pattern.meta.sizeCm } },
    },
    guide: {
      cols,
      rows,
      score,
      ...(occlusionScore ? { occlusionScore } : {}),
      sourceLab,
      sourceAlpha,
      protectedCells,
    },
    // shrink 的 offset 不是"画布偏移"，而是"内框起始格"，仅供 remapEdits 反向换算
    offset: n,
    grew: false,
    cells: n,
  };
}

// ---------------------------------------------------------------------------
// 编辑层迁移
// ---------------------------------------------------------------------------

/**
 * 把 edits 的键从「旧网格坐标」变换到「新网格坐标」。
 *
 * `occupy` 返回原对象引用：空编辑是最常见的入参，且这条路径每帧都走；
 * 返回副本会让 React 的依赖比较失效、白白重渲染。
 *
 * 非法键（NaN / 非整数 / 负数 / 越界）一律丢弃：UI 切尺寸时画笔可能残留上一张
 * 图的坐标，静默丢掉比崩掉好。但"改完边距后编辑没跟过去"是用户能感知的，
 * 调用方应当在迁移后重建画布。
 *
 * 值原样保留（色号字符串）。注意这里**不**校验色号是否存在 —— 那是
 * applyEdits 的职责，这里只搬运。
 */
export function remapEdits(
  edits: EditMap,
  pattern: PatternResult,
  mode: MarginMode,
): EditMap {
  if (mode === 'occupy') return edits;

  const cols = pattern.cols;
  const rows = pattern.rows;
  const cellCount = cols * rows;

  if (mode === 'expand') {
    const n = MARGIN_CELLS;
    const newCols = cols + 2 * n;
    const next: EditMap = {};
    for (const key of Object.keys(edits)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= cellCount) continue;
      const x = index % cols;
      const y = (index - x) / cols;
      next[(y + n) * newCols + (x + n)] = edits[index];
    }
    return next;
  }

  // ---- shrink ----
  const n = shrinkCellsFor(cols, rows);
  // n === 0 时 applyMargin 也退化成 occupy；这里保持同样的"不迁移"语义，
  // 否则会出现"图没变、编辑却被搬走了"的诡异状态
  if (n === 0) return edits;

  const innerW = cols - 2 * n;
  const innerH = rows - 2 * n;
  const next: EditMap = {};
  for (const key of Object.keys(edits)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= cellCount) continue;
    const sx = index % cols;
    const sy = (index - sx) / cols;
    const jx = innerIndexForSrc(sx, cols, innerW);
    const jy = innerIndexForSrc(sy, rows, innerH);
    /*
     * 降采样后多个源格会落到同一个内框格，**后写覆盖先写**是故意的：
     * `Object.keys` 对整数键按升序返回，所以结果确定、可复现。
     * 想"该保留哪一个"没有正确答案（用户在两格上都画过，缩小后只剩一格），
     * 稳定就好。
     */
    next[(n + jy) * cols + (n + jx)] = edits[index];
  }
  return next;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

/**
 * 边距策略存在自己的键里，不并进 `pindou.options.v1`。
 *
 * 为什么不并进 options：options 会被原样交给 `generatePattern` 当量化配方，
 * 而边距是**在量化之前**对源图做的预处理（裁多少、补多少边、画布给多大）。
 * 混进去会让 `generatePattern` 收到一个它不认识的字段，也让"改边距"和
 * "改色数"在历史去重、会话快照里表现成同一种变更 —— 前者会改变 cols/rows，
 * 后者不会，值得分开。
 */
export const MARGIN_KEY = 'pindou.margin.v1';

/** 读回来的值不信任：只认三个合法字符串，其余一律回默认。 */
export function sanitizeMargin(raw: unknown): MarginMode {
  if (raw === 'shrink' || raw === 'expand' || raw === 'occupy') return raw;
  return DEFAULT_MARGIN;
}

// ---------------------------------------------------------------------------
// 跨空间的编辑迁移
// ---------------------------------------------------------------------------

/**
 * 把 edits 从一种「显示空间」搬到另一种。
 *
 * 为什么需要它：用户画的格子属于**他当时看到的那个网格**，而 `margin`
 * 会改变网格（expand 加 6 行 6 列）。于是只要"画过之后又动了边距"或者
 * "画过之后开关了黑边"（黑边关掉时显示的是未加边距的裸图纸），
 * 原来那批下标就全部错位 —— 表现是手绘的豆子莫名其妙飘到别处，
 * 而颗数还是对的，极难归因。
 *
 * 做法是两步：先按 `from` 还原出"基础网格坐标"，再按 `to` 正映射回去。
 * 对 `expand` 是精确可逆的；对 `shrink` 只能近似（降采样天然有损，
 * 多个基础格会挤进同一个内框格，后写覆盖先写）。
 */
export function remapEditsBetween(
  edits: EditMap,
  from: { cols: number; rows: number; mode: MarginMode },
  to: { cols: number; rows: number; mode: MarginMode },
): EditMap {
  // 同一个空间、同一种模式：不产生新对象，让 React 的引用比较继续成立
  if (from.cols === to.cols && from.rows === to.rows && from.mode === to.mode) {
    return edits;
  }

  const fromN = from.mode === 'expand' ? MARGIN_CELLS : from.mode === 'shrink' ? shrinkCellsFor(from.cols, from.rows) : 0;
  const toN = to.mode === 'expand' ? MARGIN_CELLS : to.mode === 'shrink' ? shrinkCellsFor(to.cols, to.rows) : 0;
  const fromInnerW = from.cols - 2 * fromN;
  const fromInnerH = from.rows - 2 * fromN;
  const toInnerW = to.cols - 2 * toN;
  const toInnerH = to.rows - 2 * toN;
  const next: EditMap = {};
  const limit = from.cols * from.rows;

  for (const key of Object.keys(edits)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= limit) continue;

    // ① 显示坐标 → 基础网格坐标
    const dx = index % from.cols;
    const dy = (index - dx) / from.cols;
    let bx: number;
    let by: number;
    if (from.mode === 'expand') {
      bx = dx - fromN;
      by = dy - fromN;
      if (bx < 0 || by < 0 || bx >= fromInnerW || by >= fromInnerH) continue;
    } else if (from.mode === 'shrink') {
      // 外框是留白，画不到；落在框外说明数据已经和这张图无关了
      if (dx < fromN || dy < fromN || dx >= fromN + fromInnerW || dy >= fromN + fromInnerH) continue;
      bx = srcIndexForInner(dx - fromN, fromInnerW, fromInnerW);
      by = srcIndexForInner(dy - fromN, fromInnerH, fromInnerH);
    } else {
      bx = dx;
      by = dy;
    }

    // ② 基础网格坐标 → 新的显示坐标
    let nx: number;
    let ny: number;
    if (to.mode === 'expand') {
      nx = bx + toN;
      ny = by + toN;
    } else if (to.mode === 'shrink') {
      nx = toN + innerIndexForSrc(bx, fromInnerW, toInnerW);
      ny = toN + innerIndexForSrc(by, fromInnerH, toInnerH);
    } else {
      nx = bx;
      ny = by;
    }

    if (nx < 0 || ny < 0 || nx >= to.cols || ny >= to.rows) continue;
    next[ny * to.cols + nx] = edits[index];
  }
  return next;
}
