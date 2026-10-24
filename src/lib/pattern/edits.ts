/**
 * 人工编辑层（纯逻辑，不含任何 UI）
 * ===============================================================
 * 引擎（generate.ts）只负责"从图算出初始图纸"。一旦用户开始手工改格子，
 * 数据真相就分成两层：
 *
 *   1. base —— 引擎结果，**不可变**，永远保留原始生成结果；
 *   2. edits —— 稀疏覆盖层（EditMap），只记录被手工改过的格子。
 *
 * 为什么不用"把编辑直接写进 base.cells"：
 *   - 撤销/重做需要知道"改之前是什么"；覆盖层天然记录 before；
 *   - 改回原样时可以直接删掉覆盖项、回到引擎值，不必保存整份原始数组；
 *   - 用户改参数重新生成时 base 换新，覆盖层还能按同一套格子下标继续套用
 *     （所以键是"行优先下标"而不是行列对）。
 *
 * 这一层刻意不碰 DOM / Canvas / PDF：画布、图例、导出都应该消费它的输出，
 * 才能保证"屏幕上看到的"和"导出的图纸"永远是同一份数据。
 *
 * 约定（与引擎一致）：
 *   - 一格要么是一颗具体品牌的豆子，要么空白（`cells[i] === -1`）；
 *   - 色号用品牌色号的字符串（如 `A01`）表示，空串 `''` 表示擦除。
 */

import {
  type BeadColor,
  type Brand,
  getBrandPalette,
  nearestBead,
} from '@/lib/color/palette';
import { rgbToOklab, type Rgb } from '@/lib/color/oklab';
import type { PatternResult, UsedColor } from './generate';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一格的手工修改：cellIndex -> 品牌色号；空串 `''` 表示"这里不拼豆"（擦除）。
 *
 * 键必须是**规范的数字下标**（`String(row * cols + col)`）。对象键本身是
 * 字符串，`"01"` 这类非规范键会和 `1` 冲突，所以这里只认
 * `Number(key)` 后仍是整数的键，其余一律忽略。
 */
export type EditMap = Record<number, string>;

/** 一笔画操作，用于撤销/重做与"改了多少格"的提示 */
export interface EditDelta {
  /** 这笔记在哪些格子上 */
  cells: number[];
  /** 每格改之前的值（undefined 表示之前是引擎生成的，不是手工值） */
  before: (string | undefined)[];
  /** 改之后的值 */
  after: (string | undefined)[];
}

/**
 * 冻结的空覆盖层。
 *
 * `{}` 每次都要新建一个对象，而画布每帧、每格都可能调用这些函数；
 * 空编辑是**最常见**的入参（用户还没动手）。共享一个冻结对象既省分配，
 * 也让"误写入"直接暴露（严格模式下写冻结对象会抛错）。
 */
export const EMPTY_EDITS: EditMap = Object.freeze({});

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const hasOwn = Object.prototype.hasOwnProperty;

/** 是否真的存在这一格的覆盖项（`edits[i] === undefined` 与"没有键"等价） */
function hasEdit(edits: EditMap, index: number): boolean {
  return hasOwn.call(edits, index);
}

/**
 * 色号 -> 真实豆子 的索引缓存（按品牌）。
 *
 * 用户从色卡里挑的颜色可能引擎根本没用到（不在 base.palette 里），
 * 这时必须回到品牌色卡拿 hex/rgb。色卡本身是单例且只读，缓存一次即可；
 * 用 Map 而不是每次 `find`，因为 applyEdits 里可能新增几十个色号。
 */
const beadCodeCache = new Map<Brand, Map<string, BeadColor>>();

function beadsByCode(brand: Brand): Map<string, BeadColor> {
  let map = beadCodeCache.get(brand);
  if (!map) {
    map = new Map<string, BeadColor>();
    for (const bead of getBrandPalette(brand)) {
      // 同一色号重复出现时取色卡里第一条（buildBrandPalette 已去重，这里只是兜底）
      if (!map.has(bead.code)) map.set(bead.code, bead);
    }
    beadCodeCache.set(brand, map);
  }
  return map;
}

/** 在品牌色卡里查色号；查不到返回 undefined（未知色号不应让整次操作崩掉） */
function beadOfCode(brand: Brand, code: string): BeadColor | undefined {
  return beadsByCode(brand).get(code);
}

function isIndex(i: number): boolean {
  return Number.isInteger(i) && i >= 0;
}

// ---------------------------------------------------------------------------
// 应用编辑
// ---------------------------------------------------------------------------

