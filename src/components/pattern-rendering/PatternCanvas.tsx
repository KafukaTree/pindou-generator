'use client';

/**
 * 图案预览画布
 * ---------------------------------------------------------------
 * 这一版渲染器解决的 9 个实测缺陷（详见 usePatternCanvas.ts 顶部注释）：
 *  1. devicePixelRatio 高清渲染，每格边界对齐整设备像素 —— 不再整体模糊、不再灰边
 *  2. 分级网格（1 格/5 格/10 格），不再每格描黑边变成灰雾
 *  3. 色号在 cellSize ≥ 14 完整显示，9–14 自适应缩小，< 9 隐藏
 *  4. 字色用 readableInkFor()（真实 WCAG 对比度），中灰/饱和色不再判错
 *  5. HTML 行/列标尺（每 5 格标数字，10 的倍数加粗），不占 canvas
 *  6. 0.5×–4× 缩放：按钮 + 滚轮（preventDefault，仅在画布上），以光标为锚点
 *  7. hover 高亮 + 工具提示（行/列/色号/HEX/RGB），坐标用 getBoundingClientRect 反算
 *  8. 空白格（cells = -1）不画，透出 .px-checker 棋盘格
 *  9. 色号/网格/标尺开关 + 缩放值持久化到 localStorage（key 前缀 pindou.canvas.）
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { PatternResult } from '@/lib/pattern/generate';
import { getBrandPalette, type Brand } from '@/lib/color/palette';
import { Slider } from '@/components/ui/slider';
import { DETAIL_ALGORITHMS, DETAIL_META, type DetailAlgorithm } from '@/lib/pattern/detail';
import type { DetailBrush } from '@/lib/pattern/regions';
import type { EditDelta, EditMap } from '@/lib/pattern/edits';
import { PixelCursor, PixelSwatch } from '@/components/scenery';
import {
  usePatternCanvas,
  RULER_LEFT,
  RULER_TOP,
  ZOOM_MIN,
  ZOOM_MAX,
  BRUSH_RADIUS_MIN,
  BRUSH_RADIUS_MAX,
  FEATHER_MIN,
  FEATHER_MAX,
  type EditTool,
} from './usePatternCanvas';

export interface PatternCanvasProps {
  pattern: PatternResult | null;
  brand: Brand;
  className?: string;
  /**
   * 填满父容器高度：外壳 height:100% 走 flex 列、滚动区吃掉剩余空间。
   * 父容器必须自己有确定高度（例如 h-screen 工作台里的一栏）。
   * 可用高度不足 240px 时自动降级为"限高 + 内部滚动"，避免移动端塌成一条线。
   */
  fill?: boolean;
  /** 已有的区域笔刷（受控） */
  brushes?: DetailBrush[];
  /** 笔刷变化回调；每一笔结束 / 撤销 / 清空各触发一次，父组件可 debounce 重算 */
  onBrushesChange?: (next: DetailBrush[]) => void;
  /** 区域羽化 0.12–1，默认 0.55 */
  regionFeather?: number;
  onRegionFeatherChange?: (v: number) => void;
  /** 正在重算（刷完到出结果之间给个轻提示，不阻塞继续刷） */
  isWorking?: boolean;
  /*
   * ---------------- 手工编辑（全部可选，不传时行为与旧版完全一致） ----------------
   *
   * 编辑的真相在父组件：`edits` 是稀疏覆盖层，`onEditsChange` 是唯一写入口。
   * 画布自己只算"叠加后长什么样"，不持有数据 —— 这样导出 PDF、图例、
   * 历史记录拿到的都是同一份。
   */
  /** 手工编辑覆盖层（受控） */
  edits?: EditMap;
  /** 编辑变化回调：`deltas` 是这次变化包含的若干笔，父组件可据此做撤销栈 */
  onEditsChange?: (next: EditMap, deltas: EditDelta[]) => void;
  /** 当前画笔色号变化（色卡高亮 / 外部图例联动用） */
  onCurrentCodeChange?: (code: string) => void;
  /** 初始工具，默认 'pencil' */
  initialTool?: EditTool;
  /**
   * 画布当前占用状态变化回调。
   *
   * 刷区域和编辑模式都会把用户的注意力锁在画布上，此时画布周边不该有东西
   * 在晃（巡游的桌宠尤其不该）。这两个开关都活在画布内部 —— `brushMode`
   * 在 hook 里、`editActive` 在组件 state 里 —— 父组件看不见，所以把结果
   * 上报出去。只在值真正变化时触发。
   */
  onActivityChange?: (activity: CanvasActivity) => void;
  /**
   * 缩放控件要渲染进去的 DOM 节点（「04 图纸」标题栏右侧那个空槽）。
   *
   * 由父层用 ref callback 拿到真实节点后传进来，本组件用 `createPortal` 把
   * 缩放组送进去 —— 状态留在画布内部（zoom/zoomIn/zoomOut 都活在
   * usePatternCanvas 里），只有渲染位置搬走。
   *
   * 不传时缩放组退回工具条内联渲染，功能不丢（组件被别处复用时不会白屏）。
   */
  zoomSlot?: HTMLElement | null;
}

/**
 * 画布的三种占用状态。
 *
 * 用枚举而不是两个 bool：父组件要做的判断是"现在是不是该让开"，
 * 这个判断三种状态互斥，合并成一个值可以少两次 && 逻辑，也便于以后加档位。
 */
export type CanvasActivity = 'idle' | 'brushing' | 'editing';

/**
 * 桌面端色板竖栏宽度（CSS px）。
 *
 * 200 是反算出来的，不是拍的：竖栏 200 − 左右各 2px 边框 = 196 的内容宽，
 * 再减 px-2（左右各 8px）= 180 的净宽；7 列 × 24px + 6 个 2px 间隙 = 180，
 * 正好吃满且不出现横向滚动条。
 *
 * 为什么卡在 200 而不是更宽：中栏 1244px 里，200 侧栏 + 2px 边框 + 8px
 * 间隙之后画布仍有约 1026px，方形图能撑到 1000 以上（验收要求 >= 700）。
 * 再宽就开始明显抢画布 —— 而这个改动的首要目的恰恰是"把面积还给画布"。
 */
const TRAY_RAIL_W = 200;
/** 桌面断点，与 globals.css 里的 .wb 断点（64rem）保持一致 */
const DESKTOP_QUERY = '(min-width: 64rem)';
/**
 * 竖栏里的色块边长。
 *
 * 24px 是"能放下 8px 色号角标"（PixelSwatch 在 >= 18px 时才画角标）与
 * "一屏看到足够多色"的折中：24 + 2px 间隙的栅格下，291 色在 200 宽的
 * 竖栏里是 7 列 × 42 行，约两屏看完。
 */
const SWATCH_DESKTOP = 24;
/**
 * 手机上的色块边长。
 *
 * 22px 是给鼠标的尺寸：手指点 22px 的方块命中率很差（拇指指腹接触面直径
 * 约 8–10mm ≈ 30–38 CSS px），很容易点到隔壁色号。28px 是"能稳定点中"的
 * 下限（也是验收要求的 >= 28），配合 4px 间隙形成 32px 的点击栅格。
 */
const SWATCH_MOBILE = 28;

/**
 * 断点判定：用 matchMedia 而不是量 host 宽度。
 *
 * 依据是"窗口一行还能不能并排放两栏"，那是媒体查询的事，不是画布容器的事 ——
 * 容器宽度还受左栏折叠、专注模式影响，用它判定会让同一个窗口在不同状态下
 * 来回换布局。断点值与 globals.css 里 `.wb` 的 64rem 对齐，两边一起变。
 *
 * 用 useSyncExternalStore 读，而不是 useEffect + useState：后者首帧永远渲染成
 * "手机"，桌面用户会看到一次布局跳动；前者给出服务端快照（false）与客户端
 * 快照两条通道，React 在 hydrate 时按真实值一次到位。
 */
