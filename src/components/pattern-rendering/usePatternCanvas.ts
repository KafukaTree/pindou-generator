'use client';

/**
 * 图案画布的渲染引擎（与 UI 分离，便于单独推演/测试）
 * ---------------------------------------------------------------
 * 关键决策：
 *
 * 1. **高 DPI 渲染 + 设备像素对齐**。CSS 尺寸 × devicePixelRatio 作为 canvas
 *    的 width/height 属性，绘制在 scale(dpr) 后的坐标系里；但每一格的位置
 *    先换算成"设备像素整数"，再换算回 CSS 坐标 —— 等价于 setTransform(dpr)
 *    且所有矩形四边都落在整设备像素上，任何 dpr（含 1.25/1.5 这种小数）都
 *    不会出现 0.5px 灰色描边。线条统一用 fillRect 而不是 strokeRect。
 *
 * 2. **图案底色离屏缓存**。每格纯色先在 cols×rows 的离屏 canvas 上画一次
 *    （putImageData），之后缩放只做 drawImage(nearest-neighbor)。所以缩放
 *    *不会*重跑逐格绘制，只是重新采样；网格线和色号才是按当前 cellSize
 *    重新生成的（它们必须随缩放改变粗细/字号）。
 *
 * 3. **分级网格**：1 格 = 极淡（cellSize ≥ 8 才画）/ 5 格 = 中等 / 10 格 =
 *    深色主线。图案是主角，网格只是数格子的辅助。
 *
 * 4. **色号**：cellSize ≥ 14 完整色号，9–14 自适应缩小（measureText 收缩，
 *    最小 6px），< 9 不画。字色用 readableInkFor()（真实 WCAG 对比度）。
 *
 * 5. **悬停高亮画在独立的 overlay canvas 上**，鼠标移动只重绘 overlay，
 *    不重绘几千个格子。
 *
 * 6. 行/列标尺是 HTML（文字更清晰、不吃 canvas 显存），用 sticky 让标尺
 *    在滚动时保持可见。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PatternResult } from '@/lib/pattern/generate';
import { parseHex, readableInkFor } from '@/lib/color/oklab';
import { getBrandPalette, type Brand } from '@/lib/color/palette';
import {
  EMPTY_EDITS,
  applyDelta,
  applyEdits,
  editCount,
  floodFill,
  invertDelta,
  makeDelta,
  pickCodeAt,
  type EditDelta,
  type EditMap,
} from '@/lib/pattern/edits';
import {
  buildRegionField,
  regionAlgorithms,
  type DetailBrush,
  type RegionField,
} from '@/lib/pattern/regions';
import { getDetailProfile, type DetailAlgorithm } from '@/lib/pattern/detail';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

/** 标尺尺寸（CSS px） */
export const RULER_LEFT = 24;
export const RULER_TOP = 18;

/**
 * 画布四周留给"手指/鼠标落点"的空白。
 *
 * 用户反馈：「现在的状态是下面的不容易看到并拖动编辑，我猜测可能要把画板
 * 的周围的拖动底部空间预留的大一点」。实测（编辑态 1600×1000，duck 52×64）
 * 滚到四边极限时到容器边框的距离是 左 18 / 上 **2** / 右 30 / 下 **2** ——
 * 上下贴着边框"顶死"了，下沿那个位置既看不出还有内容、也没有地方落笔。
 *
 * 这块留白必须**在滚动内容之内**（做成内容的 padding，跟着内容一起滚），
 * 不能做成容器的 padding —— 容器 padding 的话内容滚动时会滑进 padding 区，
 * 从 sticky 标尺旁边漏出来（画布区那条 `padding: 0` 的注释就是在说这个）。
 *
 * 20px 的依据：手机上一根手指的触点半径大约 20–24px，光标落点要在画布之外
 * 有地方放，边缘格才点得准；桌面端 20px 也刚好让"顶死"的观感消失。
 */
export const CANVAS_GUTTER = 20;
/**
 * 窄屏（手机）用的留白。
 *
 * 20px 在手机上会把整整一列格子挤掉（430 宽、64 列的图：留给画布的宽度
 * 少 40px 后每格从 5px 掉到 4px，画布从 320 缩到 256）。手机上手指点不准
 * 的问题已经在画板外框高度上解决过了，这里不需要再吃宽度，8px 够让格子
 * 不贴着边框即可。
 */
export const CANVAS_GUTTER_NARROW = 8;

/**
 * 边缘自动滚动的热区宽度（CSS px）与速度区间（px / 帧）。
 *
 * 指针进入滚动容器**可视边**往里 EDGE_ZONE 的这条带，画面就开始朝那个
 * 方向滚；越贴边越快，从 EDGE_SPEED_MIN 线性加到 EDGE_SPEED_MAX。
 *
 * 40px 大约是一个指尖的直径：再窄的话，笔尖压在画面边缘的格子上时就
 * 频繁误触发滚动；再宽则"明明还在画面中央，画面自己跑起来了"。
 * 速度按 60fps 折算，12px/帧 ≈ 720px/秒，够从画布顶端一口气拉到尾，
 * 而 2px/帧 让人在刚进热区时能精确停在想停的位置。
 */
const EDGE_ZONE = 40;
const EDGE_SPEED_MIN = 2;
const EDGE_SPEED_MAX = 12;

/** .px-inset 的内边距 + 边框，以及滚动条预留 */
const FRAME_PAD = 20;
/** 滚动容器 px-inset 的边框（1px 描边 + 极小的内衬） */
const FRAME_BORDER = 4;
const SCROLLBAR_ALLOWANCE = 12;

const MIN_FIT_CELL = 4;
const MAX_FIT_CELL = 48;
/**
 * 高度约束的适用门槛（CSS px / 格）。
 *
 * 高度参与取小值的目的是"打开就一眼看到整张图、不用滚"。但这笔交易的
 * 前提是换来的格子还能看清 —— 手机竖屏上 64 行的图按高度算下来只有
 * 2px/格，被 MIN_FIT_CELL 夹回 4px 后，画布只有 208px 宽而容器有 338px：
 * 既没铺满宽度，格子又糊得连色号和标尺数字都读不出来，两头不占。
 *
 * 所以：只有当高度约束还能给出可读格子时才采用它；否则让宽度说了算，
 * 竖向滚动交给滚动容器（手机上本来就在滚，这个代价更小）。
 */
const MIN_READABLE_CELL = 6;
/**
 * "窄屏"的判定线（CSS px，滚动容器宽度）。只有窄屏才允许为了可读性放弃
 * "整图铺满"的取小值。
 *
 * 桌面（尤其矮窗口，如 1440×700 里可视区只有 356px 高）上，按高度取小值
 * 会得到 5px/格 —— 确实偏小，但一打开就能看全整张图是桌面端最有价值的
 * 默认值（桌面没有"本来就在滚"这回事，滚动条还是显式的干扰）。放宽后
 * 这张图会跳成 19px/格、画布 1216px 高，等于默认就进了放大状态。
 * 所以这条规则只对窄屏生效：手机上滚动是常态，可读性才是矛盾的主要方面。
 */
const NARROW_VIEWPORT = 640;

/**
 * 编辑态的"别高到离谱"上限，按可见高度的倍数表示。
 *
 * 宽度优先会把"很宽很扁"的图算出离谱的高度（300×40 的横幅在 1000px 宽里
 * 是 30px/格 → 1200px 高），所以要有一条防线。但这条线必须**松**：
 *
 *  - 窄窗口（<64rem）里 `.wb-mid` 是 54dvh 的定高盒子，编辑工具条再吃掉
 *    52px，滚动视口往往只剩 220–310px。按 1.5 倍算只有 330–465px，64×54
 *    的图会被压回 6–8px/格、画布 384 宽，而容器有 642 宽 —— 横向空掉
 *    260px，格子还点不准。用户截图抱怨的"面板太小不好操作"就是这个。
 *  - 3 倍能让格子回到 9–15px、画布宽度基本吃满容器，代价是纵向要滚一屏
 *    多。对"下笔涂格子"这个动作来说，格子大远比"不用滚"重要。
 *
 * 只有真正极端的长条（300×40 这种）才会被这条线收住，那时按高度缩是对的。
 */
const EDIT_TALL_FACTOR = 3;

/** 色号字号上限（CSS px）。放大到 4× 时字也该跟着长，但不必无限长 */
const MAX_CODE_FONT = 30;

/** 画布显存预算：超过就降采样（极端缩放下宁可略软，也不要 200MB 的位图） */
const MAX_BACKING_PX = 28_000_000;
const MAX_BACKING_DIM = 8192;

const PREF_PREFIX = 'pindou.canvas.';
const PREF_KEYS = {
  zoom: 'zoom',
  codes: 'showCodes',
  grid: 'showGrid',
  rulers: 'showRulers',
  regionOverlay: 'regionOverlay',
} as const;

/** fill 模式下父容器最小可用高度：低于它就降级成"限高 + 内部滚动" */
const MIN_FILL_HOST_HEIGHT = 240;

/**
 * 区域遮罩的不透明度上限（中心处）。
 *
 * 0.18 实测在深色豆（R22 那种暗棕）上几乎看不出来，只能靠轮廓线猜。
 * 0.26 是"能一眼看出这块会被重算"与"不干扰辨认豆子颜色"的平衡点
 * —— 再高，用户就没法判断这块重算后色号对不对了。
 */
const REGION_MASK_ALPHA = 0.2;
/**
 * 已应用区域的**常态**内纹透明度。
 *
 * 0.2 常驻的问题很具体：用户看到的是"画面脏了一块"—— 陶土色糊在整片
 * 重算区域上，压住了豆子本身的颜色，而那块区域其实只是在说"这里重算过"。
 * 常态降到 0.1（≈26/255），只留一层能感觉到"范围不同"的极淡底纹，
 * 主要信息交给外沿那圈虚线；鼠标移到这块区域上时再升回 0.2 让它"发亮"。
 */
const REGION_MASK_IDLE_ALPHA = 0.1;
/**
 * 遮罩层"这一格算不算在区域里"的门槛（权重）。
 *
 * 填充与轮廓**必须用同一个门槛**。早先填充用 0.02、轮廓也用 0.02，但
 * 权重 0.02 处的填充 alpha 只有 0.02×0.28×255 ≈ 1.4 —— 肉眼看是透明的，
 * 而轮廓线是 0.95 不透明的一整条。于是"松手后的 pending"总比"拖动中的
 * live"多出一圈只有轮廓、没有填充的虚边，量 bbox 时直径差出 10%。
 * 现在两者统一到 0.06（填充 alpha ≈ 4.3，虽然淡但确实画了），量出来
 * 的几何范围就等于用户看到的范围。
 */
const MASK_MIN_WEIGHT = 0.06;
/**
 * 待应用选区的遮罩透明度。
 *
 * 用 --sky 而不是 --clay，是为了让"还没生效"和"已经生效"一眼分得开：
 * 陶土色 = 已应用，天空蓝 = 草稿。上限压在 0.30 以内 —— 再高会盖住
 * 下方色号，用户就没法判断选区落得准不准了。
 */
const PENDING_MASK_ALPHA = 0.28;
/**
 * 一次刷区域最多保留多少支笔（点数，超出从头丢）。
 *
 * 120 而不是 60：改成"先画选区再应用"之后，用户会在一整块区域上反复
 * 叠加笔划、还会叠好几笔再一次性提交，60 个点连一次稍长的拖动都不够。
 */
export const MAX_BRUSHES = 120;
/** 笔刷半径的允许范围（归一化，相对图案长边） */
export const BRUSH_RADIUS_MIN = 0.03;
export const BRUSH_RADIUS_MAX = 0.35;
/** 羽化范围（与引擎 buildRegionField 的 feather 参数一致） */
export const FEATHER_MIN = 0.12;
export const FEATHER_MAX = 1;

/**
 * 一画笔刷的几何：核心半径 + 羽化带 + 总触及半径。
 *
 * **这段必须与引擎 `buildRegionField`（src/lib/pattern/regions.ts）逐字同形。**
 * 三处都要用同一个几何：
 *   - 拖动中的实时预览（stampLive）
 *   - 悬停/拖动时的圆环（drawBrushRing）
 *   - 抬手后交给引擎重算的区域（pending → applyPending → buildRegionField）
 *
 * 早先 stampLive 只盖核心圆，而引擎按 reach 重算，于是"按住时看到的圈"
 * 比"松手后冒出来的选区"小 1.73 倍 —— 用户吐槽的"选区逻辑很差"根子在这里。
 * 现在三者共用这一个函数，按住 = 松手 = 引擎重算范围。
 */
export function brushGeometry(
  x: number,
  y: number,
  radius: number,
  cols: number,
  rows: number,
  feather: number,
) {
  const longest = Math.max(cols, rows);
  // 与引擎完全一致的三个量（改这里之前先看 regions.ts:radiusCells/bandCells）
  const radiusCells = Math.max(1.2, radius * longest);
  const bandCells = Math.min(radiusCells, Math.max(1.2, radiusCells * Math.max(0.12, feather)));
  return {
    cx: x * cols,
    cy: y * rows,
    radiusCells,
    bandCells,
    reach: radiusCells + bandCells,
  };
}

/** 与 regions.ts 的 smoothstep 同形（含两端 clamp） */
const smoothstep = (t: number) => {
  const v = t < 0 ? 0 : t > 1 ? 1 : t;
  return v * v * (3 - 2 * v);
};

/**
 * 把一支笔刷点盖进"正在拖的这一笔"的实时权重图。
 *
 * 为什么不直接用 buildRegionField：它每次要分配 5 个 Float32Array(cols*rows)，
 * 320 格时约 1.7MB/次 —— 放在 pointermove 里等于每帧一次 GC 惊雷。
 * 这里只维护一张 Float32Array，按格量化后取 max（同一格被同一笔反复盖时
 * 不能叠加，否则拖着来回蹭会出现一块比别处深得多的斑）。
 *
 * 衰减形状刻意与 buildRegionField 的 smoothstep 同形，这样"拖的时候看到
 * 的"和"抬手后 pending 遮罩显示的"是同一个渐变，不会出现一松手选区
 * 突然变了个形状的错觉。
 */
function stampLive(
  w: Float32Array,
  cols: number,
  rows: number,
  p: DetailBrush,
  feather: number,
) {
  const { cx, cy, radiusCells, bandCells, reach } = brushGeometry(
    p.x,
    p.y,
    p.radius,
    cols,
    rows,
    feather,
  );
  const c0 = Math.max(0, Math.floor(cx - reach));
  const c1 = Math.min(cols - 1, Math.ceil(cx + reach));
  const r0 = Math.max(0, Math.floor(cy - reach));
  const r1 = Math.min(rows - 1, Math.ceil(cy + reach));
  for (let y = r0; y <= r1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = c0; x <= c1; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > reach) continue;
      /*
       * 与引擎逐字同一套曲线：核心内权重 1，核心外按 smoothstep 衰减到 0。
       * 不是"1 - smoothstep(d/r)"那种简化 —— 那种在核心边界处斜率不连续，
       * 拖动时的渐变看着会比松手后硬一档。
       */
      const t = 1 - (d - radiusCells) / bandCells;
      const v = smoothstep(t);
      if (v <= 0.002) continue;
      const i = y * cols + x;
      if (v > w[i]) w[i] = v;
    }
  }
}

/**
 * 把一串笔刷点重新聚成"笔"。
 *
 * brushes 是个扁平的 DetailBrush[]，一次拖动会被插值成十几个点存进去 ——
 * 直接拿 length 当"几处"会显示"已应用 13 处"，而用户明明只画了一笔。
 * 撤销时也只想整笔撤掉，不是撤掉一个点。
 *
 * 插值步长是 radius*0.35、抽稀阈值 radius*0.25，所以同一笔内相邻点的
 * 间距不会超过约 0.35 个半径；两笔之间只要离得比 1.25 个半径远，就认为
 * 是新的一处。阈值取 1.25 而不是 1.0：两笔挨着画（想刷成一片）时，
 * 中间的重叠点不该被算成两处。
 */
function clusterBrushes(
  strokes: DetailBrush[],
  cols: number,
  rows: number,
): DetailBrush[][] {
  if (strokes.length === 0) return [];
  const longest = Math.max(cols, rows);
  const groups: DetailBrush[][] = [];
  let current: DetailBrush[] = [strokes[0]];

  for (let i = 1; i < strokes.length; i++) {
    const prev = strokes[i - 1];
    const next = strokes[i];
    const dx = (next.x - prev.x) * cols;
    const dy = (next.y - prev.y) * rows;
    const gap = Math.hypot(dx, dy);
    const limit = Math.max(prev.radius, next.radius) * longest * 1.25;
    if (gap > limit) {
      groups.push(current);
      current = [next];
    } else {
      current.push(next);
    }
  }
  groups.push(current);
  return groups;
}

// ---------------------------------------------------------------------------
// 偏好存取（localStorage）
// ---------------------------------------------------------------------------

function readPref(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(PREF_PREFIX + key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREF_PREFIX + key, value);
  } catch {
    /* 隐私模式 / 配额满：忽略即可 */
  }
}

function readBoolPref(key: string, fallback: boolean): boolean {
  const raw = readPref(key);
  if (raw === '0') return false;
  if (raw === '1') return true;
  return fallback;
}

function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100));
}

// ---------------------------------------------------------------------------
// 几何 / 像素度量
// ---------------------------------------------------------------------------

export interface CanvasMetrics {
  cols: number;
  rows: number;
  /** 每格设备像素（整数） */
  cellDev: number;
  /** 实际生效的 devicePixelRatio（大画布时会降级） */
  eff: number;
  /** canvas 的 CSS 尺寸 */
  cssW: number;
  cssH: number;
  /** 每格 CSS 尺寸 */
  cellCss: number;
}

function computeMetrics(cols: number, rows: number, cellPx: number, dpr: number): CanvasMetrics {
  const cssW0 = Math.max(1, cols * cellPx);
  const cssH0 = Math.max(1, rows * cellPx);

  let eff = Math.max(0.5, Number.isFinite(dpr) && dpr > 0 ? dpr : 1);
  eff = Math.min(eff, MAX_BACKING_DIM / Math.max(cssW0, cssH0));
  eff = Math.min(eff, Math.sqrt(MAX_BACKING_PX / (cssW0 * cssH0)));
  if (!Number.isFinite(eff) || eff <= 0) eff = 1;

  const cellDev = Math.max(1, Math.round(cellPx * eff));
  return {
    cols,
    rows,
    cellDev,
    eff,
    // 让 canvas 的 CSS 尺寸 = 设备尺寸 / eff，保证 1 device px 精确对应
    cssW: (cols * cellDev) / eff,
    cssH: (rows * cellDev) / eff,
    cellCss: cellDev / eff,
  };
}