/**
 * 应用编辑到引擎结果上，返回新的 PatternResult（不改入参）。
 *
 * 这是整个编辑层的核心，也是最容易写错的地方，逐条说明见下方实现。
 * 复杂度 O(格子数 + 编辑数)：用计数桶重新统计，绝不逐格去 palette 里 find。
 *
 * 色号处理规则：
 *   - `''`      → 该格置 -1（空白，不拼豆）；
 *   - 已在 palette 里 → 复用原下标（**不会产生重复色号**）；
 *   - 不在 palette 里但品牌色卡里有 → 追加进 palette（尾部，保持旧下标不动）；
 *   - 品牌色卡里也没有（错色号/别的品牌）→ 忽略这一条，不崩、不污染调色板。
 */
export function applyEdits(
  base: PatternResult,
  edits: EditMap,
  brand: Brand,
): PatternResult {
  const cellCount = base.cells.length;

  // 1) 克隆：Int16Array 必须复制，palette 也要复制（不能改入参，也不能让
  //    返回值与 base 共享可变对象，否则后续一次 in-place 修改会污染引擎结果）
  const cells = new Int16Array(base.cells);
  const palette: UsedColor[] = base.palette.map((u) => ({
    index: u.index,
    hex: u.hex,
    rgb: { r: u.rgb.r, g: u.rgb.g, b: u.rgb.b },
    code: u.code,
    count: u.count,
    ratio: u.ratio,
  }));

  // 色号 -> palette 下标（旧调色板可能很大，先建索引，避免逐条 find）
  const codeIndex = new Map<string, number>();
  for (let i = 0; i < palette.length; i++) {
    if (!codeIndex.has(palette[i].code)) codeIndex.set(palette[i].code, i);
  }

  // 2) 逐条套用编辑
  for (const key of Object.keys(edits)) {
    const index = Number(key);
    // 6) 越界 / 非整数下标直接忽略（UI 的画笔可能因尺寸切换越界）
    if (!isIndex(index) || index >= cellCount) continue;
    const code = edits[index];
    if (typeof code !== 'string') continue;

    if (code === '') {
      // 3) 擦除统一用 -1，与引擎约定一致
      cells[index] = -1;
      continue;
    }

    let paletteIndex = codeIndex.get(code);
    if (paletteIndex === undefined) {
      // 2) palette 要能容纳编辑引入的新色号：从品牌色卡取真实 hex/rgb
      const bead = beadOfCode(brand, code);
      if (!bead) continue; // 未知色号：忽略，宁可不画也不写坏图纸
      paletteIndex = palette.length;
      palette.push({
        index: paletteIndex, // 先占位，最后按压缩后的新位置重排
        hex: bead.hex,
        rgb: { r: bead.rgb.r, g: bead.rgb.g, b: bead.rgb.b },
        code: bead.code,
        count: 0,
        ratio: 0,
      });
      codeIndex.set(code, paletteIndex);
    }
    cells[index] = paletteIndex;
  }

  // 4) 重新统计：一次线性扫描 + 数组计数桶
  const counts = new Array<number>(palette.length).fill(0);
  let totalBeads = 0;
  for (let i = 0; i < cellCount; i++) {
    const c = cells[i];
    if (c >= 0 && c < counts.length) {
      counts[c]++;
      totalBeads++;
    }
  }

  // 4) 压缩调色板：count 变 0 的色号要删掉，否则图例里会出现"该色 0 颗"；
  //    下标跟着重排，所有格子做一次 remap，保证引用仍然正确（关键，易错位）
  const remap = new Int16Array(palette.length).fill(-1);
  const compact: UsedColor[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (counts[i] <= 0) continue;
    remap[i] = compact.length;
    compact.push({
      index: compact.length,
      hex: palette[i].hex,
      rgb: palette[i].rgb,
      code: palette[i].code,
      count: counts[i],
      ratio: totalBeads ? counts[i] / totalBeads : 0,
    });
  }
  for (let i = 0; i < cellCount; i++) {
    const c = cells[i];
    if (c < 0) continue;
    cells[i] = c < remap.length ? remap[c] : -1;
  }

  return {
    cols: base.cols,
    rows: base.rows,
    cells,
    palette: compact,
    totalBeads,
    // 5) 手工编辑后无法有意义地重算"与原图的平均色差"，保持引擎值
    meanDeltaE: base.meanDeltaE,
    // 5) meta 传引用（参数没变，不必深拷贝）
    meta: base.meta,
  };
}