function subscribeDesktop(onChange: () => void) {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const getDesktopSnapshot = () => window.matchMedia(DESKTOP_QUERY).matches;
/** 服务端拿不到窗口尺寸，按手机布局渲染（窄的那套是安全的默认） */
const getDesktopServerSnapshot = () => false;

export function PatternCanvas({
  pattern,
  brand,
  className,
  fill = false,
  brushes,
  onBrushesChange,
  regionFeather = 0.55,
  onRegionFeatherChange,
  isWorking = false,
  edits,
  onEditsChange,
  onCurrentCodeChange,
  initialTool,
  onActivityChange,
  zoomSlot: zoomSlotProp,
}: PatternCanvasProps) {
  /**
   * 「编辑」是总开关（默认关）。
   *
   * 为什么不默认开：画布的首要任务是"看图纸"，鼠标移过格子就弹色号才是
   * 常态。如果一进来就是编辑态，用户想拖动画布看局部时反而会涂掉一颗豆
   * —— 而且他自己未必立刻发现。所以必须先明确表示"我要改"。
   *
   * 声明在 usePatternCanvas **之前**：编辑态要改变格子的 sizing 策略
   * （编辑时宽度优先、让画板吃满面积），所以要作为 option 传进 hook。
   */
  const [editActive, setEditActive] = useState(false);
  const c = usePatternCanvas(pattern, {
    brushes,
    onBrushesChange,
    regionFeather,
    fill,
    brand,
    edits,
    onEditsChange,
    onCurrentCodeChange,
    initialTool,
    editing: editActive,
  });
  const {
    hostRef,
    scrollRef,
    canvasRef,
    overlayRef,
    maskRef,
    metrics,
    zoom,
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
    brushMode,
    setBrushMode,
    brushAlgorithm,
    setBrushAlgorithm,
    brushRadius,
    setBrushRadius,
    onBrushPointerDown,
    onBrushPointerMove,
    onBrushPointerUp,
    undoBrush,
    clearBrushes,
    regionSummary,
    useFill,
    pendingCount,
    pendingLabel,
    livePreview,
    appliedCount,
    appliedCoverage,
    applyPending,
    cancelPending,
    canUndo,
    exitBrushMode,
    displayPattern,
    editEnabled,
    editTool,
    setEditTool,
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
  } = c;

  /** 给了 onBrushesChange 才显示刷子工具条（不传时行为与旧版完全一致） */
  const brushEnabled = typeof onBrushesChange === 'function';
  const appliedPercent = Math.round(appliedCoverage * 100);

  /**
   * 刷子模式的指针位置（视口坐标）。
   *
   * 刷子模式下不能再弹原来的色号 tooltip（会跟笔刷圈打架），改弹
   * "该处将被怎么处理"的反向命中提示。位置单独存一份，因为 hover
   * 在刷子模式下被主动抑制了。
   */
  const [brushTip, setBrushTip] = useState<{ x: number; y: number } | null>(null);

  // ---- 编辑：色卡与工具 ----
  /**
   * 品牌色卡（全部色号）。
   *
   * 用**全部**色卡而不是当前图案的调色板：手绘的意义恰恰是把图案改成
   * 色卡里另一个颜色，只给 13 个已用色就等于把画笔限制死了。
   * 按色号排序（A01、A02…）而不是按颜色排序 —— 拼豆实物是按色号找豆子的。
   */
  const brandColors = useMemo(() => {
    if (!editEnabled) return [];
    try {
      return [...getBrandPalette(brand)].sort((a, b) =>
        a.code.localeCompare(b.code, 'en', { numeric: true }),
      );
    } catch {
      return [];
    }
  }, [brand, editEnabled]);

  /** 默认画笔色：图案里用量最大的那个色号（用户最可能想继续用颜色） */
  useEffect(() => {
    if (!editEnabled || currentCode) return;
    if (!pattern || pattern.palette.length === 0) return;
    const top = [...pattern.palette].sort((a, b) => b.count - a.count)[0];
    if (top) setCurrentCode(top.code);
  }, [editEnabled, currentCode, pattern, setCurrentCode]);

  /**
   * 桌面端（>= 64rem）编辑布局：色板放右侧竖栏。
   *
   * 用户原话：「如果是手机，面板和色板放在上面没问题，但是电脑在侧边（右边？）
   * 会方便很多」—— 所以形态跟着断点走，不是跟着用户偏好走。
   */
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    getDesktopServerSnapshot,
  );
  /** 色板是否展开。桌面 = 右侧竖栏，手机 = 覆盖在画布上的浮层 */
  const [trayOpen, setTrayOpen] = useState(false);
  /**
   * 进入编辑时按断点给色板初值：桌面展开、手机收起。
   *
   * 桌面展开的理由：竖栏在右，不占画布高度，291 色直接摊开最省事。
   * 手机收起的理由：横条会把画布往下推（用户原话认可"放在上面没问题"，
   * 但高度本来就紧），所以默认收起、点「当前色」再以浮层出现。
   *
   * 写成"渲染期调整 state"而不是 useEffect：effect 里同步 setState 会触发
   * 一轮级联渲染（eslint 的 react-hooks/set-state-in-effect 会直接报错），
   * 而这里要的恰恰是"在渲染同一帧里就按新状态算好"，正是 React 文档里
   * adjusting state when props change 那个模式。跨断点拖窗口也走这条路：
   * 切到手机 → 收起；切回桌面 → 展开。
   */
  const [layoutSeed, setLayoutSeed] = useState({ editing: editActive, desktop: isDesktop });
  if (layoutSeed.editing !== editActive || layoutSeed.desktop !== isDesktop) {
    setLayoutSeed({ editing: editActive, desktop: isDesktop });
    if (editActive) setTrayOpen(isDesktop);
  }
  const trayRef = useRef<HTMLDivElement | null>(null);
  /**
   * 当前色块。
   *
   * 291 个色号，用户记不住位置 —— 选完一个色，高亮块很可能就滚出视野了，
   * 那时"我现在拿的是什么色"立刻断掉。每次当前色变化把它滚回可见区。
   * block:'nearest' 而不是 'center'：后者会让色板每点一下就整块跳一下。
   */
  const activeSwatchRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!trayOpen) return;
    activeSwatchRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentCode, trayOpen]);

  /*
   * 把"画布现在被占着"这件事上报给父组件。
   *
   * 刷区域/编辑都让用户盯着画布，此时画布周边不该有东西在动。父组件拿这个
   * 值决定要不要让巡游桌宠避开 —— 它看不见画布内部的 brushMode / editActive。
   *
   * 用 ref 记住上一次上报的值，只在**真正变化**时回调：这个 effect 的依赖
   * 里有 brushMode 和 editActive，但它们任一变化都必然导致这个值变化，
   * 不做去重就会在父组件里反复触发渲染。
   */
  const lastActivityRef = useRef<CanvasActivity>('idle');
  useEffect(() => {
    const next: CanvasActivity = brushMode
      ? 'brushing'
      : editActive && editEnabled
        ? 'editing'
        : 'idle';
    if (next === lastActivityRef.current) return;
    lastActivityRef.current = next;
    onActivityChange?.(next);
  }, [brushMode, editActive, editEnabled, onActivityChange]);

  const currentBead = useMemo(
    () => brandColors.find((c) => c.code === currentCode) ?? null,
    [brandColors, currentCode],
  );

  /**
   * 291 色按色号首字母分组（A/B/C/…/ZG，共 15 组）。
   *
   * 分组不是为了好看，是为了**可定位**：291 个方块平铺成一片时，用户只能
   * 靠肉眼从左上角扫到右下角找 A26；有了首字母小标题和分组之间的留白，
   * 视线能直接跳到"我要 A 开头"那一段。标题 sticky 在容器顶部，滚到哪
   * 都知道自己在哪一组。
   */
  const colorGroups = useMemo(() => {
    const groups: { prefix: string; colors: typeof brandColors }[] = [];
    for (const bead of brandColors) {
      const match = /^[A-Z]+/.exec(bead.code);
      const prefix = match ? match[0] : '#';
      const last = groups[groups.length - 1];
      if (last && last.prefix === prefix) last.colors.push(bead);
      else groups.push({ prefix, colors: [bead] });
    }
    return groups;
  }, [brandColors]);

  const EDIT_TOOLS: { tool: EditTool; label: string; title: string }[] = [
    { tool: 'pencil', label: '手绘', title: '逐格涂色（可拖动连涂）' },
    { tool: 'eraser', label: '橡皮', title: '把格子擦成空白（不拼豆）' },
    { tool: 'picker', label: '取色', title: '选中某一格的色号作为当前画笔' },
    { tool: 'fill', label: '油漆桶', title: '把同色连通区一次填满当前色号' },
  ];

  const brushRadiusCells = useMemo(() => {
    const longest = pattern ? Math.max(pattern.cols, pattern.rows) : 50;
    return Math.max(1, Math.round(brushRadius * longest));
  }, [pattern, brushRadius]);

  const onSurfacePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (brushMode) {
        setBrushTip({ x: e.clientX, y: e.clientY });
        onBrushPointerMove(e);
        return;
      }
      onPointerMove(e);
      // 编辑模式在 hover 之外还要跟踪"落点格"：hover 是看色号，
      // 编辑是高亮我要下笔的那一格，两者可以同时存在
      if (editActive) onEditPointerMove(e);
    },
    [brushMode, onBrushPointerMove, onPointerMove, editActive, onEditPointerMove],
  );

  const onSurfacePointerLeave = useCallback(() => {
    setBrushTip(null);
    onPointerLeave();
    onEditPointerLeave();
  }, [onPointerLeave, onEditPointerLeave]);

  /**
   * 羽化用"几格"来表述，比 0–1 的小数有用得多 —— 用户想知道的是
   * "这条边会糊几颗豆宽"，而不是一个抽象的百分比。
   * 公式与引擎 buildRegionField 一致：带宽 = 夹在 [1.2, 半径] 的半径×feather。
   */
  const featherCellsLabel = useMemo(() => {
    const longest = pattern ? Math.max(pattern.cols, pattern.rows) : 50;
    const radiusCells = Math.max(1.2, brushRadius * longest);
    const band = Math.min(radiusCells, Math.max(1.2, radiusCells * regionFeather));
    return band < 1.9 ? band.toFixed(1) : String(Math.round(band));
  }, [pattern, brushRadius, regionFeather]);

  const zoomPct = Math.round(zoom * 100);


  /** 缩放控件本体。渲染位置由 portal 决定，状态仍归本组件。 */
  const zoomGroup = (
    <div className="flex items-center gap-1.5">
      {/*
        「Zoom」这个词在 xl 以下藏起来。

        标题栏是 flex-wrap 的，1240px（1600 视口）一行放得下；但 1024–1279
        时标题栏只有 664–920px，塞标题组 + 缩放组 + 六个按钮会超出 9–90px，
        折成两行 —— 那就等于没省下空间，还不如原来固定的两行整齐。
        「− 100% +」本身已经无歧义，这个词是纯装饰，让位于空间。
      */}
      <span className="px-label mr-1 hidden xl:inline" style={{ color: 'var(--ink-3)' }}>
        Zoom
      </span>
      <button
        type="button"
        className="px-btn px-btn-sm"
        onClick={zoomOut}
        disabled={zoom <= ZOOM_MIN + 1e-6}
        title="缩小 (−)"
        aria-label="缩小"
        style={{ minWidth: 32, paddingInline: 0 }}
      >
        −
      </button>
      <button
        type="button"
        className="px-btn px-btn-sm"
        onClick={resetZoom}
        title="重置为 100% (0)"
        style={{ minWidth: 54, fontVariantNumeric: 'tabular-nums' }}
      >
        {zoomPct}%
      </button>
      <button
        type="button"
        className="px-btn px-btn-sm"
        onClick={zoomIn}
        disabled={zoom >= ZOOM_MAX - 1e-6}
        title="放大 (+)"
        aria-label="放大"
        style={{ minWidth: 32, paddingInline: 0 }}
      >
        +
      </button>
    </div>
  );

  /*
   * 整条工具条（缩放组 + 功能开关）要渲染到「04 图纸」标题栏右侧的空槽里，
   * 而不是自己占一行。
   *
   * 用户两次标注：先是「这个东西位置不好，占了一行，下面就会少一行空间给
   * 面板」，把 Zoom 组指到标题栏右侧；Zoom 搬走后又圈出剩下那排
   * 「刷区域/编辑/色号/网格/标尺」说「这个也移植到上面那一行吧，不然看起来
   * 很难受，能省空间就省」。所以整条一起上去，画布上方那 31px + 8px gap
   * 全部还给画布。
   *
   * 容量核算（1600px 视口实测）：标题栏 1240px 宽。左侧标题组 224 +
   * 缩放组 237 + 按钮组 294 + gap 28 = 783，右侧那句说明已按用户要求删掉
   * （「这个删了，不用提示的」），余量 457px。窄屏放不下，所以槽位本身带
   * `hidden lg:flex`，窄屏退回画布上方内联渲染。
   *
   * 为什么用 portal 而不是把 zoom 状态提到 page.tsx：zoom/zoomIn/zoomOut/
   * resetZoom 全在 usePatternCanvas 里，提到父层要新增 5 个 prop 并搬走
   * hook 状态，而"控件画在哪"和"状态归谁"本来就不必绑定。portal 让状态
   * 一动不动，父层只提供一个空节点。
   *
   * 槽找不到时（比如别人复用本组件但没给槽）退回内联渲染，功能不丢。
   */
  const zoomSlot = zoomSlotProp ?? null;
  const cellCss = metrics?.cellCss ?? 12;
  /*
   * 颗数读**叠加编辑后**的数字：手绘加一颗豆，颗数就该 +1；
   * 用引擎值会让人以为"我改了个假的图纸"。这个值还给画布的 aria-label 用。
   */
  const shownTotal = displayPattern?.totalBeads ?? 0;

  // ---- 标尺刻度（HTML，1-based，每 5 格标数字，10 的倍数加粗） ----
  /*
   * 标尺刻度：步长由 hook 按格宽反算（labelStep），保证相邻标签至少有
   * 18px 的间距。320 格时若还死守"每 5 格一个数字"，就是每 20px 一个
   * 三位数，整条标尺糊成一片数字墙。
   *
   * 加粗仍然只跟 10 的倍数有关 —— 那是拼豆板的物理分界。
   */
  const labelStep = ruler.labelStep;
  /*
   * 相邻标签之间的物理间距（CSS px）：字号据此收缩，避免三位数叠在一起。
   *
   * 但只允许缩到 7px —— 再小就失去"能读"的意义了（实测 320 格原来按
   * 系数 0.16 收缩会掉到 6.4px，屏幕放大后是糊的）。间距实在不够时，
   * 优先保字号，让上层的 labelStep 去加大跨度。
   */
  const labelPitch = labelStep * (metrics?.cellCss ?? 12);
  const labelFont = useCallback(
    (bold: boolean) => {
      const cap = bold ? 9.5 : 8.5;
      const scaled = labelPitch / (bold ? 3.4 : 3.9);
      return Math.round(Math.max(7, Math.min(cap, scaled)) * 10) / 10;
    },
    [labelPitch],
  );
  const makeTicks = useCallback(
    (count: number) => {
      const out: { index: number; label: number; bold: boolean }[] = [];
      for (let k = labelStep; k <= count; k += labelStep) {
        out.push({ index: k - 1, label: k, bold: k % 10 === 0 });
      }
      return out;
    },
    [labelStep],
  );

  /**
   * 标尺上的小刻度：在标签之间补短线（不写字），让"每 10 格一格"的
   * 物理分界即使在 3 位数字的稀疏标签下也能被数出来。
   *
   * 只有标签间距 ≥ 2 倍格宽时才补，否则短线和标签会挤在一起。
   */
  const makeMinorTicks = useCallback(
    (count: number) => {
      const out: number[] = [];
      const base = ruler.labelStep >= 10 ? 10 : 5;
      if (base >= labelStep) return out;
      for (let k = base; k <= count; k += base) {
        if (k % labelStep === 0) continue;
        out.push(k - 1);
      }
      return out;
    },
    [labelStep, ruler.labelStep],
  );
  const colMinorTicks = useMemo(
    () => (pattern && showRulers ? makeMinorTicks(pattern.cols) : []),
    [pattern, showRulers, makeMinorTicks],
  );
  const rowMinorTicks = useMemo(
    () => (pattern && showRulers ? makeMinorTicks(pattern.rows) : []),
    [pattern, showRulers, makeMinorTicks],
  );
  const colTicks = useMemo(
    () => (pattern && showRulers ? makeTicks(pattern.cols) : []),
    [pattern, showRulers, makeTicks],
  );
  const rowTicks = useMemo(
    () => (pattern && showRulers ? makeTicks(pattern.rows) : []),
    [pattern, showRulers, makeTicks],
  );

  // ---- 悬停格信息 ----
  /*
   * 悬停读**叠加编辑后**的图案：用户手绘了一颗豆子，鼠标移上去却显示
   * 引擎原来的色号，那是最容易让人怀疑"我刚才那笔没生效"的 bug。
   */
  const hoverInfo = useMemo(() => {
    const shown = displayPattern;
    if (!shown || !hover) return null;
    const idx = shown.cells[hover.row * shown.cols + hover.col];
    const bead = idx >= 0 ? shown.palette[idx] : null;
    return {
      row: hover.row + 1,
      col: hover.col + 1,
      bead,
      rgb: bead ? bead.rgb : null,
      edited: Boolean(editActive && editCursor && editCursor.row === hover.row && editCursor.col === hover.col),
    };
  }, [displayPattern, hover, editActive, editCursor]);

  // 工具提示：fixed + portal，跟着光标走，不会被滚动容器/画布边界裁掉
  const [tipSize, setTipSize] = useState({ w: 168, h: 74 });
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width && r.height && (r.width !== tipSize.w || r.height !== tipSize.h)) {
      setTipSize({ w: r.width, h: r.height });
    }
  }, [hover, tipSize.w, tipSize.h]);

  const tipStyle = useMemo(() => {
    if (!hover) return null;
    const pad = 14;
    const vw = typeof window === 'undefined' ? 0 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 0 : window.innerHeight;
    const flipX = vw > 0 && hover.x + pad + tipSize.w > vw - 8;
    const flipY = vh > 0 && hover.y + pad + tipSize.h > vh - 8;
    return {
      position: 'fixed' as const,
      left: flipX ? undefined : Math.round(hover.x + pad),
      right: flipX ? Math.round(vw - hover.x + pad) : undefined,
      top: flipY ? undefined : Math.round(hover.y + pad),
      bottom: flipY ? Math.round(vh - hover.y + pad) : undefined,
      zIndex: 60,
      minWidth: 150,
    };
  }, [hover, tipSize.w, tipSize.h]);

  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      /*
       * 撤销/重做：Ctrl+Z / Cmd+Z，以及 Ctrl+Shift+Z / Ctrl+Y 重做。
       *
       * 放在最前面，且**不管编辑模式开没开**都生效 —— 撤销是对已发生的
       * 操作的回退，不该要求用户先切进某个模式。刷区域的隐式应用也在这
       * 条历史里（见 hook 的 applyPending），所以刷完直接 Ctrl+Z 就能退。
       */
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoEdit();
        else undoEdit();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoEdit();
        return;
      }
      // 编辑模式下的工具快捷键（1–4），Esc 退出
      if (editActive && !mod) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setEditActive(false);
          onEditPointerLeave();
          return;
        }
        const toolKey: Record<string, EditTool> = {
          '1': 'pencil',
          '2': 'eraser',
          '3': 'picker',
          '4': 'fill',
        };
        const t = toolKey[e.key];
        if (t) {
          e.preventDefault();
          setEditTool(t);
          return;
        }
      }
      // 刷子模式下的三键：Enter 提交、Esc 取消选区（草稿为空才退出刷子）、
      // Delete/Backspace 走撤销（与按钮同一套优先级：先草稿后已应用）
      if (brushMode) {
        if (e.key === 'Enter' && pendingCount > 0) {
          e.preventDefault();
          applyPending();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (pendingCount > 0) cancelPending();
          else setBrushMode(false);
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          undoBrush();
          return;
        }
      }
      if (e.key === 'Escape' && brushMode) {
        e.preventDefault();
        setBrushMode(false);
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetZoom();
      }
    },
    [
      zoomIn,
      zoomOut,
      resetZoom,
      brushMode,
      setBrushMode,
      pendingCount,
      applyPending,
      cancelPending,
      undoBrush,
      undoEdit,
      redoEdit,
      editActive,
      setEditTool,
      onEditPointerLeave,
    ],
  );

  /*
   * 全局撤销快捷键。
   *
   * scrollRef 上的 onKeyDown 只在容器有焦点时触发，而用户点完色卡/按钮后
   * 焦点就跑到按钮上了 —— 那时 Ctrl+Z 会落到按钮身上，"撤销不灵"的印象
   * 就是这么来的。这里再挂一个 window 监听兜底：
   *   - 焦点在输入框/文本域里时让路（那里 Ctrl+Z 是撤销输入，不能抢）；
   *   - 有组合键修饰（shift/alt）且不是 shift+z 的，也不抢。
   */
  useEffect(() => {
    /*
     * 挂的条件是"有可撤销的东西"，不能只看 editEnabled —— 刷区域的隐式应用
     * 也要能 Ctrl+Z 撤销（lead 明确要求），而刷区域不依赖编辑层。
     */
    if (!editEnabled && !brushEnabled) return;
    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) redoEdit();
        else undoEdit();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redoEdit();
      }
    };
    window.addEventListener('keydown', onWindowKey);
    return () => window.removeEventListener('keydown', onWindowKey);
  }, [editEnabled, brushEnabled, undoEdit, redoEdit]);

  // ---------------------------------------------------------------- 空状态
  if (!pattern || !hasPattern) {
    return (
      <div
        className={['relative flex flex-col', className].filter(Boolean).join(' ')}
        style={fill ? { height: '100%', minHeight: 0 } : undefined}
      >
        <div
          className="px-inset flex flex-col items-center justify-center gap-4 px-6 py-10 text-center"
          style={
            fill
              ? { flex: '1 1 auto', minHeight: 240 }
              : { minHeight: 300, flex: '1 1 auto' }
          }
        >
          <EmptyBeadArt />
          <p className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
            还没有生成图案
          </p>
          <p className="max-w-[36ch] text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            上传一张图、选好图纸尺寸与颜色数，点「生成图案」后这里会显示逐颗可数、带色号的拼豆图纸。
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- 主视图
  const { cols, rows } = pattern;
  const cssW = metrics?.cssW ?? 0;
  const cssH = metrics?.cssH ?? 0;

  const toggleBtn = (
    active: boolean,
    label: string,
    onClick: () => void,
    title: string,
    disabled = false,
  ) => (
    <button
      type="button"
      className="px-btn px-btn-sm"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      style={
        active
          ? { background: 'var(--clay)', borderColor: 'var(--clay-deep)', color: 'var(--on-clay)' }
          : undefined
      }
    >
      {label}
    </button>
  );

  /** 功能开关组。和 zoomGroup 一起被 portal 到标题栏，或窄屏时留在画布上方。 */
  const toolbarButtons = (
    <div className="flex flex-wrap items-center gap-1.5">
      {brushEnabled &&
        toggleBtn(
          brushMode,
          brushMode ? '退出刷子' : '刷区域',
          // 退出时若有未提交的草稿，自动应用（见 hook 里 exitBrushMode 的注释）
          () => (brushMode ? exitBrushMode() : setBrushMode(true)),
          '在图上刷一块区域，用不同的精细度算法重算（其余部分不变）',
        )}
      {editEnabled &&
        toggleBtn(
          editActive,
          editActive ? '退出编辑' : '编辑',
          () => {
            setEditActive((v) => {
              if (v) onEditPointerLeave(); // 关掉时清掉落点方框
              return !v;
            });
            // 编辑与刷区域互斥：两套拖动语义打架
            if (brushMode) setBrushMode(false);
          },
          '手工改格子：手绘 / 橡皮 / 取色 / 油漆桶（可 Ctrl+Z 撤销）',
        )}
      {toggleBtn(showCodes, '色号', () => setShowCodes((v) => !v), '显示/隐藏每颗豆子的色号')}
      {toggleBtn(showGrid, '网格', () => setShowGrid((v) => !v), '显示/隐藏网格线')}
      {toggleBtn(showRulers, '标尺', () => setShowRulers((v) => !v), '显示/隐藏行列标尺')}
      {/*
        「区域标记」必须常驻这一排。
        早先它挂在刷子工具条里，退出刷子模式后按钮消失，而遮罩还在图上
        —— 用户再也关不掉那块覆盖层（实测：退出后 mask 仍有 56,689 像素
        在显示，但按钮已经不存在了）。现在和色号/网格/标尺同排，任何时候
        都能关。pending/live 不受它影响，见 drawRegionMask 的注释。
      */}
      {appliedCount > 0 &&
        toggleBtn(
          showRegionOverlay,
          '区域标记',
          () => setShowRegionOverlay((v) => !v),
          '显示/隐藏已应用区域的标记（陶土色底纹+虚线轮廓）。待应用草稿与拖动预览不受此开关影响',
        )}
    </div>
  );


  return (
    <div
      ref={hostRef}
      className={['relative flex flex-col gap-2', className].filter(Boolean).join(' ')}
      style={
        fill
          ? {
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              /*
               * 移动端/窄高容器里，工具条（尤其刷区域那一整块）可能比可用高度
               * 还高，把下面的画布区挤成一条缝 —— 实测 390×844 进刷子模式后
               * 画布可视区只剩 4px，手指在上面拖，屏幕上什么都看不到。
               * 这里让外层自己滚：画布区留着最小可用高度（见 scrollRef 的
               * minHeight），超出的部分由 host 内部滚动消化，不改页面的总高。
               */
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }
          : undefined
      }
    >
      {/* ---------------- 工具条 ----------------
          桌面端整条搬到「04 图纸」标题栏右侧（见下方 toolbar 的注释）。
          这里只在窄屏 / 没有槽位时兜底渲染 —— 那些情况下标题栏放不下
          六个按钮，留在画布上方独占一行才是可用的。

          剩下的功能开关单独一行时不能用 justify-between（会把它顶到右端），
          用 justify-end 保持和标题栏动作按钮一条竖线。 */}
      {!(zoomSlot && isDesktop) && (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {zoomGroup}
          {toolbarButtons}
        </div>
      )}

      {/*
        编辑区外壳：桌面 = 左画布 + 右色板竖栏；手机 = 单列（色板以浮层出现）。

        结构上的重点在**外层这一个 flex 行**：桌面两栏时画布列 flex-1、色板列
        flex-none，于是"色板占多少宽"与"画布占多少高"完全解耦 —— 色板再高也
        不会把画布顶下去（这正是原来横条版的问题：色卡一展开 92px，画布矮了
        92px）。手机上这个行仍是 column，色板改绝对定位浮在画布上，同样不推挤
        画布高度。
      */}
      <div
        className="flex min-h-0 min-w-0 gap-2"
        style={{
          flex: useFill ? '1 1 auto' : undefined,
          flexDirection: isDesktop && editActive ? 'row' : 'column',
          // 非 fill（老行为）时不让这一层撑高，交给里面原来的限高逻辑
          minHeight: 0,
        }}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {/* ---------------- 编辑工具条（父组件接管 edits 时出现） ---------------- */}
          {editEnabled && editActive && (
            <div
              className="px-panel-flat flex flex-col gap-2 px-2.5 py-2"
              role="region"
              aria-label="编辑工具条"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/* 四个工具 */}
                <div className="flex items-center gap-1" role="group" aria-label="编辑工具">
                  {EDIT_TOOLS.map(({ tool, label, title }) => {
                    const active = editTool === tool;
                    return (
                      <button
                        key={tool}
                        type="button"
                        className="px-btn px-btn-sm inline-flex items-center gap-1.5"
                        aria-pressed={active}
                        title={title}
                        onClick={() => setEditTool(tool)}
                        data-testid={`tool-${tool}`}
                        style={
                          active
                            ? {
                                background: 'var(--clay)',
                                borderColor: 'var(--clay-deep)',
                                color: 'var(--on-clay)',
                              }
                            : { padding: '4px 7px' }
                        }
                      >
                        <PixelCursor
                          kind={
                            tool === 'pencil'
                              ? 'pencil'
                              : tool === 'eraser'
                                ? 'eraser'
                                : tool === 'picker'
                                  ? 'picker'
                                  : 'fill'
                          }
                          size={14}
                        />
                        <span className="text-[11px]">{label}</span>
                      </button>
                    );
                  })}
                </div>

                {/*
                  当前色 + 展开色卡。
                  桌面端它仍然是色板竖栏的开关（此时色号的大预览在右侧栏顶）；
                  手机端它是唯一入口 —— 点击才浮出色板，不常驻。
                */}
                <button
                  type="button"
                  className="px-btn px-btn-sm inline-flex items-center gap-1.5"
                  onClick={() => setTrayOpen((v) => !v)}
                  aria-expanded={trayOpen}
                  title={
                    trayOpen
                      ? isDesktop
                        ? '收起右侧色板，让画布变宽'
                        : '收起色板'
                      : isDesktop
                        ? '展开右侧色板'
                        : '展开色板选色'
                  }
                  data-testid="toggle-tray"
                >
                  {currentBead ? (
                    <PixelSwatch hex={currentBead.hex} size={16} />
                  ) : (
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        background: 'var(--paper-sunken)',
                        border: '1px solid var(--line-strong)',
                        display: 'inline-block',
                      }}
                    />
                  )}
                  <span className="font-px text-[11px] font-bold" style={{ color: 'var(--ink)' }}>
                    {currentCode || '—'}
                  </span>
                  <span style={{ color: 'var(--ink-3)' }}>{trayOpen ? '▲' : '▼'}</span>
                </button>

                {/* 撤销 / 重做 / 清除手改 */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="px-btn px-btn-sm"
                    onClick={undoEdit}
                    disabled={!canUndoEdit}
                    title="撤销上一步（Ctrl+Z）"
                    data-testid="undo-edit"
                  >
                    撤销
                  </button>
                  <button
                    type="button"
                    className="px-btn px-btn-sm"
                    onClick={redoEdit}
                    disabled={!canRedoEdit}
                    title="重做（Ctrl+Shift+Z / Ctrl+Y）"
                    data-testid="redo-edit"
                  >
                    重做
                  </button>
                  <button
                    type="button"
                    className="px-btn px-btn-sm"
                    onClick={clearEdits}
                    disabled={editedCount === 0}
                    title="把所有手改格子恢复成引擎生成的样子（可撤销）"
                    data-testid="clear-edits"
                  >
                    还原
                  </button>
                </div>

                {editedCount > 0 && (
                  <span
                    className="px-tag px-tag-gold"
                    style={{ fontSize: 10 }}
                    data-testid="tag-edited"
                  >
                    手改 {editedCount} 格
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ---------------- 刷区域工具条（只在父组件接管 brushes 时出现） ---------------- */}
          {brushEnabled && brushMode && (
        <div
          className="px-panel-flat flex flex-wrap items-center gap-x-3 gap-y-2 px-2.5 py-2"
          role="region"
          aria-label="刷区域工具条"
        >
          {/* 算法分段按钮 */}
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="区域精细度算法">
            <span className="px-label mr-0.5" style={{ color: 'var(--ink-3)' }}>
              区域算法
            </span>
            {DETAIL_ALGORITHMS.map((algo) => {
              const meta = DETAIL_META[algo];
              const active = brushAlgorithm === algo;
              return (
                <button
                  key={algo}
                  type="button"
                  className="px-btn px-btn-sm"
                  aria-pressed={active}
                  title={`${meta.blurb}（适合：${meta.best}）`}
                  onClick={() => setBrushAlgorithm(algo as DetailAlgorithm)}
                  style={
                    active
                      ? {
                          background: 'var(--clay)',
                          borderColor: 'var(--clay-deep)',
                          color: 'var(--on-clay)',
                        }
                      : { padding: '4px 8px', fontSize: 11 }
                  }
                >
                  {meta.short}
                </button>
              );
            })}
          </div>

          {/* 笔刷大小 */}
          <label className="flex min-w-[150px] flex-1 items-center gap-2">
            <span className="px-label whitespace-nowrap" style={{ color: 'var(--ink-3)' }}>
              笔刷 {Math.round(brushRadius * 100)}%
            </span>
            <Slider
              className={SLIDER_CLASSES}
              value={[Math.round(brushRadius * 1000)]}
              onValueChange={(vals) =>
                setBrushRadius((vals[0] ?? brushRadius * 1000) / 1000)
              }
              min={Math.round(BRUSH_RADIUS_MIN * 1000)}
              max={Math.round(BRUSH_RADIUS_MAX * 1000)}
              step={5}
              aria-label="笔刷大小"
            />
          </label>

          {/* 羽化 */}
          {onRegionFeatherChange && (
            <label className="flex min-w-[160px] flex-1 items-center gap-2">
              <span className="px-label whitespace-nowrap" style={{ color: 'var(--ink-3)' }}>
                过渡 {featherCellsLabel} 格
              </span>
              <Slider
                className={SLIDER_CLASSES}
                value={[Math.round(regionFeather * 100)]}
                onValueChange={(vals) =>
                  onRegionFeatherChange(
                    Math.min(FEATHER_MAX, Math.max(FEATHER_MIN, (vals[0] ?? 55) / 100)),
                  )
                }
                min={Math.round(FEATHER_MIN * 100)}
                max={Math.round(FEATHER_MAX * 100)}
                step={1}
                aria-label="区域羽化"
              />
            </label>
          )}

          {/*
            两步式的核心按钮，放在撤销/清空左边 —— 它才是这个工具条里
            用户唯一"必须点"的动作，位置和 primary 配色都要压过其它按钮。
          */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="px-btn px-btn-primary px-btn-sm"
              onClick={applyPending}
              disabled={pendingCount === 0}
              title="把这批选区交给引擎重算（Enter）"
              data-testid="apply-region"
              style={{ fontWeight: 700 }}
            >
              应用重建
              {pendingCount > 0 && (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  （{pendingCount} 处 · 覆盖约 {pendingLabel.percent}%）
                </span>
              )}
              {pendingCount === 0 && livePreview.active && (
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75 }}>
                  （涂抹中 · 约 {livePreview.percent}%）
                </span>
              )}
            </button>
            {pendingCount > 0 && (
              <button
                type="button"
                className="px-btn px-btn-sm"
                onClick={cancelPending}
                title="丢弃当前选区，不影响已应用区域（Esc）"
                data-testid="cancel-region"
              >
                取消选区
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="px-btn px-btn-sm"
              onClick={undoBrush}
              disabled={!canUndo}
              title={
                pendingCount > 0 ? '撤销草稿里最后一处（不影响已应用）' : '撤销已应用的最后一处'
              }
            >
              撤销
            </button>
            <button
              type="button"
              className="px-btn px-btn-sm"
              onClick={clearBrushes}
              disabled={!canUndo}
              title={pendingCount > 0 ? '清空草稿（不影响已应用）' : '清空所有已应用区域'}
            >
              清空
            </button>
          </div>

          {/* 两段摘要：已应用（陶土）/ 待应用（天空蓝），状态一眼分得开 */}
          {appliedCount > 0 && (
            <span
              className="px-tag px-tag-clay"
              style={{ fontSize: 10 }}
              data-testid="tag-applied"
            >
              已应用 {appliedCount} 处 · 覆盖约 {appliedPercent}%
              {regionSummary.algorithms.length > 0 && (
                <span style={{ opacity: 0.75 }}>
                  {' '}
                  · {regionSummary.algorithms.map((a) => DETAIL_META[a].short).join('+')}
                </span>
              )}
            </span>
          )}
          {pendingCount > 0 && (
            <span
              className="px-tag px-tag-sky"
              style={{ fontSize: 10 }}
              data-testid="tag-pending"
            >
              待应用 {pendingCount} 处 · 覆盖约 {pendingLabel.percent}%
            </span>
          )}
          {/* 拖动中：pending 还没落地，但用户需要看到数字在涨 */}
          {pendingCount === 0 && livePreview.active && (
            <span
              className="px-tag px-tag-sky"
              style={{ fontSize: 10, opacity: 0.8 }}
              data-testid="tag-live"
            >
              涂抹中 · 约 {livePreview.percent}%
            </span>
          )}
          {isWorking && (
            <span
              className="px-tag px-tag-gold inline-flex items-center gap-1.5"
              style={{ fontSize: 10 }}
              data-testid="region-working"
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  background: 'var(--gold)',
                  animation: 'px-blink 1s steps(2) infinite',
                }}
              />
              重算区域中…
            </span>
          )}
        </div>
      )}

      {/*
        刷子模式下的用法提示。
        用户第一次进来最容易卡在"我拖了半天怎么什么都没变"——因为他不知道
        要先点「应用重建」。这行字直接把三步写出来，比任何 tooltip 都省事。
      */}
      {brushEnabled && brushMode && (
        <p
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-snug"
          style={{ color: 'var(--ink-2)' }}
          data-testid="brush-hint"
        >
          <span
            aria-hidden
            style={{ width: 6, height: 6, flex: 'none', background: 'var(--sky)' }}
          />
          拖动涂抹选区 →
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>点「应用重建」</span>→
          只重算选中区域
          <span style={{ color: 'var(--ink-3)' }}>
            （拖动时图案不变是正常的；Enter 应用 · Esc 取消）
          </span>
        </p>
      )}

      {/*
        超大图案的量级提示。
        320 格是 8.6 万颗豆 —— 一个人闷头拼要几十小时，真实做法是拆成
        拼豆板分块做。这个信息直接影响用户要不要换小尺寸，所以直接写在
        画布上方，不弹窗、不打断。
      */}
      {pattern && pattern.cols * pattern.rows > 40000 && (
        <p
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-snug"
          style={{ color: 'var(--ink-2)' }}
          data-testid="big-hint"
        >
          <span
            aria-hidden
            style={{ width: 6, height: 6, flex: 'none', background: 'var(--clay)' }}
          />
          约
          <span className="font-px tabular-nums" style={{ color: 'var(--ink)', fontWeight: 700 }}>
            {(shownTotal / 10000).toFixed(1)} 万
          </span>
          颗豆，建议分板制作
          <span style={{ color: 'var(--ink-3)' }}>
            （{pattern.cols}×{pattern.rows} 格 · 可放大看局部）
          </span>
        </p>
      )}

          {/*
            画布外框：单独包一层，只为了给手机色板一个**不参与排版**的定位父级。

            手机色板用 absolute 浮在画布上（见下面 trayOpen 的浮层），如果直接
            挂在画布滚动容器里，absolute 会跟着画布内容一起滚走；挂在编辑工具条
            那层又会把工具条盖住。所以这里多一层 relative 的壳，浮层贴在画布
            上沿，画布高度完全不被它推挤。
          */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* ---------------- 画布区 ---------------- */}
            <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="px-inset relative"
        style={{
          // 不能有 padding：滚动时内容会滑进 padding 区，从 sticky 标尺左侧/上方漏出来
          padding: 0,
          // useFill 时由 flex 吃掉父容器剩余高度；否则沿用原来的限高行为
          maxHeight: useFill ? 'none' : 'min(70vh, 780px)',
          flex: useFill ? '1 1 auto' : undefined,
          // 给画布区留一块**能用手指画**的高度下限（0 会被工具条挤成 4px）
          minHeight: useFill ? 200 : undefined,
          overflow: 'auto',
          overscrollBehavior: 'contain',
          display: 'flex',
          justifyContent: 'safe center',
          alignItems: 'safe center',
          outline: 'none',
          scrollbarGutter: 'stable',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: showRulers ? `${RULER_LEFT}px ${cssW}px` : `${cssW}px`,
            gridTemplateRows: showRulers ? `${RULER_TOP}px ${cssH}px` : `${cssH}px`,
            flex: 'none',
          }}
        >
          {/* 左上角 */}
          {showRulers && (
            <div
              className="px-ruler flex items-center justify-center"
              style={{
                position: 'sticky',
                left: 0,
                top: 0,
                zIndex: 3,
                borderWidth: 0,
                borderRightWidth: 2,
                borderBottomWidth: 2,
                borderStyle: 'solid',
                borderColor: 'var(--line-strong)',
                background: 'var(--paper-sunken)',
                fontSize: 8,
                letterSpacing: '0.04em',
                color: 'var(--ink-3)',
              }}
            >
              R\C
            </div>
          )}

          {/* 顶部标尺：列 */}
          {showRulers && (
            <div
              className="px-ruler"
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                height: RULER_TOP,
                borderWidth: 0,
                borderBottomWidth: 2,
                borderStyle: 'solid',
                borderColor: 'var(--line-strong)',
                backgroundImage: ruler.tickBgTop,
                backgroundColor: 'var(--paper-sunken)',
                overflow: 'visible',
              }}
            >
              {colTicks.map((t) => (
                <span
                  key={`c${t.label}`}
                  style={{
                    position: 'absolute',
                    left: (t.index + 0.5) * cellCss,
                    bottom: 3,
                    transform: 'translateX(-50%)',
                    fontWeight: t.bold ? 700 : 400,
                    color: t.bold ? 'var(--ink)' : 'var(--ink-2)',
                    /*
                     * 字号跟着可用间距收缩：320 格 / 100% 时每格 4px、
                     * 标签步长 25 → 间距 100px，9.5px 放得下；但 50 格
                     * 缩到 50% 时步长 10 → 间距只有 50px，三位数在这个
                     * 位置还是偏挤，缩到 8px 更稳。
                     */
                    fontSize: labelFont(t.bold),
                    lineHeight: 1,
                    letterSpacing: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t.label}
                </span>
              ))}
              {/* 标签之间的小刻度：不写字，只标出 10 格分界，方便数格 */}
              {colMinorTicks.map((index) => (
                <span
                  key={`cm${index}`}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: (index + 0.5) * cellCss,
                    bottom: 0,
                    transform: 'translateX(-50%)',
                    width: 1,
                    height: 2,
                    background: 'var(--ink-3)',
                    opacity: 0.7,
                  }}
                />
              ))}
              {/* 标签正下方的短刻度：把数字明确指向它命名的那一列（cell 中心） */}
              {colTicks.map((t) => (
                <span
                  key={`ct${t.label}`}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: (t.index + 0.5) * cellCss,
                    bottom: 0,
                    transform: 'translateX(-50%)',
                    width: 2,
                    height: t.bold ? 3 : 2,
                    background: t.bold ? 'var(--ink)' : 'var(--ink-3)',
                  }}
                />
              ))}
            </div>
          )}

          {/* 左侧标尺：行 */}
          {showRulers && (
            <div
              className="px-ruler"
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 2,
                width: RULER_LEFT,
                borderWidth: 0,
                borderRightWidth: 2,
                borderStyle: 'solid',
                borderColor: 'var(--line-strong)',
                backgroundImage: ruler.tickBgLeft,
                backgroundColor: 'var(--paper-sunken)',
              }}
            >
              {rowTicks.map((t) => (
                <span
                  key={`r${t.label}`}
                  style={{
                    position: 'absolute',
                    top: (t.index + 0.5) * cellCss,
                    right: 4,
                    transform: 'translateY(-50%)',
                    fontWeight: t.bold ? 700 : 400,
                    color: t.bold ? 'var(--ink)' : 'var(--ink-2)',
                    fontSize: labelFont(t.bold),
                    lineHeight: 1,
                    letterSpacing: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t.label}
                </span>
              ))}
              {rowMinorTicks.map((index) => (
                <span
                  key={`rm${index}`}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    top: (index + 0.5) * cellCss,
                    right: 0,
                    transform: 'translateY(-50%)',
                    height: 1,
                    width: 2,
                    background: 'var(--ink-3)',
                    opacity: 0.7,
                  }}
                />
              ))}
              {rowTicks.map((t) => (
                <span
                  key={`rt${t.label}`}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    top: (t.index + 0.5) * cellCss,
                    right: 0,
                    transform: 'translateY(-50%)',
                    height: 2,
                    width: t.bold ? 3 : 2,
                    background: t.bold ? 'var(--ink)' : 'var(--ink-3)',
                  }}
                />
              ))}
            </div>
          )}

          {/* 画布本体 */}
          <div
            ref={surfaceRef}
            data-canvas-surface=""
            onPointerMove={onSurfacePointerMove}
            onPointerLeave={onSurfacePointerLeave}
            onPointerDown={
              brushMode ? onBrushPointerDown : editActive ? onEditPointerDown : undefined
            }
            onPointerUp={brushMode ? onBrushPointerUp : editActive ? onEditPointerUp : undefined}
            onPointerCancel={
              brushMode ? onBrushPointerUp : editActive ? onEditPointerUp : undefined
            }
            style={{
              position: 'relative',
              width: cssW,
              height: cssH,
              cursor: brushMode
                ? 'none'
                : editActive
                  ? editTool === 'picker'
                    ? 'copy'
                    : 'crosshair'
                  : cellCss >= 8
                    ? 'crosshair'
                    : 'default',
              // 刷子/编辑模式都要吃掉触摸手势（否则手指一拖就变成滚动页面），
              // 其它情况保持可以滚动/双指缩放
              touchAction: brushMode || editActive ? 'none' : 'auto',
            }}
          >
            {/* 透出"这些地方不用拼豆"的棋盘格 */}
            <div
              className="px-checker absolute inset-0"
              style={{ border: '1px solid var(--line)' }}
              aria-hidden
            />
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`拼豆图案 ${cols} 列 × ${rows} 行，共 ${shownTotal} 颗`}
              style={{
                position: 'absolute',
                inset: 0,
                width: cssW,
                height: cssH,
                display: 'block',
                imageRendering: 'pixelated',
              }}
            />
            {/* 区域遮罩：独立一层，图案本体保持纯净 */}
            <canvas
              ref={maskRef}
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                width: cssW,
                height: cssH,
                display: 'block',
                pointerEvents: 'none',
                // 不按 showRegionOverlay 一刀切：那个开关只管"已应用"的历史标记，
                // 待应用草稿与拖动预览是"正在进行的操作"，必须始终可见
                opacity: 1,
                transition: 'opacity 0.12s linear',
              }}
            />
            {/* 交互层：hover 高亮 / 笔刷圆环（两者互斥） */}
            <canvas
              ref={overlayRef}
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                width: cssW,
                height: cssH,
                display: 'block',
                pointerEvents: 'none',
                imageRendering: 'pixelated',
              }}
            />

          </div>
        </div>
            </div>

            {/*
              手机色板：**覆盖**在画布上的浮层，不推挤画布高度。

              为什么不选"展开时压缩画布"：压缩那条路已经在原来横条版里试过了
              —— 92px 的横条把 390×844 的画布挤到只剩 216px 高，正好落进
              "看不清也点不准"的区间。浮层方案下画布高度完全不变，色板占的
              是用户"正在选色、暂时不画"的那几秒，选完收起即可。

              定位在这一层（画布外壳）而不是画布滚动容器里：后者会跟着画布
              内容一起滚走；也不在工具条那层，否则会盖住工具条。

              **铺满画布区**（inset-0）而不是只占顶上一条：手机画布区本身只有
              约 207px 高，浮层若只取 46% 就只剩 95px —— 28px 的色块只放得下
              两行，291 色要翻二十屏。铺满之后色块区有 150px 以上，一屏能看
              6 行，翻五屏左右看完。代价是选色时看不见画布，但这本来就是
              "先选色、再回去画"的两段式操作，收起即恢复。
            */}
            {!isDesktop && editEnabled && editActive && trayOpen && (
              <div
                className="px-panel absolute inset-0 z-30 flex flex-col"
                style={{
                  background: 'var(--paper-raised)',
                  boxShadow: 'var(--shadow-px)',
                }}
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  {/*
                    当前色大样也在手机上出现，但只在这个浮层里 —— 平时常驻
                    会白占 40px 高度，而那正是手机上最缺的东西。选色时用户
                    的目光本来就在这块面板上，把色号/hex/RGB 放这里正好。
                  */}
                  {currentBead ? (
                    <PixelSwatch hex={currentBead.hex} size={SWATCH_MOBILE} />
                  ) : (
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        flex: 'none',
                        background: 'var(--paper-sunken)',
                        border: '2px solid var(--line-strong)',
                        display: 'inline-block',
                      }}
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="font-px text-[12px] leading-none font-bold"
                      style={{ color: 'var(--ink)' }}
                    >
                      {currentBead?.code ?? '—'}
                      <span
                        className="ml-1.5 text-[9px] font-normal tabular-nums"
                        style={{ color: 'var(--ink-3)' }}
                      >
                        {currentBead ? currentBead.hex.toUpperCase() : ''}
                      </span>
                    </span>
                    <span
                      className="font-px text-[9px] leading-none tabular-nums"
                      style={{ color: 'var(--ink-3)' }}
                    >
                      {currentBead
                        ? `RGB ${currentBead.rgb.r},${currentBead.rgb.g},${currentBead.rgb.b} · 共 ${brandColors.length} 色`
                        : `共 ${brandColors.length} 色`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="px-btn px-btn-sm"
                    onClick={() => setTrayOpen(false)}
                    title="收起色板"
                  >
                    收起
                  </button>
                </div>
                <div
                  ref={trayRef}
                  className="px-inset min-h-0 flex-1 overflow-y-auto p-1.5"
                  data-testid="color-tray"
                  aria-label="品牌色卡"
                  style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 4 }}
                >
                  {brandColors.map((bead) => {
                    const active = bead.code === currentCode;
                    return (
                      <PixelSwatch
                        key={bead.code}
                        hex={bead.hex}
                        code={bead.code}
                        /*
                          手机上 22px 是"看"的尺寸，不是"点"的尺寸：手指落点
                          有 8–10px 抖动，22px 的方块点准一格很费劲。28px 是
                          能稳定点中的下限，再大就一屏放不下几个色了。
                        */
                        size={SWATCH_MOBILE}
                        selected={active}
                        title={`${bead.code} · ${bead.hex.toUpperCase()}（${bead.rgb.r},${bead.rgb.g},${bead.rgb.b}）`}
                        onClick={() => setCurrentCode(bead.code)}
                      />
                    );
                  })}
                  {brandColors.length === 0 && (
                    <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>
                      这个品牌没有色卡数据
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/*
            手机端不额外加「当前色」横条。
            390×844 上编辑态的画布只剩 200 出头，下方再挂一行 40px 就把它
            压到 160 —— 那正是这次要修的问题。当前色的信息放进色板浮层的
            头部（见上面的浮层），不常驻、不占高度；平时 tool 按钮上的
            16px 小色块 + 色号已经够提示"我现在拿的是什么"。
          */}
        </div>

        {/*
          桌面端色板竖栏。

          宽度 200px 是量出来的：291 色要在大约两屏内看完，同时不能把画布压窄
          —— 1244px 的中栏里，198px 侧栏 + 2px 边框 + 8px 间隙之后，画布仍有
          约 1030px，方形图能撑到 1000 以上。再宽就明显开始抢画布了。

          它是 flex-none：画布列 flex-1 吃掉其余宽度，所以"侧栏多宽"与"画布多高"
          完全无关 —— 这正是原来横条版做不到的。
        */}
        {isDesktop && editEnabled && editActive && trayOpen && (
          <aside
            className="px-panel flex flex-none flex-col"
            aria-label="品牌色板"
            style={{ width: TRAY_RAIL_W }}
          >
            {/* 当前色大样：32×32 色块 + 色号 + hex + RGB */}
            <div
              className="flex items-center gap-2 border-b-2 px-2 py-2"
              style={{ borderColor: 'var(--line-strong)' }}
            >
              {currentBead ? (
                <PixelSwatch hex={currentBead.hex} size={32} />
              ) : (
                <span
                  style={{
                    width: 32,
                    height: 32,
                    background: 'var(--paper-sunken)',
                    border: '2px solid var(--line-strong)',
                    display: 'inline-block',
                    flex: 'none',
                  }}
                />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span
                  className="font-px text-[14px] leading-none font-bold"
                  style={{ color: 'var(--ink)' }}
                >
                  {currentBead?.code ?? '—'}
                </span>
                {currentBead && (
                  <>
                    <span
                      className="font-px text-[10px] leading-none tabular-nums"
                      style={{ color: 'var(--ink-2)' }}
                    >
                      {currentBead.hex.toUpperCase()}
                    </span>
                    <span
                      className="font-px text-[10px] leading-none tabular-nums"
                      style={{ color: 'var(--ink-3)' }}
                    >
                      RGB {currentBead.rgb.r},{currentBead.rgb.g},{currentBead.rgb.b}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* 色号网格：7 列 × 24px + 2px 间隙 = 侧栏内宽正好吃满 */}
            <div
              ref={trayRef}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
              data-testid="color-tray"
              aria-label="品牌色卡"
            >
              {colorGroups.map((group) => (
                <div key={group.prefix} className="mb-1.5">
                  <div
                    className="font-px sticky top-0 z-10 mb-1 text-[9px] uppercase tracking-[0.12em]"
                    style={{
                      color: 'var(--ink-3)',
                      background: 'var(--paper-raised)',
                      paddingBlock: 1,
                    }}
                  >
                    {group.prefix}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(7, ${SWATCH_DESKTOP}px)`,
                      gap: 2,
                    }}
                  >
                    {group.colors.map((bead) => {
                      const active = bead.code === currentCode;
                      return (
                        <span
                          key={bead.code}
                          ref={active ? activeSwatchRef : undefined}
                          style={{ display: 'inline-flex' }}
                        >
                          <PixelSwatch
                            hex={bead.hex}
                            code={bead.code}
                            size={SWATCH_DESKTOP}
                            selected={active}
                            title={`${bead.code} · ${bead.hex.toUpperCase()}（${bead.rgb.r},${bead.rgb.g},${bead.rgb.b}）`}
                            onClick={() => setCurrentCode(bead.code)}
                          />
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
              {brandColors.length === 0 && (
                <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>
                  这个品牌没有色卡数据
                </span>
              )}
            </div>
          </aside>
        )}
      </div>

      {/*
        这里原来有一条统计条：格数 / 颗数 / 色数 / 品牌 / 成品尺寸 / 平均色差 /
        每格像素与 DPR。全删了。

        理由：这些数字在别处都能看到 —— 页头有「颗数 / 色数 / 格数」三个 tag，
        用料清单里有逐色颗数与建议备货量，尺寸在图纸标题里写着。画布下方再铺
        一整排，等于把同一组数字在同一屏里印两遍，还占掉 40px 宽度给画布。
        用户原话：「右侧主要是画板就行，下面那个不需要有」。

        只保留 DPR 那一项的信息量没有替代品，但它是给开发核对渲染质量的，
        不是用户要看的东西 —— 真要查，devtools 里量一下更准。
      */}

      {/*
        缩放控件搬到 04「图纸」标题栏右侧的空槽里。
        见上方 zoomGroup 的注释：状态留在本组件，只有渲染位置搬走。

        只在桌面端搬：那块槽位在 lg 以下被 `hidden` 掉（手机上标题栏连
        「拖动画布可平移…」那句都放不下，塞六个缩放按钮会把标题挤成一团），
        此时上面的 `!(zoomSlot && isDesktop)` 条件会把它退回工具条内联渲染。
        portal 这边必须用同一个条件，否则窄屏会渲染两遍。
      */}
      {zoomSlot &&
        isDesktop &&
        createPortal(
          <div className="flex items-center gap-2.5">
            {zoomGroup}
            {toolbarButtons}
          </div>,
          zoomSlot,
        )}

      {/* 刷子模式的反向命中提示：告诉用户"这一笔会把这处变成什么" */}
      {brushMode &&
        brushTip &&
        createPortal(
          <div
            className="px-tooltip"
            data-testid="brush-tooltip"
            style={{
              position: 'fixed',
              left: Math.min(
                brushTip.x + 16,
                (typeof window !== 'undefined' ? window.innerWidth : 1200) - 190,
              ),
              top: Math.min(
                brushTip.y + 16,
                (typeof window !== 'undefined' ? window.innerHeight : 900) - 70,
              ),
              zIndex: 60,
              pointerEvents: 'none',
              minWidth: 160,
            }}
          >
            <div
              className="font-px text-[9px] uppercase tracking-[0.1em]"
              style={{ color: 'var(--ink-3)' }}
            >
              该处将被
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                style={{
                  width: 8,
                  height: 8,
                  flex: 'none',
                  background: 'var(--clay)',
                  display: 'inline-block',
                }}
              />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>
                {DETAIL_META[brushAlgorithm].short}
              </span>
              <span className="font-px text-[10px]" style={{ color: 'var(--ink-3)' }}>
                · 半径 {brushRadiusCells} 格
              </span>
            </div>
          </div>,
          document.body,
        )}

      {/* hover 工具提示（portal 到 body：fixed 定位，任何滚动/缩放都不会裁切） */}
      {!brushMode &&
        hoverInfo &&
        tipStyle &&
        createPortal(
          <div
            ref={tipRef}
            className="px-tooltip"
            style={tipStyle}
            data-testid="cell-tooltip"
          >
            <div
              className="font-px text-[9px] uppercase tracking-[0.1em]"
              style={{ color: 'var(--ink-3)' }}
            >
              第 {hoverInfo.row} 行 · 第 {hoverInfo.col} 列
            </div>
            {hoverInfo.bead && hoverInfo.rgb ? (
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  style={{
                    width: 14,
                    height: 14,
                    flex: 'none',
                    background: hoverInfo.bead.hex,
                    border: '1px solid var(--line-strong)',
                    display: 'inline-block',
                  }}
                />
                <span className="font-px text-[12px] font-bold" style={{ color: 'var(--ink)' }}>
                  {hoverInfo.bead.code}
                </span>
                <span
                  className="font-px text-[10px]"
                  style={{ color: 'var(--ink-2)', marginLeft: 'auto' }}
                >
                  {hoverInfo.bead.hex.toUpperCase()}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[12px] font-semibold" style={{ color: 'var(--ink-2)' }}>
                空白 · 不拼豆
              </div>
            )}
            {hoverInfo.rgb && (
              <div
                className="mt-0.5 font-px text-[9px]"
                style={{ color: 'var(--ink-3)', letterSpacing: '0.02em' }}
              >
                RGB {hoverInfo.rgb.r} {hoverInfo.rgb.g} {hoverInfo.rgb.b}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 像素滑杆样式修正
// ---------------------------------------------------------------------------
/*
 * globals.css 里 `.px-slider [data-slot=slider-track]` 写在 @layer components，
 * 而 Tailwind 的 utilities 层在它之后输出，shadcn Slider 自带的 h-1.5 / rounded-full
 * 会把像素风盖掉。globals.css 不在我改的范围内，所以在这里用任意变体 + !important
 * 把方角轨道、方角拨片、clay 填充抢回来（与 PatternSettings 里的处理保持一致）。
 */
const SLIDER_CLASSES =
  'px-slider ' +
  '[&_[data-slot=slider-track]]:!h-2 [&_[data-slot=slider-track]]:!rounded-none ' +
  '[&_[data-slot=slider-track]]:!border-2 [&_[data-slot=slider-track]]:!border-[var(--line-strong)] ' +
  '[&_[data-slot=slider-track]]:!bg-[var(--paper-sunken)] ' +
  '[&_[data-slot=slider-range]]:!bg-[var(--clay)] ' +
  '[&_[data-slot=slider-thumb]]:!h-5 [&_[data-slot=slider-thumb]]:!w-4 ' +
  '[&_[data-slot=slider-thumb]]:!rounded-none [&_[data-slot=slider-thumb]]:!border-2 ' +
  '[&_[data-slot=slider-thumb]]:!border-[var(--line-strong)] ' +
  '[&_[data-slot=slider-thumb]]:!bg-[var(--paper-hi)] ' +
  '[&_[data-slot=slider-thumb]]:!shadow-[0_3px_0_0_var(--line-strong)] ' +
  '[&_[data-slot=slider-thumb]]:hover:!bg-[var(--clay)]';

// ---------------------------------------------------------------------------
// 空状态占位：8×8 的像素方块拼一颗豆（纯 div，无图片资源）
// ---------------------------------------------------------------------------

/** 8×8 像素图：# = 实心豆、o = 高光、. = 空 */
const EMPTY_ART = [
  '#.....#.',
  '##...##.',
  '#o####..',
  '##o####.',
  '#######.',
  '.#####..',
  '..###...',
  '...#....',
];

function EmptyBeadArt() {
  const cell = 9;
  return (
    <div
      aria-hidden
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(8, ${cell}px)`,
        gridTemplateRows: `repeat(8, ${cell}px)`,
        gap: 1,
        padding: 8,
        border: '2px solid var(--line)',
        background: 'var(--paper-raised)',
      }}
    >
      {EMPTY_ART.flatMap((row, y) =>
        row.split('').map((ch, x) => {
          const filled = ch !== '.';
          return (
            <div
              key={`${y}-${x}`}
              style={{
                width: cell,
                height: cell,
                background: filled
                  ? ch === 'o'
                    ? 'var(--clay-soft)'
                    : 'var(--clay)'
                  : 'transparent',
                border: filled ? '1px solid var(--clay-deep)' : 'none',
                boxSizing: 'border-box',
              }}
            />
          );
        }),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 尺寸选择器（页面顶部设置区）
// ---------------------------------------------------------------------------

export interface GridSizeSelectorProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** 预估成品尺寸提示，例如 "约 14.4 × 14.4 cm" */
  hint?: string;
}

export function GridSizeSelector({
  value,
  onChange,
  min = 16,
  max = 320,
  disabled = false,
  hint,
}: GridSizeSelectorProps) {
  const safeMin = Math.max(2, Math.min(min, max - 1));
  const safeMax = Math.max(safeMin + 1, max);
  const clamped = Math.min(safeMax, Math.max(safeMin, value));

  // 常用档位：小摆件 / 中号 / 大号 / 大图纸
  /*
   * 档位阶梯：16 → 320 如果按线性滑杆，16 到 320 一步就是 3 格，
   * 前段（用户最常待的地方）根本点不准。所以滑杆走**档位下标**而不是
   * 原始数值：每一档就是一个位置，拖动时 snap 到最近档位。
   * 数字输入框保留任意值，想要 137 就敲 137。
   */
  const LADDER = [16, 24, 32, 48, 64, 80, 96, 128, 160, 200, 240, 320];
  const ladder = LADDER.filter((v) => v >= safeMin && v <= safeMax);
  const ladderSafe = ladder.length ? ladder : [safeMin, safeMax];

  // 当前值在阶梯上的位置（不是恰好落档时取最近的档）
  const ladderIndex = (() => {
    let best = 0;
    let bestGap = Infinity;
    ladderSafe.forEach((v, i) => {
      const gap = Math.abs(v - clamped);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    return best;
  })();

  const commit = (v: number) => {
    if (disabled) return;
    onChange(Math.min(safeMax, Math.max(safeMin, Math.round(v))));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="px-label" style={{ color: 'var(--ink-3)' }}>
          图纸尺寸
        </span>
        <span
          className="font-px text-[13px] font-bold tabular-nums"
          style={{ color: 'var(--ink)' }}
        >
          {clamped} 格/长边
        </span>
      </div>

      <Slider
        value={[ladderIndex]}
        onValueChange={(vals) => commit(ladderSafe[vals[0] ?? ladderIndex] ?? clamped)}
        min={0}
        max={ladderSafe.length - 1}
        step={1}
        disabled={disabled}
        aria-label="图纸尺寸（档位）"
      />

      {/* 数字输入：滑杆只到档位，想要中间值就敲进去 */}
      <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-3)' }}>
        <span>精确格数</span>
        <input
          type="number"
          className="px-field w-[74px] text-center font-px text-[12px] tabular-nums"
          value={clamped}
          min={safeMin}
          max={safeMax}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) commit(v);
          }}
          aria-label="精确格数"
        />
        <span>
          （{safeMin}–{safeMax}）
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        {ladderSafe.map((p) => {
          const active = p === clamped;
          return (
            <button
              key={p}
              type="button"
              className="px-btn px-btn-sm"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => commit(p)}
              style={
                active
                  ? {
                      background: 'var(--clay)',
                      borderColor: 'var(--clay-deep)',
                      color: 'var(--on-clay)',
                    }
                  : { padding: '4px 8px', fontSize: 11 }
              }
            >
              {p}
            </button>
          );
        })}
        {hint && (
          <span className="ml-auto text-[11px]" style={{ color: 'var(--ink-3)' }}>
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}
