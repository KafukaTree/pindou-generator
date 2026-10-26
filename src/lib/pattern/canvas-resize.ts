/**
 * 换画板尺寸时把已有图案搬过去
 * ===============================================================
 *
 * ---- 为什么需要这一层 ----
 *
 * 「新建空白画布」原本是纯粹的替换：旧图纸连同手改一起丢掉，只留一句
 * 警告。但用户的真实意图绝大多数不是"重来"，而是"这块板子小/大了"——
 * 换尺寸动手画的东西就没了，等于惩罚用户改主意。
 *
 * `pixel-native.ts` 里的 `resizePattern()` 已经做了按比例搬运（面积加权
 * 多数表决，空格保持空），但它只处理 `Int16Array`。这里补上三层转换：
 *
 *   1. **调色板重编**：旧 pattern 的 cells 存的是旧调色板下标，重采样后
 *      同一批下标仍然有效，但用量分布变了 —— 必须重新统计 count/ratio、
 *      按用量降序重排、再把 cells 的每个下标映射到新位置。不重编的话
 *      UI 会显示"某个色号 0 颗"，PDF 的用料清单也会空一行。
 *   2. **色号跨品牌重查**：换尺寸时用户可以顺手换色号体系。旧 hex 在新
 *      品牌里未必有同色（色卡不是同一批），`getCodesForHex` 查不到时退化
 *      到该品牌最近的豆色 —— 和引擎里"永远落在一颗真实存在的豆上"的
 *      约定一致。
 *   3. **手改层跟随**：编辑记录是按行优先下标存的，尺寸一变全部失效。
 *      `resizePattern` 返回的 indexMap 正好是"旧下标 → 新下标"，按它重写
 *      一遍键，用户改过的格子就跟着图案一起过去。
 */

import { getCodesForHex, nearestBeadForRgb, type Brand } from '@/lib/color/palette';
import { parseHex } from '@/lib/color/oklab';
import type { EditMap } from './edits';
import { estimateSizeCm, type PatternResult, type UsedColor } from './generate';
import { centerPattern, resizePattern, scalePattern } from './pixel-native';

export interface RecanvasResult {
  pattern: PatternResult;
  edits: EditMap;
  /** 落在新画板之外的源豆数（缩小画板时会被裁掉） */
  clippedCells: number;
  /** 新画板里保持空的格数 */
  emptyCells: number;
  /** 长宽比变化幅度，1 = 完全等比；离 1 越远图案被拉伸得越明显 */
  aspectDistort: number;
}

/**
 * 把 `pattern` 按比例重采样到 `newCols × newRows`。
 *
 * 尺寸没变时返回原对象本身（引用相等），调用方可以直接跳过 setState。
 */
export function resizePatternToCanvas(
  pattern: PatternResult,
  newCols: number,
  newRows: number,
  brand: Brand,
  edits: EditMap,
): RecanvasResult {
  const moved = resizePattern(pattern.cells, pattern.cols, pattern.rows, newCols, newRows);

  if (!moved.resized) {
    return {
      pattern,
      edits,
      clippedCells: 0,
      emptyCells: 0,
      aspectDistort: 1,
    };
  }

  // ---- 1+2. 重统计用量、重排 palette、重映射 cells 下标 ----
  const { cells, palette, total } = rebuildPalette(moved.cells, pattern, brand);

  // ---- 3. 手改层跟着搬家 ----
  const nextEdits: EditMap = {};
  for (const [key, code] of Object.entries(edits)) {
    const oldIndex = Number(key);
    if (!Number.isFinite(oldIndex)) continue;
    const newIndex = moved.indexMap[oldIndex];
    if (newIndex === undefined || newIndex < 0) continue;
    nextEdits[newIndex] = code;
  }

  return {
    pattern: {
      cols: newCols,
      rows: newRows,
      cells,
      palette,
      totalBeads: total,
      // 颜色没被重算，只是搬了位置，平均色差沿用原值
      meanDeltaE: pattern.meanDeltaE,
      meta: {
        ...pattern.meta,
        brand,
        sizeCm: estimateSizeCm(newCols, newRows, pattern.meta.beadSize),
        /*
         * 原图信息对这张板子已经不再成立（重采样过），源图也已被切断。
         * 留着 autoCrop 会让「参数面板」显示一个不再生效的开关。
         */
        autoCrop: false,
      },
    },
    edits: nextEdits,
    clippedCells: moved.clippedCells,
    emptyCells: moved.emptyCells,
    aspectDistort: moved.aspectDistort,
  };
}