export interface HoverCell {
  row: number;
  col: number;
  /** 视口坐标，用于 fixed 定位的工具提示（不会被滚动容器裁掉） */
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// 主题色读取（只用 CSS 变量，自动适配深色主题）
// ---------------------------------------------------------------------------

interface CanvasTokens {
  line: string;
  lineStrong: string;
  ink: string;
  ink3: string;
  clay: string;
  clayDeep: string;
  sky: string;
  skySoft: string;
  paperHi: string;
  /** 手改标记 / 强调用的麦黄 */
  gold: string;
  goldDeep: string;
  /** 棋盘格双色：擦除预览要画成"和最终结果一样"的样子 */
  checkerA: string;
  checkerB: string;
  mono: string;
  /**
   * 色号候选字体，按优先级排列。
   *
   * --font-pixel 是 Silkscreen 像素字体 —— 好看，但字符推进宽度约 0.875em，
   * 比后备等宽字体宽得多。50×50（每格 19px）时它连 6px 都塞不下 "R22"，
   * fitFontSize 会直接返回 null，色号整片消失（实测踩过）。
   * 所以这里同时给出宽窄两种，让 fitFontSize 挑能排出最大字号的那个。
   */
  codeFonts: string[];
}

function readTokens(el: HTMLElement): CanvasTokens {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    return raw || fallback;
  };
  const pixelFont = v('--font-pixel', '');
  const mono = pixelFont
    ? `${pixelFont}, ui-monospace, SFMono-Regular, Menlo, monospace`
    : 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return {
    line: v('--line', '#DDCDB2'),
    lineStrong: v('--line-strong', '#432F1E'),
    ink: v('--ink', '#33261A'),
    ink3: v('--ink-3', '#9C876D'),
    clay: v('--clay', '#B0522C'),
    clayDeep: v('--clay-deep', '#8E3E1F'),
    sky: v('--sky', '#456F82'),
    skySoft: v('--sky-soft', '#DEEAEE'),
    paperHi: v('--paper-hi', '#FFFEF9'),
    gold: v('--gold', '#A87718'),
    goldDeep: v('--gold-deep', '#8C6112'),
    checkerA: v('--checker-a', '#F3E9D7'),
    checkerB: v('--checker-b', '#FFFBF0'),
    mono,
    codeFonts: [mono, 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'],
  };
}

// ---------------------------------------------------------------------------
// 图案离屏缓存
// ---------------------------------------------------------------------------

interface SurfaceHit {
  pattern: PatternResult;
  canvas: HTMLCanvasElement;
}
interface SurfaceCacheRef {
  current: SurfaceHit | null;
}

function getSurface(pattern: PatternResult, cache: SurfaceCacheRef): HTMLCanvasElement {
  const hit = cache.current;
  if (hit && hit.pattern === pattern) return hit.canvas;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, pattern.cols);
  canvas.height = Math.max(1, pattern.rows);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const image = ctx.createImageData(canvas.width, canvas.height);
    const data = image.data;
    const rgb = pattern.palette.map((p) => parseHex(p.hex) ?? { r: 0, g: 0, b: 0 });
    const { cols, rows, cells } = pattern;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = cells[r * cols + c];
        if (idx < 0) continue; // 空白：保持透明
        const color = rgb[idx];
        if (!color) continue;
        const o = (r * cols + c) * 4;
        data[o] = color.r;
        data[o + 1] = color.g;
        data[o + 2] = color.b;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  cache.current = { pattern, canvas };
  return canvas;
}

// ---------------------------------------------------------------------------
// 绘制：主画布
// ---------------------------------------------------------------------------

function ringFill(
  ctx: CanvasRenderingContext2D,
  d: (dev: number) => number,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
) {
  if (w <= 0 || h <= 0 || t <= 0) return;
  const tw = Math.min(t, Math.floor(w / 2));
  ctx.fillRect(d(x), d(y), d(w), d(tw));
  ctx.fillRect(d(x), d(y + h - tw), d(w), d(tw));
  ctx.fillRect(d(x), d(y + tw), d(tw), d(h - tw * 2));
  ctx.fillRect(d(x + w - tw), d(y + tw), d(tw), d(h - tw * 2));
}

interface CodeFont {
  size: number;
  family: string;
}

/**
 * 在给定宽度里排下最长的色号，返回能用的最大字号与对应字体。
 *
 * 同时尝试多个字体族（像素字体 vs 等宽字体）—— 像素字体更符合设计语言，
 * 但它更宽；格子小的时候等宽字体能排出更大字号，可读性优先。
 */
function fitCodeFont(
  ctx: CanvasRenderingContext2D,
  texts: string[],
  maxWidth: number,
  preferred: number,
  minSize: number,
  families: string[],
): CodeFont | null {
  let best: CodeFont | null = null;
  for (const family of families) {
    let size = Math.floor(Math.min(preferred, MAX_CODE_FONT) * 2) / 2;
    if (size < minSize) size = minSize;
    while (size >= minSize - 1e-6) {
      ctx.font = `600 ${size}px ${family}`;
      let widest = 0;
      for (const t of texts) {
        const w = ctx.measureText(t).width;
        if (w > widest) widest = w;
      }
      if (widest <= maxWidth) {
        if (!best || size > best.size) best = { size, family };
        break;
      }
      size = Math.round((size - 0.5) * 2) / 2;
    }
    // 已经能排到 preferred 上限了，换字体也不会更好
    if (best && best.size >= Math.min(preferred, MAX_CODE_FONT) - 0.5) break;
  }
  return best;
}

/** 可视区（CSS px，相对图案左上角）。null = 不知道，退化为整张绘制。 */
export interface PatternView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 把可视区换算成格子范围，并向外多留几格。
 *
 * 320 格 × 400% 时整张图有 5120×4336 设备像素（22M）—— 逐格遍历一遍色号
 * 要 86,400 次 measure/draw，单帧根本进不了 16ms。视口裁剪后每次只处理
 * 屏幕上真能看见的那几十格宽的行列，开销和缩放级别无关。
 */
function visibleCellRange(
  metrics: CanvasMetrics,
  view: PatternView | null | undefined,
): { c0: number; c1: number; r0: number; r1: number } {
  const { cols, rows, cellCss } = metrics;
  if (!view) return { c0: 0, c1: cols, r0: 0, r1: rows };
  const pad = 2;
  const c0 = Math.max(0, Math.floor(view.x / cellCss) - pad);
  const c1 = Math.min(cols, Math.ceil((view.x + view.w) / cellCss) + pad);
  const r0 = Math.max(0, Math.floor(view.y / cellCss) - pad);
  const r1 = Math.min(rows, Math.ceil((view.y + view.h) / cellCss) + pad);
  return { c0, c1: Math.max(c0, c1), r0, r1: Math.max(r0, r1) };
}

/**
 * 网格线宽度随格宽降级。
 *
 * 320 格时每格只有 3–4 CSS px，还按"10 格 = 3px 深线"画的话，一条线就吃掉
 * 大半个格子，整张图看起来全是网格、色块反而不见了。网格是辅助定位的，
 * 任何时候都不能盖过图案本身 —— 所以格子越小，线越少越细。
 */
function gridProfile(cellCss: number) {
  if (cellCss >= 12) {
    return { minor: true, minorAlpha: 0.22, med: true, medDev: 2, strongDev: 3 };
  }
  if (cellCss >= 7) {
    return { minor: true, minorAlpha: 0.14, med: true, medDev: 2, strongDev: 2 };
  }
  if (cellCss >= 3.5) {
    // 4px 格时 1px 的细线会糊成一片灰底，索性只留 5 格 / 10 格
    return { minor: false, minorAlpha: 0, med: true, medDev: 1, strongDev: 2 };
  }
  // 再小就只剩 10 格主线，否则色块完全被网格吃掉
  return { minor: false, minorAlpha: 0, med: false, medDev: 1, strongDev: 1 };
}