// ---------------------------------------------------------------------------
// 单格查询
// ---------------------------------------------------------------------------

/**
 * 某个格子最终显示的颜色（考虑编辑覆盖），返回 `{code,hex,rgb,blank}`。
 *
 * 空白格返回 `code: ''`、`hex: ''`、`rgb: {0,0,0}`、`blank: true` ——
 * UI 应该看 `blank` 决定画什么（棋盘格/透明），**不要**拿 hex 当颜色画：
 * 空串让画布的 fillStyle 赋值自动失效，不会被误画成黑色。
 *
 * 编辑引入、但尚未经过 applyEdits 的新色号，会回退到品牌色卡取 hex/rgb，
 * 所以"取色器/画笔"在只读原始 pattern + 覆盖层时也能拿到正确颜色。
 */
export function cellColorAt(
  pattern: PatternResult,
  edits: EditMap,
  index: number,
): { code: string; hex: string; rgb: Rgb; blank: boolean } {
  const blank = { code: '', hex: '', rgb: { r: 0, g: 0, b: 0 }, blank: true };
  if (!isIndex(index) || index >= pattern.cells.length) return blank;

  if (hasEdit(edits, index)) {
    const code = edits[index];
    if (code === '') return blank;
    // 优先用 pattern 里的（已压缩）调色板；编辑层可能还没 apply
    for (const u of pattern.palette) {
      if (u.code === code) return { code, hex: u.hex, rgb: u.rgb, blank: false };
    }
    const bead = beadOfCode(pattern.meta.brand, code);
    if (bead) return { code, hex: bead.hex, rgb: bead.rgb, blank: false };
    // 未知色号：色号照回，颜色留空（调用方可据此提示"该色号不存在"）
    return { code, hex: '', rgb: { r: 0, g: 0, b: 0 }, blank: false };
  }

  const c = pattern.cells[index];
  if (c < 0 || c >= pattern.palette.length) return blank;
  const u = pattern.palette[c];
  return { code: u.code, hex: u.hex, rgb: u.rgb, blank: false };
}

/** 取色器：读出某格当前的色号（空白格返回 ''） */
export function pickCodeAt(
  pattern: PatternResult,
  edits: EditMap,
  index: number,
): string {
  if (!isIndex(index) || index >= pattern.cells.length) return '';
  if (hasEdit(edits, index)) {
    const code = edits[index];
    return typeof code === 'string' ? code : '';
  }
  const c = pattern.cells[index];
  if (c < 0 || c >= pattern.palette.length) return '';
  return pattern.palette[c].code;
}

// ---------------------------------------------------------------------------
// 洪水填充 / 油漆桶
// ---------------------------------------------------------------------------

/**
 * 从起点做 4 邻域洪水填充，返回应被涂成 `code` 的格子下标（同色连通区）。
 *
 * - **迭代式**显式栈，不用递归：120×120=14400 格的一片同色区递归必爆栈；
 * - 判定"相同"用**当前显示色号**（先看覆盖层，再看 cells），不是原始 cells，
 *   否则"先涂色再倒桶"会把已经改过的格子当成异色、漫不过去；
 * - 起点已经是 `code` 时返回空数组，避免产生一条无意义的 delta；
 * - `code` 可以是 `''`（橡皮桶擦掉一整片同色区），逻辑完全一致。
 *
 * 返回下标已去重、顺序为 DFS 访问序（UI 不需要有序，只用来做批量编辑）。
 */
export function floodFill(
  pattern: PatternResult,
  edits: EditMap,
  start: number,
  code: string,
): number[] {
  const { cells, cols } = pattern;
  const n = cells.length;
  if (!isIndex(start) || start >= n || cols <= 0) return [];

  const startCode = pickCodeAt(pattern, edits, start);
  // 起点就是目标色：没有可改的（这一条能省掉大量无意义的重绘）
  if (startCode === code) return [];

  const visited = new Uint8Array(n);
  const stack: number[] = [start];
  visited[start] = 1;
  const region: number[] = [];

  // 4 邻域（上下左右），边界用坐标判断，不依赖 rows 的奇偶
  while (stack.length) {
    const cur = stack.pop() as number;
    region.push(cur);
    const x = cur % cols;
    const y = (cur - x) / cols;

    // 左
    if (x > 0) {
      const nb = cur - 1;
      if (!visited[nb] && pickCodeAt(pattern, edits, nb) === startCode) {
        visited[nb] = 1;
        stack.push(nb);
      }
    }
    // 右
    if (x + 1 < cols) {
      const nb = cur + 1;
      if (!visited[nb] && pickCodeAt(pattern, edits, nb) === startCode) {
        visited[nb] = 1;
        stack.push(nb);
      }
    }
    // 上
    if (y > 0) {
      const nb = cur - cols;
      if (!visited[nb] && pickCodeAt(pattern, edits, nb) === startCode) {
        visited[nb] = 1;
        stack.push(nb);
      }
    }
    // 下
    if (y + 1 < pattern.rows) {
      const nb = cur + cols;
      if (nb < n && !visited[nb] && pickCodeAt(pattern, edits, nb) === startCode) {
        visited[nb] = 1;
        stack.push(nb);
      }
    }
  }

  return region;
}