/**
 * 按 cells 的实际用量重建调色板，并把 cells 的下标映射到新顺序。
 *
 * 为什么必须重排而不是沿用旧 palette：`resizePattern` 是面积加权重采样，
 * 同一个色号在新网格上的用量占比会变。沿旧顺序的话，图例和 PDF 用料清单
 * 按旧顺序渲染，用户会看到"第 3 个色号突然变成用得最多的" —— 排序本身
 * 没错，错在它是旧的。
 *
 * 顺序按用量降序 + 旧下标升序兜底。稳定性很重要：两次校准如果顺序抖动，
 * 用户会以为颜色变了。
 */
function rebuildPalette(
  cells: Int16Array,
  pattern: PatternResult,
  brand: Brand,
): { cells: Int16Array; palette: UsedColor[]; total: number } {
  const counts = new Map<number, number>();
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v < 0) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const byIndex = new Map<number, UsedColor>();
  for (const u of pattern.palette) byIndex.set(u.index, u);

  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const remap = new Map<number, number>();
  const palette: UsedColor[] = ordered.map(([oldIndex, count], newIndex) => {
    remap.set(oldIndex, newIndex);
    const src = byIndex.get(oldIndex);
    const hex = src?.hex ?? '#000000';
    return {
      index: newIndex,
      hex,
      rgb: src?.rgb ?? parseHex(hex) ?? { r: 0, g: 0, b: 0 },
      code: resolveCode(hex, brand, src?.code),
      count,
      ratio: total > 0 ? count / total : 0,
    };
  });

  const out = new Int16Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    out[i] = v < 0 ? -1 : (remap.get(v) ?? -1);
  }
  return { cells: out, palette, total };
}

/**
 * 取该品牌下的色号。
 *
 * 优先用色卡直查（同 hex 在多品牌共用一条记录），查不到再退到"最近豆色"。
 * 这里的 `fallbackCode` 只在完全查不到时兜底，正常路径用不上 —— 因为旧
 * pattern 的每个 hex 本来就是一个真实色卡条目。
 */
function resolveCode(hex: string, brand: Brand, fallbackCode?: string): string {
  const direct = getCodesForHex(hex)[brand];
  if (direct) return direct;
  const rgb = parseHex(hex);
  if (rgb) return nearestBeadForRgb(rgb, brand).code;
  return fallbackCode ?? '--';
}

/* ------------------------------------------------------------------ *
 * 画板校准：居中 / 放大约到边
 * ------------------------------------------------------------------ */

export interface CalibrateResult {
  pattern: PatternResult;
  edits: EditMap;
  /** 是否真的动了 */
  moved: boolean;
  /** 平移量（居中时）或实际倍率（放大时） */
  amount: number;
  /** 居中前后四边最小余量；放大时恒为 0 */
  marginBefore: number;
  marginAfter: number;
  /** 放大时的锯齿格数，整数倍缩放恒为 0 */
  raggedCells: number;
}

/**
 * 把图案**平移**到画板正中央（纯平移，不缩放）。
 *
 * 为什么必须和「放大」拆开：放大是重采样，会改每颗豆的位置关系；平移不会。
 * 用户抱怨"图案贴在左上角"时他要的是平移，如果顺手给放大，图案会突然
 * 变成 2 倍大 —— 那不是他要的。
 */
export function centerPatternToCanvas(
  pattern: PatternResult,
  edits: EditMap,
): CalibrateResult {
  const r = centerPattern(pattern.cells, pattern.cols, pattern.rows);
  if (!r.moved) {
    return {
      pattern,
      edits,
      moved: false,
      amount: 0,
      marginBefore: r.marginBefore,
      marginAfter: r.marginAfter,
      raggedCells: 0,
    };
  }
  return {
    pattern: { ...pattern, cells: r.cells },
    /*
     * 平移后编辑层必须跟着挪，否则手改的格子会留在原位、和图案错开。
     * 平移是纯位移，所以下标换算比 resizePattern 更简单。
     */
    edits: shiftEdits(edits, pattern.cols, pattern.rows, r.dx, r.dy),
    moved: true,
    amount: Math.max(Math.abs(r.dx), Math.abs(r.dy)),
    marginBefore: r.marginBefore,
    marginAfter: r.marginAfter,
    raggedCells: 0,
  };
}