function drawPattern(
  canvas: HTMLCanvasElement,
  pattern: PatternResult,
  metrics: CanvasMetrics,
  surface: HTMLCanvasElement,
  opts: {
    showCodes: boolean;
    showGrid: boolean;
    tokens: CanvasTokens;
    forceRebuild?: boolean;
    view?: PatternView | null;
    /** 手工改过的格子标记（1 = 改过），用于画金色三角 */
    editMarks?: Uint8Array | null;
  },
) {
  const { cols, rows, cellDev, eff, cssW, cssH } = metrics;
  const cellCss = cellDev / eff;
  const devW = cols * cellDev;
  const devH = rows * cellDev;

  // forceRebuild：图案换了（尺寸/内容），必须整块重建，不能复用上一张的位图
  if (canvas.width !== devW || canvas.height !== devH || opts.forceRebuild) {
    canvas.width = devW;
    canvas.height = devH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, devW, devH);
  ctx.scale(eff, eff);

  const d = (dev: number) => dev / eff;
  const { tokens } = opts;
  const { c0, c1, r0, r1 } = visibleCellRange(metrics, opts.view);

  // ---- 1. 图案底色（离屏缓存，最近邻放大，绝不模糊） ----
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(surface, 0, 0, cols, rows, 0, 0, cssW, cssH);

  // ---- 2. 分级网格 ----
  if (opts.showGrid) {
    const g = gridProfile(cellCss);
    const medDev = eff >= 1.5 ? g.medDev : 1;
    const strongDev = eff >= 1.5 ? g.strongDev : Math.min(g.strongDev, 2);

    /*
     * 只画可视区内的线条（±2 格余量）。整张图 320 格时要画的线本来也就
     * 640 条，但配合 400% 缩放后每条线长 5120 设备像素，全画一遍的
     * fillRect 调用量依然可观 —— 裁剪后开销只和视口大小有关。
     */
    const vLine = (col: number, wDev: number, color: string, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(d(col * cellDev), d(r0 * cellDev), d(wDev), d((r1 - r0) * cellDev));
    };
    const hLine = (row: number, hDev: number, color: string, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(d(c0 * cellDev), d(row * cellDev), d((c1 - c0) * cellDev), d(hDev));
    };

    for (let c = c0; c <= c1; c++) {
      if (c % 10 === 0) vLine(c, strongDev, tokens.lineStrong, 0.9);
      else if (g.med && c % 5 === 0) vLine(c, medDev, tokens.ink3, 0.9);
      else if (g.minor && c % 1 === 0) vLine(c, 1, tokens.line, g.minorAlpha);
    }
    for (let r = r0; r <= r1; r++) {
      if (r % 10 === 0) hLine(r, strongDev, tokens.lineStrong, 0.9);
      else if (g.med && r % 5 === 0) hLine(r, medDev, tokens.ink3, 0.9);
      else if (g.minor) hLine(r, 1, tokens.line, g.minorAlpha);
    }
  }

  // 图案外框永远画，便于看出图案边界（关掉网格时尤其重要）
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = tokens.lineStrong;
  ctx.fillRect(0, 0, d(devW), d(1));
  ctx.fillRect(0, d(devH - 1), d(devW), d(1));
  ctx.fillRect(0, 0, d(1), d(devH));
  ctx.fillRect(d(devW - 1), 0, d(1), d(devH));

  // ---- 3. 色号 ----
  if (opts.showCodes && cellCss >= 9) {
    const codes = pattern.palette.map((p) => p.code).filter(Boolean);
    if (codes.length) {
      // 留 8% 边距即可：色号本来就要撑满格子才好读（太多留白会把字号压小一档）
      const maxWidth = cellCss * 0.92;
      // 100% 时（cellCss≈19）保持 9.5px 的可读字号；放大后跟着格宽一起长
      // （否则 300% 下每格 57px 里挤着 9px 的字，看着像没放大）。
      const preferred = cellCss >= 14 ? Math.max(9.5, cellCss * 0.5) : cellCss * 0.55;
      const code = fitCodeFont(ctx, codes, maxWidth, preferred, 6, tokens.codeFonts);
      if (code) {
        ctx.globalAlpha = 1;
        ctx.font = `600 ${code.size}px ${code.family}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const inks = pattern.palette.map((p) => readableInkFor(p.rgb));
        const { cells } = pattern;
        let lastInk = '';
        for (let r = r0; r < r1; r++) {
          for (let c = c0; c < c1; c++) {
            const idx = cells[r * cols + c];
            if (idx < 0) continue;
            const bead = pattern.palette[idx];
            if (!bead) continue;
            const ink = inks[idx];
            if (ink !== lastInk) {
              ctx.fillStyle = ink;
              lastInk = ink;
            }
            // 中心点对齐到整设备像素，文字才不会发虚
            ctx.fillText(
              bead.code,
              d(Math.round((c + 0.5) * cellDev)),
              d(Math.round((r + 0.5) * cellDev)),
            );
          }
        }
      }
    }
  }

  /*
   * ---- 3.5 手改标记 ----
   *
   * 每颗被手工改过的豆子右上角打一个金色小三角。为什么不用描边框：
   * 50×50 时每格才 19px，描边会把整格颜色压掉一半、还把网格线糊掉；
   * 三角只占右上角约 1/3，色号照样看得清，而且"尖角朝内"的形状在
   * 满屏幕的方块里非常跳 —— 用户扫一眼就知道哪几颗是自己改的。
   *
   * 只在每格 ≥ 6px 时画：再小三角只有一个像素，等于给格子上了一颗脏点。
   */
  const marks = opts.editMarks;
  if (marks && cellCss >= 6) {
    /*
     * 注意坐标系：这里已经 `ctx.scale(eff, eff)`，所以**一切尺寸都要用
     * CSS px**（cellCss），不能混进设备像素 —— 混进去三角会画到画布外
     * （dpr2 下坐标翻倍，实测整片消失）。格子边界那些地方才用 d() 把
     * 设备像素换算回来，是为了让线条落在整设备像素上。
     */
    const leg = Math.max(2, Math.round(cellDev * 0.32)) / eff;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = tokens.gold;
    ctx.beginPath();
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (!marks[r * cols + c]) continue;
        const x = (c + 1) * cellCss;
        const y = r * cellCss;
        ctx.moveTo(x - leg, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + leg);
        ctx.closePath();
      }
    }
    ctx.fill();
    // 描一道深色边：金色在浅黄/亮绿豆子上会隐形，压深一档才够看
    if (cellDev >= 10) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = tokens.goldDeep;
      ctx.lineWidth = Math.max(1, 1 / eff);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// 绘制：区域遮罩（独立图层，绝不污染图案本体）
// ---------------------------------------------------------------------------

/**
 * 把区域场画成一层"能看见但不挡图"的标记。
 *
 * 为什么按格画、而不是画一个模糊的圆：引擎的权重本来就是**按格**算的，
 * 按格画出来的 alpha 阶梯就是引擎实际生效的那条羽化曲线 —— 用户看到的
 * 渐变和最终重算出来的渐变是同一件事，不会"看着柔和、出图生硬"。
 *
 * 两层结构：
 *   1. 填充：alpha = 权重 × 0.18，中心深、边缘淡，峰谷之间的过渡带自然浮现；
 *   2. 轮廓：在权重穿过 0.5 的等值线上描一圈亮线，标出"核心区域在哪"。
 *      只描核心等值线而不描填充最外沿 —— 外沿 alpha 已趋近 0，描了反而像硬边。
 */
function drawRegionMask(
  canvas: HTMLCanvasElement,
  metrics: CanvasMetrics,
  appliedField: RegionField | null,
  pendingField: RegionField | null,
  liveWeights: Float32Array | null,
  liveBox: { c0: number; r0: number; c1: number; r1: number } | null,
  tokens: CanvasTokens,
  appliedFocus: boolean,
) {
  const { cols, rows, cellDev } = metrics;
  const devW = cols * cellDev;
  const devH = rows * cellDev;

  if (canvas.width !== devW || canvas.height !== devH) {
    canvas.width = devW;
    canvas.height = devH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, devW, devH);
  if (!appliedField?.active && !pendingField?.active && !liveWeights) return;

  /*
   * 这一层只回答一个问题：**哪些地方会被重新分析**。
   *
   * 曾经试过两种"更花"的表达，都不合适：
   *   a) 斜线网按密度分桶：各环覆盖率 28.4/26.4/27.7… 几乎恒定，
   *      线距收窄与 alpha 变淡互相抵消，肉眼看不出梯度；
   *   b) 每格撒采样点阵：梯度是出来了，但把色号盖住了。
   *      拼豆画布上真正的主角永远是色号，标记层不能抢。
   *
   * 现在分层很轻：极淡底纹（按权重衰减）+ 一圈外沿轮廓。
   * 精度有没有真的渐变，看的是**重算后的图像**，不是这层标记。
   *
   * ------------------------------------------------------------------
   * 关键改动：**每格只填一次**（优先级合成，不是三层叠着填）。
   *
   * 早先的实现是依次刷三遍（applied 一遍、pending 一遍、live 一遍），
   * 于是同一格被画 2–4 次，canvas 的 source-over 会让 alpha 按
   * 1-(1-a)^n 累积：设计上中心 0.28（71/255）实际量到 184（0.72），
   * 已应用区域设计 0.2 量到 96。数值超标只是表象，真正的后果是
   * **两种颜色叠出一种说不清的第三种色**，用户没法判断自己看到的是
   * 已应用还是草稿。
   *
   * 现在先在内存里把每格的最终 (颜色, alpha) 算出来、再只 fillRect 一次：
   *   - 优先级 live > pending > applied（草稿盖住历史，因为草稿是"正在做的"）
   *   - live 与 pending 同为草稿色 --sky，取权重较大者（不叠加）
   *   - 因此每格 alpha 上限严格 = weight × PENDING_MASK_ALPHA ≤ 0.28
   * ------------------------------------------------------------------
   *
   * 配色语义：
   *   - 已应用（applied）：陶土色，**常态只有 0.1**（"这里重算过"的极淡
   *     痕迹，不糊住豆子颜色），鼠标移进该区域时升到 0.2 让它发亮；
   *   - 待应用（pending）：天空蓝 0.28 + **实线**轮廓，比已应用醒目 ——
   *     这是"你正要提交的东西"；
   *   - 拖动中（live）：与 pending 同色同档，但不画轮廓（轮廓留给抬手后，
   *     否则每一帧都在重算外沿，线条会一路抖，像坏了）。
   */
  const appliedAlpha = appliedFocus ? REGION_MASK_ALPHA : REGION_MASK_IDLE_ALPHA;
  const aw = appliedField?.active ? appliedField.w : null;
  const pw = pendingField?.active ? pendingField.w : null;
  const lw = liveWeights;

  // 只扫会被扫到的范围：三层里任何一层可能有权重的格子并集
  let c0 = cols - 1;
  let c1 = 0;
  let r0 = rows - 1;
  let r1 = 0;
  let any = false;
  const scan = (w: Float32Array | null) => {
    if (!w) return;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (w[r * cols + c] < MASK_MIN_WEIGHT) continue;
        any = true;
        if (c < c0) c0 = c;
        if (c > c1) c1 = c;
        if (r < r0) r0 = r;
        if (r > r1) r1 = r;
      }
    }
  };
  scan(aw);
  scan(pw);
  if (lw) {
    const b = liveBox;
    if (b) {
      if (b.c0 < c0) c0 = Math.max(0, b.c0);
      if (b.c1 > c1) c1 = Math.min(cols - 1, b.c1);
      if (b.r0 < r0) r0 = Math.max(0, b.r0);
      if (b.r1 > r1) r1 = Math.min(rows - 1, b.r1);
      any = true;
    } else {
      scan(lw);
    }
  }
  if (!any) return;

  // ---- 1) 底纹：每格只填一次 ----
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * cols;
    for (let c = c0; c <= c1; c++) {
      const i = rowBase + c;
      const wl = lw ? lw[i] : 0;
      const wp = pw ? pw[i] : 0;
      // 草稿层：live 与 pending 取较大权重（同色，叠加只会变深）
      const draft = wl > wp ? wl : wp;
      if (draft >= MASK_MIN_WEIGHT) {
        ctx.globalAlpha = draft * PENDING_MASK_ALPHA;
        ctx.fillStyle = tokens.sky;
      } else {
        const wa = aw ? aw[i] : 0;
        if (wa < MASK_MIN_WEIGHT) continue;
        ctx.globalAlpha = wa * appliedAlpha;
        ctx.fillStyle = tokens.clay;
      }
      ctx.fillRect(c * cellDev, r * cellDev, cellDev, cellDev);
    }
  }
  ctx.globalAlpha = 1;

  /*
   * ---- 2) 外沿轮廓 ----
   *
   * 描在"权重刚过 MASK_MIN_WEIGHT"的位置而不是 0.5：0.5 那圈是**参数变化最快**的
   * 地方，描上去会形成一条视觉硬线，正是用户要避免的"生硬"。描在最
   * 外沿只标记区域范围，中间的过渡区留给图像自己去渐变。
   *
   * 用连续 stroke 而非逐格 fillRect：相邻格的边界段在格角首尾相接，
   * 逐段 stroke 才连得成一条折线（逐格填小方块会裂成碎屑）。
   */
  const outline = (
    w: Float32Array | null,
    color: string,
    alpha: number,
    dashed: boolean,
    skip?: Float32Array | null,
  ) => {
    if (!w) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, Math.round(cellDev * 0.07));
    if (dashed) {
      const dash = Math.max(2, Math.round(cellDev * 0.5));
      ctx.setLineDash([dash, dash]);
    }
    ctx.beginPath();
    const at = (r: number, c: number) => {
      if (r < 0 || c < 0 || r >= rows || c >= cols) return 0;
      const i = r * cols + c;
      // 被草稿覆盖的地方不参与已应用轮廓，避免两条轮廓叠在一处
      if (skip && skip[i] >= MASK_MIN_WEIGHT) return 0;
      return w[i];
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const inside = at(r, c) >= MASK_MIN_WEIGHT;
        if (inside !== at(r, c + 1) >= MASK_MIN_WEIGHT) {
          const x = (c + 1) * cellDev;
          ctx.moveTo(x, r * cellDev);
          ctx.lineTo(x, (r + 1) * cellDev);
        }
        if (inside !== at(r + 1, c) >= MASK_MIN_WEIGHT) {
          const y = (r + 1) * cellDev;
          ctx.moveTo(c * cellDev, y);
          ctx.lineTo((c + 1) * cellDev, y);
        }
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  /*
   * 轮廓的 alpha 刻意低于"看起来最精神"的 0.95。
   *
   * 轮廓是 1 设备像素的线，它**必然**落在填充格上（格边界就是填充边缘），
   * source-over 复合后峰值 = lineAlpha + fillAlpha×(1-lineAlpha)。0.95 时
   * 实测峰值到 187/255 —— 那不是我们设计的上限，会让"标记层最浓的地方"
   * 变成一个说不清的数字。现在压到 0.75/0.34：峰值降到 ~150/87，
   * 仍明显高于填充（0.28×weight），"这是范围边界"读得出来，但整层
   * 的最浓处回到可解释的量级。
   */
  // 已应用：虚线（历史痕迹，低调）；被草稿盖住的地方跳过
  outline(aw, tokens.clayDeep, 0.34, true, lw ?? pw);
  // 待应用：实线（更亮更肯定）
  outline(pw, tokens.sky, 0.75, false);
  // live 也画实线吗？不 —— 拖动中每一帧外沿都在变，画轮廓会抖成"坏掉了"
}

/**
 * 笔刷圆环：跟随指针，半径就是这一笔实际会影响的半径（已含羽化带）。
 * 虚线边 + 半透明填充，压在图上也能看清自己刷到哪儿。
 */
function drawBrushRing(
  ctx: CanvasRenderingContext2D,
  metrics: CanvasMetrics,
  cursor: { x: number; y: number; core: number; reach: number } | null,
  tokens: CanvasTokens,
) {
  if (!cursor) return;
  // ctx 已 scale(eff)，这里的坐标系就是 CSS px，直接用即可
  const { x: cx, y: cy, core, reach } = cursor;
  if (reach < 1) return;

  /*
   * 双圈：内圈实线 = 核心半径（权重恒为 1，这里一定改到位），
   * 外圈虚线 = reach（含羽化带，只是过渡）。
   *
   * 早先是单圈且传的是裸半径 —— 比引擎实际重算范围小一个羽化带
   * （默认 feather=0.55 时小 1.73 倍），用户按圆环判断"我这笔盖到了没"
   * 必然判断错。现在两档画出来，"核心/过渡"一眼分得开。
   */
  // 过渡带：内外圈之间铺一层极淡的草稿色
  ctx.beginPath();
  ctx.arc(cx, cy, reach, 0, Math.PI * 2);
  ctx.arc(cx, cy, core, 0, Math.PI * 2, true);
  ctx.globalAlpha = 0.07;
  // 刷子模式下画出来的一切都先进"待应用"草稿层，所以圆环用草稿色 --sky，
  // 和它在遮罩层里留下的蓝色选区是同一个语义
  ctx.fillStyle = tokens.sky;
  ctx.fill();

  // 内圈核心：实线，稍微实一点
  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = tokens.sky;
  ctx.lineWidth = metrics.eff >= 1.5 ? 1.5 : 1;
  ctx.stroke();

  // 外圈 reach：虚线间距随格宽走（固定间距放大后会变成一串疏点，
  // 缩小时又会糊成实线）
  const dash = Math.max(3, Math.min(9, Math.round(metrics.cellCss * 0.5)));
  ctx.beginPath();
  ctx.arc(cx, cy, reach, 0, Math.PI * 2);
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([dash, dash]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 圆心十字：大笔刷下更需要一个精确落点
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = tokens.sky;
  const arm = Math.max(2, Math.round(core * 0.14));
  ctx.fillRect(cx - arm, cy - 0.5, arm * 2, 1);
  ctx.fillRect(cx - 0.5, cy - arm, 1, arm * 2);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// 绘制：悬停 overlay（只重绘这一层）
// ---------------------------------------------------------------------------

function drawHover(
  canvas: HTMLCanvasElement,
  metrics: CanvasMetrics,
  hover: HoverCell | null,
  tokens: CanvasTokens,
) {
  const { cols, rows, cellDev, eff } = metrics;
  const devW = cols * cellDev;
  const devH = rows * cellDev;

  if (canvas.width !== devW || canvas.height !== devH) {
    canvas.width = devW;
    canvas.height = devH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, devW, devH);
  if (!hover || cellDev < 4) return;
  if (hover.col < 0 || hover.row < 0 || hover.col >= cols || hover.row >= rows) return;

  ctx.scale(eff, eff);
  const d = (dev: number) => dev / eff;
  const x = hover.col * cellDev;
  const y = hover.row * cellDev;

  // 单色描边在深色豆（R22 那种深棕）上会糊掉，所以用"深-亮-陶土"三层环：
  // 最外层深墨（亮色块可见）→ 中间纸白（深色块可见）→ 内层陶土（品牌色强调）。
  if (cellDev >= 12) {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = tokens.ink;
    ringFill(ctx, d, x - 1, y - 1, cellDev + 2, cellDev + 2, 1);

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = tokens.paperHi;
    ringFill(ctx, d, x, y, cellDev, cellDev, 1);

    const ring = Math.max(2, Math.min(4, Math.round(cellDev * 0.11)));
    ctx.globalAlpha = 1;
    ctx.fillStyle = tokens.clay;
    ringFill(ctx, d, x + 1, y + 1, cellDev - 2, cellDev - 2, ring);

    // 中心留一点纸白十字，密集色块里也能一眼锁定这一格
    if (cellDev >= 22) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = tokens.paperHi;
      const arm = Math.max(2, Math.round(cellDev * 0.12));
      ctx.fillRect(
        d(x + Math.round(cellDev / 2) - arm),
        d(y + Math.round(cellDev / 2) - 1),
        d(arm * 2),
        d(2),
      );
      ctx.fillRect(
        d(x + Math.round(cellDev / 2) - 1),
        d(y + Math.round(cellDev / 2) - arm),
        d(2),
        d(arm * 2),
      );
    }
  } else {
    // 缩得很小时只画一圈，避免糊成一片
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = tokens.clay;
    ringFill(ctx, d, x, y, cellDev, cellDev, 1);
  }

  ctx.globalAlpha = 1;
}

/**
 * 拖动中的编辑预览：把这一笔已经划过的格子按目标色直接画出来。
 *
 * 只画这一笔涉及的格子（用户一次拖动通常几十格，极端也就几百格），
 * 不碰主画布、不重建 surface —— 这是能和 320 格画布并存的唯一代价合理做法。
 *
 * 擦除（`after === ''`）要画成**棋盘格**而不是"什么都不画"：透明格在画布上
 * 透出的是 .px-checker 背景，如果这里直接 clear 掉，看到的会是上一帧的图案
 * 残影；而如果把格子填成纸色，又会被误读成"变成纸色豆子"。棋盘格才是
 * "这里将不存在豆子"的正确表达，和擦除后的最终结果一致。
 */
function drawEditPreview(
  canvas: HTMLCanvasElement,
  metrics: CanvasMetrics,
  cells: readonly number[],
  after: string,
  hex: string | null,
  tokens: CanvasTokens,
  skipClear = false,
) {
  const { cols, rows, cellDev, eff } = metrics;
  const devW = cols * cellDev;
  const devH = rows * cellDev;

  if (canvas.width !== devW || canvas.height !== devH) {
    canvas.width = devW;
    canvas.height = devH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  /*
   * skipClear：调用方（overlay 绘制 effect）刚被 drawHover 清过整层，
   * 再清一次会把 hover 环一起擦掉。独立使用时（默认 false）自己负责清。
   */
  if (!skipClear) ctx.clearRect(0, 0, devW, devH);
  if (cells.length === 0) return;
  ctx.scale(eff, eff);
  const d = (dev: number) => dev / eff;
  const size = d(cellDev);

  if (after === '') {
    // 擦除预览：两色棋盘，格内 2×2 交替，小格子时退化成单色块
    const half = size / 2;
    const a = tokens.checkerA;
    const b = tokens.checkerB;
    for (const index of cells) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = d(col * cellDev);
      const y = d(row * cellDev);
      if (cellDev < 8) {
        ctx.fillStyle = a;
        ctx.fillRect(x, y, size, size);
        continue;
      }
      ctx.fillStyle = a;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = b;
      ctx.fillRect(x, y, half, half);
      ctx.fillRect(x + half, y + half, half, half);
    }
    ctx.globalAlpha = 1;
    return;
  }

  if (!hex) return;
  ctx.fillStyle = hex;
  for (const index of cells) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    ctx.fillRect(d(col * cellDev), d(row * cellDev), size, size);
  }

  /*
   * 高亮轮廓：预览色可能和底下那一格几乎同色（例如在橙块上画橙豆），
   * 一旦重合用户就看不出"我到底涂到了没有"。给这一笔的外沿补一圈金色细边，
   * 让"已覆盖范围"永远可读。
   *
   * 但门槛必须够高：7px 的格子上 1px 描边就占掉 14%，两侧加起来 28%，
   * 整条笔迹会读成"黄黑相间的虚线"（实测截图里就是这样，比不加还难看）。
   * 小格子下色块本身已经换色，足以判断，所以只在格子足够大时才描边。
   */
  if (cellDev >= 11) {
    /*
     * 用 Set 查邻格：stroke.cells 在快速拖动下可能有几百格，`includes`
     * 逐格线性扫会让这一步退化成 O(n²)（几百格 = 十几万次比较，
     * 每帧跑一次就开始掉帧）。
     */
    const set = new Set(cells);
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = tokens.gold;
    const edge = Math.max(1, Math.round(cellDev * 0.08));
    for (const index of cells) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = d(col * cellDev);
      const y = d(row * cellDev);
      // 只在没有相邻预览格的那条边画，内部不画（否则一片格子全是金线）
      const up = row > 0 && set.has(index - cols);
      const down = row < rows - 1 && set.has(index + cols);
      const left = col > 0 && set.has(index - 1);
      const right = col < cols - 1 && set.has(index + 1);
      const t = d(edge);
      if (!up) ctx.fillRect(x, y, size, t);
      if (!down) ctx.fillRect(x, y + size - t, size, t);
      if (!left) ctx.fillRect(x, y, t, size);
      if (!right) ctx.fillRect(x + size - t, y, t, size);
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * 编辑工具。
 *
 * `pencil` 是唯一会连续绘制（拖出一片）的；`eraser` 同理；`picker` 与
 * `fill` 都是一次性点击 —— 它们没有"拖动"的语义，拖也只算点一下。
 *
 * `pan`（抓手）是用户后补的一项：
 * 「然后画笔的左边可以加一个"抓手"吧，抓手就是用来控制画板的上下左右
 * 灵活移动的」。它**不碰任何格子**，只改滚动容器的 scrollLeft/scrollTop。
 * 放大到 400% 之后画布比可视区大好几倍，靠滚动条拖动要反复瞄准；抓手是
 * "按住就甩"的那种操作。摆在工具组最左边（画笔左边）—— 先移动视线、
 * 再下笔，是鼠标手势的自然顺序。
 */
export type EditTool = 'pan' | 'pencil' | 'eraser' | 'picker' | 'fill';

/**
 * 笔头粗细（直径，格）。
 *
 * 用户先后提了三件事：
 *   1.「编辑模式可以加入一个粗笔刷，这样初期绘制起来比较方便」
 *   2.「其实可以合并笔……调整笔刷的粗细」
 *   3.「太保守了，可以做个滑动条然后跟进到 1-16 直径的吧」
 *
 * 所以最后不设"粗笔"这个独立工具 —— 笔只有一支，粗细是个连续参数，
 * 用一个滑动条从 1 调到 16。
 *
 * 为什么是参数而不是工具：
 *   · 分开两个工具时，用户画到一半想变粗必须先切工具，切完 currentCode
 *     和笔迹状态都要重建，手感是断的；
 *   · 而"粗/细"本质是同一个动作的两档反馈，放在同一个笔上才符合直觉
 *     （真实的手绘就是换笔尖，不是换笔）。
 *
 * 上限从 4 提到 16：4 太保守了。320 格的大图上，16 格直径只占 5%，一笔
 * 铺一片背景正好；而 4 格在大图上和细笔几乎没差别，用户还得来回拖几十笔。
 * 小图上 16 格确实很粗，但那是用户自己的选择 —— 有个滑动条在旁边，
 * 手感和结果的关系是直接可见的，不需要系统去替他挡。
 */
export const MIN_BRUSH_WIDTH = 1;
export const MAX_BRUSH_WIDTH = 16;

/**
 * 笔头形状：把"直径 N 格"翻译成"覆盖哪些偏移格"。
 * ===============================================================
 * 这个函数被**两处**共用，而且必须共用：
 *   1. `applyToolAt` 落笔时实际涂哪些格；
 *   2. 画布上的预览环（鼠标悬停时那圈金线）。
 * 两处各写一份的话，改了一处忘了另一处，用户就会看到"圈住 4 格、涂了 1 格"
 * 这种最伤信任的错位。
 *
 * ## 为什么偶数直径要偏移半格
 *
 * 奇数直径（1/3/5…）中心正好落在某一格的正中，直接算距离就行。
 * 偶数直径（2/4/6…）没有"正中那一格" —— 中心落在四格的交角上。
 * 如果硬按格心算：
 *   · 直径 2 的半径是 0.5，阈值 0.5+0.35=0.85，而相邻格心距离是 1.0
 *     → 只有自己那一格入选，直径 2 和直径 1 画出来一模一样（实测过，
 *     用户报的就是这个：滑动条从 1 拖到 2，画面没变化）；
 *   · 直径 4 也只覆盖到 9 格，和直径 3 的 5 格差别远小于应有倍数。
 * 把中心偏移到 `(0.5, 0.5)`，直径 2 正好覆盖 2×2 的四格 —— 这才是
 * "直径 2 颗豆"的物理含义（一个 2×2 的豆块）。
 *
 * 阈值 `+0.35` 是给圆盘边缘做柔化：纯粹按半径切，直径 3 会得到 3×3 的
 * 实心方块（画竖线变成 3 格宽的柱子，很硬）；+0.35 把四个角切掉，
 * 得到"3×3 去四角"的十字块，斜边和细线上自然得多。
 */
export function brushSpan(width: number): { lo: number; hi: number } {
  const w = Math.max(MIN_BRUSH_WIDTH, Math.min(MAX_BRUSH_WIDTH, Math.round(width)));
  const center = w % 2 === 0 ? 0.5 : 0;
  const radius = (w - 1) / 2;
  return { lo: Math.floor(center - radius), hi: Math.ceil(center + radius) };
}

/** 这个偏移格是否被笔头覆盖（中心偏移规则见 `brushSpan`） */
export function brushContains(width: number, dx: number, dy: number): boolean {
  const w = Math.max(MIN_BRUSH_WIDTH, Math.min(MAX_BRUSH_WIDTH, Math.round(width)));
  if (w === 1) return dx === 0 && dy === 0;
  const center = w % 2 === 0 ? 0.5 : 0;
  const radius = (w - 1) / 2;
  return Math.hypot(dx - center, dy - center) <= radius + 0.35;
}

/** 把任意输入夹到合法笔宽（渲染期与事件里都要用，抽出来避免两处不同步） */
export const clampBrushWidth = (w: number): number =>
  Math.min(MAX_BRUSH_WIDTH, Math.max(MIN_BRUSH_WIDTH, Math.round(w)));


/** 编辑历史上限：每笔一格一条 delta，太大反而找不到想撤的那一步 */
const MAX_EDIT_HISTORY = 200;

export interface UsePatternCanvasOptions {
  /** 受控的区域笔刷 */
  brushes?: DetailBrush[];
  /** 笔刷变化回调（每一笔结束 / 撤销 / 清空时调用一次） */
  onBrushesChange?: (next: DetailBrush[]) => void;
  /** 区域羽化（0.12–1），由父组件持有 */
  regionFeather?: number;
  /** 填满父容器高度（父容器需是有确定高度的 flex 列） */
  fill?: boolean;
  /** 品牌（编辑需要它把色号翻译成真实 hex/rgb） */
  brand?: Brand;
  /** 手工编辑覆盖层（受控；不传则编辑功能关闭） */
  edits?: EditMap;
  /** 编辑变化回调；`deltas` 是这次变化包含的若干笔（撤销栈用） */
  onEditsChange?: (next: EditMap, deltas: EditDelta[]) => void;
  /** 取色器/当前画笔色号 变化时通知父组件（色卡高亮用） */
  onCurrentCodeChange?: (code: string) => void;
  /** 初始工具（不传默认 pencil） */
  initialTool?: EditTool;
  /**
   * 编辑模式是否激活（画布进入"手绘/橡皮/取色/油漆桶"状态）。
   *
   * 只影响**格子尺寸的计算策略**：编辑时按宽度优先，让画板占主要面积；
   * 非编辑时仍是"宽高取小值、一打开看全整图"。两者是不同的使用场景，
   * 不能共用一套 fit。
   */
  editing?: boolean;
}

export function usePatternCanvas(
  pattern: PatternResult | null,
  options: UsePatternCanvasOptions = {},
) {
  const {
    brushes,
    onBrushesChange,
    regionFeather = 0.55,
    fill = false,
    brand,
    edits: editsProp,
    onEditsChange,
    onCurrentCodeChange,
    initialTool,
    editing = false,
  } = options;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<SurfaceHit | null>(null);
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ fx: number; fy: number; vx: number; vy: number; active: boolean }>({
    fx: 0.5,
    fy: 0.5,
    vx: 0,
    vy: 0,
    active: false,
  });

  const [hostWidth, setHostWidth] = useState(0);
  const [hostHeight, setHostHeight] = useState(0);
  /**
   * 滚动容器自身的可视尺寸。
   *
   * 不能用 hostHeight 算格子高度：host 里还有工具条（约 32px）和提示行，
   * 拿整个 host 的高度去凑图，格子会比可视区多算一档，结果每次都差 30px
   * 而多出一条纵向滚动条（实测 1920×1080：scrollH 774 vs clientH 742）。
   * 滚动容器在 fill 模式下是 flex:1，高度只由父级决定、不受内容影响，
   * 直接量它不会形成反馈环。
   */
  const [viewportW, setViewportW] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  /**
   * 滚动位置计数器。
   *
   * 滚动会改变"可视区"，可视区决定要重绘哪些格子 —— 所以滚动必须触发重绘，
   * 否则一侧滚就会看到没画过的空白。用 rAF 节流：一次滚动事件只排一次重绘，
   * 再快的滚轮也不会排队堆积。
   */
  const [scrollTick, setScrollTick] = useState(0);
  const scrollRafRef = useRef(0);
  const [dpr, setDpr] = useState(1);
  const [zoom, setZoomState] = useState(1);
  const [showCodes, setShowCodesState] = useState(true);
  const [showGrid, setShowGridState] = useState(true);
  const [showRulers, setShowRulersState] = useState(true);
  const [showRegionOverlay, setShowRegionOverlayState] = useState(true);
  const [hover, setHover] = useState<HoverCell | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [themeTick, setThemeTick] = useState(0);

  // ---- 刷区域状态 ----
  const [brushMode, setBrushModeState] = useState(false);
  const [brushAlgorithm, setBrushAlgorithmState] = useState<DetailAlgorithm>('crisp');
  const [brushRadius, setBrushRadiusState] = useState(0.12);
  /** 指针在画布上的归一化位置 + 设备像素半径，用于画笔刷圆环 */
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number; r: number } | null>(
    null,
  );
  /** 正在拖的这笔（抬手时并入 pending，不触发任何重算） */
  const strokeRef = useRef<DetailBrush[] | null>(null);
  /** 最后一次仍在画布内的位置：拖出画布再拖回来时用它补插值，线不断 */
  const lastInsideRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * 待应用的选区草稿。
   *
   * 这是"两步式"的核心：拖动过程中所有笔划只累在这里，**全程不调用
   * onBrushesChange**。父组件的重算是 180ms debounce + 全图重算，如果
   * 每一笔都提交，用户体感就是"只能单点、拖不动"——那正是要修的毛病。
   * 用户点「应用重建」时这一整批才一次性提交。
   *
   * 不持久化：刷新即丢。否则隔天回来会莫名其妙带着一堆自己忘了的选区。
   */
  const [pendingStrokes, setPendingStrokesState] = useState<DetailBrush[][]>([]);
  const pendingRef = useRef<DetailBrush[][]>([]);
  const setPendingStrokes = useCallback((next: DetailBrush[][]) => {
    pendingRef.current = next;
    setPendingStrokesState(next);
  }, []);
  /** 草稿的扁平点序列：只用来算遮罩和提交，界面上按"几处"报数 */
  const pendingPoints = useMemo(() => pendingStrokes.flat(), [pendingStrokes]);

  /*
   * 正在拖的这一笔的**实时**权重图。
   *
   * 为什么单独维护：pendingField 只在抬手后才有数据，拖动全程遮罩是空的 ——
   * 用户手指底下什么都不发生，一松手突然冒出一大片，体感就是"没反应"。
   * 但又不能每帧重建 RegionField（见 stampLive 上方的注释）。
   *
   * 所以这里走一张轻量 Float32Array，只被 pointermove 直接写，
   * 再用 liveTick 这个计数器把重绘"推"一次（ref 变化不会触发渲染）。
   */
  const liveRef = useRef<Float32Array | null>(null);
  const liveStampedRef = useRef(0);
  const [liveTick, setLiveTick] = useState(0);
  /**
   * 这一笔实时遮罩覆盖的格子包围盒。
   *
   * 每一帧重画实时层时只遍历这块区域 —— 320 格是 86,400 格，全遍历一遍
   * 要 20ms 以上（实测拖动手感发滞），只遍历笔刷扫过的几百格则 <1ms。
   */
  const liveBoxRef = useRef<{ c0: number; r0: number; c1: number; r1: number } | null>(null);
  const liveRafRef = useRef(0);

  const brushModeRef = useRef(false);
  const brushAlgorithmRef = useRef<DetailAlgorithm>('crisp');
  const brushRadiusRef = useRef(0.12);
  /**
   * 羽化值的 ref 镜像。
   *
   * 实时层必须用与引擎同一个 feather 算 band —— 否则按住时画的圈和松手后
   * 引擎重算的范围又会对不上（这正是缺陷 ① 的一半原因）。走 ref 是为了
   * 让 stampLive/growLiveBox 这些 useCallback 不必因为 feather 变化而重建。
   */
  const featherRef = useRef(0.55);
  featherRef.current = regionFeather;

  /**
   * 推进实时层。
   *
   * 用 rAF 合并：pointermove 在 120Hz 触摸屏上每秒能来 120 次，每次都
   * setState 会让 React 一帧渲染多轮、遮罩层重复重画。合并到"每帧最多
   * 一次"后，帧耗时和事件频率无关。
   */
  /** 把一支笔的包围盒并进实时层的总包围盒 */
  const growLiveBox = useCallback((p: DetailBrush) => {
    if (!pattern) return;
    const { cols, rows } = pattern;
    // 包围盒必须按 reach（含羽化带）算，否则外圈过渡区画不出来
    const { cx, cy, reach } = brushGeometry(
      p.x,
      p.y,
      p.radius,
      cols,
      rows,
      featherRef.current,
    );
    const r = Math.ceil(reach) + 1;
    const c0 = Math.max(0, Math.floor(cx - r));
    const c1 = Math.min(cols - 1, Math.ceil(cx + r));
    const r0 = Math.max(0, Math.floor(cy - r));
    const r1 = Math.min(rows - 1, Math.ceil(cy + r));
    const cur = liveBoxRef.current;
    if (!cur) {
      liveBoxRef.current = { c0, r0, c1, r1 };
      return;
    }
    if (c0 < cur.c0) cur.c0 = c0;
    if (r0 < cur.r0) cur.r0 = r0;
    if (c1 > cur.c1) cur.c1 = c1;
    if (r1 > cur.r1) cur.r1 = r1;
  }, [pattern]);

  const bumpLiveTick = useCallback(() => {
    if (liveRafRef.current) return;
    liveRafRef.current = requestAnimationFrame(() => {
      liveRafRef.current = 0;
      setLiveTick((t) => t + 1);
    });
  }, []);

  /** 清掉实时层（抬笔 / 移出画布 / 切出刷子 / 换图案都要清，否则留幽灵遮罩） */
  const resetLive = useCallback(() => {
    liveRef.current = null;
    liveStampedRef.current = 0;
    // 注意：liveBoxRef 由绘制 effect 在擦完上一帧后自己清空，
    // 这里清掉会导致那一块擦不干净（残留幽灵遮罩）
    setLiveTick((t) => t + 1);
  }, []);

  /** 确保实时层已分配，并和设备尺寸对齐 */
  const ensureLive = useCallback((cols: number, rows: number): Float32Array => {
    const need = cols * rows;
    const cur = liveRef.current;
    if (!cur || cur.length !== need) {
      const fresh = new Float32Array(need);
      liveRef.current = fresh;
      liveStampedRef.current = 0;
      return fresh;
    }
    return cur;
  }, []);
  const brushesRef = useRef<DetailBrush[]>(brushes ?? []);
  brushesRef.current = brushes ?? [];

  const hasPattern = !!pattern && pattern.cols > 0 && pattern.rows > 0;
  /**
   * fill 生效条件：父容器必须真的给出了高度。
   *
   * 移动端单列布局里父容器常常没有确定高度（或者 h-dvh 被软键盘压缩），
   * 直接用 height:100% 会把画布塌成一条线。所以低于 MIN_FILL_HOST_HEIGHT
   * 就自动降级回"限高 + 内部滚动"的老行为 —— ResizeObserver 同时盯着宽高，
   * 条件恢复时会自动切回 fill，不需要额外的窗口 resize 监听。
   */
  const useFill = fill && hostHeight >= MIN_FILL_HOST_HEIGHT;

  // ==========================================================================
  // 编辑层（手绘 / 橡皮 / 取色器 / 油漆桶）
  // ==========================================================================

  /*
   * 编辑的真相分两层：`pattern` 是引擎结果（不可变），`edits` 是稀疏覆盖层。
   * 画布、统计、导出都必须消费**两者叠加后**的结果，否则"屏幕上看到的"
   * 和"拼出来的"就会打架。这里统一在 hook 内部算出叠加后的 `displayPattern`，
   * 下游（surface / 色号 / 统计条）只认它，不再各自去 applyEdits。
   */
  const edits = editsProp ?? EMPTY_EDITS;
  const editsRef = useRef<EditMap>(edits);
  editsRef.current = edits;

  /** 编辑器是否可用：父组件给了 onEditsChange 才启用（不传则整块 UI 消失） */
  const editEnabled = typeof onEditsChange === 'function' && typeof brand === 'string';

  /**
   * 叠加编辑后的图案 —— **画布/统计/hover 全都只认这一个**。
   *
   * 为什么不把编辑直接写回 pattern：pattern 是引擎结果，换参数重算时要
   * 能整体替换；覆盖层独立存着，重算后同一套格子下标还能继续套用。
   *
   * `editCount > 0` 才克隆：没编辑时直接返回原引用，surface 缓存命中，
   * 不会白重建一张 320×292 的位图。
   */
  const displayPattern = useMemo<PatternResult | null>(() => {
    if (!pattern) return pattern;
    if (!editEnabled || !brand) return pattern;
    if (editCount(edits) === 0) return pattern;
    return applyEdits(pattern, edits, brand);
  }, [pattern, edits, brand, editEnabled]);

  /**
   * 手改格子的位图（每格 1 字节），供 drawPattern 画金色三角。
   *
   * 用 Uint8Array 而不是 Set<number>：drawPattern 里要对可视区每一格做
   * 一次查表，Set.has 在 30 万格/帧的量级下比数组下标慢一个数量级。
   */
  const editMarks = useMemo<Uint8Array | null>(() => {
    if (!pattern || !editEnabled) return null;
    const keys = Object.keys(edits);
    if (keys.length === 0) return null;
    const marks = new Uint8Array(pattern.cells.length);
    for (const key of keys) {
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i < marks.length) marks[i] = 1;
    }
    return marks;
  }, [pattern, edits, editEnabled]);

  const [editTool, setEditToolState] = useState<EditTool>(initialTool ?? 'pencil');
  const [currentCode, setCurrentCodeState] = useState<string>('');
  /*
   * 笔宽 1–4（格）。默认 1 = 单格，和原来的手绘完全一致 —— 老用户升级
   * 版本后手感不该变。想铺大色块自己调粗。
   *
   * ref 同步：指针处理器是 useCallback 缓存的，直接读 state 会拿到旧值
   * （处理器不会为笔宽变化重建）。ref 每次渲染同步。
   */
  /**
   * 最近真正用过的色号（倒序，最多 18 个）。
   *
   * 色卡里那个「常用」组的数据源。**只在 commitDeltas 里更新** —— 也就是说
   * 只有真的落笔画了东西才算"用过"。
   *
   * 为什么不能用 currentCode 当数据源：进编辑模式时系统会自动选中"图案里
   * 用得最多的那个色"作为起手色（见 PatternCanvas 里那个默认画笔 effect），
   * 用户还没动手，「常用」组里就已经躺着一个色 —— 他会以为是自己之前用过
   * 的，信任感就没了。取色器选中、色卡点选这两个也是"用户动作"，但它们
   * 都不等于"用这个色画过"，所以同样不算。
   *
   * 数据从 delta 里取而不是从 currentCodeRef 取：`delta.after` 就是这一笔
   * 真正写进格子的色号，橡皮的 `after` 是空串（会被过滤掉），油漆桶的
   * 也是同一个值 —— 全都准确。
   */
  const [recentCodes, setRecentCodes] = useState<string[]>([]);

  const [brushWidth, setBrushWidthState] = useState<number>(MIN_BRUSH_WIDTH);
  const brushWidthRef = useRef(brushWidth);
  brushWidthRef.current = brushWidth;
  // 事件回调里要读最新工具/色号，但不能让它们进依赖数组（否则每换一次色就重建指针处理器）
  const editToolRef = useRef<EditTool>(editTool);
  editToolRef.current = editTool;
  const currentCodeRef = useRef(currentCode);
  currentCodeRef.current = currentCode;

  /*
   * 撤销/重做栈存的是 **delta**（改了哪些格、改之前是什么、改之后是什么），
   * 不是整份 EditMap 快照 —— 一张 320 格图纸改 500 格时，快照会占几十 MB。
   */
  /*
   * 刷区域的"隐式应用"也要能撤销（lead 明确要求）。
   *
   * 但刷子和编辑是两个不同的数据层：刷子改的是 `brushes`（引擎重算的输入），
   * 编辑改的是 `edits`（格子覆盖层）。撤销栈如果只认 delta，就撤不掉
   * brushes 的变化。所以这里额外记一份"刷子快照"，让 Ctrl+Z 在两类操作
   * 之间按时间顺序回退 —— 用户不关心底层是哪个层，他只知道"刚才那一下"。
   */
  type BrushUndoEntry = { kind: 'brushes'; before: DetailBrush[]; after: DetailBrush[] };
  type EditUndoEntry = { kind: 'edits'; delta: EditDelta };
  const undoLogRef = useRef<(BrushUndoEntry | EditUndoEntry)[]>([]);
  const redoLogRef = useRef<(BrushUndoEntry | EditUndoEntry)[]>([]);
  /** 栈状态用计数器推进渲染（栈本身在 ref 里，避免每次 push 都整棵重渲染） */
  const [historyTick, setHistoryTick] = useState(0);
  const bumpHistory = useCallback(() => setHistoryTick((t) => t + 1), []);

  /** 把一笔记入撤销栈（同时清空重做栈：新的分支开始了） */
  const pushUndo = useCallback(
    (entry: BrushUndoEntry | EditUndoEntry) => {
      const log = undoLogRef.current;
      log.push(entry);
      if (log.length > MAX_EDIT_HISTORY) log.shift();
      redoLogRef.current = [];
      bumpHistory();
    },
    [bumpHistory],
  );

  /** 提交一批编辑 delta（一次油漆桶 / 一笔涂色 = 一条或多条 delta，原子撤销） */
  const commitDeltas = useCallback(
    (deltas: EditDelta[]) => {
      if (!onEditsChange || deltas.length === 0) return;
      let next = editsRef.current;
      for (const d of deltas) next = applyDelta(next, d);
      // 多条 delta 合成一条历史项，撤销时一起退掉
      const merged: EditDelta =
        deltas.length === 1
          ? deltas[0]
          : {
              cells: deltas.flatMap((d) => d.cells),
              before: deltas.flatMap((d) => d.before),
              after: deltas.flatMap((d) => d.after),
            };
      editsRef.current = next;
      pushUndo({ kind: 'edits', delta: merged });
      onEditsChange(next, deltas);
      /*
       * 记「常用」：这一笔真正写了哪些色号。
       *
       * 按"最后写的在前"排序 —— merged.after 是按笔画顺序排列的，一笔多色
       * （拖动中换了色理论上不会发生，但油漆桶之后接着手绘会）取第一个即可
       * 覆盖绝大多数情况；去重后最多留 18 个。
       */
      const painted: string[] = [];
      for (const code of merged.after) {
        if (code && !painted.includes(code)) painted.push(code);
      }
      if (painted.length > 0) {
        setRecentCodes((prev) => {
          const mergedCodes = [...painted, ...prev.filter((c) => !painted.includes(c))];
          const next = mergedCodes.slice(0, 18);
          /*
           * 内容相同时返回原数组，避免无意义的重渲染 —— 这个回调在每一笔
           * 结束时都会跑，拖动时可能一秒十几次。
           */
          if (next.length === prev.length && next.every((c, i) => c === prev[i])) return prev;
          return next;
        });
      }
    },
    [onEditsChange, pushUndo],
  );

  const setCurrentCode = useCallback(
    (code: string) => {
      setCurrentCodeState(code);
      onCurrentCodeChange?.(code);
    },
    [onCurrentCodeChange],
  );

  // ---- 偏好恢复（挂载后一次） ----
  useEffect(() => {
    const z = Number(readPref(PREF_KEYS.zoom));
    if (Number.isFinite(z) && z > 0) {
      const v = clampZoom(z);
      zoomRef.current = v;
      setZoomState(v);
    }
    setShowCodesState(readBoolPref(PREF_KEYS.codes, true));
    setShowGridState(readBoolPref(PREF_KEYS.grid, true));
    setShowRulersState(readBoolPref(PREF_KEYS.rulers, true));
    setShowRegionOverlayState(readBoolPref(PREF_KEYS.regionOverlay, true));
  }, []);

  // ---- 设置器（同时持久化） ----
  const setZoom = useCallback((next: number) => {
    const v = clampZoom(next);
    zoomRef.current = v;
    setZoomState(v);
    writePref(PREF_KEYS.zoom, String(v));
  }, []);

  const setShowCodes = useCallback((next: boolean | ((p: boolean) => boolean)) => {
    setShowCodesState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      writePref(PREF_KEYS.codes, v ? '1' : '0');
      return v;
    });
  }, []);
  const setShowGrid = useCallback((next: boolean | ((p: boolean) => boolean)) => {
    setShowGridState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      writePref(PREF_KEYS.grid, v ? '1' : '0');
      return v;
    });
  }, []);
  const setShowRulers = useCallback((next: boolean | ((p: boolean) => boolean)) => {
    setShowRulersState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      writePref(PREF_KEYS.rulers, v ? '1' : '0');
      return v;
    });
  }, []);

  const setShowRegionOverlay = useCallback((next: boolean | ((p: boolean) => boolean)) => {
    setShowRegionOverlayState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      writePref(PREF_KEYS.regionOverlay, v ? '1' : '0');
      return v;
    });
  }, []);

  const setBrushRadius = useCallback((next: number) => {
    const v = Math.min(BRUSH_RADIUS_MAX, Math.max(BRUSH_RADIUS_MIN, next));
    brushRadiusRef.current = v;
    setBrushRadiusState(v);
  }, []);

  const setBrushAlgorithm = useCallback((next: DetailAlgorithm) => {
    brushAlgorithmRef.current = next;
    setBrushAlgorithmState(next);
  }, []);

  const setBrushMode = useCallback(
    (next: boolean | ((p: boolean) => boolean)) => {
      setBrushModeState((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        brushModeRef.current = v;
        /*
         * 进刷子模式时自动打开「区域标记」，退出时**保留用户的选择**。
         *
         * 为什么进来自动开：刷子模式的整个心智就是"看哪些地方会被重算"，
         * 标记关着的时候用户刷完看不出区别（尤其重算结果本身很接近）。
         * 为什么退出不复原：用户可能特意关掉它（不想让标记盖住图案），
         * 退出时硬切回打开等于把他的选择丢了 —— 下次进来又会"自己变回来"。
         * 开关本身现在常驻主工具条，任何时候都能手动关（见 PatternCanvas）。
         */
        if (v) setShowRegionOverlayState(true);
        if (!v) {
          setBrushCursor(null);
          // 切出刷子模式时清掉实时层：否则那张半成品遮罩会一直挂着，
          // 变成一层没有对应的"幽灵选区"
          strokeRef.current = null;
          resetLive();
        }
        return v;
      });
    },
    [resetLive],
  );

  const setBrushWidth = useCallback(
    (w: number | ((prev: number) => number)) => {
      setBrushWidthState((prev) =>
        clampBrushWidth(typeof w === 'function' ? w(prev) : w),
      );
    },
    [],
  );

  const setEditTool = useCallback(
    (t: EditTool) => {
      setEditToolState(t);
      // 切工具时退出刷区域模式：两套拖动语义会打架（一个改格子、一个改选区）
      if (brushModeRef.current) setBrushMode(false);
    },
    [setBrushMode],
  );


  // ---- 容器尺寸（宽定 cellPx，高只用于判定 fill 是否成立） ----
  useEffect(() => {
    if (!hasPattern) return;
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width > 0) setHostWidth(Math.round(rect.width));
      // offsetHeight 而非 rect.height：host 在 fill 模式下高度由 flex 决定，
      // 用布局高度才能在内容把容器撑高时拿到真实值
      setHostHeight(Math.round(host.clientHeight || rect.height));
      const vp = scrollRef.current;
      if (vp) {
        setViewportW(Math.round(vp.clientWidth));
        setViewportH(Math.round(vp.clientHeight));
      }
      /*
       * 容器尺寸变化也会改变"可视区"，而 computeView() 读的是 DOM 矩形。
       * 只靠 metrics 变化来驱动重绘不够：分栏断点切换、拖动窗口这些场景
       * 里 cellPx 可能算出同一个值（宽度刚好卡在两档之间），但可视区变了，
       * 视口裁剪就会按旧范围画、边缘漏白。这里显式再推一次。
       */
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        setScrollTick((t) => t + 1);
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, [hasPattern]);

  // ---- devicePixelRatio（含跨屏拖动的 dppx 变化） ----
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setDpr(window.devicePixelRatio || 1);
    update();
    window.addEventListener('resize', update);
    let mq: MediaQueryList | null = null;
    const onDppx = () => {
      update();
      mq?.removeEventListener('change', onDppx);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDppx);
    };
    onDppx();
    return () => {
      window.removeEventListener('resize', update);
      mq?.removeEventListener('change', onDppx);
    };
  }, []);

  // ---- 主题变化 / 字体加载完成后重绘 ----
  useEffect(() => {
    const bump = () => setThemeTick((t) => t + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    document.fonts?.ready.then(bump).catch(() => {});
    return () => mo.disconnect();
  }, []);

  // ---- 每格尺寸 ----
  /**
   * 100% 时的格子大小。
   *
   * fill 模式下**优先**同时受宽度和高度约束：只按宽度算的话，64×54 的图在
   * 1440 宽的中栏里每格约 18px，图高 972px，而可视区只有 566px ——
   * 打开就要滚动才能看全，工作台上"一眼看到整张图"的意义就没了。
   * 所以高度也参与取小值，让整张图刚好铺满可视区（用户仍可放大看细节，
   * 那时才出现滚动条，是符合预期的）。
   *
   * 但高度约束只在**还能给出可读格子**时生效（MIN_READABLE_CELL）：手机
   * 竖屏 64 行的图按高度只能给出 2px/格，夹到地板值 4px 之后画布远窄于
   * 容器、格子却仍然看不清，等于把宽度白白扔掉还照样要滚。这种情况下
   * 让宽度说了算，滚动由容器承担。
   *
   * 高度约束只在 useFill 成立、且 hostHeight 是有效值时启用：非 fill 模式
   * 高度本来就由内容决定，拿它算会形成反馈环。
   */
  /*
   * 编辑态：宽度优先，让画板吃满可用面积。
   *
   * 和上面的默认策略是**两种用途**，所以分开算：
   *  - 非编辑（看图纸）：宽高取小值，一打开就能看全整张图；
   *  - 编辑（下笔）：格子要够大好点，画板要占主要面积。竖长的图按高度
   *    算会把格子压到 10px 而横向空掉一半，用户原话就是冲着这个来的
   *    （"应该是画板占主要的面板"）。
   *
   * 编辑态仍然不是无脑按宽度：给一个"别高到离谱"的松上限（
   * EDIT_TALL_FACTOR × 可视高度）。超过就按高度收 —— 否则 300×60 的
   * 横幅图会算出 3000px 高的画布，用户得滚一整屏才看得到底边。
   * 方形图上这个上限永远不会生效，格子直接按宽度铺满，画布自然 1:1。
   */
  /*
   * 画布外那一圈留白到底多宽。
   *
   * 窄屏用 8px、桌面用 20px（理由见 CANVAS_GUTTER_NARROW 的注释）。
   * 这个值同时被 cellPx（算可用宽高）和 PatternCanvas（给内容块加 padding）
   * 用，所以统一在这里算、通过返回值传给渲染层 —— 两边各算一份的话，
   * padding 只要比扣掉的宽一点，内容就会横向溢出。
   */
  const canvasGutter =
    viewportW > 0 && viewportW < NARROW_VIEWPORT ? CANVAS_GUTTER_NARROW : CANVAS_GUTTER;

  const cellPx = useMemo(() => {
    if (!pattern) return 16;
    const rulerX = showRulers ? RULER_LEFT : 0;
    // 有滚动容器的实测宽度就优先用它（减掉边框），否则退回 hostWidth
    const baseW = viewportW > 0 ? viewportW - FRAME_BORDER : (hostWidth || 640) - FRAME_PAD;
    // 两侧各留一圈留白（见 CANVAS_GUTTER 注释：给边缘格留落点，别贴着边框）
    const availW = Math.max(
      120,
      baseW - rulerX - SCROLLBAR_ALLOWANCE - canvasGutter * 2,
    );
    const fitW = Math.floor(availW / Math.max(1, pattern.cols));

    let fit = fitW;
    if (editing) {
      /*
       * 编辑态：**宽度优先**，画板吃满可用宽度。
       *
       * 默认策略（下面那段）是"宽高取小值、整图可见"，那对看图是对的，对
       * 下笔是错的：64×54 的图在 1000px 宽的中栏里按高度只能给 12px/格、
       * 画布 768 宽 —— 横向空掉 240px，格子还小。用户原话就是冲这个来的
       * （"应该是画板占主要的面板"）。
       *
       * 唯一的守门是"别把画布拉到一屏半以上"：很竖的图（比如 20×200）按
       * 宽度算出 48px/格就是 9600px 高，那不叫占主要面积，叫没法用。
       * 所以 fit 与 fitH × EDIT_TALL_FACTOR 取小 —— 方形图和常见的
       * 4:3、3:4 作品都碰不到这条线，只有极端长条才会被高度收回来。
       *
       * 窄屏（< NARROW_VIEWPORT，如 390 宽手机）不需要特别处理：那里
       * 宽度本身就是最紧的约束，fitW 算出来就是"整图铺满宽度"，与默认
       * 策略同解，所以不加分支也不会把移动端改坏。
       */
      if (useFill && viewportH > 0) {
        const rulerY = showRulers ? RULER_TOP : 0;
        // 上下各留 CANVAS_GUTTER（编辑态要能滚到图以外的空白再落笔）
        const availH = Math.max(
          80,
          viewportH - FRAME_BORDER - rulerY - canvasGutter * 2,
        );
        const fitH = Math.floor(availH / Math.max(1, pattern.rows));
        const tallCap = Math.floor(fitH * EDIT_TALL_FACTOR);
        if (fit > tallCap) fit = tallCap;
      }
      /*
       * 下限仍是 MIN_FIT_CELL，**不是** MIN_EDIT_CELL：地板值一抬就会超过
       * 宽度容纳的上限（实测 1280 宽 + 色板竖栏时 64 列只算得出 10px/格，
       * 抬到 12 就变成 768px 画布、横向溢出容器）。格子的"好不好点"由
       * 缩放解决，不由地板值解决。
       */
      const baseEdit = Math.max(MIN_FIT_CELL, Math.min(MAX_FIT_CELL, fit));
      return Math.max(2, Math.round(baseEdit * zoom));
    }

    if (useFill && viewportH > 0) {
      const rulerY = showRulers ? RULER_TOP : 0;
      // 横向滚动条只有在真的溢出时才占位，先按不出现算，留 1 格余量即可
      // 上下各留 CANVAS_GUTTER，与编辑态同一套留白，避免进出编辑时格子跳变
      const availH = Math.max(
        80,
        viewportH - FRAME_BORDER - rulerY - canvasGutter * 2,
      );
      const fitH = Math.floor(availH / Math.max(1, pattern.rows));
      /*
       * 高度约束只在**它还给出可读格子**时才在窄屏采用。
       *
       * 桌面端（含矮窗口）一律保留"整图铺满"：桌面没有"本来就在滚"这回事，
       * 一打开就能看全整张图是默认值里最有用的那个，即使格子小到 4–5px
       * 也仍然是可读的整体轮廓，而且用户一放大就能看细节。
       *
       * 窄屏上这条交易就不成立了：手机上本来就在滚，而 4px 的格子连标尺
       * 数字和色号都糊成一团 —— 既没换来"不用滚"，又把宽度白白扔掉
       * （390 宽下 52 列的图只画到 208px，容器却有 338px）。
       */
      const keepHeightConstraint = viewportW >= NARROW_VIEWPORT || fitH >= MIN_READABLE_CELL;
      if (keepHeightConstraint) fit = Math.min(fitW, fitH);
    }

    const base = Math.max(MIN_FIT_CELL, Math.min(MAX_FIT_CELL, fit));
    return Math.max(2, Math.round(base * zoom));
  }, [
    pattern,
    hostWidth,
    viewportW,
    viewportH,
    showRulers,
    zoom,
    useFill,
    editing,
    canvasGutter,
  ]);

  const metrics = useMemo<CanvasMetrics | null>(() => {
    if (!hasPattern || !pattern) return null;
    return computeMetrics(pattern.cols, pattern.rows, cellPx, dpr);
  }, [hasPattern, pattern, cellPx, dpr]);

  /**
   * 区域场：直接复用引擎的 buildRegionField 解算。
   *
   * 关键点 —— 画布上画的遮罩和引擎算出来的参数场是**同一份数据**，
   * 所以用户看到的渐变就是重算时真正生效的渐变。若这里自己用高斯模糊
   * 画个好看的圆，等重算出来是另一条曲线，那个"所见即所得"就断了。
   */
  const regionField = useMemo<RegionField | null>(() => {
    if (!pattern || !brushes || brushes.length === 0) return null;
    const base = getDetailProfile(pattern.meta?.detail);
    return buildRegionField(pattern.cols, pattern.rows, brushes, base, regionFeather);
  }, [pattern, brushes, regionFeather]);

  /** 待应用草稿对应的参数场：只用来画蓝色遮罩，绝不喂给引擎 */
  const pendingField = useMemo<RegionField | null>(() => {
    if (!pattern || pendingPoints.length === 0) return null;
    const base = getDetailProfile(pattern.meta?.detail);
    return buildRegionField(pattern.cols, pattern.rows, pendingPoints, base, regionFeather);
  }, [pattern, pendingPoints, regionFeather]);

  /**
   * 覆盖率一律按**格数**估算，用圆面积累加。
   *
   * 不用 regionCoverage(field)：那是引擎按 smoothstep 权重求和再除以总格数，
   * 权重在羽化带里衰减到 0，大笔刷重叠时数字也上不去，跟用户"我刷了一片"
   * 的直觉对不上。这里直接 π r²（r 换算成格）× 笔次，再按总格数归一，
   * 多笔重叠会超过 100%，所以最后 clamp —— 宁可显示 100% 也不能出现 137%。
   */
  /**
   * 估算一组笔刷覆盖了图案的百分之多少。
   *
   * 不能用"Σ 圆面积 ÷ 总格数"：拖动时插值出来的几十个点间距远小于笔刷
   * 半径，圆与圆大幅重叠，面积一相加就爆表（实测一笔拖动算出 70%，
   * 而实际只盖住中间一条带）。这里改成**按格求并集**：把每个笔刷的包围盒
   * 扫一遍，命中圆心距 ≤ 半径的格子打标记，最后数标记数。
   *
   * 顺带得到两个好处：① 天然不会超过 100%，不用再 clamp；
   * ② 数字和用户眼睛看到的蓝色选区面积一致，不会"我明明只刷了一条，怎么
   * 显示 70%"。
   */
  const estimateCoverage = useCallback(
    (strokes: DetailBrush[] | undefined): number => {
      if (!pattern || !strokes || strokes.length === 0) return 0;
      const { cols, rows } = pattern;
      const totalCells = cols * rows;
      if (totalCells <= 0) return 0;
      const longest = Math.max(cols, rows);
      const hits = new Uint8Array(totalCells);
      let covered = 0;

      for (const b of strokes) {
        const rCells = Math.max(0.6, b.radius * longest);
        /*
         * 用 reach（核心 + 羽化带）而不是只有核心半径。
         *
         * 引擎真正会重算的是 reach 这么大一块，遮罩也是画到 reach 的（权重
         * 衰减到 0.02 处）。如果这里只数核心圆，就会出现"显示覆盖 17%、
         * 蓝色却盖了小半张图"的自相矛盾 —— 用户会怀疑数字是假的。
         * bandCells 必须和 buildRegionField 内部用同一个公式。
         */
        const bandCells = Math.min(
          rCells,
          Math.max(1.2, rCells * Math.max(0.12, regionFeather)),
        );
        const reach = rCells + bandCells;
        const cx = b.x * cols;
        const cy = b.y * rows;
        const r2 = reach * reach;
        // 只扫圆的包围盒，别为每支笔都遍历整张图
        const c0 = Math.max(0, Math.floor(cx - reach));
        const c1 = Math.min(cols - 1, Math.ceil(cx + reach));
        const r0 = Math.max(0, Math.floor(cy - reach));
        const r1 = Math.min(rows - 1, Math.ceil(cy + reach));
        for (let r = r0; r <= r1; r++) {
          const dy = r + 0.5 - cy;
          for (let c = c0; c <= c1; c++) {
            const dx = c + 0.5 - cx;
            if (dx * dx + dy * dy > r2) continue;
            const i = r * cols + c;
            if (hits[i]) continue;
            hits[i] = 1;
            covered++;
          }
        }
      }
      return covered / totalCells;
    },
    [pattern, regionFeather],
  );

  /**
   * 已应用的"几处" = 重新聚出来的笔数。
   *
   * brushes 是扁平的点数组（一次拖动插值成十几个点），直接数 length 会
   * 显示"已应用 13 处"而用户只画了一笔。见 clusterBrushes 的注释。
   */
  const appliedGroups = useMemo(
    () =>
      pattern && brushes?.length
        ? clusterBrushes(brushes, pattern.cols, pattern.rows)
        : ([] as DetailBrush[][]),
    [brushes, pattern],
  );
  const appliedCount = appliedGroups.length;
  /** 草稿是按笔分组存的，"几处"直接数分组 */
  /**
   * 草稿的"几处" = **连通块数**，不是笔数。
   *
   * 用户连着拖三笔把一片刷满，他心里是"一块区域"；如果报"3 处"，
   * 读数和他眼睛看到的就对不上了。4 邻域 BFS 在 pendingField.w 上跑，
   * 依赖是 pendingField（useMemo），所以只在草稿变化时算一次，
   * 绝不进渲染循环。
   */
  const pendingRegions = useMemo(() => {
    if (!pattern || !pendingField?.active) return 0;
    const { cols, rows } = pattern;
    const w = pendingField.w;
    const seen = new Uint8Array(cols * rows);
    const stack: number[] = [];
    let count = 0;
    for (let i = 0; i < w.length; i++) {
      if (seen[i] || w[i] <= 0.02) continue;
      count++;
      seen[i] = 1;
      stack.push(i);
      while (stack.length > 0) {
        const j = stack.pop() as number;
        const r = (j / cols) | 0;
        const c = j % cols;
        if (r > 0 && !seen[j - cols] && w[j - cols] > 0.02) {
          seen[j - cols] = 1;
          stack.push(j - cols);
        }
        if (r < rows - 1 && !seen[j + cols] && w[j + cols] > 0.02) {
          seen[j + cols] = 1;
          stack.push(j + cols);
        }
        if (c > 0 && !seen[j - 1] && w[j - 1] > 0.02) {
          seen[j - 1] = 1;
          stack.push(j - 1);
        }
        if (c < cols - 1 && !seen[j + 1] && w[j + 1] > 0.02) {
          seen[j + 1] = 1;
          stack.push(j + 1);
        }
      }
    }
    return count;
  }, [pendingField, pattern]);

  /** 笔数仍要保留：撤销是按"一笔"操作的 */
  const pendingCount = pendingRegions;

  const appliedCoverage = useMemo(() => estimateCoverage(brushes), [estimateCoverage, brushes]);
  /**
   * 草稿覆盖率 = pending ∪ 正在拖的这一笔，按**格数**数。
   *
   * 用权重图而不是圆的面积（applied 那边还在用面积法）：拖动中每一笔都
   * 是密集重叠的点，面积法会把同几格数十几遍，数字一路飙到 100% 而图上
   * 只有一条带。权重图天然去重，数字和图面一致。
   */
  const pendingCoverage = useMemo(() => {
    if (!pattern) return 0;
    // liveTick 只用于"拖动推进时重算"：权重图是 ref，本身不触发渲染，
    // 靠这个计数器把新值推出来。这里显式读一下，让依赖关系成立。
    if (liveTick < 0) return 0;
    const total = pattern.cols * pattern.rows;
    if (total <= 0) return 0;
    const pw = pendingField?.active ? pendingField.w : null;
    const lw = liveRef.current;
    if (!pw && !lw) return 0;
    let n = 0;
    for (let i = 0; i < total; i++) {
      const a = pw ? pw[i] : 0;
      const b = lw ? lw[i] : 0;
      if (a > 0.02 || b > 0.02) n++;
    }
    return n / total;
  }, [pattern, pendingField, liveTick]);

  /**
   * 已应用的摘要。
   *
   * count 用 brushes.length 而不是"几个圈"：一个圈在插值后会展开成很多个点，
   * 用户眼里"我刷了 1 处"，所以这里按**笔数**统计（stroke 数），不是点数。
   */
  const regionSummary = useMemo(() => {
    if (!regionField || !regionField.active) {
      return {
        active: false,
        count: 0,
        coverage: 0,
        algorithms: [] as DetailAlgorithm[],
        appliedCount,
        pendingCount,
        appliedCoverage,
        pendingCoverage,
      };
    }
    return {
      active: true,
      count: brushes?.length ?? 0,
      coverage: appliedCoverage,
      algorithms: regionAlgorithms(regionField),
      appliedCount,
      pendingCount,
      appliedCoverage,
      pendingCoverage,
    };
  }, [
    regionField,
    brushes,
    appliedCount,
    pendingCount,
    appliedCoverage,
    pendingCoverage,
  ]);

  // ---- 缩放：以光标为锚点 ----
  const zoomAt = useCallback(
    (next: number, anchor?: { clientX: number; clientY: number }) => {
      const scroll = scrollRef.current;
      const canvas = canvasRef.current;
      if (scroll && canvas) {
        const sRect = scroll.getBoundingClientRect();
        const a =
          anchor ?? {
            clientX: sRect.left + sRect.width / 2,
            clientY: sRect.top + sRect.height / 2,
          };
        const cRect = canvas.getBoundingClientRect();
        if (cRect.width > 0 && cRect.height > 0) {
          anchorRef.current = {
            fx: (a.clientX - cRect.left) / cRect.width,
            fy: (a.clientY - cRect.top) / cRect.height,
            vx: a.clientX - sRect.left,
            vy: a.clientY - sRect.top,
            active: true,
          };
        }
      }
      setZoom(next);
    },
    [setZoom],
  );

  const zoomIn = useCallback(() => zoomAt(zoomRef.current + ZOOM_STEP), [zoomAt]);
  const zoomOut = useCallback(() => zoomAt(zoomRef.current - ZOOM_STEP), [zoomAt]);
  const resetZoom = useCallback(() => zoomAt(1), [zoomAt]);

  // 缩放后把光标下的那一格固定在原处（缩放前记录的锚点，布局更新后应用）
  const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
  useIsoLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor.active) return;
    anchor.active = false;
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    if (!scroll || !canvas || !metrics) return;
    const sRect = scroll.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    const offX = cRect.left - sRect.left + scroll.scrollLeft;
    const offY = cRect.top - sRect.top + scroll.scrollTop;
    scroll.scrollLeft = offX + anchor.fx * cRect.width - anchor.vx;
    scroll.scrollTop = offY + anchor.fy * cRect.height - anchor.vy;
  }, [zoom, metrics, showRulers]);

  // ---- 滚轮缩放（只作用于画布表面；React 的 onWheel 是被动的，必须原生监听） ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-canvas-surface]')) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0016);
      zoomAt(zoomRef.current * factor, { clientX: e.clientX, clientY: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // hasPattern：空状态时滚动容器还没挂载，图案出现后必须重新绑定
  }, [zoomAt, hasPattern]);

  // ---- 指针悬停 ----
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (brushModeRef.current) return; // 刷子模式不再弹色号 tooltip
      const canvas = canvasRef.current;
      if (!canvas || !pattern) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const px = e.clientX;
      const py = e.clientY;
      lastPointerRef.current = { x: px, y: py };
      const col = Math.floor(((px - rect.left) / rect.width) * pattern.cols);
      const row = Math.floor(((py - rect.top) / rect.height) * pattern.rows);
      if (row < 0 || col < 0 || row >= pattern.rows || col >= pattern.cols) {
        setHover((prev) => (prev ? null : prev));
        return;
      }
      setHover((prev) =>
        prev && prev.row === row && prev.col === col && prev.x === px && prev.y === py
          ? prev
          : { row, col, x: px, y: py },
      );
    },
    [pattern],
  );

  const onPointerLeave = useCallback(() => {
    setHover(null);
    setBrushCursor(null);
    /*
     * 指针离开画布也要清实时层。
     *
     * 但只在「这一笔已经断了」时清：正常拖动拖出画布外再拖回来，
     * strokeRef 还在（pointer capture 让事件继续送来），此时清掉会让
     * 遮罩闪一下。真正该清的是"没按下却残留"的情况。
     */
    if (!strokeRef.current) resetLive();
  }, [resetLive]);

  // ---- 刷区域：Pointer Events（鼠标 / 触屏 / 手写笔同一套） ----

  /** 视口坐标 → 归一化图案坐标（0..1）。超出画布时夹紧，避免刷到界外产生无效笔刷 */
  const toPatternSpace = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
        inside:
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom,
      };
    },
    [],
  );

  /**
   * 把一笔落成点序列。
   *
   * 两个间距参数针对不同问题：
   *  - 插值间距 radius*0.35：快速拖动时两次 pointermove 可能隔了半张图，
   *    不插值就会刷成一串断开的圆点；
   *  - 抽稀间距 radius*0.25：慢慢拖会生成大量几乎重合的点，
   *    对渲染没有任何贡献，只会让 brushes 数组膨胀。
   * 两个阈值合起来就是"只保留必要点"。上限 60 支，超出从头丢。
   */
  /**
   * 把一次指针移动插值成一串笔刷点，追加到 stroke。
   *
   * fromX/fromY 用于"拖出画布再拖回来"：那时 stroke 的最后一个点在画布
   * 边界附近，而新位置在很远的地方，直接连线会横穿整个图案。传入上一次
   * **仍在画布内**的位置作为起点，就能只补画用户实际划过的这一段。
   */
  const stampStroke = useCallback(
    (
      stroke: DetailBrush[],
      x: number,
      y: number,
      radius: number,
      algo: DetailAlgorithm,
      fromX?: number,
      fromY?: number,
      discontinuous?: boolean,
    ) => {
      const step = Math.max(0.004, radius * 0.35);
      const dedupe = radius * 0.25;
      const last = stroke[stroke.length - 1];
      /*
       * 起笔的第一个点、以及"拖出画布再拖回画布"后的第一个点，都必须无条件
       * 入栈：它们与上一个点之间没有需要补画的路径（中间那段根本不在画布上），
       * 硬插值会横穿整个图案画出一条假线。
       */
      if (last && !discontinuous) {
        const ox = fromX ?? last.x;
        const oy = fromY ?? last.y;
        const dx = x - ox;
        const dy = y - oy;
        const dist = Math.hypot(dx, dy);
        // 抽稀：移动距离小于半径 1/4 的中间点丢掉（连续 pointermove 常常是同一点）
        if (dist < dedupe) return;
        // 沿路径补齐中间点
        if (dist > step) {
          const n = Math.min(64, Math.floor(dist / step));
          for (let i = 1; i < n; i++) {
            const t = i / n;
            stroke.push({
              x: ox + dx * t,
              y: oy + dy * t,
              radius,
              algorithm: algo,
            });
          }
        }
      }
      stroke.push({ x, y, radius, algorithm: algo });
      if (stroke.length > MAX_BRUSHES) stroke.splice(0, stroke.length - MAX_BRUSHES);
    },
    [],
  );

  /**
   * 抬手：把这一笔并入**草稿**，不触发任何重算。
   *
   * 这是两步式的关键差异。旧版这里直接 onBrushesChange，父组件立刻 debounce
   * 全图重算，拖动中途图案一直在变，"只能单点"的体感就是这么来的。
   */
  const commitStroke = useCallback(() => {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    if (!stroke || stroke.length === 0) return;
    const next = [...pendingRef.current, stroke];
    // 上限按点数算，超了就整笔整笔地从最早处丢 —— 半笔被砍掉会在图上
    // 留下一段"凭空消失"的选区，用户会以为笔刷掉帧了
    let total = next.reduce((sum, s2) => sum + s2.length, 0);
    let from = 0;
    while (total > MAX_BRUSHES && from < next.length - 1) {
      total -= next[from].length;
      from++;
    }
    setPendingStrokes(from > 0 ? next.slice(from) : next);
  }, [setPendingStrokes]);

  /**
   * 拖动中的实时预览值。
   *
   * 抬手前 pendingStrokes 还是空的，工具条如果只看 pending 就会一直显示
   * "0 处 / 0%"，用户拖了半天没有任何数字变化 —— 和"按着没反应"是同一种
   * 体感。所以拖动期间改用实时层的格数来报数。
   */
  const livePreview = useMemo(() => {
    if (!pattern) return { active: false, cells: 0, percent: 0 };
    const lw = liveRef.current;
    if (!lw || liveTick === 0) {
      return { active: false, cells: 0, percent: 0 };
    }
    const total = pattern.cols * pattern.rows;
    let n = 0;
    for (let i = 0; i < lw.length; i++) if (lw[i] > 0.02) n++;
    return {
      active: n > 0,
      cells: n,
      percent: total > 0 ? Math.round((n / total) * 100) : 0,
    };
  }, [pattern, liveTick]);

  /** 草稿处的"几处 · 覆盖几%"文案，工具条主按钮和蓝色 tag 共用 */
  const pendingLabel = useMemo(
    () => ({
      count: pendingCount,
      coverage: pendingCoverage,
      percent: Math.round(pendingCoverage * 100),
    }),
    [pendingCount, pendingCoverage],
  );

  /**
   * 提交草稿：一次性把 pending 追加到已应用列表，然后清空草稿。
   *
   * 注意顺序 —— 先 onBrushesChange 再清 pending。父组件收到新数组后会
   * 走 180ms debounce 重算，图案稍后才更新；而 pending 立刻清空，主按钮
   * 马上回到 disabled，不会出现"点两次应用出双份"的窗口。
   */
  const applyPending = useCallback(() => {
    const groups = pendingRef.current;
    if (groups.length === 0) return;
    const flat = groups.flat();
    const before = brushesRef.current ?? [];
    const next = [...before, ...flat];
    const clipped = next.length > MAX_BRUSHES ? next.slice(next.length - MAX_BRUSHES) : next;
    brushesRef.current = clipped;
    /*
     * 记一笔历史。退出刷区域时草稿是**隐式应用**的（不弹确认），如果这次
     * 应用撤不掉，用户会觉得"我只是切了个开关，选区就没了"。
     */
    pushUndo({ kind: 'brushes', before, after: clipped });
    setPendingStrokes([]);
    onBrushesChange?.(clipped);
  }, [onBrushesChange, setPendingStrokes, pushUndo]);

  /** 取消选区：只丢草稿，已应用的一根汗毛都不动 */
  const cancelPending = useCallback(() => {
    if (pendingRef.current.length === 0) return;
    setPendingStrokes([]);
  }, [setPendingStrokes]);

  const onBrushPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!brushModeRef.current || !pattern) return;
      // 只接主键 / 触摸 / 笔尖，右键留给浏览器菜单
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const pos = toPatternSpace(e.clientX, e.clientY);
      if (!pos || !pos.inside) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const stroke: DetailBrush[] = [];
      strokeRef.current = stroke;
      lastInsideRef.current = { x: pos.x, y: pos.y };
      // 实时层：一按下就有反馈，不用等抬手
      const live = ensureLive(pattern.cols, pattern.rows);
      live.fill(0);
      liveBoxRef.current = null;
      liveStampedRef.current = 0;
      stampStroke(
        stroke,
        pos.x,
        pos.y,
        brushRadiusRef.current,
        brushAlgorithmRef.current,
      );
      for (const pt of stroke) {
        stampLive(live, pattern.cols, pattern.rows, pt, featherRef.current);
        growLiveBox(pt);
      }
      liveStampedRef.current = stroke.length;
      bumpLiveTick();
    },
    [pattern, stampStroke, toPatternSpace, ensureLive, bumpLiveTick, growLiveBox],
  );

  const onBrushPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!brushModeRef.current || !pattern) return;
      const pos = toPatternSpace(e.clientX, e.clientY);
      if (!pos) return;
      // 存归一化坐标而不是像素：缩放时圆环要跟着变，不能钉在旧尺寸上
      setBrushCursor({ x: pos.x, y: pos.y, r: brushRadiusRef.current });
      if (!strokeRef.current) return;

      /*
       * 指针拖到画布外时**不盖章**。
       *
       * strokeRef 因为 setPointerCapture 还在，事件会继续送进来；如果照常
       * 盖章，toPatternSpace 夹紧后的坐标会让笔一路"贴边刷" —— 实测拖出
       * 画布再拖回来，遮罩像素从 34 万暴涨到 121 万，用户只是想拖出去再
       * 拖回来，结果整条边都被刷满了。
       *
       * 但线要接上：记住最后一次在画布内的位置，指针回到画布内时从那里
       * 向新位置插值补齐，视觉上仍是连续的一笔（而不是断成两截）。
       */
      if (!pos.inside) {
        lastInsideRef.current = null;
        return;
      }
      // 上一个点不在画布内 → 这是"重新进入"，断开插值，直接落一个点
      const reentering = lastInsideRef.current === null;
      lastInsideRef.current = { x: pos.x, y: pos.y };

      const stroke = strokeRef.current;
      const before = stroke.length;
      stampStroke(
        stroke,
        pos.x,
        pos.y,
        brushRadiusRef.current,
        brushAlgorithmRef.current,
        undefined,
        undefined,
        reentering,
      );
      // 只盖这一笔新长出来的点（liveStampedRef 之前的已经盖过了）
      const live = ensureLive(pattern.cols, pattern.rows);
      const start = Math.min(liveStampedRef.current, before);
      for (let i = start; i < stroke.length; i++) {
        stampLive(live, pattern.cols, pattern.rows, stroke[i], featherRef.current);
        growLiveBox(stroke[i]);
      }
      liveStampedRef.current = stroke.length;
      bumpLiveTick();
    },
    [pattern, stampStroke, toPatternSpace, ensureLive, bumpLiveTick, growLiveBox],
  );

  const onBrushPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!brushModeRef.current) return;
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      commitStroke();
      // 抬手后 pending 遮罩接棒（带实线轮廓），实时层立刻退场，
      // 否则两张遮罩会叠在一起变成一条更深的带子
      resetLive();
    },
    [commitStroke, resetLive],
  );

  useEffect(() => {
    setHover(null);
  }, [pattern]);

  // ==========================================================================
  // 编辑：落点 / 绘制 / 油漆桶 / 取色器
  // ==========================================================================

  /** 正在拖的编辑笔（cellIndex 集合，抬手时一次性提交成一条 delta） */
  /*
   * 一条笔。
   *
   * `anchor` 是**笔心**最后落到的格子下标，拖动插值拿它当起点 —— 不能用
   * `cells[cells.length - 1]`：粗笔一次盖章会往 cells 里塞一整片格子，最后
   * 那个必然是笔头右下角而不是光标所在格。拿它当起点，下一段 Bresenham 就
   * 从一个偏移 (radius, radius) 的错误位置出发，笔画会越拖越歪、越拖越胖
   * （实测 w=8 时纵向厚度从 8 格涨到 20 格）。
   */
  const editStrokeRef = useRef<{ cells: number[]; after: string; anchor: number } | null>(
    null,
  );
  const [editCursor, setEditCursor] = useState<{ col: number; row: number } | null>(null);

  /**
   * 拖动中的**实时预览**（用户反馈「画笔画过去橡皮擦过去，不能实时的去预览」）。
   *
   * 为什么必须有这一层：`paintCell` 只把笔迹记进 `editStrokeRef`（ref 不触发
   * 渲染），真正的落图要等抬手时 `commitEditStroke` → `onEditsChange` →
   * 父组件 `setEdits` → `displayPattern` 换新引用 → 主画布重绘。所以整条拖动
   * 过程中画面**一格都不会变**，用户看到的是"笔划过去了但什么都没发生"，
   * 松手才一次性刷出来。
   *
   * 实测（Playwright，H07 黑色画 10 个点）：拖动中画布近黑像素 648 → 648
   * （零变化），松手后 648 → 1022。这就是这个 bug 的量化形态。
   *
   * 设计取舍：
   *   · **不改主画布 / surface 缓存**。走主画布就得每帧重建整张离屏位图
   *     （320 格 = 8.7 万格 putImageData），拖动会掉帧。预览画在 overlay 层
   *     （和 hover 环同一层），只画这一笔涉及的那几十个格子。
   *   · **不改 edits / 不写撤销栈**。预览是"将要发生"，不是"已经发生"；
   *     写进 edits 会让撤销栈里出现半条笔，且父组件的统计/图例会在拖动中途
   *     抖动。抬手后走的还是原来那条 commitDeltas 路径。
   *   · 用一个自增 tick 推重绘（和刷区域的 `liveTick` 同一套办法）——
   *     stroke 存在 ref 里，ref 变化不触发渲染。
   */
  const [editLiveTick, setEditLiveTick] = useState(0);

  /** 色号 → #RRGGBB。色卡每次最多 291 项，用 Map 缓存避免拖动时反复线性查找。 */
  const codeHexRef = useRef<{ brand: Brand | undefined; map: Map<string, string> }>({
    brand: undefined,
    map: new Map(),
  });
  const codeHex = useCallback((code: string): string | null => {
    if (!brand) return null;
    const cache = codeHexRef.current;
    if (cache.brand !== brand) {
      const map = new Map<string, string>();
      for (const bead of getBrandPalette(brand)) map.set(bead.code, bead.hex);
      codeHexRef.current = { brand, map };
    }
    return codeHexRef.current.map.get(code) ?? null;
  }, [brand]);

  /**
   * 视口坐标 → 格子下标（越界返回 null）。
   *
   * 必须用**画布的** getBoundingClientRect 反算，不能用整张图或滚动容器：
   * 画布本身可能被居中、被缩放，只有它自己的矩形才是"格子的坐标系"。
   */
  const cellAt = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas || !pattern) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
      const col = Math.min(pattern.cols - 1, Math.floor(fx * pattern.cols));
      const row = Math.min(pattern.rows - 1, Math.floor(fy * pattern.rows));
      return row * pattern.cols + col;
    },
    [pattern],
  );

  /**
   * 应用一次"编辑笔"到指定格子。
   *
   * `pencil` 把格子设成当前色号；`eraser` 设成 `''`（引擎约定的擦除值）。
   * 只记进 editStrokeRef，不立刻提交 —— 拖一次要合并成一条 delta，
   * 否则一次拖动会往撤销栈里塞几百条。
   */
  const paintCell = useCallback(
    (index: number, after: string) => {
      const stroke = editStrokeRef.current;
      if (!stroke || !pattern) return;
      if (stroke.after !== after) return;
      // 同一格在一条笔里只记一次（拖回来重复涂不该产生多条 before/after）
      if (stroke.cells.includes(index)) return;
      /*
       * 涂成它**本来就是**的颜色，不算一次编辑。
       *
       * 不做这层过滤的后果很具体：用户拿默认色（用量最大的那个）随手涂
       * 两笔，画面上什么都没变，却冒出 40 条"手改"，标签亮着、Ctrl+Z
       * 要按 40 下才能退出 —— 全是空操作。擦同样颜色的空白也一样。
       */
      if (pickCodeAt(pattern, editsRef.current, index) === after) return;
      stroke.cells.push(index);
      /*
       * 推一次重绘让预览跟上（用户反馈的"画过去看不到"就在这里）。
       *
       * 必须放在 push 之后：预览读的是 stroke.cells，先推 tick 再 push 会
       * 永远慢一格（尤其单点点击时这一格根本不会出现）。
       */
      setEditLiveTick((t) => t + 1);
    },
    [pattern],
  );

  /**
   * 一次落点（点击或拖动中的一点）。
   *
   * 取色器不写数据：读出该格当前色号、设为当前画笔色，然后**不产生 delta**。
   * 空白格用取色器时保持原色不变（不能把画笔设成"空"—— 那用户就没法画了）。
   */
  /**
   * 在一个格子上"盖章"：按当前笔宽把笔头形状盖上去。
   *
   * **落笔和拖动必须都走这里**。曾经拖动是直接 `paintCell(index)` 单格的，
   * 于是画出来的笔迹是「点一下是粗圆点，一拖就变回 1 格细线」——
   * 用户报的就是这个：「笔粗的时候，点击的一瞬间是粗的，但是拖动的时候
   * 留下的痕迹还是细的」。
   *
   * 拖动的插值（Bresenham）会逐格调用本函数，所以快速拖动时相邻两格各自
   * 盖一个圆盘、自然重叠，不会出现"珠子串"式的断续。
   */
  const stampBrush = useCallback(
    (index: number, after: string) => {
      if (!pattern) return;
      const width = brushWidthRef.current;
      if (width <= 1) {
        paintCell(index, after);
        return;
      }
      const cols = pattern.cols;
      const c0 = index % cols;
      const r0 = Math.floor(index / cols);
      const { lo, hi } = brushSpan(width);
      for (let dy = lo; dy <= hi; dy++) {
        for (let dx = lo; dx <= hi; dx++) {
          if (!brushContains(width, dx, dy)) continue;
          const c = c0 + dx;
          const r = r0 + dy;
          if (c < 0 || r < 0 || c >= cols || r >= pattern.rows) continue;
          paintCell(r * cols + c, after);
        }
      }
    },
    [pattern, paintCell],
  );

  const applyToolAt = useCallback(
    (index: number) => {
      if (!pattern || !editEnabled) return;
      const tool = editToolRef.current;
      const code = currentCodeRef.current;
      /*
       * 抓手不是"编辑"，不该产生任何 delta。
       *
       * 正常路径上 onEditPointerDown 已经在 pan 分支里 return 了、根本不会
       * 走到这里；但键盘快捷键（1–5 切工具）+ 落点事件是两条独立的路径，
       * 这一句是防"切到抓手后还有残留笔在落点"的兜底 —— 抓手唯一合法的
       * 副作用是移动视口。
       */
      if (tool === 'pan') return;

      if (tool === 'picker') {
        const picked = pickCodeAt(pattern, editsRef.current, index);
        if (picked) setCurrentCode(picked);
        return;
      }
      if (tool === 'fill') {
        const cells = floodFill(pattern, editsRef.current, index, code);
        if (cells.length === 0) return;
        commitDeltas([makeDelta(editsRef.current, cells, code)]);
        return;
      }
      /*
       * pencil / eraser：开始或继续一条笔。
       *
       * 橡皮的 `after` 就是空串（引擎约定的"擦除"值），**不能**像铅笔那样
       * 要求它非空 —— 早先写成 `if (!after) return` 直接让橡皮彻底失效。
       * 只有铅笔需要校验"当前有没有选色"。
       */
      if (tool === 'pencil' && !code) return;
      const after = tool === 'eraser' ? '' : code;
      const stroke = editStrokeRef.current;
      // 换工具时（比如擦到一半切回铅笔）不能混在一条笔里：after 不同就另起一条
      if (!stroke || stroke.after !== after) editStrokeRef.current = { cells: [], after, anchor: index };
      else stroke.anchor = index;
      /*
       * 粗笔：一次落点盖住一个小圆盘，而不是一格。
       *
       * 只在 thick 语义下生效（橡皮不跟着变粗 —— 保守起来，避免用户本想
       * 点掉一颗豆却抹掉一片）。半径 1 时 hypot 阈值取 1.35，四角被切掉，
       * 得到的是"3×3 去掉四个角"的十字块（5 格）。这个形状在斜边和细线上
       * 比实心方块自然得多：实心 3×3 画一条竖线会得到 3 格宽的柱子，
       * 而十字块画出来是带柔边的笔触。
       *
       * 走 paintCell 同一套流程，所以：
       *  - 一条笔内的格子去重、同色不算编辑、撤销栈粒度，全部自动一致
       *  - 拖动时 Bresenham 补间的每一格都会各自铺一次圆盘，接缝自然重叠
       */
      stampBrush(index, after);
    },
    [pattern, editEnabled, stampBrush, commitDeltas, setCurrentCode],
  );

  /** 抬手：把这一条笔提交成一条 delta */
  const commitEditStroke = useCallback(() => {
    const stroke = editStrokeRef.current;
    editStrokeRef.current = null;
    /*
     * 清掉预览层。
     *
     * 抬手后主画布会通过 displayPattern 重绘成真实结果，但那是**下一个
     * 渲染周期**；这期间 overlay 上还留着预览色块。若不清 tick，那些块
     * 会一直挂着（用户会看到"松手后颜色更亮一点、过一会儿又变暗"的闪烁）。
     * 推一次 tick 让 overlay 立刻重画成"只有 hover/方框"的干净状态。
     */
    setEditLiveTick((t) => t + 1);
    if (!stroke || stroke.cells.length === 0) return;
    commitDeltas([makeDelta(editsRef.current, stroke.cells, stroke.after)]);
  }, [commitDeltas]);

  // ---- 图案变更：整块重建 + 维持滚动位置不跳 ----
  const drawnPatternRef = useRef<PatternResult | null>(null);
  const scrollKeepRef = useRef({ x: 0, y: 0 });

  // 持续记录滚动位置：图案换掉时用它复位（浏览器会因画布变小而夹紧滚动值）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollKeepRef.current = { x: el.scrollLeft, y: el.scrollTop };
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        setScrollTick((t) => t + 1);
      });
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = 0;
      }
    };
  }, [hasPattern, showRulers]);

  useIsoLayoutEffect(() => {
    if (!pattern) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    const keep = scrollKeepRef.current;
    scroll.scrollLeft = Math.min(keep.x, Math.max(0, scroll.scrollWidth - scroll.clientWidth));
    scroll.scrollTop = Math.min(keep.y, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    scrollKeepRef.current = { x: scroll.scrollLeft, y: scroll.scrollTop };
    // 只在图案（内容）换掉时复位；缩放走 zoomAt 的光标锚点逻辑
  }, [pattern]);

  /**
   * 当前可视区（相对图案左上角，CSS px）。
   *
   * 滚动容器里滚到哪，就只需要重画那一片 —— 320 格 × 400% 时整张图
   * 是 5120×4336 设备像素（22M），全画一遍光 clearRect 就要几毫秒，
   * 色号更是 86,400 次 fillText。裁剪后开销只和**窗口大小**有关，
   * 和网格密度、缩放倍数都无关。
   */
  const computeView = useCallback((): PatternView | null => {
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    if (!scroll || !canvas) return null;
    const scrollBox = scroll.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    if (canvasBox.width <= 0 || canvasBox.height <= 0) return null;
    // canvas 左上角相对可视区左上角的偏移（画布可能被居中）
    const x = scrollBox.left - canvasBox.left;
    const y = scrollBox.top - canvasBox.top;
    return { x, y, w: scrollBox.width, h: scrollBox.height };
  }, []);

  // ---- 主画布绘制 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const shown = displayPattern;
    if (!canvas || !shown || !metrics) return;
    const tokens = readTokens(canvas);
    /*
     * surface 必须基于**叠加编辑后**的图案生成。
     *
     * 否则用户手绘的那一颗豆永远不会出现在画布上 —— 引擎结果没变，
     * 变的只是覆盖层。缓存键是 pattern 引用，displayPattern 换新引用
     * 时会自然重建，不需要额外的失效逻辑。
     */
    const surface = getSurface(shown, surfaceRef);
    // 图案引用变了就强制重建位图（尺寸可能变小，旧画布残留会露出来）
    const forceRebuild = drawnPatternRef.current !== shown;
    drawnPatternRef.current = shown;
    drawPattern(canvas, shown, metrics, surface, {
      showCodes,
      showGrid,
      tokens,
      forceRebuild,
      view: computeView(),
      editMarks,
    });
    // computeView 读的是 DOM 的实时位置，不能进依赖数组（每次渲染都是新函数）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPattern, editMarks, metrics, showCodes, showGrid, themeTick, scrollTick]);

  /**
   * 鼠标是否落在"已应用区域"内。
   *
   * 用来做 hover 加强：已应用区域常态只有 0.1 的极淡底纹（见
   * REGION_MASK_IDLE_ALPHA 的注释），移到它上面时才升到 0.2。
   * 取的是布尔值而不是 hover 对象 —— hover 每移动一格都变，进依赖数组
   * 会让整层遮罩每格重画一次；只有"进入/离开该区域"才需要重画。
   */
  const appliedFocus = !!(
    hover &&
    pattern &&
    regionField?.active &&
    regionField.w[hover.row * pattern.cols + hover.col] >= MASK_MIN_WEIGHT
  );

  // ---- 区域遮罩层（独立 canvas，绝不画在图案本体上） ----
  useEffect(() => {
    const canvas = maskRef.current;
    if (!canvas || !metrics) return;
    const tokens = readTokens(canvas);
    /*
     * 「显不显示区域标记」这个开关只控制**已应用**区域的历史标记。
     *
     * 待应用草稿（pending）和拖动中的实时预览（live）**无视这个开关**：
     * 它们是"正在进行的操作"，不是"历史痕迹"。早先三者一起被开关管着，
     * 用户一旦关过标记（偏好持久化了 '0'），进刷子拖动就什么都不显示、
     * 只有工具条数字在涨 —— 那看起来就是"笔刷坏了"。
     */
    drawRegionMask(
      canvas,
      metrics,
      showRegionOverlay ? regionField : null,
      pendingField,
      liveRef.current,
      liveBoxRef.current,
      tokens,
      appliedFocus,
    );
  }, [
    metrics,
    regionField,
    pendingField,
    showRegionOverlay,
    appliedFocus,
    themeTick,
    pattern,
    liveTick,
  ]);

  // ---- overlay 绘制：刷子模式画笔刷圆环，否则画 hover 高亮 ----
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !metrics) return;
    const tokens = readTokens(canvas);
    if (brushMode) {
      // 刷子模式：整层重画成"圆环"，不再画格子高亮（两者会打架）
      const { cols, rows, cellDev, eff } = metrics;
      const devW = cols * cellDev;
      const devH = rows * cellDev;
      if (canvas.width !== devW || canvas.height !== devH) {
        canvas.width = devW;
        canvas.height = devH;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, devW, devH);
      ctx.scale(eff, eff);
      // 归一化 → CSS 像素：半径相对长边，格子是正方形所以单位宽一致
      const unit = metrics.cellCss;
      // 圆环必须用与引擎同一套几何（核心 + 羽化带），否则按圆环判断会判错
      const geo = brushCursor
        ? brushGeometry(
            brushCursor.x,
            brushCursor.y,
            brushCursor.r,
            cols,
            rows,
            featherRef.current,
          )
        : null;
      const ring = geo
        ? {
            x: geo.cx * unit,
            y: geo.cy * unit,
            core: geo.radiusCells * unit,
            reach: geo.reach * unit,
          }
        : null;
      drawBrushRing(ctx, metrics, ring, tokens);
    } else {
      drawHover(canvas, metrics, hover, tokens);
      /*
       * 拖动中的编辑预览（用户反馈「画笔画过去橡皮擦过去，不能实时的去预览」）。
       *
       * 顺序有讲究：
       *   · 必须在 drawHover 之后 —— 它会 clearRect 整层，先画就被擦掉；
       *   · 必须在"当前格方框"之前 —— 方框是"我这一下落在哪"，该在最上层。
       * 所以这里传 skipClear=true：本层已被 drawHover 清空，预览只叠加填充。
       */
      const stroke = editStrokeRef.current;
      if (editEnabled && stroke && stroke.cells.length > 0) {
        drawEditPreview(
          canvas,
          metrics,
          stroke.cells,
          stroke.after,
          stroke.after ? codeHex(stroke.after) : null,
          tokens,
          true,
        );
      }
      /*
       * 编辑模式下画"这一笔会落在哪"的落点预览。
       *
       * hover 的三层环是给"看色号"用的，颜色是陶土；编辑时用户关心的是
       * "我这一下会盖住哪些格"，需要更硬、更方的提示 —— 用金色，
       * 与手改标记同色系，语义一致（金色 = 我动过/我要动）。
       *
       * **形状必须跟笔宽走**（用户要求「笔刷选择过后鼠标预览也跟着变化」）。
       * 原来只画"当前格"一个方框，笔宽调到 4 时指针还是只框住一格 ——
       * 用户以为笔没变粗，实际落下去盖了 37 格。现在按同一套圆盘判据
       * 逐格描边，屏幕上的形状就是真实落笔的形状。
       *
       * 描边而不是填充：填充会盖住底下的色号（编辑时经常要看着色号画）。
       * 只在最外圈描边（判断该格是否有不在圆盘内的邻居），内部格子跳过 ——
       * 否则 4 格粗时 37 个方框叠在一起是一团金雾。
       */
      if (editEnabled && editCursor) {
        const { cellDev, eff } = metrics;
        const ctx = canvas.getContext('2d');
        if (ctx && cellDev >= 4) {
          // drawHover 结束后变换矩阵还停在 scale(eff) 上，这里显式重置再缩放，
          // 不能直接再 scale 一次（会变成 eff²，方框画到画布外）
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.scale(eff, eff);
          const d = (dev: number) => dev / eff;
          const cols = pattern ? pattern.cols : 1;
          const rows = pattern ? pattern.rows : 1;
          const bw = brushWidthRef.current;
          const { lo, hi } = brushSpan(bw);
          /* 与落笔共用同一套判据 —— 圈住什么就一定涂什么 */
          const inside = (dx: number, dy: number) => brushContains(bw, dx, dy);
          const lineW = Math.max(1, Math.round(cellDev * 0.09));
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = tokens.gold;
          for (let dy = lo; dy <= hi; dy++) {
            for (let dx = lo; dx <= hi; dx++) {
              if (!inside(dx, dy)) continue;
              const c = editCursor.col + dx;
              const r = editCursor.row + dy;
              if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
              // 只描"圆盘边缘"：四邻里有落在圆盘外的，才需要画这个格子
              const edge =
                !inside(dx - 1, dy) ||
                !inside(dx + 1, dy) ||
                !inside(dx, dy - 1) ||
                !inside(dx, dy + 1);
              if (!edge) continue;
              const x = c * cellDev;
              const y = r * cellDev;
              // 逐边判断：邻居在圆盘内就不画这条边，边缘才不会出现内部横线
              if (!inside(dx, dy - 1)) ctx.fillRect(d(x), d(y), d(cellDev), d(lineW));
              if (!inside(dx, dy + 1))
                ctx.fillRect(d(x), d(y + cellDev - lineW), d(cellDev), d(lineW));
              if (!inside(dx - 1, dy)) ctx.fillRect(d(x), d(y), d(lineW), d(cellDev));
              if (!inside(dx + 1, dy))
                ctx.fillRect(d(x + cellDev - lineW), d(y), d(lineW), d(cellDev));
            }
          }
          ctx.globalAlpha = 1;
        }
      }
    }
  }, [
    metrics,
    hover,
    themeTick,
    brushMode,
    brushCursor,
    editEnabled,
    editCursor,
    /*
     * editLiveTick 是拖动预览的"推重绘"计数器。
     *
     * 笔迹存在 editStrokeRef 里（ref 变化不触发渲染），所以必须靠这个
     * 自增值进依赖数组才能让 overlay 每落一格重画一次。少了它，预览只会在
     * hover 恰好变化时偶尔刷新 —— 表现为"画快了才看得到，慢慢画反而没有"。
     */
    editLiveTick,
    /*
     * 笔宽变了要立刻重绘一次预览环 —— 回调里读的是 brushWidthRef，
     * ref 变化不会触发重绘，所以把 state 也放进依赖，让光标形状跟手变化。
     */
    brushWidth,
    pattern,
    codeHex,
  ]);

  // ---- 标尺 ----
  /*
   * 标签步长必须按可用间距反算，不能死守"每 5 格一个数字"。
   *
   * 320 格时每格只有 3–4 CSS px，"每 5 格"就是 20px 一个三位数 —— 标尺上
   * 会挤成一团连续的数字，一个都读不出来（实测实锤）。这里按"至少 18px
   * 才放得下三位数 + 间隙"反算，再 snap 到人类习惯的档位（1/2/5/10/20/25/50/100）。
   *
   * 注意 10 格主线**不受这个步长影响**：那是拼豆板的物理分界，无论缩到多小
   * 都必须画出来，变的只是"隔多少格标一个数字"。
   */
  const ruler = useMemo(() => {
    const cellCss = metrics?.cellCss ?? 12;
    const span = Math.max(metrics?.cols ?? 0, metrics?.rows ?? 0);
    /*
     * 标签要几个字宽，取决于最大是多少 —— 320 格的标尺要放 3 位数。
     * 固定 18px 在 3 位数上是不够的：8.5px 像素字体一个数字约 5.5–6px，
     * 三位数加间隙要 ~28px，否则相邻标签会叠在一起（实测 320 格时
     * "105 110 115" 直接糊成一团）。
     */
    const digits = Math.max(2, String(span).length);
    const minLabelPx = 10 + digits * 6;
    const rawStep = Math.max(1, Math.ceil(minLabelPx / cellCss));
    /*
     * 从 5 起跳，不给 1/2 的档位。
     *
     * 格子大的时候（16 格图每格 48px）rawStep = ceil(22/48) = 1，若候选里
     * 有 1 就会变成"每格都标一个数字"，16 格标 16 个 —— 间距是够，但密得
     * 没有信息量。标尺的语义是"每 5 格一档、10 格加粗"，5 就是下限。
     */
    const step = [5, 10, 20, 25, 50, 100].find((s) => s >= rawStep) ?? 100;

    /*
     * 刻度底纹的周期也要跟着放大：每格 4px 时"每格一条 1px 线"意味着
     * 25% 的面积是墨色，那条标尺会看起来像一条灰带子。小格时改成
     * 每 5 格一档，至少能读成"刻度"。
     */
    const tickPeriod = cellCss >= 6 ? cellCss : cellCss * 5;
    return {
      left: RULER_LEFT,
      top: RULER_TOP,
      labelStep: step,
      tickPeriod,
      tickBgTop: `repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px ${tickPeriod}px)`,
      tickBgLeft: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${tickPeriod}px)`,
    };
  }, [metrics]);

  // ---- 编辑：指针驱动 ----
  /*
   * 编辑和刷区域互斥，共用同一个画布表面，所以指针处理器必须在最外层
   * 分派 —— 谁的模式开着就走谁，绝不两边都跑（否则一次拖动既改格子
   * 又画选区，两种遮罩叠在一起，用户完全看不懂发生了什么）。
   */
  /*
   * 抓手的拖拽状态。
   *
   * 不用 React state：指针每动一像素都要读上一次位置、算位移，走 state 会
   * 每帧额外渲染一次整块画布（三层 canvas 一起 redraw），拖起来会掉帧。
   * 这里只需要记住"按下时指针在哪、当时滚到哪"。
   */
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  /*
   * 边缘自动滚动（edge auto-scroll）。
   *
   * 用户反馈：「下面的不容易看到并拖动编辑，我猜测可能要把画板周围的拖动
   * 底部空间预留的大一点」。实测（编辑态 1600×1000，画布高 1152px、可视
   * 高 742px）从容器中间起笔往下拖到容器外 40px，scrollTop 采样全程 0 ——
   * 笔拖到边上画面不跟着走，要画下半部分得先松手、滚下去、再落笔。
   *
   * 判据用指针到滚动容器**可视边**的距离：进入 EDGE_ZONE 就按比例滚，
   * 越靠边越快（EDGE_SPEED_MIN → EDGE_SPEED_MAX 线性）。不能只在
   * pointermove 里滚 —— 指针停住不动时 pointermove 不触发，用户把笔杵在
   * 底边就再也滚不动了，所以必须用 rAF 循环自己跑。
   */
  const panEdgeRef = useRef<{ x: number; y: number } | null>(null);
  const edgeRafRef = useRef<number | null>(null);
  /** 停掉边缘自动滚动的 rAF 循环（抬手 / 取消 / 退出编辑都要调） */
  const stopEdgeScroll = useCallback(() => {
    if (edgeRafRef.current !== null) {
      cancelAnimationFrame(edgeRafRef.current);
      edgeRafRef.current = null;
    }
    panEdgeRef.current = null;
  }, []);

  /**
   * 把一次落点画到第 `index` 格，并从上一格的笔心插值过来。
   *
   * 从 onEditPointerMove 里抽出来的：边缘自动滚动时，指针本身没动，
   * 但滚动让**指针底下的格子变了**，那种情况下也要按同样的插值规则补画
   * （否则滚过去的那些格子不会被涂到，画面里会出现一条没画上的断带）。
   * 两条路径共用这一份，插值规则就只有一处。
   */
  const paintToIndex = useCallback(
    (index: number | null) => {
      // 只有笔在拖动中才连续画：取色器/油漆桶没有拖动语义，拖也只算点一下
      const stroke0 = editStrokeRef.current;
      if (!stroke0) return;
      if (index === null) return;
      // 夹紧到边界太远会画成一条穿图的直线 —— 用上一个格子和当前格子
      // 做直线插值（Bresenham），这样快速拖动也不会漏格
      const stroke = stroke0;
      /*
       * 起点用 anchor（上一笔的**笔心**），不是 cells 的末尾。
       * 粗笔一次盖章写进 cells 的是一整片格子，末尾是笔头右下角；
       * 拿它插值会让下一段从偏移 (radius, radius) 的位置开始。
       */
      const last = stroke.anchor;
      if (!pattern) {
        stampBrush(index, stroke.after);
        return;
      }
      if (last === index) {
        stampBrush(index, stroke.after);
        return;
      }
      /*
       * 走一遍两点之间的格子，避免快速拖动跳过中间格（相邻时就是它自己）。
       *
       * 每个中间格都用 stampBrush 盖章（而不是 paintCell 单格）—— 否则
       * 笔宽 > 1 时「按下是粗圆点、一拖就变细线」。
       */
      let c0 = last % pattern.cols;
      let r0 = Math.floor(last / pattern.cols);
      const c1 = index % pattern.cols;
      const r1 = Math.floor(index / pattern.cols);
      const dc = Math.abs(c1 - c0);
      const dr = Math.abs(r1 - r0);
      const sc = c0 < c1 ? 1 : -1;
      const sr = r0 < r1 ? 1 : -1;
      let err = dc - dr;
      for (let guard = 0; guard < 4096; guard++) {
        stampBrush(r0 * pattern.cols + c0, stroke.after);
        if (c0 === c1 && r0 === r1) break;
        const e2 = err * 2;
        if (e2 > -dr) {
          err -= dr;
          c0 += sc;
        }
        if (e2 < dc) {
          err += dc;
          r0 += sr;
        }
      }
    },
    [pattern, stampBrush],
  );

  /**
   * 启动边缘自动滚动的 rAF 循环（幂等：已在跑就不再开一条）。
   *
   * 为什么不用 pointermove 直接滚：pointermove 只在指针**动**的时候来。
   * 用户把笔停在容器底边不动、想让它继续往下滚，是最自然的操作，而那种
   * 情况下一个事件都不会再来，画面就卡住了。rAF 循环自己按当前位置跑，
   * 指针停着也继续滚。
   *
   * 滚动发生后必须补画：滚动改变的只是视口，指针在屏幕上的位置没变，
   * 但指针底下已经是别的格子了。补画走 paintToIndex，和普通拖动同一套
   * Bresenham —— 滚过去的每一格都练得上，画出来才不会断。
   */
  const startEdgeScroll = useCallback(() => {
    if (edgeRafRef.current !== null) return;
    const tick = () => {
      const scroll = scrollRef.current;
      const ptr = panEdgeRef.current;
      if (!scroll || !ptr || !editStrokeRef.current) {
        edgeRafRef.current = null;
        return;
      }
      const rect = scroll.getBoundingClientRect();
      // 只在指针还停在滚动容器上时滚；拖到容器外就停（不然手一滑出界画面狂滚）
      if (
        ptr.x < rect.left ||
        ptr.x > rect.right ||
        ptr.y < rect.top ||
        ptr.y > rect.bottom
      ) {
        edgeRafRef.current = null;
        return;
      }
      /** 0 = 没进热区，1 = 正贴边 */
      const ramp = (dist: number) => {
        if (dist >= EDGE_ZONE) return 0;
        const t = 1 - Math.max(0, dist) / EDGE_ZONE;
        return t * t; // 平方：靠近边缘时提速更明显，离开一点就迅速变慢
      };
      const top = rect.top + EDGE_ZONE;
      const bottom = rect.bottom - EDGE_ZONE;
      const left = rect.left + EDGE_ZONE;
      const right = rect.right - EDGE_ZONE;
      let dx = 0;
      let dy = 0;
      if (ptr.y < top) dy = -ramp(ptr.y - rect.top);
      else if (ptr.y > bottom) dy = ramp(rect.bottom - ptr.y);
      if (ptr.x < left) dx = -ramp(ptr.x - rect.left);
      else if (ptr.x > right) dx = ramp(rect.right - ptr.x);
      if (dx === 0 && dy === 0) {
        edgeRafRef.current = null;
        return;
      }
      const beforeLeft = scroll.scrollLeft;
      const beforeTop = scroll.scrollTop;
      if (dy !== 0) {
        const step = Math.round(dy * EDGE_SPEED_MAX);
        scroll.scrollTop += Math.max(
          -EDGE_SPEED_MAX,
          Math.min(EDGE_SPEED_MAX, step || Math.sign(dy) * EDGE_SPEED_MIN),
        );
      }
      if (dx !== 0) {
        const step = Math.round(dx * EDGE_SPEED_MAX);
        scroll.scrollLeft += Math.max(
          -EDGE_SPEED_MAX,
          Math.min(EDGE_SPEED_MAX, step || Math.sign(dx) * EDGE_SPEED_MIN),
        );
      }
      // 滚到边了（滚动量没变）就没有继续跑的必要，交给下一次 move 重启
      if (scroll.scrollLeft === beforeLeft && scroll.scrollTop === beforeTop) {
        edgeRafRef.current = null;
        return;
      }
      // 指针底下的格子变了 —— 补画，否则滚过的部分会留下一条断带
      paintToIndex(cellAt(ptr.x, ptr.y));
      edgeRafRef.current = requestAnimationFrame(tick);
    };
    edgeRafRef.current = requestAnimationFrame(tick);
  }, [paintToIndex, cellAt]);

  const onEditPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!editEnabled || brushModeRef.current) return;
      // 只响应主键：右键/中键在画布上是"别的动作"，不该落笔
      if (e.button !== undefined && e.button !== 0) return;
      /*
       * 抓手：按下即开始平移，**不读格子**。
       *
       * 放在 cellAt 之前是必需的 —— 画布放大到 400% 时可视区里可能全是
       * 同一格的放大像素、也可能正好落在留白上（cellAt 返回 null），
       * 而抓手这两种情况都得能拖动。它操作的是滚动容器，不是图案。
       */
      if (editToolRef.current === 'pan') {
        const scroll = scrollRef.current;
        if (!scroll) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        panRef.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          left: scroll.scrollLeft,
          top: scroll.scrollTop,
        };
        return;
      }
      const index = cellAt(e.clientX, e.clientY);
      if (index === null) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      editStrokeRef.current = null;
      applyToolAt(index);
      /*
       * 按下也要启动边缘滚动：笔一落就停在底边（最常见的是想画最下面那几行，
       * 落点本来就在底部热区）时，没有 pointermove 就永远不会开始滚。
       */
      if (editStrokeRef.current) {
        panEdgeRef.current = { x: e.clientX, y: e.clientY };
        startEdgeScroll();
      }
    },
    [editEnabled, cellAt, applyToolAt, startEdgeScroll],
  );

  const onEditPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!editEnabled || brushModeRef.current) return;
      /*
       * 抓手拖动中：把指针位移换算成滚动量。
       *
       * 用「按下时的 scrollLeft - 指针位移」而不是「累加 delta」：累加会把
       * 滚动容器在到达两端时的夹紧损失吃掉，指针拖出去再拖回来，画布会
       * 慢慢跑偏（常见的手感 bug）。以起点为基准则是指针在哪画布就在哪，
       * 拖到边界自然停住，拖回来立刻跟手。
       */
      const pan = panRef.current;
      if (pan) {
        const scroll = scrollRef.current;
        if (!scroll) return;
        scroll.scrollLeft = pan.left - (e.clientX - pan.x);
        scroll.scrollTop = pan.top - (e.clientY - pan.y);
        return;
      }
      const index = cellAt(e.clientX, e.clientY);
      setEditCursor(
        index === null || !pattern
          ? null
          : { col: index % pattern.cols, row: Math.floor(index / pattern.cols) },
      );
      paintToIndex(index);
      // 记下指针位置，供边缘自动滚动的 rAF 循环读取（指针停住时 move 不再触发）
      panEdgeRef.current = { x: e.clientX, y: e.clientY };
      startEdgeScroll();
    },
    [editEnabled, cellAt, pattern, paintToIndex, startEdgeScroll],
  );

  const onEditPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!editEnabled) return;
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      /*
       * 抓手收尾：只清状态，**不提交笔**。
       *
       * commitEditStroke 会把 editStrokeRef 里攒的格子写成一条 delta；
       * 抓手根本没攒格子（editStrokeRef 一直是 null），走一遍也是空操作，
       * 但显式分流更安全 —— 万一将来抓手里误碰了 editStrokeRef，这里
       * 能挡住"拖一下画布多出一笔手改"这种事。
       */
      // 抬手必须停掉边缘自动滚动（漏清的话松手后画面还在自己滚）
      stopEdgeScroll();
      if (panRef.current) {
        panRef.current = null;
        return;
      }
      commitEditStroke();
    },
    [editEnabled, commitEditStroke, stopEdgeScroll],
  );

  const onEditPointerLeave = useCallback(() => {
    // 笔拖出容器就停滚（rAF 里也有一道同样的判断，这里提前收掉更省事）
    stopEdgeScroll();
    // 抓手拖到画布外（pointer capture 还在）不能清 panRef，否则松手前
    // 再拖回来就不动了。只有真的没在拖时才清悬停格。
    if (!panRef.current) setEditCursor(null);
  }, [stopEdgeScroll]);

  // ---- 撤销 / 重做（统一历史） ----
  /*
   * 撤销栈里混着两类操作：编辑 delta 和刷子快照。它们分属不同的数据层，
   * 但用户在界面上只看到"我刚做的那一下"，所以按时间顺序统一回退。
   *
   * 刷子那条尤其重要：退出刷区域时草稿会被**隐式应用**（不弹确认），
   * 如果那次应用撤不掉，用户会觉得"我只是切了个开关，选区就没了"。
   */
  const undoEdit = useCallback(() => {
    const log = undoLogRef.current;
    const entry = log.pop();
    if (!entry) return;
    redoLogRef.current.push(entry);
    if (entry.kind === 'brushes') {
      brushesRef.current = entry.before;
      onBrushesChange?.(entry.before);
    } else if (onEditsChange) {
      const next = applyDelta(editsRef.current, invertDelta(editsRef.current, entry.delta));
      editsRef.current = next;
      onEditsChange(next, []);
    }
    bumpHistory();
  }, [onBrushesChange, onEditsChange, bumpHistory]);

  const redoEdit = useCallback(() => {
    const entry = redoLogRef.current.pop();
    if (!entry) return;
    undoLogRef.current.push(entry);
    if (entry.kind === 'brushes') {
      brushesRef.current = entry.after;
      onBrushesChange?.(entry.after);
    } else if (onEditsChange) {
      const next = applyDelta(editsRef.current, entry.delta);
      editsRef.current = next;
      onEditsChange(next, []);
    }
    bumpHistory();
  }, [onBrushesChange, onEditsChange, bumpHistory]);

  const canUndoEdit = undoLogRef.current.length > 0;
  const canRedoEdit = redoLogRef.current.length > 0;
  /*
   * historyTick 只用来"推一下"渲染：撤销栈在 ref 里，push 不会触发重渲染，
   * 按钮的 disabled 状态就会滞后一帧。这个 void 表达式让 lint 知道它是故意的。
   */
  void historyTick;
  const editedCount = editEnabled ? editCount(edits) : 0;

  /** 清空所有手工编辑（可撤销：整批合成一条 delta 反转） */
  const clearEdits = useCallback(() => {
    if (!onEditsChange) return;
    const cur = editsRef.current;
    const cells = Object.keys(cur)
      .map(Number)
      .filter((i) => Number.isInteger(i));
    if (cells.length === 0) return;
    const delta: EditDelta = {
      cells,
      before: cells.map((c) => cur[c]),
      after: cells.map(() => undefined as string | undefined),
    };
    /*
     * 压栈的是**原始** delta，不要在这里预反转 —— undoEdit 会调 invertDelta
     * 再翻一次。早先预反转了一次，结果"还原"撤不回（撤销后仍是 0 格）。
     */
    pushUndo({ kind: 'edits', delta });
    editsRef.current = EMPTY_EDITS;
    onEditsChange(EMPTY_EDITS, [delta]);
  }, [onEditsChange, pushUndo]);

  // ---- 撤销 / 清空 ----
  /*
   * 两者都优先作用在**草稿**上：草稿是用户刚画、还没提交的东西，
   * 撤销它不需要等重算，是最便宜也最符合直觉的操作。草稿空了才动
   * 已应用的部分（那才需要走 onBrushesChange 触发重算）。
   */
  const undoBrush = useCallback(() => {
    const drafts = pendingRef.current;
    if (drafts.length > 0) {
      setPendingStrokes(drafts.slice(0, -1));
      return;
    }
    const cur = brushesRef.current ?? [];
    if (cur.length === 0) return;
    // 整笔撤掉：按簇算出最后一笔占多少个点，一次砍掉它们
    const clusters = pattern
      ? clusterBrushes(cur, pattern.cols, pattern.rows)
      : [cur];
    const lastLen = clusters.length > 0 ? clusters[clusters.length - 1].length : 1;
    const next = cur.slice(0, Math.max(0, cur.length - lastLen));
    brushesRef.current = next;
    onBrushesChange?.(next);
  }, [onBrushesChange, setPendingStrokes, pattern]);

  const clearBrushes = useCallback(() => {
    if (pendingRef.current.length > 0) {
      setPendingStrokes([]);
      return;
    }
    if ((brushesRef.current ?? []).length === 0) return;
    brushesRef.current = [];
    onBrushesChange?.([]);
  }, [onBrushesChange, setPendingStrokes]);

  /** 撤销/清空按钮是否该亮：草稿或已应用任一非空 */
  const canUndo = pendingCount > 0 || appliedCount > 0;
  const hasAnything = canUndo;

  /**
   * 退出刷子模式时怎么处理没提交的草稿？
   *
   * 选了**自动应用**，而不是丢弃 + toast。理由：
   *  - 丢弃是破坏性操作，而"退出刷子"这个动作本身没有任何"我不要了"的
   *    语义 —— 用户只是想看看图案、切个开关。凭空吞掉他刚画的选区，
   *    比多算一次更让人恼火（尤其选区画了几十笔的时候）。
   *  - 自动应用也符合"草稿最终都要落地"的心智，而且成本可控：这就是
   *    他本来要点「应用重建」的那一次重算。
   *  - toast 得引入 sonner 的调用点，还会在移动端盖住工具条；自动应用
   *    连提示都不需要 —— 图案自己变了，就是最好的反馈。
   */
  const exitBrushMode = useCallback(() => {
    if (pendingRef.current.length > 0) applyPending();
    setBrushMode(false);
  }, [applyPending, setBrushMode]);

  /*
   * 卸载时收掉边缘自动滚动的 rAF 循环。
   *
   * 退出编辑/切到刷区域时 onEditPointerDown/Move 都不再走，但 rAF 是**自己
   * 排自己**的，没人调 stopEdgeScroll 的话它会一直跑下去 —— 而且 tick 里
   * 只在 `!editStrokeRef.current` 时才自然退出，退出编辑时那条笔往往还
   * 挂着（用户按 Esc 走的，不是抬手走的），于是画面在退出编辑后还在滚。
   */
  useEffect(() => stopEdgeScroll, [stopEdgeScroll]);

  return {
    hostRef,
    scrollRef,
    canvasRef,
    overlayRef,
    maskRef,
    /**
     * host 的实测尺寸。
     *
     * 加进返回值是为了让调用方能在**不看滚动容器**的前提下判断"这块地方够
     * 不够宽放一条侧栏"。不能用滚动容器的宽度判：侧栏一出现滚动容器就变窄，
     * 判据跟着翻转，布局会自己抖起来。host 包着侧栏，宽度与侧栏在不在无关，
     * 是稳定的判据。
     */
    hostWidth,
    hostHeight,
    metrics,
    zoom,
    setZoom,
    zoomIn,
    zoomOut,
    resetZoom,
    showCodes,
    showGrid,
    showRulers,
    showRegionOverlay,
    setShowCodes,
    setShowGrid,
    setShowRulers,
    setShowRegionOverlay,
    hover,
    onPointerMove,
    onPointerLeave,
    ruler,
    hasPattern,
    // 刷区域
    brushMode,
    setBrushMode,
    brushAlgorithm,
    setBrushAlgorithm,
    brushRadius,
    setBrushRadius,
    brushCursor,
    onBrushPointerDown,
    onBrushPointerMove,
    onBrushPointerUp,
    undoBrush,
    clearBrushes,
    regionField,
    regionSummary,
    // 两步式选区
    pendingStrokes,
    pendingCount,
    pendingCoverage,
    livePreview,
    pendingLabel,
    appliedCount,
    appliedCoverage,
    applyPending,
    cancelPending,
    canUndo,
    hasAnything,
    exitBrushMode,
    useFill,
    /** 画布外那一圈留白的宽度（窄屏更窄，见 CANVAS_GUTTER_NARROW） */
    canvasGutter,
    // ---- 编辑（② 工具栏） ----
    displayPattern,
    editEnabled,
    editTool,
    setEditTool,
    brushWidth,
    setBrushWidth,
    recentCodes,
    currentCode,
    setCurrentCode,
    editCursor,
    onEditPointerDown,
    onEditPointerMove,
    onEditPointerUp,
    onEditPointerLeave,
    undoEdit,
    redoEdit,
    canUndoEdit,
    canRedoEdit,
    clearEdits,
    editedCount,
    editHistoryTick: historyTick,
    hud: pattern
      ? {
          cols: pattern.cols,
          rows: pattern.rows,
          totalBeads: pattern.totalBeads,
          paletteSize: pattern.palette.length,
          meanDeltaE: pattern.meanDeltaE,
        }
      : null,
  };
}

export type PatternCanvasController = ReturnType<typeof usePatternCanvas>;