// ---------------------------------------------------------------------------
// 辅助功能
// ---------------------------------------------------------------------------

/** 这一格属于哪个品牌色（用于"用附近已有的豆色"这类辅助功能） */
export function nearestBrandCode(brand: Brand, rgb: Rgb): string {
  const palette = getBrandPalette(brand);
  if (!palette.length) return '';
  const lab = rgbToOklab(rgb.r, rgb.g, rgb.b);
  return nearestBead(lab, palette).bead.code;
}

// ---------------------------------------------------------------------------
// Delta（撤销栈）
// ---------------------------------------------------------------------------

/**
 * 把一批格子合成一个 EditDelta（用于撤销栈）。
 *
 * `after` 对整批格子是同一个值（一笔油漆桶/一次矩形填充），所以签名只有
 * 一个字符串；`before` 逐格从当前覆盖层读取，undefined = 之前是引擎值。
 * 重复下标会去重（一次笔画里同一格被写两次没有意义，还会让"改了多少格"
 * 的提示虚高）。
 */
export function makeDelta(
  edits: EditMap,
  cells: number[],
  after: string,
): EditDelta {
  const seen = new Set<number>();
  const uniq: number[] = [];
  for (const c of cells) {
    if (!isIndex(c) || seen.has(c)) continue;
    seen.add(c);
    uniq.push(c);
  }
  return {
    cells: uniq,
    before: uniq.map((c) => (hasEdit(edits, c) ? edits[c] : undefined)),
    after: uniq.map(() => after),
  };
}

/**
 * 应用一条 delta 到 EditMap，返回新的 EditMap（不改入参，浅拷贝即可）。
 *
 * `after[i] === undefined` 表示"这一格回到引擎值"——对应地要**删掉键**，
 * 而不是写一个 undefined 占位（否则 editCount 会虚高、序列化也会带上它）。
 */
export function applyDelta(edits: EditMap, delta: EditDelta): EditMap {
  const next: EditMap = { ...edits };
  const n = Math.min(delta.cells.length, delta.after.length);
  for (let k = 0; k < n; k++) {
    const index = delta.cells[k];
    if (!isIndex(index)) continue;
    const value = delta.after[k];
    if (value === undefined) delete next[index];
    else next[index] = value;
  }
  return next;
}

/**
 * 反向 delta，用于撤销。
 *
 * `base` 应当传**应用该 delta 之后**的当前覆盖层：反向 delta 的 `before`
 * 描述"撤销时被覆盖掉的现状"，`after` 才是要恢复的历史值。两者在正常
 * 撤销栈用法下一致（base[cells[i]] 恰好等于 delta.after[i]），但传当前
 * 状态能让这条 delta 在任何时刻都自解释、可重复应用。
 */
export function invertDelta(base: EditMap, delta: EditDelta): EditDelta {
  const cells = delta.cells.slice();
  return {
    cells,
    before: cells.map((c) => (hasEdit(base, c) ? base[c] : undefined)),
    after: delta.before.slice(),
  };
}

/** 当前有多少格被手工改过 */
export function editCount(edits: EditMap): number {
  let count = 0;
  for (const key of Object.keys(edits)) {
    if (edits[Number(key)] !== undefined) count++;
  }
  return count;
}

/**
 * 手工改动用到的色号集合（用于 UI 提示"你新增了 2 个色号"）。
 *
 * 擦除（`''`）不算色号，不返回；顺序按 EditMap 的键序（数字键即升序），
 * 去重后返回，调用方可以再排序或与引擎 palette 求差。
 */
export function editedCodes(edits: EditMap): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(edits)) {
    const code = edits[Number(key)];
    if (typeof code !== 'string' || code === '' || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}