/**
 * 把图案**等比放大**到尽量铺满画板。
 *
 * 默认 `integer` 模式：只接受 2/3/4 倍整数放大（源格 → k×k 块）。
 * 非整数倍会让一半源列映射到 1 列、一半映射到 2 列，实物上一眼就是坏的
 * —— 拼豆是手摆的，"这一列宽一点"立刻看得出来。所以宁可留白也不牵强。
 */
export function scalePatternToCanvas(
  pattern: PatternResult,
  edits: EditMap,
  opts: { mode?: 'integer' | 'nearest'; maxScale?: number } = {},
): CalibrateResult {
  const r = scalePattern(pattern.cells, pattern.cols, pattern.rows, opts);
  if (r.appliedScale <= 1) {
    return {
      pattern,
      edits,
      moved: false,
      amount: 1,
      marginBefore: 0,
      marginAfter: 0,
      raggedCells: 0,
    };
  }
  /*
   * 放大一般会把图案重新居中，编辑层按位移+倍率换算没有简单闭式解，
   * 所以这里直接按"同一套 .map"重算：源格中心 → 目标格中心。
   * 换算不出来的（被裁到画板外）就丢掉，那是用户主动放大的代价。
   */
  const scale = r.appliedScale;
  const nextEdits: EditMap = {};
  const b = contentBounds(pattern.cells, pattern.cols, pattern.rows);
  if (!b) return { pattern, edits, moved: false, amount: 1, marginBefore: 0, marginAfter: 0, raggedCells: 0 };
  const outW = Math.round((b.maxC - b.minC + 1) * scale);
  const outH = Math.round((b.maxR - b.minR + 1) * scale);
  const offC = Math.floor((pattern.cols - outW) / 2);
  const offR = Math.floor((pattern.rows - outH) / 2);
  for (const [key, code] of Object.entries(edits)) {
    const idx = Number(key);
    if (!Number.isFinite(idx)) continue;
    const sr = Math.floor(idx / pattern.cols);
    const sc = idx % pattern.cols;
    if (sr < b.minR || sr > b.maxR || sc < b.minC || sc > b.maxC) continue;
    const tr = offR + Math.min(outH - 1, Math.floor((sr - b.minR) * scale));
    const tc = offC + Math.min(outW - 1, Math.floor((sc - b.minC) * scale));
    for (let dy = 0; dy < Math.ceil(scale); dy++) {
      for (let dx = 0; dx < Math.ceil(scale); dx++) {
        const rr = tr + dy;
        const cc = tc + dx;
        if (rr < 0 || rr >= pattern.rows || cc < 0 || cc >= pattern.cols) continue;
        nextEdits[rr * pattern.cols + cc] = code;
      }
    }
  }
  const rebuilt = rebuildPalette(r.cells, pattern, pattern.meta.brand);
  return {
    pattern: {
      ...pattern,
      cells: rebuilt.cells,
      palette: rebuilt.palette,
      totalBeads: rebuilt.total,
    },
    edits: nextEdits,
    moved: true,
    amount: scale,
    marginBefore: 0,
    marginAfter: 0,
    raggedCells: r.raggedCells,
  };
}

/** 内容外接框；全空返回 null */
function contentBounds(cells: Int16Array, cols: number, rows: number) {
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
  if (maxC < 0) return null;
  return { minC, maxC, minR, maxR };
}

/** 纯平移重编编辑层下标（越界的丢掉） */
function shiftEdits(
  edits: EditMap,
  cols: number,
  rows: number,
  dx: number,
  dy: number,
): EditMap {
  const next: EditMap = {};
  for (const [key, code] of Object.entries(edits)) {
    const idx = Number(key);
    if (!Number.isFinite(idx)) continue;
    const r = Math.floor(idx / cols) + dy;
    const c = (idx % cols) + dx;
    if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
    next[r * cols + c] = code;
  }
  return next;
}
