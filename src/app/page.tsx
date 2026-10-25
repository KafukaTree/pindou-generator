'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  Moon,
  Sun,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  Grid2x2,
  RefreshCw,
  SlidersHorizontal,
  AlignCenter,
  Maximize2,
  X,
} from 'lucide-react';

import { FileUpload } from '@/components/image-upload/FileUpload';
import { NewCanvasDialog } from '@/components/blank-canvas/NewCanvasDialog';
import { PatternSettings } from '@/components/settings/PatternSettings';
import { MobileDrawer } from '@/components/pattern-rendering/MobileDrawer';
import {
  PatternCanvas,
  type CanvasActivity,
} from '@/components/pattern-rendering/PatternCanvas';
import type { DetailBrush } from '@/lib/pattern/regions';
import {
  applyEdits,
  editCount,
  EMPTY_EDITS,
  type EditMap,
} from '@/lib/pattern/edits';
import { ColorLegend } from '@/components/palette/ColorLegend';
import { PDFExport } from '@/components/pdf-export/PDFExport';
import { HistoryList } from '@/components/history/HistoryList';
import {
  PixelGarden,
  PixelMascotPeek,
  PixelEmpty,
  MascotBubble,
  MascotPromptButton,
  MascotRoamer,
  WORKBENCH_ANCHORS,
  type MascotAwareness,
} from '@/components/scenery';

import {
  compressSourceDataUrl,
  useHistory,
  type HistoryItem,
  type HistoryVersion,
} from '@/hooks/useHistory';
import {
  estimateSizeCm,
  generatePattern,
  imageDataFromSource,
  patternToThumbnail,
  type GenerateOptions,
  type PatternResult,
} from '@/lib/pattern/generate';
import {
  blankSourceKey,
  blankThumbnail,
  makeBlankId,
  makeBlankPattern,
  parseBlankSourceKey,
} from '@/lib/pattern/blank';
import { BRANDS, BRAND_META, type Brand } from '@/lib/color/palette';
import {
  centerPatternToCanvas,
  scalePatternToCanvas,
  resizePatternToCanvas,
} from '@/lib/pattern/canvas-resize';
import { readStorage, writeStorage } from '@/hooks/useLocalStorage';
import { useDocHistory } from '@/hooks/useDocHistory';
import {
  clearWorkspaceSession,
  decodePatternSnapshot,
  encodePatternSnapshot,
  readWorkspaceSession,
  writeWorkspaceSession,
} from '@/hooks/useWorkspaceSession';
import { parseHex } from '@/lib/color/oklab';
import {
  DEFAULT_OUTLINE,
  OUTLINE_KEY,
  sanitizeOutline,
  type OutlineSettings,
} from '@/lib/pattern/outline-settings';
import {
  DEFAULT_MARGIN,
  MARGIN_KEY,
  applyMargin,
  remapEditsBetween,
  sanitizeMargin,
  type MarginMode,
} from '@/lib/pattern/margin';
import { applyCartoonOutline, buildOutlineGuide } from '@/lib/pattern/outline';
import { cn } from '@/lib/utils';

/* ============================================================
 * 拼豆图纸工坊 · 主页
 * ------------------------------------------------------------
 * 这一版把原来的"三步走 + Apply 按钮"改成一条**连续的创作流程**：
 *
 *   ① 放一张图  →  ② 调参数（实时出图）  →  ③ 看图纸 / 导出 / 存历史
 *
 * 几个关键决策：
 *
 * - **去掉 Apply**。原版必须先点 Apply 才重算，滑完滑杆看到的是旧图，
 *   用户根本不知道"还没生效"，于是连点十几次、历史被刷屏。现在参数
 *   一动就重算，但用一个 180ms 的 debounce 合并连续拖动 —— 拖滑杆
 *   的过程不会卡，松手后立刻出结果。
 *
 * - **历史记录真的能恢复**。恢复时把 item 里存的原始图片重新灌进流程
 *   （sourceDataUrl），而不是只把几个滑杆数字塞回去。原版点"恢复"
 *   之后画面还是空的，因为图片根本没进历史。
 *
 * - **颗数只有一个来源**。全部读 pattern.totalBeads / palette[].count，
 *   页面任何地方都不再自己 reduce 一遍 —— 原版 UI 显示"1 beads"、
 *   PDF 显示"H01 x1674"，同一张图两个数，纯属自找麻烦。
 *
 * - **空白格是真空白**。cells[i] === -1 表示"这里不拼豆"，画布用
 *   棋盘格透出来，不再用白豆填满整块方形区域。
 * ============================================================ */

/** 参数变化到重算之间的静默期：够短不觉得卡，够长能合并拖动 */
const RECOMPUTE_DELAY = 180;

const DEFAULT_OPTIONS: GenerateOptions = {
  gridSize: 64,
  aspect: 1,
  brand: 'MARD',
  colorLimit: 16,
  fit: 'contain',
  smoothing: 0.6,
  autoCrop: true,
  background: 'ignore',
  chromaBoost: 1.1,
  dither: false,
  /*
   * detail = 精细度算法（四档，见 lib/pattern/detail.ts）。
   * 默认 balanced：它在"色块成片"和"保住五官"之间取了中间值，
   * 实测洛克猫 72×61 时 13 色 / 孤立点 1.4%，是唯一能同时应付
   * 头像和卡通立绘的档位。
   */
  detail: 'balanced',
};

/*
 * 局部精细度笔刷：故意**不**放在 options 里。
 *
 * options 会写进 localStorage 跨会话保留，但笔刷坐标是相对"某一张图"的
 * 归一化位置 —— 换个图之后那些圆圈落在完全不相干的地方，比没有还糟。
 * 所以笔刷只活在当前这次编辑里，换图/恢复历史就清空。
 */
const DEFAULT_FEATHER = 0.55;

const OPTIONS_KEY = 'pindou.options.v1';
const THEME_KEY = 'pindou.theme';
const FOCUS_KEY = 'pindou.leftCollapsed';

type Theme = 'light' | 'dark';

/**
 * 一份"文档"的完整快照 —— 撤销栈里存的就是它。
 *
 * 划分标准是"用户会不会觉得这是另一个东西"：换图、换画板尺寸会换掉整个
 * 上下文，换参数会换整张图，手绘和区域笔刷是局部改动，边距/羽化改变排版。
 * 这些全算同一份文档的不同状态，所以撤销能一路走回去。
 *
 * 路径依赖的细节：
 *  - `pattern` 与 `outlinePattern` 是**派生**结果，但它们必须进快照 ——
 *    「居中」「放大约到边」直接改 cells，只靠图源+参数重算永远回不到
 *    居中之前的那个结果。
 *  - `outlineSpace` 是描边所在网格空间的记录（见 outlineSpaceRef），
 *    不还回去的话，撤销后描边 effect 会把 edits 再迁移一遍。
 */
interface DocSnapshot {
  sourceDataUrl: string | null;
  blankCanvas: { cols: number; rows: number; id: string } | null;
  options: GenerateOptions;
  edits: EditMap;
  brushes: DetailBrush[];
  margin: MarginMode;
  regionFeather: number;
  pattern: PatternResult | null;
  outlinePattern: PatternResult | null;
  outlineSpace: { cols: number; rows: number; mode: MarginMode } | null;
}

export default function Home() {
  const { isLoaded, addToHistory } = useHistory();

  // ---- 输入图片 ----------------------------------------------------------
  const [sourceDataUrl, setSourceDataUrl] = useState<string | null>(null);
  const [imageInfo, setImageInfo] = useState<{
    width: number;
    height: number;
    name: string;
  } | null>(null);

  // 解码后的源图，重算时反复用，不必每次重新 new Image()
  const sourceRef = useRef<HTMLImageElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  /** 当前 imageDataRef 的长边（用于判断"已有精度够不够"，避免重复解码） */
  const sourceEdgeRef = useRef(0);
  /*
   * 解码完成要有一个 state 信号，不能只靠 ref。
   *
   * 踩过的坑：源图 onload 里把 ImageData 放进 ref，同时顺手把 aspect
   * 改成图片真实比例 —— 但如果比例本来就已经是 1（正方形图），
   * setOptions 返回的是同一个对象、不触发重渲染，而重算 effect 的依赖
   * [sourceDataUrl, optionsKey] 里也没有任何东西变了（sourceDataUrl 早在
   * 解码前就设过了，那时 ref 还是空的、effect 直接 return 了）。
   * 结果：图解码好了，但永远没人算 —— 界面卡在"重算中"，图纸空白。
   * 用一个自增的 imageReady 作为显式信号，解码完成就一定重算一次。
   */
  const [imageReady, setImageReady] = useState(0);

  // ---- 局部精细度笔刷 ------------------------------------------------------
  const [brushes, setBrushes] = useState<DetailBrush[]>([]);
  const [regionFeather, setRegionFeather] = useState(DEFAULT_FEATHER);

  /*
   * ---- 人工编辑覆盖层 ----------------------------------------------------
   *
   * 这一层**只在渲染层叠加**：`pattern` 永远是引擎原始结果，`edits` 记录
   * 用户手工改过的格子。两者合成出的 `displayPattern` 才是"用户眼里的
   * 图纸"—— 画布、色号、图例、统计、PDF、历史全部必须读它，否则会出现
   * "屏幕上改了但导出没改"这种最让人怀疑工具坏了的不一致。
   *
   * 踩过的坑：画布内部也自己算一份 applyEdits，但父组件（图例/导出/历史）
   * 读的是原始 pattern —— 手绘的豆子画得出来，用料清单却不涨。所以这里
   * 在父层算一次，往下只传最终结果。
   */
  const [edits, setEdits] = useState<EditMap>(EMPTY_EDITS);

  // ---- 参数 --------------------------------------------------------------
  const [options, setOptions] = useState<GenerateOptions>(() => {
    if (typeof window === 'undefined') return DEFAULT_OPTIONS;
    const saved = readStorage<Partial<GenerateOptions> | null>(
      OPTIONS_KEY,
      null,
    );
    return saved ? { ...DEFAULT_OPTIONS, ...saved } : DEFAULT_OPTIONS;
  });

  /*
   * ---- 卡通黑边（可选的渲染层描边） --------------------------------------
   *
   * 默认关闭。开启后，在引擎结果之上再算一遍轮廓并盖一层纯黑豆，
   * **不改** 原始 `pattern`（引擎结果永远是基线，历史、恢复、参数重算
   * 都回到它）。
   *
   * 惰性初始化读 localStorage：这个值不影响首帧 DOM 结构（只是决定
   * 一段 effect 要不要跑），所以不会造成水合不一致 —— 与 `leftCollapsed`
   * 那种直接改 className 的情况不同。
   */
  const [outline, setOutline] = useState<OutlineSettings>(() => {
    if (typeof window === 'undefined') return DEFAULT_OUTLINE;
    return sanitizeOutline(readStorage<unknown>(OUTLINE_KEY, null));
  });

  /*
   * ---- 空白画布 ----------------------------------------------------------
   *
   * 有值时表示"当前这张图纸不是从图片生成的，而是用户从空板子开始画的"。
   * 它和 `sourceDataUrl` 是互斥的两个来源：
   *
   *   sourceDataUrl  → 走引擎（重算 effect）
   *   blankCanvas    → 不走引擎，直接造一张全空 cells 的图纸
   *
   * 为什么要一个独立 state 而不是"造一张纯白图去生成"：引擎会对白底做
   * 自动裁背景、超采样、调色板选择，最后给出一张可能被裁空的图纸，颜色
   * 还是它自己编的 —— 与"我要一块空板子"完全不是一回事。
   *
   * 尺寸单独存：网格密度滑杆在空白画布下不参与重算（那样会静默换掉用户
   * 的画布尺寸），改尺寸只走「新建空白画布」对话框。
   *
   * `id` 是这块画布的身份，只在"新建"那一刻生成一次。它进历史记录的
   * sourceDataUrl 占位串，作用见 `blankSourceKey` 的注释：没有它，两块
   * 内容无关的 29×29 板子会被历史去重逻辑并成同一条，后画的顶掉先画的。
   */
  const [blankCanvas, setBlankCanvas] = useState<{
    cols: number;
    rows: number;
    id: string;
  } | null>(null);
  const [newCanvasOpen, setNewCanvasOpen] = useState(false);
  /*
   * 换尺寸时已经搬好内容的图纸。
   *
   * 那个「空白画布 → makeBlankPattern」的 effect 只依赖 blankCanvas，它分不
   * 清"新建一块空的"和"换尺寸但保留内容"。这个 ref 就是那一次的信使：带
   * 值进去就用它，用完立刻清空。
   */
  const carriedRef = useRef<PatternResult | null>(null);
  /*
   * 这一帧的 blankCanvas 变化是"撤销/重做写回来的"，不是"用户新建板子"。
   *
   * 下面那条 `blankCanvas → 造图纸` 的 effect 只依赖 blankCanvas，它分不清
   * 这两种情况：撤销把画板从 57 换回 29 时，它会以为用户新建了一块板，
   * 于是 `setPattern(makeBlankPattern(...))` 把刚还原的图案盖成空板，
   * 只剩手绘覆盖层还浮在上面。实测表现：重做到 57×57 后颗数显示 8
   * （应为 28）—— 图案没了，只有 8 颗手绘的豆子。
   */
  const docApplyRef = useRef(false);

  // ---- 输出 --------------------------------------------------------------
  const [pattern, setPattern] = useState<PatternResult | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * 画布当前占用状态（空闲 / 刷区域 / 编辑）。
   *
   * 巡游桌宠要躲开这个状态：用户开始刷区域或编辑时，它应该主动离开画布附近
   * 的锚点，别在人家正盯着的格子上晃。状态源头在 PatternCanvas 内部，通过
   * onActivityChange 上报。
   */
  const [canvasActivity, setCanvasActivity] = useState<CanvasActivity>('idle');
  /*
   * 「04 图纸」标题栏右侧的缩放槽位节点。
   *
   * 用回调 ref 直接持有 DOM 节点、再作为 prop 交给 PatternCanvas，而不是让它
   * 自己 `document.getElementById(...)` 去查：查 DOM 得放在挂载后的 effect 里，
   * 那会多一次同步渲染（eslint 的 react-hooks/set-state-in-effect），而且父层
   * 重排标题栏后节点可能被换掉、画布手里就成了悬空引用。回调 ref 由 React
   * 在节点挂载/卸载时各调一次，天然同步。
   */
  const [zoomSlot, setZoomSlot] = useState<HTMLDivElement | null>(null);
  const hasCanvasImage = sourceDataUrl !== null || blankCanvas !== null;

  /*
   * 左栏折叠：把左栏（图 + 参数）收起来，让图纸吃满整行。
   *
   * 用户原话：「这个侧边栏在绘图的时候要是能收起来就好了，要不然有点不方便」，
   * 随后又明确：「我要用户主动折叠的那种，还能还原折出来，不然不好用」。
   *
   * 所以这里**只有手动**，不做任何自动收起。之前那版会在进编辑/刷区域时
   * 自动收、退出时自动还原，看起来贴心，实际上是跟用户抢控制权：他刚展开
   * 左栏想改个参数，一碰画布又被收走 —— 用户说的"不好用"就是这个。
   *
   * 还原路径有两条，都要在：
   *   · 标题栏的按钮（展开时显示「收起左栏」，收起后显示「展开左栏」）；
   *   · 收起后在原位留一条 24px 的竖边条 —— 整块面板消失后按钮也跟着
   *     消失，用户就找不到回去的路了，这是折叠 UI 最经典的坑。
   *
   * 状态持久化到 localStorage：折叠是个"工作姿态"，关掉页面再回来应该
   * 还是那个姿势，不该每都会话都重新点一次。
   *
   * ⚠️ 惰性初始化 + SSR 有一个必踩的坑：服务端渲染时 `readStorage` 返回
   * 默认值 `false`（渲染出"展开"），客户端首次渲染读到 `true`（渲染出
   * "收起"）—— 两边 HTML 结构不同，React 直接抛
   * "A tree hydrated but some attributes ... didn't match"。实测只要
   * localStorage 里存过 `true`，每次刷新都报这条错（控制台红字）。
   *
   * 解法是**首次渲染强制与服务端一致**，挂载后再一次性同步到磁盘值：
   * 代价是多一帧"展开态"，换来不红屏。这不等于回到"放 effect 里"那个
   * 被否掉的方案 —— 那个是每次渲染都碰磁盘，这里只在挂载跑一次。
   */
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  useEffect(() => {
    const saved = readStorage<boolean>(FOCUS_KEY, false) === true;
    if (saved) setLeftCollapsed(true);
  }, []);

  const toggleFocus = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      writeStorage(FOCUS_KEY, next);
      return next;
    });
  }, []);

  /**
   * 桌宠的"现在的处境"。
   *
   * 顺序即优先级：出错最要紧 → 重算中 → 编辑/刷区域 → 无图 → 出图完成。
   * 它只影响表情，不影响别的任何逻辑 —— 所以这里即使判歪了也只是表情不对，
   * 不会把功能弄坏。
   */
  const awareness: MascotAwareness = error
    ? 'error'
    : isWorking
      ? 'working'
      : canvasActivity === 'editing'
        ? 'editing'
        : canvasActivity === 'brushing'
          ? 'brushing'
          : !hasCanvasImage
            ? 'empty'
            : 'done';

  // ---- 主题 --------------------------------------------------------------
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const saved = readStorage<Theme | null>(THEME_KEY, null);
    const initial: Theme =
      saved ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light');
    setTheme(initial);
    document.documentElement.classList.toggle('dark', initial === 'dark');
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      writeStorage(THEME_KEY, next);
      return next;
    });
  }, []);

  // ---- 参数变化时持久化 --------------------------------------------------
  useEffect(() => {
    writeStorage(OPTIONS_KEY, options);
  }, [options]);

  /*
   * 卡通黑边偏好单独一个键。
   *
   * 不并进 OPTIONS_KEY：那份是引擎的量化配方，而描边是量化之后的渲染层
   * 偏好（见 outline-settings.ts 的说明）。混在一起会让"历史记录里的
   * 参数"多出一个不影响量化结果的字段，恢复历史时还会把别人的描边偏好
   * 一起套上去。
   */
  useEffect(() => {
    writeStorage(OUTLINE_KEY, outline);
  }, [outline]);

  /*
   * ---- 画布边距策略 ------------------------------------------------------
   *
   * 与 options 分开存：它决定的是"给源图裁多少、画布多大"，属于出图尺寸
   * 的一部分，但改它不需要重跑描边本身 —— 反而要重跑量化。放进 options
   * 会让 optionsKey 变化，而 options 会被原样交给 generatePattern。
   *
   * 惰性初始化同样安全：只决定重算 effect 里的一个分支，不影响首帧 DOM。
   */
  const [margin, setMargin] = useState<MarginMode>(() => {
    if (typeof window === 'undefined') return DEFAULT_MARGIN;
    return sanitizeMargin(readStorage<unknown>(MARGIN_KEY, null));
  });

  useEffect(() => {
    writeStorage(MARGIN_KEY, margin);
  }, [margin]);

  /* ---------------------------------------------------------------
   * 选图：只管把图片解码好，真正出图交给下面的统一重算效应
   * --------------------------------------------------------------- */
  const handleImage = useCallback(
    (dataUrl: string, info: { width: number; height: number; name: string }) => {
      setError(null);
      // 换图 = 离开空白画布。两种来源互斥，留着 blankCanvas 会让重算
      // effect 一直早退，用户传了图却一张图纸也出不来。
      setBlankCanvas(null);
      setSourceDataUrl(dataUrl);
      setImageInfo(info);
      // 换图就清空笔刷：归一化坐标在新图上毫无意义
      setBrushes([]);
      // 同理，手工覆盖层是按"格子下标"存的，换一张图后同一套下标
      // 指向的完全是别的位置 —— 不清就会把上一张图的改动套到新图上
      setEdits(EMPTY_EDITS);
      // 新文档：旧索引对新图毫无意义，历史必须清零
      setDocEpoch((n) => n + 1);
    },
    [],
  );

  /* ---------------------------------------------------------------
   * 工作区会话：刷新后回到刚才那一屏
   * --------------------------------------------------------------- */
  /*
   * 用户原话：「现在刷新就把工作区的东西清除了，没保存状态，不太对，虽然
   * 能看到历史记录」。
   *
   * 这里补的就是"当前这一屏"：图片/空白画布 + 手绘覆盖层 + 区域笔刷。
   * 参数和主题本来就有各自的键，不重复存（理由见 useWorkspaceSession
   * 的注释：同一份真相两个副本，一边写失败就会拼出谁都没见过的组合）。
   *
   * 为什么用 ref 守"只恢复一次"：这个 effect 的依赖里会有 sourceDataUrl，
   * 而它自己又 setSourceDataUrl —— 不守就会无限循环。用 ref 而不是 state
   * 是因为它不需要触发重渲染。
   */
  const sessionRestoredRef = useRef(false);
  /* 恢复时记下当时图纸的行列数，等 pattern 算出来再核对 edits 能不能用 */
  const sessionDimsRef = useRef<{ cols: number; rows: number } | null>(null);

  /*
   * 「首帧还没补上状态」的标记。
   *
   * 恢复是在 effect 里做的，而 effect 排在首帧绘制之后 —— 所以第一帧
   * `sourceDataUrl` 还是 null、`hasImage` 是 false，04 面板会闪一下
   * 「还没有图纸」。用这个标记在那一帧改成不渲染空态（见 mid 面板），
   * 避免"刷新先闪一句空话再出图"。restore effect 一跑完就置 false。
   */
  const [sessionBooting, setSessionBooting] = useState(true);
  /* restore effect 刚把 sourceDataUrl/blankCanvas 补上（首帧它们还是 null） */
  const restoredThisTickRef = useRef(false);
  /*
   * 启动恢复那一次变化不算用户的"上一步"。
   *
   * 恢复会把图源、画布、edits 一次性补上来，若不拦住，撤销栈的第一条就是
   * "空工作区" —— 用户刷新一下再点撤销，刚画的东西凭空消失。用 ref 而不是
   * 布尔 prop：恢复和 setSessionBooting(false) 在同一批里，下一轮渲染时布尔
   * 已经翻回去了，拦不住；而"恢复 effect 先跑、历史 effect 后跑"的顺序由
   * 声明顺序保证，ref 最可靠。
   */
  const docHistorySuppressRef = useRef(false);
  /*
   * 文档身份。换了身份（放新图 / 清空 / 从空态新建画布）就要清空撤销历史。
   *
   * 不清的后果是实测出来的：放一张示例图后按 Ctrl+Z，会退回"空工作区"——
   * 而空工作区里画布组件根本不渲染，撤销/重做按钮和快捷键跟着一起消失，
   * 用户再也回不去，只能刷新。打开新文档重置历史是所有编辑器的一致做法。
   *
   * 换尺寸**不**换身份：那是同一份图纸换了块板子，要能撤销。
   */
  const [docEpoch, setDocEpoch] = useState(0);

  useEffect(() => {
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    const session = readWorkspaceSession();
    if (!session) {
      setSessionBooting(false);
      return;
    }
    restoredThisTickRef.current = true;
    docHistorySuppressRef.current = true;
    setSessionBooting(false);

    if (session.blankCanvas) {
      setBlankCanvas(session.blankCanvas);
      setSourceDataUrl(null);
      setImageInfo(null);
    } else if (session.sourceDataUrl) {
      setBlankCanvas(null);
      setSourceDataUrl(session.sourceDataUrl);
      setImageInfo(session.imageInfo);
    }
    if (session.regionFeather) setRegionFeather(session.regionFeather);
    setBrushes(session.brushes);
    /*
     * 覆盖层先设上，行列数核对放到 pattern 出来之后（那时才知道引擎
     * 这次算的是多少行多少列）。空对象直接跳过，避免无谓的重渲染。
     */
    if (Object.keys(session.edits).length > 0) {
      setEdits(session.edits);
      sessionDimsRef.current =
        session.patternCols && session.patternRows
          ? { cols: session.patternCols, rows: session.patternRows }
          : null;
    }

    /*
     * ---- 用快照垫上第一帧 ------------------------------------------
     *
     * 这是"刷新后那段动画"的解药：没有快照时，画布要等
     * 180ms 防抖 + 340ms 引擎 ≈ 500ms 才有东西，中间先显示「还没有图纸」
     * 再显示「还没有生成图案」。有快照就直接画出来，引擎算完再无缝换掉。
     *
     * 只有空白画布**不**用快照：它的 cells 全是 -1，`makeBlankPattern`
     * 是同步纯函数，本来第一帧就有，走快照反而多一次解码。
     */
    if (!session.blankCanvas && session.snapshot) {
      const decoded = decodePatternSnapshot(session.snapshot, parseHex);
      /*
       * 只认行列数一致的快照。参数变了（比如上次是在 96 格算的，
       * 现在 options 里是 64）时快照就是过期的，画上去会"闪一下旧图
       * 再跳成新图"。用会话里记的 patternCols/rows 判不了这个 ——
       * 那俩就是快照自己的尺寸，得跟当前 options 估出来的期望尺寸比。
       */
      if (decoded) {
        setPattern(decoded);
        sessionDimsRef.current = { cols: decoded.cols, rows: decoded.rows };
      }
    }
  }, []);

  /*
   * 会话写入：压缩后的图 **算一次就够**。
   *
   * 不能把 "压缩" 放进写入 effect：拖一笔改一次 edits 就要重编码一次
   * canvas（640px PNG 约 30–50ms），编辑模式下会明显卡手。而且压缩结果
   * 只跟源图有关，跟 edits 无关。
   */
  const [compactSource, setCompactSource] = useState<string | null>(null);
  useEffect(() => {
    if (!sourceDataUrl) {
      setCompactSource(null);
      return;
    }
    let cancelled = false;
    void compressSourceDataUrl(sourceDataUrl)
      .then((compact) => {
        if (!cancelled) setCompactSource(compact);
      })
      .catch(() => {
        // 压缩失败（极罕见的解码异常）：退回原图，总比什么都不存强
        if (!cancelled) setCompactSource(sourceDataUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceDataUrl]);

  /*
   * 快照编码只在 pattern 变时做一次（不在写入 effect 里现编）。
   * 320 格图是 8.7 万个格子，每次拖滑杆都编一遍纯属浪费；而 pattern
   * 变一次本来就意味着引擎刚跑完一轮（几百毫秒），这里几十毫秒不算事。
   */
  const patternSnapshot = useMemo(
    () => (pattern ? encodePatternSnapshot(pattern) : null),
    [pattern],
  );

  useEffect(() => {
    /*
     * ---- 三个"这一轮不许动磁盘"的前置条件 ----------------------------
     *
     * 这几个判断写错过一次，症状是**刷新两次就丢**（用户反馈「连续刷新
     * 多次会丢失」）。根因很隐蔽：mount 时 restore effect 和本 effect 在
     * 同一次 commit 里按定义顺序执行，而 restore 里的 setState 要到下一次
     * 渲染才生效 —— 所以本 effect 的首轮读到的 `sourceDataUrl` 仍然是
     * null。那时若把它当"空态"，就会把磁盘上那份完好的会话删掉。
     *
     * 恢复前先什么都不做，等 sessionBooting 落成 false（restore effect
     * 同一批里设的）再开始写。
     */
    if (sessionBooting) return;

    /*
     * 空的判据必须是「没有图源」= `sourceDataUrl` + `blankCanvas`。
     *
     * **不能**用 `compactSource` —— 它是压缩后的副本，刚恢复或刚上传时
     * 有几十毫秒还是 null（要异步解码 canvas 才能算出来）。用它判断会让
     * 每一轮"图已就绪、压缩还没好"的写入都把会话删掉。
     */
    if (!blankCanvas && !sourceDataUrl) {
      clearWorkspaceSession();
      return;
    }

    /*
     * 压缩副本还没算出来：这一轮**什么都不做**（既不写也不删）。
     * 磁盘上那份要么是上次的正确内容，要么还不存在 —— 两种情况下
     * "不动"都对。等 compactSource 好了下一轮自然会写。
     */
    if (!blankCanvas && !compactSource) return;

    /*
     * 240ms debounce：编辑模式下每一笔都会改 edits，逐笔写 localStorage
     * 是同步阻塞（比画一格的耗时还长）。用户松手 240ms 后再落盘，
     * 刷新前那一下也来得及 —— 而且真正的风险窗口只有"最后一笔之后
     * 立刻按 F5"，240ms 足够覆盖。
     */
    const timer = window.setTimeout(() => {
      writeWorkspaceSession({
        version: 1,
        savedAt: Date.now(),
        sourceDataUrl: blankCanvas ? null : compactSource,
        imageInfo: blankCanvas ? null : imageInfo,
        blankCanvas,
        edits,
        patternCols: pattern?.cols ?? null,
        patternRows: pattern?.rows ?? null,
        brushes,
        regionFeather,
        snapshot: patternSnapshot,
      });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [
    sessionBooting,
    blankCanvas,
    sourceDataUrl,
    compactSource,
    imageInfo,
    edits,
    pattern,
    patternSnapshot,
    brushes,
    regionFeather,
  ]);

  /*
   * 覆盖层与图纸行列数核对。
   *
   * edits 是按格子下标存的。如果会话里的图和实际算出来的图行列数不同
   * （理论上不会，但存储被外部改过、或引擎某天改了网格算法就会出现），
   * 套上去会得到一堆错位色块 —— 那比"恢复成没涂过的样子"糟得多。
   */
  useEffect(() => {
    const expect = sessionDimsRef.current;
    if (!expect || !pattern) return;
    sessionDimsRef.current = null;
    if (pattern.cols === expect.cols && pattern.rows === expect.rows) return;
    setEdits(EMPTY_EDITS);
    toast.warning('图纸尺寸和保存时不一致，手绘的那几笔没法套用，已跳过');
  }, [pattern]);

  // 源图变化 → 解码
  useEffect(() => {
    /*
     * 空白画布下 sourceDataUrl 是 null，但**不能**顺手把 pattern 清掉 ——
     * 空白画布的图纸是直接造出来的，不走引擎。这个分支原来只判断
     * sourceDataUrl，创建空白画布时会把刚造好的图纸又抹成 null，
     * 表现就是"点了新建，中间一片空白，还以为没生效"。
     */
    if (!sourceDataUrl && blankCanvas) return;
    /*
     * 首帧的 `sourceDataUrl` 还是 null（恢复是在 effect 里补的），
     * 这时**不能**清 pattern —— 会把刚解码出来的快照抹掉，
     * 表现就是"明明存了快照，刷新还是要等引擎算完"。
     * 只忽略这一轮，下一轮 sourceDataUrl 就有值了。
     */
    if (restoredThisTickRef.current && !sourceDataUrl) {
      restoredThisTickRef.current = false;
      return;
    }
    if (!sourceDataUrl) {
      sourceRef.current = null;
      imageDataRef.current = null;
      sourceEdgeRef.current = 0;
      setPattern(null);
      setImageReady(0);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      sourceRef.current = img;
      /*
       * 换图必须把旧缓存**清掉**。
       *
       * ensureSource 的判断是"已有解码边长 >= 本次需要的边长就跳过"，
       * 若不清缓存，换一张图后它会看着上一张图的 2880px 缓存直接跳过，
       * 于是用户看到的仍然是上一张图的图案 —— 这种 bug 极难从截图发现。
       */
      imageDataRef.current = null;
      sourceEdgeRef.current = 0;
      /*
       * 这里**不**解码 ImageData：解码边长依赖 gridSize（见下面的
       * ensureSource），统一由那一个 effect 负责，避免两处各写一套。
       */
      setImageReady((n) => n + 1);
      // 用图片真实比例更新 aspect，让画布按原图长宽比切格
      const ratio = img.naturalWidth / img.naturalHeight;
      setOptions((prev) =>
        Math.abs(prev.aspect - ratio) < 0.005 ? prev : { ...prev, aspect: ratio },
      );
    };
    img.onerror = () => {
      if (cancelled) return;
      setError('这张图片解不开，换一张试试（支持 JPG / PNG / WebP / GIF）。');
    };
    img.src = sourceDataUrl;
    return () => {
      cancelled = true;
    };
  }, [sourceDataUrl, blankCanvas]);

  /* ---------------------------------------------------------------
   * 源图解码：边长跟着网格密度走
   *
   * 原来固定长边 720。对 120 格来说 720 是够的（6px/格），但用户把网格
   * 拉到 320 格时，超采样要 4× 也就是 1280px 才够 —— 720px 的源图会被
   * 引擎先放大再采样，等于凭空插值，细节全是假的（实测同理：320 格下
   * 用 720px 源图，五官边缘出现大片平滑色块，因为源头就没有那么多像素）。
   *
   * 所以解码边长 = max(720, gridSize * 4)，并夹在原图自然尺寸以内
   * （放大于事无补，只会烧内存）。已经解到够用的边长就不重复解码。
   */
  const ensureSource = useCallback((img: HTMLImageElement, gridSize: number) => {
    const natural = Math.max(img.naturalWidth, img.naturalHeight);
    const want = Math.min(natural, Math.max(720, Math.round(gridSize * 4)));
    if (imageDataRef.current && sourceEdgeRef.current >= want) return;
    imageDataRef.current = imageDataFromSource(img, want);
    sourceEdgeRef.current = want;
  }, []);

  /* ---------------------------------------------------------------
   * 统一重算：图片或参数任一变化都走这里，带 debounce 和竞态保护
   * --------------------------------------------------------------- */
  const optionsKey = useMemo(
    () => JSON.stringify({ ...options, brushes, regionFeather }),
    [options, brushes, regionFeather],
  );

  useEffect(() => {
    /*
     * 空白画布不走引擎。图纸由另一个 effect 直接造（见下方"空白画布 →
     * 造图纸"），这里必须早退，否则 options 一变就会拿上一张图的
     * imageData 重新生成，把用户画的板子顶掉。
     */
    if (blankCanvas) return;
    const img = sourceRef.current;
    if (!sourceDataUrl || !img) return;
    /*
     * 关键：先保证源图解码精度够这次 gridSize 用，再算。
     * 拉高网格密度时这里会重新解码一次更大的位图；拉低时不重新解码
     * （已有的像素更多，够用），省一次几十毫秒的解码。
     */
    ensureSource(img, options.gridSize);
    const data = imageDataRef.current;
    if (!data) return;

    let cancelled = false;
    setIsWorking(true);

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const result = generatePattern(data, {
          ...options,
          brushes,
          regionFeather,
        });
        if (cancelled) return;
        setPattern(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error('[pindou] generate failed', err);
        setError('这张图没能算出来。试着调低网格密度或换张对比更清楚的图。');
      } finally {
        if (!cancelled) setIsWorking(false);
      }
    }, RECOMPUTE_DELAY);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // 注意：不清 isWorking —— 下一轮 effect 会立刻把它再置 true，
      // 清了反而让提示在连续拖动时反复闪。
    };
    // optionsKey 是 options 的稳定序列化，避免每帧新对象触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDataUrl, optionsKey, imageReady, ensureSource, blankCanvas]);

  /*
   * 空白画布 → 造图纸。
   *
   * 依赖只有 blankCanvas 与品牌：尺寸定了就不该再变。**故意不监听
   * optionsKey** —— 网格密度滑杆在空白画布下不参与任何计算，若跟着它
   * 重造，用户拖一下滑杆画布尺寸就变了，画了一半的图会被 resize 掉。
   * 改尺寸的唯一入口是「新建空白画布」，那是显式操作。
   */
  useEffect(() => {
    if (!blankCanvas) return;
    /*
     * 撤销/重做刚写回来的画板：pattern 已经随快照一起还原了，再造一张
     * 空板只会把它盖掉（实测：重做到 57×57 后图案消失，只剩手绘的 8 颗）。
     */
    if (docApplyRef.current) {
      docApplyRef.current = false;
      return;
    }
    const carried = carriedRef.current;
    carriedRef.current = null;
    setPattern(carried ?? makeBlankPattern(blankCanvas.cols, blankCanvas.rows, options));
    setIsWorking(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blankCanvas]);

  /* ---------------------------------------------------------------
   * 卡通黑边：在引擎结果之上再盖一层纯黑轮廓
   * ---------------------------------------------------------------
   *
   * ---- 为什么单独一条 effect，不并进上面的重算 effect ----
   *
   * 量化（generatePattern）与描边是两件事：前者决定"每格是什么颜色"，
   * 后者只是在这个结果上再加几颗黑豆。并在一起的话，用户切换"细/中/粗"
   * 会把整个量化流程重跑一遍（320 格要 1 秒），而实际上只有描边那一步
   * 需要重算。分开之后：改粗细只跑 10–410ms 的描边，不碰量化。
   *
   * ---- 为什么 guide 要缓存 ----
   *
   * `buildOutlineGuide` 是这个模块里最贵的一步（实测 135–290ms），
   * 而它只取决于「源图 + 网格 + 裁切/背景/fit」—— 与粗细、样式都无关。
   * 所以只要 pattern 没换（= 量化没重跑），粗细来回切都复用同一份 guide。
   *
   * ---- 为什么读 imageDataRef 而不进依赖 ----
   *
   * ref 不是响应式的，但这里的时序是确定的：上面的重算 effect 先
   * `ensureSource()` 更新 imageDataRef，再 `generatePattern()` 产出
   * 新的 pattern 对象。也就是说 `pattern` 一变，ref 里一定已经是与它
   * 配套的 ImageData。把 ref 放进依赖只会引入无意义的空转。
   */
  const outlineGuideRef = useRef<{
    pattern: PatternResult;
    guide: ReturnType<typeof buildOutlineGuide>;
  } | null>(null);
  const [outlinePattern, setOutlinePattern] = useState<PatternResult | null>(
    null,
  );
  /*
   * `outlinePattern` 所属的「显示空间」。
   *
   * 为什么必须跟着描边结果一起记：边距会改变网格（expand 加 6 行 6 列），
   * 而用户的手绘 edits 是按**他当时看到的那个网格**存下标的。只要网格变了，
   * 旧下标就全部错位 —— 表现是手绘的豆子飘到别处，颗数却还是对的，极难查。
   *
   * 单独存一份而不是从 `margin` 现推：`margin` 是用户点击后立刻变的，而
   * `outlinePattern` 要等描边 effect 跑完才更新。中间那 300ms 里若按 `margin`
   * 现推，算出来的空间与手上的 `outlinePattern` 并不匹配，迁移必然算错。
   * 这里记的是"产出这份 outlinePattern 时用的边距"。
   */
  /*
   * 「上一轮描边结果所在的显示空间」。
   *
   * 为什么用 ref 而不是 state：描边 effect 需要把"上一轮的空间"和"这一轮的
   * 空间"同时拿在手上才能算坐标迁移，而 state 在同一个 effect 里刚 set 完
   * 读回来还是旧值（setState 到下一次渲染才生效）。这个值也不参与渲染，
   * 没有理由触发重渲染。
   */
  const outlineSpaceRef = useRef<{
    cols: number;
    rows: number;
    mode: MarginMode;
  } | null>(null);
  /*
   * 手机端的参数抽屉。
   *
   * 02 参数面板有 1260px 高，比一屏还高。窄屏上它排在图纸下方，用户往下
   * 拖到底改一个滑杆，画布早就滑出视野了 —— 而画布变化正是调参数的唯一
   * 判断依据。抽屉是覆盖层，开合时画布尺寸一格都不动，抽出来的同时右侧
   * 还留着阴影和一条画布边缘可以瞄。
   *
   * 只在 lg 以下用它：桌面左栏本来就与画布并排，看得见。
   */
  const [paramsOpen, setParamsOpen] = useState(false);
  const paramsBtnRef = useRef<HTMLButtonElement | null>(null);
  /*
   * edits 的即时镜像。描边 effect 需要读当前编辑内容去迁移，但**不能**把
   * edits 放进它的 deps —— 那样每涂一笔就要重算一次描边（320 格约 1 秒）。
   */
  const editsRef = useRef<EditMap>(EMPTY_EDITS);
  editsRef.current = edits;
  /*
   * 描边失败的原因。不弹 toast：用户可能只是随手点开看一眼，而"色位满了"
   * 这种情况本来就是正常的边界（黑色要占一个名额）。在参数面板的开关下面
   * 显示一行说明，比打断操作的红色提示合适。
   */
  const [outlineNote, setOutlineNote] = useState<string | null>(null);

  useEffect(() => {
    /*
     * 关闭 = 立刻回到原始图纸，且不保留上一份描边结果 —— 否则关掉开关
     * 还留着一份 outlinePattern 在内存里，下次打开会先闪一下旧的粗细。
     */
    if (!outline.enabled || !pattern || blankCanvas) {
      const baseCols = pattern?.cols ?? 0;
      const baseRows = pattern?.rows ?? 0;
      /*
       * 关掉描边 = 回到引擎原始图纸，而原始图纸是**未经边距变换**的空间。
       * 若之前开着 expand（画布 58×70），手绘格要搬回 52×64 才不会飘。
       */
      const prevSpace = outlineSpaceRef.current;
      if (
        prevSpace &&
        baseCols > 0 &&
        (prevSpace.mode !== 'occupy' ||
          prevSpace.cols !== baseCols ||
          prevSpace.rows !== baseRows)
      ) {
        setEdits(
          remapEditsBetween(editsRef.current, prevSpace, {
            cols: baseCols,
            rows: baseRows,
            mode: 'occupy',
          }),
        );
      }
      outlineSpaceRef.current = null;
      setOutlinePattern(null);
      setOutlineNote(null);
      return;
    }
    const data = (() => {
      /*
       * 自己保证源图解码到位，不等重算 effect 顺手填。
       *
       * `imageDataRef` 唯一的写入点是 `ensureSource`，而它原来只在重算
       * effect 里被调用。刷新页面时快照先恢复出图纸（100ms 级），此时
       * ref 还是空的 —— 描边 effect 只能空手回去等，于是用户先看到
       * 一张没有黑边的图，等引擎重算完（约 2.5 秒）黑边才突然出现。
       *
       * 实测时间线（只加 imageReady 依赖时仍是这个形状）：
       *   256ms  画出无黑边的 1552 颗
       *   2606ms 才变 1925 颗
       *
       * 这里主动解码一次：ensureSource 内部有"已解码边长够用就跳过"的
       * 判断，与重算 effect 共用同一个缓存，不会重复解码。
       */
      let d = imageDataRef.current;
      if (!d && sourceRef.current) {
        ensureSource(sourceRef.current, options.gridSize);
        d = imageDataRef.current;
      }
      return d;
    })();
    if (!data) {
      /*
       * 源图还没解码好，这一轮算不了 —— 但**必须**留下重试的钩子。
       * `imageReady` 是解码完成时自增的显式信号（与重算 effect 共用），
       * 放进 deps 保证解码完成后自动补一次。
       */
      setOutlinePattern(null);
      return;
    }

    let cancelled = false;

    try {
      // guide 复用：只有 pattern 换过才重算（粗细/线条画法/边距都不影响它）
      let cached = outlineGuideRef.current;
      if (!cached || cached.pattern !== pattern) {
        cached = { pattern, guide: buildOutlineGuide(data, pattern, {}) };
        outlineGuideRef.current = cached;
      }

      /*
       * 边距在描边**之前**：黑边是往主体外侧长，长的地方就是这里补出来的
       * 空白格。顺序反过来（先描边再扩画布）等于黑边已经贴着边界画完了，
       * 之后再补空白也补不出线来。
       *
       * applyMargin 同时搬 cells 和 guide，所以下面两者网格一定对齐；
       * 它不重跑量化，expand 只是加空格、shrink 是最近邻降采样。
       */
      const margined = applyMargin(pattern, cached.guide, margin);

      const result = applyCartoonOutline(margined.pattern, margined.guide, {
        enabled: true,
        thickness: outline.thickness,
        style: outline.style,
        // 线条两种：卡通线条=内部也描，轮廓黑边=只描最外圈
        internal: outline.lines === 'cartoon',
        experimentalParts: outline.experimentalParts,
      });
      if (cancelled) return;

      /*
       * skippedReason 只有几种，逐一翻译成人话。
       * `disabled` 不会走到这里（上面已经 return），但留着兜底：
       * 万一 outline.enabled 与传下去的值不同步，不要静默当成成功。
       */
      const reason = result.diagnostics.skippedReason;
      if (reason === 'no-free-color-slot') {
        setOutlinePattern(null);
          setOutlineNote(
          `颜色数已经用满 ${pattern.meta.colorLimit} 个，黑色占不到名额。把「颜色数量」调高 1 个，或者减少一种颜色再试。`,
        );
        return;
      }
      if (reason === 'no-brand-stroke-color') {
        setOutlinePattern(null);
          setOutlineNote('这个品牌色卡里没有中性深色，画不出黑边。换个品牌试试。');
        return;
      }
      if (reason) {
        setOutlinePattern(null);
          setOutlineNote(null);
        return;
      }

      setOutlineNote(
        result.diagnostics.touchesCanvasEdge
          ? '主体贴着画布边缘，最外圈没办法再往外扩一格；把「适配方式」改成完整放入会好一些。'
          : null,
      );
      setOutlinePattern(result.pattern);
      /*
       * 记下这份结果所在的显示空间。applyMargin 的 expand 会加 6 行 6 列，
       * shrink 保持行列数不变，所以直接读 margined.pattern 的行列数，
       * 而不是从 options.gridSize 反推。
       */
      const nextSpace = {
        cols: margined.pattern.cols,
        rows: margined.pattern.rows,
        mode: margin,
      };
      /*
       * 迁移手绘格：只在这两张图纸**格数不同**时才搬。
       *
       * 同一行列数下不动的原因：expand↔occupy 在长宽比恰好落在整数格时
       * 可能算出同样的 cols/rows，此时若照搬一遍"迁移"，等于把 edits 原样
       * 返回（remapEditsBetween 会短路），白跑一趟；而如果误判成"空间变了"
       * 又没短路，反而会叠加偏移。宁可少搬一次也不要多搬。
       */
      /*
       * 没有 prevSpace（描边刚被打开）时，手上那批 edits 属于**基础空间**
       * —— 也就是引擎原始图纸、没经过任何边距变换的那个网格。漏掉这一步
       * 会让"先画几笔、再打开黑边"的手绘格整体错位：画布从 52×64 变成
       * 58×70，但下标没跟着挪，同一个数字现在指向另一格，豆子就飘了。
       */
      const prevSpace = outlineSpaceRef.current ?? {
        cols: pattern.cols,
        rows: pattern.rows,
        mode: 'occupy' as MarginMode,
      };
      if (
        prevSpace.cols !== nextSpace.cols ||
        prevSpace.rows !== nextSpace.rows
      ) {
        setEdits(remapEditsBetween(editsRef.current, prevSpace, nextSpace));
      }
      outlineSpaceRef.current = nextSpace;
    } catch (err) {
      /*
       * 描边是可选装饰，它失败不该把整张图纸弄没。捕获后回落到原始图纸，
       * 让用户至少还能看、能导出、能继续编辑。
       */
      if (cancelled) return;
      console.error('[pindou] outline failed', err);
      setOutlinePattern(null);
      setOutlineNote('这次描边没算出来，先显示原始图纸。改一下粗细或换张图再试。');
    }

    return () => {
      cancelled = true;
    };
  }, [
    outline.enabled,
    outline.thickness,
    outline.style,
    outline.lines,
    // 边距会改变画布行列数（expand +6），必须重算描边
    margin,
    outline.experimentalParts,
    pattern,
    blankCanvas,
    /*
     * 源图解码完成信号：没有它，刷新后描边会静默放弃且永不重试。
     * 详见上面 `if (!data)` 分支里记录的实测时间线。
     */
    imageReady,
    ensureSource,
    // ensureSource 用 gridSize 决定解码精度；它变了要重新解码再描边
    options.gridSize,
  ]);


  /*
   * 用户眼里的图纸 = 引擎结果 + 手工覆盖层。
   *
   * 单点真相：页面上**所有**展示与导出都读这个，绝不读裸 pattern。
   * 手改的格子会连带影响颗数、色数、用料清单、PDF 图例 —— 那些数字
   * 必须跟着变，否则"我明明加了两颗红"的账对不上。画布内部虽然也
   * 自己算过一份叠加结果，但父层（图例/统计/导出/历史）读的是裸
   * pattern，于是会出现"画得出来、清单不涨"的不一致。
   *
   * 没有手工改动时（最常见）直接返回原对象，不做无谓的克隆：
   * applyEdits 会整份复制 cells，而 320 格图是 8.7 万个格，
   * 每次渲染复制一遍纯属浪费。
   *
   * 位置说明：必须定义在历史记录的 effect **之前** —— 那个 effect 的
   * deps 数组在渲染期就求值，若 displayPattern 还在这行之下，
   * 访问到的是尚未初始化的 const（TDZ 直接抛 ReferenceError）。
   */
  const editedCount = useMemo(() => editCount(edits), [edits]);
  const displayPattern = useMemo(() => {
    if (!pattern) return null;
    /*
     * 管线顺序：引擎量化 → 卡通黑边 → 手工覆盖层。
     *
     * 描边必须排在手工编辑**之前**：用户在描边结果上刷了一笔，那一格
     * 就该是他的颜色，不能又被黑边盖回去。反过来若先套编辑再描边，
     * 用户刚把某格改成白色、描边又给它画成黑 —— 这就是"改了没用"。
     *
     * outlinePattern 为 null 时（关闭/失败/不支持）完全等价于原先的行为，
     * 是同一个对象引用，所以关闭描边不会带来任何额外开销。
     */
    const base = outlinePattern ?? pattern;
    if (editedCount === 0) return base;
    return applyEdits(base, edits, options.brand);
  }, [pattern, outlinePattern, edits, editedCount, options.brand]);

  /*
   * ---------------------------------------------------------------
   * 文档级撤销 / 重做
   * ---------------------------------------------------------------
   *
   * 用户原话：「撤销和还原，还有还原到最初的那个就是有点不太对，尤其是你
   * 涂了某些区域应用算法之后，它就有点怪怪的。而且还有改画幅什么什么的，
   * 我觉得这都挺怪的，没有串起来。」
   *
   * 根本原因是回退能力散在三处互不相干的地方（画布内部的 delta 栈、刷区域
   * 工具条的撤销、编辑工具条的还原），每处只认识自己那一小块数据；而换图 /
   * 换尺寸 / 居中 / 放大这些**改变文档本身**的动作完全不进任何栈。详见
   * `src/hooks/useDocHistory.ts` 开头的长注释。
   *
   * 这里把整份文档当一个对象交给它：变化前后各拍一个快照。快照里全是引用
   * （每次变化 pattern/edits/brushes 都是新对象），所以"拍快照"只是几个指针。
   *
   * 记「意图」不记「派生」：`pattern` 是引擎算出来的，brushes 一变它几百
   * 毫秒后自己就变，若两个变化都记一笔，撤销一次只会退掉那次重算（图案闪
   * 回旧结果、选区还在图上）—— 这正是用户说的"怪怪的"。所以只有 sig 里那
   * 几项（图源、画板、参数、edits、brushes、边距、羽化）变了才记，pattern
   * 与描边结果只作为快照的一部分带着走（居中/放大直接改 cells，撤销得把
   * 那份 cells 一起还回去）。
   */
  const docSnapshot = useMemo<DocSnapshot>(
    () => ({
      sourceDataUrl,
      blankCanvas,
      options,
      edits,
      brushes,
      margin,
      regionFeather,
      pattern,
      outlinePattern,
      outlineSpace: outlineSpaceRef.current,
    }),
    [
      sourceDataUrl,
      blankCanvas,
      options,
      edits,
      brushes,
      margin,
      regionFeather,
      pattern,
      outlinePattern,
    ],
  );

  const docSig = useMemo(
    () => [
      sourceDataUrl,
      blankCanvas,
      /*
       * 参数逐项展开而不是整个 options 对象：源图解码完会顺手把 aspect
       * 改成图片真实比例，那不是用户动作。若整个对象进签名，每换一张图
       * 都会多记一笔"什么都没变"的历史，撤销要多按一次。
       */
      options.gridSize,
      options.brand,
      options.colorLimit,
      options.fit,
      options.smoothing,
      options.autoCrop,
      options.background,
      options.chromaBoost,
      options.dither,
      options.detail,
      edits,
      brushes,
      margin,
      regionFeather,
    ],
    [sourceDataUrl, blankCanvas, options, edits, brushes, margin, regionFeather],
  );

  const applyDoc = useCallback((d: DocSnapshot) => {
    /*
     * 顺序不重要（React 会把这一批合并成一次渲染），但**全都得设**：
     * 少设一样，撤销后图上就是"半旧半新"的状态，比不撤销更让人困惑。
     */
    /*
     * 告诉"空白画布 → 造图纸"那条 effect：这一帧的 blankCanvas 变化是
     * 还原历史写回来的，**不要**再造一张空板把 pattern 盖掉。见 docApplyRef。
     */
    if (d.blankCanvas) docApplyRef.current = true;
    setSourceDataUrl(d.sourceDataUrl);
    setBlankCanvas(d.blankCanvas);
    setOptions(d.options);
    setEdits(d.edits);
    setBrushes(d.brushes);
    setMargin(d.margin);
    setRegionFeather(d.regionFeather);
    setOutlinePattern(d.outlinePattern);
    /*
     * 描边所在空间也要还回去。描边 effect 每次跑都会拿它和新的行列数比，
     * 不等就重新迁移一遍 edits —— 撤销时若不还，迁移就会以还原后的 edits
     * 为输入再算一次，结果既不是撤销前也不是撤销后的样子。
     */
    outlineSpaceRef.current = d.outlineSpace;
    setPattern(d.pattern);
  }, []);

  /*
   * 哪几项变化要**单独**占一条历史。
   *
   * 与 docSig 逐位对齐。默认全部合并（拖动滑杆 3 秒 = 一步，撤销一次回到
   * 拖动前），但这几样是用户心里有明确边界的离散动作，一次就是一步：
   *
   *   - 换图 / 换画板：上下文整个换了
   *   - 手绘、区域笔刷：一笔就是一笔，连画十几笔只留一条就退不回去了
   *   - 边距：三个按钮切换，不是滑杆
   *
   * 反过来，gridSize / colorLimit / chromaBoost 这些连着滑的必须合并。
   */
  const docSigImmediate = useMemo(
    () => [
      true, // sourceDataUrl
      true, // blankCanvas
      false, // gridSize
      false, // brand（点选，但改了会整张重算，合并成本低、体验更连贯）
      false, // colorLimit
      false, // fit
      false, // smoothing
      false, // autoCrop
      false, // background
      false, // chromaBoost
      false, // dither
      false, // detail
      true, // edits
      true, // brushes
      true, // margin
      false, // regionFeather
    ],
    [],
  );

  const docHistory = useDocHistory(docSnapshot, docSig, applyDoc, {
    suppressRef: docHistorySuppressRef,
    immediate: docSigImmediate,
    resetKey: docEpoch,
  });

  /** 「还原」= 把全部手改格子擦掉。走 jumpTo，所以撤销得回来 */
  const handleResetEdits = useCallback(() => {
    if (editCount(docSnapshot.edits) === 0) return;
    docHistory.jumpTo({ ...docSnapshot, edits: EMPTY_EDITS });
  }, [docHistory, docSnapshot]);

  /*
   * 02 参数面板的节点，抽出来是为了让**桌面左栏**与**手机抽屉**共用同一份。
   *
   * 为什么要共用：两边各写一遍的话，以后加一个参数只改了一处，另一处就
   * 静默少一个控件 —— 手机上看起来像"这个功能没有"，桌面却正常。这种分裂
   * 只有人肉点两遍才发现。共用一份节点就不存在这个问题。
   *
   * 空白画布走 BlankSettings：它不走引擎，网格/色数/精细度/成片度/彩度
   * 全都不生效，给一堆假滑杆比不给更糟。
   */
  /*
   * 画板校准：居中 / 放大约到边。
   *
   * 两件事必须分开给，不能合成一个"自动摆正"：
   *   - 居中只平移，图案大小不变 —— 用户说"它贴在左上角"时要的是这个；
   *   - 放大是重采样，每颗豆变成 k×k 块 —— 用户说"板子这么大图太小"时
   *     要的是这个。
   * 合成一个的话，想居中的用户会突然发现图案变成 2 倍大。
   */
  const handleCenter = useCallback(() => {
    if (!displayPattern) return;
    const r = centerPatternToCanvas(displayPattern, edits);
    if (!r.moved) {
      toast.info('图案已经在正中央了');
      return;
    }
    /*
     * 走 jumpTo 而不是直接 setPattern：居中只改 `cells`，**不动**图源、
     * 参数、edits 这些"意图"。若直接 set，历史层看到的意图没有任何变化，
     * 这一步就不会被记 —— 用户点了居中，Ctrl+Z 撤掉的却是更早的那一笔，
     * 表现得就像"居中不可撤销"。这正是用户说的"改画幅什么挺怪的"。
     *
     * jumpTo 会先把**现在**压进撤销栈、再把目标写回去，所以撤一次就回到
     * 居中之前，且再重做又能居中回去。
     */
    docHistory.jumpTo({ ...docSnapshot, pattern: r.pattern, edits: r.edits });
    toast.success(
      `已居中：四边余量从 ${r.marginBefore} 格调到 ${r.marginAfter} 格`,
    );
  }, [displayPattern, edits, docHistory, docSnapshot]);

  const handleScaleToFit = useCallback(() => {
    if (!displayPattern) return;
    const r = scalePatternToCanvas(displayPattern, edits);
    if (!r.moved) {
      toast.info('已经铺满画板，或放大倍数不到 2 倍（拼豆只做整数倍放大）');
      return;
    }
    // 同居中：只改 cells，必须显式进历史（见 handleCenter 的注释）
    docHistory.jumpTo({ ...docSnapshot, pattern: r.pattern, edits: r.edits });
    toast.success(
      r.raggedCells > 0
        ? `已放大 ${r.amount} 倍，有 ${r.raggedCells} 格宽度不齐`
        : `已放大 ${r.amount} 倍，无空洞无锯齿`,
    );
  }, [displayPattern, edits, docHistory, docSnapshot]);

  const sizeCm = pattern?.meta.sizeCm ?? null;
  const paramsNode = pattern || blankCanvas ? (
    blankCanvas ? (
      <BlankSettings
        brand={options.brand}
        onBrandChange={(brand) => setOptions((prev) => ({ ...prev, brand }))}
        cols={blankCanvas.cols}
        rows={blankCanvas.rows}
        onResize={() => setNewCanvasOpen(true)}
        onCenter={handleCenter}
        onScaleToFit={handleScaleToFit}
        canCalibrate={!!displayPattern && displayPattern.totalBeads > 0}
      />
    ) : (
      <PatternSettings
        value={options}
        onChange={setOptions}
        actualCols={pattern?.cols}
        actualRows={pattern?.rows}
        sizeCm={sizeCm}
        isWorking={isWorking}
        outline={outline}
        onOutlineChange={setOutline}
        outlineNote={outlineNote}
        margin={margin}
        onMarginChange={setMargin}
        onCenter={handleCenter}
        onScaleToFit={handleScaleToFit}
      />
    )
  ) : null;

  /*
   * 历史签名 = 参数 + 网格 + 颗数 + **手改格数**。
   *
   * 加上手改格数是为了让"涂了几笔"也能落进历史：不加快照的话，
   * 用户在图上涂了半天，历史里存的还是刚生成时的样子，恢复回来
   * 一片空白 —— 而且列表上显示的颗数也还是改之前的。
   * 用格数而不是完整 EditMap 做签名：涂一百格只是慢慢加数字，
   * 不会因为"涂的位置变了"就误判成一次全新记录。
   */
  const lastRecordedRef = useRef<string>('');
  useEffect(() => {
    /*
     * 图片来源有两条：引擎生成的（要 imageInfo + sourceDataUrl）与空白画布
     * （两者都没有，但有 blankCanvas）。原来这里只认第一条，于是空白画布
     * 画了一小时也不会进历史 —— 刷新就全没了。
     */
    const blank = blankCanvas;
    if (!displayPattern) return;
    if (!blank && (!imageInfo || !sourceDataUrl)) return;
    const signature = blank
      ? `blank:${blank.id}|${blank.cols}x${blank.rows}|${options.brand}|${displayPattern.totalBeads}|e${editedCount}`
      : `${optionsKey}|${displayPattern.cols}x${displayPattern.rows}|${displayPattern.totalBeads}|e${editedCount}`;
    if (lastRecordedRef.current === signature) return;
    lastRecordedRef.current = signature;

    /*
     * 空白画布的缩略图画棋盘格而不是"空画布"：一张全空白的图在历史列表里
     * 区分不出是"还没画"还是"加载失败"。用空底板棋盘，一眼知道是张空板子。
     */
    const preview = blank
      ? blankThumbnail(blank.cols, blank.rows, 132)
      : patternToThumbnail(displayPattern, 132);
    if (!preview) return;

    /*
     * 历史里存的必须是**压缩后的原图**，不能直接塞 sourceDataUrl。
     *
     * 一张 512×512 PNG 的 dataURL 有 185,670 字符，直接进 localStorage
     * 的话 12 条就要 2.2MB，逼近 5MB 配额，旧记录会被静默挤掉。
     * compressSourceDataUrl 早就写好了，但一直没人调用（实测历史里
     * 每条 sourceDataUrl 就是 185670 字符）。
     *
     * 640px + JPEG 0.75 后约 30-50KB：对 120 格的图案仍然有 5.3px/格，
     * 远高于画布需要的分辨率，而恢复历史时的图案质量几乎无损。
     */
    let cancelled = false;
    void (async () => {
      /*
       * 空白画布没有原图可压。它用 `blank:<cols>x<rows>` 作占位串 ——
       * 一是 `HistoryItem.sourceDataUrl` 必填（上层拿它做外层去重），
       * 二是把尺寸编进字符串，让 29×29 与 96×96 的两块空板天然是两条记录，
       * 不会被去重并成一条。
       */
      const compact = blank
        ? blankSourceKey(blank.cols, blank.rows, blank.id)
        : await compressSourceDataUrl(sourceDataUrl as string).catch(
            () => sourceDataUrl as string,
          );
      if (cancelled) return;
      /*
       * 历史写入是**同步返回结果**的（不是 Promise），所以这里可以立刻
       * 判断成败并给用户反馈。要区分两种失败：
       *   - trimmed：存下了，但为了腾地方把最旧的记录挤掉了
       *   - rejected：完全没存上（localStorage 满且裁无可裁）
       * 只提示 rejected 会让用户以为"trimmed"也丢了东西；
       * 完全静默又会让用户在下一次刷新后发现历史少了却不知道为什么。
       */
      const result = addToHistory({
        previewUrl: preview,
        sourceDataUrl: compact,
        settings: options,
        cols: displayPattern.cols,
        rows: displayPattern.rows,
        totalBeads: displayPattern.totalBeads,
        colorCount: displayPattern.palette.length,
        sourceMeta: blank
          ? { width: blank.cols, height: blank.rows, name: `空白画布 ${blank.cols}×${blank.rows}` }
          : imageInfo
            ? { width: imageInfo.width, height: imageInfo.height, name: imageInfo.name }
            : undefined,
        // 手改覆盖层跟着版本走，恢复历史时能一起恢复回来
        ...(editedCount > 0 ? { edits } : {}),
      });
      if (result === 'trimmed') {
        toast.warning('历史已满，最旧的一条记录被挤掉了');
      } else if (result === 'rejected') {
        toast.error('浏览器存储空间不足，这次没存进历史；可以先清空历史再试');
      }
    })();
    return () => {
      cancelled = true;
    };
    // imageInfo 只用来保证"有图"，不参与签名
  }, [
    displayPattern,
    editedCount,
    edits,
    options,
    optionsKey,
    sourceDataUrl,
    addToHistory,
    imageInfo,
    blankCanvas,
  ]);

  /*
   * 恢复历史：可带第二参数指定"恢复哪一版"。
   *
   * 为什么必须这样写：HistoryList 的 onRestore 签名是
   * `(item, version?) => void`，而 TS 允许"参数更少"的函数赋给
   * "参数更多"的类型 —— 也就是说如果这里只收 item，点版本时间线里
   * 的某一版时，version 会被**静默丢掉**，恢复的反而是最新版，
   * 而且编译器一声不响。这类 bug 跑到线上极难定位。
   *
   * item 上的 settings/cols/rows/previewUrl 都只是"当前版本"的
   * 冗余投影（见 useHistory 的 withProjection），所以恢复某一版时
   * 必须用 version 覆盖投影，不能直接用 item 上的值。
   */
  const handleRestore = useCallback(
    (item: HistoryItem, version?: HistoryVersion) => {
      const v = version ?? item.versions[item.versions.length - 1];
      /*
       * 空白画布与图片来源是互斥的两条路，恢复前必须先判断这一条记录
       * 属于哪条。
       *
       * 早期版本这里直接 setSourceDataUrl(item.sourceDataUrl)：空白画布
       * 的占位串是 `blank:64x64`，不是 dataURL，赋给 sourceDataUrl 之后
       * 解码 effect 会拿它去 `img.src`，触发 onerror，用户看到的是
       * "这张图片解不开，换一张试试" —— 明明什么都没传。
       */
      const blankSize =
        parseBlankSourceKey(item.sourceDataUrl) ??
        (item.sourceMeta?.name?.startsWith('空白画布') &&
        v.cols > 0 &&
        v.rows > 0
          ? { cols: v.cols, rows: v.rows }
          : null);

      if (blankSize) {
        // 先清图源再设空白：顺序反了会让"清空 pattern"的 effect 多跑一帧
        setSourceDataUrl(null);
        setImageInfo(null);
        sourceRef.current = null;
        imageDataRef.current = null;
        sourceEdgeRef.current = 0;
        /*
         * 复用记录里的 id，而不是新生成一个。
         *
         * 生成新的会让"恢复之后再涂两笔"变成一条**新记录**，历史里于是
         * 出现同一张图的两个分叉，用户完全无法分辨哪个是哪个。复用则
         * 继续挂在原来那条记录上、多出一个版本，语义正确。
         */
        setBlankCanvas({
          cols: v.cols,
          rows: v.rows,
          id: blankSize.id ?? makeBlankId(),
        });
      } else {
        setBlankCanvas(null);
        setSourceDataUrl(item.sourceDataUrl);
        setImageInfo(
          (prev) =>
            prev ??
            (item.sourceMeta
              ? { ...item.sourceMeta }
              : { width: 0, height: 0, name: '历史图案' }),
        );
      }

      setOptions((prev) => ({ ...prev, ...v.settings }));
      setBrushes([]);
      /*
       * 恢复该版本上的手工编辑。
       *
       * 早先这里写死 `setEdits(EMPTY_EDITS)`，理由是"覆盖层按格子下标存，
       * 跨图无意义" —— 但我们本来就不会跨图复用：edits 现在跟着
       * version 一起存，同一个 version 的 cols/rows 与它自己的 edits
       * 严格对应。清掉它等于让用户涂了一小时的图恢复回来是空白的。
       */
      setEdits(v.edits ?? EMPTY_EDITS);
      // 恢复时不要被"签名相同"挡住
      lastRecordedRef.current = '';
      toast.success(`已恢复 ${v.cols} × ${v.rows} 的图纸`);
    },
    [],
  );

  /*
   * 新建空白画布。
   *
   * 顺序有讲究：先清 sourceDataUrl 再设 blankCanvas。反过来的话，那个
   * "没有源图就清空 pattern" 的 effect 会先跑一轮把图纸抹掉，虽然紧接着
   * 空白画布 effect 会再造一张，但中间那一帧的空白会闪一下。
   *
   * 同时把 sourceRef / imageDataRef 一起清掉：它们是上一张图的内存缓存，
   * 留着不影响正确性（blankCanvas 分支根本不读它们），但 320 格时的
   * 解码位图有几十 MB，用户不会再切回来了，早点放手。
   */
  const handleCreateBlank = useCallback(
    (cols: number, rows: number, brand: Brand) => {
      /*
       * 换尺寸 = 把已有图案按比例搬过去，而不是抹掉重来。
       *
       * 用户的原话是「换尺寸的应该是按比例缩放的」：这块板子从 48×48 改成
       * 64×64，他想要的是同一张图装进更大的板，不是重画一遍。只有真的没
       * 东西可搬（没有图纸 / 全空）时才退化成纯替换。
       */
      /*
       * 源必须用 displayPattern 而不是 pattern：空白画布的手绘格子全在
       * `edits` 覆盖层里，`pattern.cells` 是一整片 -1。拿 pattern 去搬会
       * 搬过去一张空板子 —— 实测「画了 3 格 → 换尺寸 → 图没了」。
       */
      const carried = displayPattern
        ? resizePatternToCanvas(displayPattern, cols, rows, brand, edits)
        : null;

      setSourceDataUrl(null);
      setImageInfo(null);
      sourceRef.current = null;
      imageDataRef.current = null;
      sourceEdgeRef.current = 0;
      setError(null);
      setBrushes([]);
      setEdits(carried ? carried.edits : EMPTY_EDITS);
      setOptions((prev) => ({ ...prev, brand }));
      // 从空态新建 = 新文档（清历史）；同一份图纸换板子 = 不换身份（可撤销）
      if (!displayPattern) setDocEpoch((n) => n + 1);
      setBlankCanvas({ cols, rows, id: makeBlankId() });
      // 记一笔历史时不要让"签名相同"挡住
      lastRecordedRef.current = '';
      if (carried && carried.pattern.totalBeads > 0) {
        /*
         * 搬过来的图案直接 set 进 pattern 会让下面那条"空白画布 effect"再
         * 造一张全空的把它盖掉 —— 那条 effect 只认 blankCanvas 变化。所以
         * 用 carriedRef 让 effect 知道这一次已经有内容了。
         */
        carriedRef.current = carried.pattern;
        const bits = [`已换成 ${cols} × ${rows}，图案按比例搬过来了`];
        if (carried.clippedCells > 0) bits.push(`裁掉 ${carried.clippedCells} 颗`);
        if (Math.abs(carried.aspectDistort - 1) > 0.02) {
          bits.push(`长宽比变了 ${carried.aspectDistort.toFixed(2)} 倍，图案有拉伸`);
        }
        toast.success(bits.join('，'));
      } else {
        carriedRef.current = null;
        toast.success(`已新建 ${cols} × ${rows} 的空白画布，点「编辑」开始画`);
      }
    },
    [displayPattern, edits],
  );

  const handleClear = useCallback(() => {
    setDocEpoch((n) => n + 1);
    setSourceDataUrl(null);
    setBlankCanvas(null);
    setImageInfo(null);
    setPattern(null);
    setError(null);
    setBrushes([]);
    setEdits(EMPTY_EDITS);
    /*
     * 清空要**立刻**删会话，不能等下面那个 effect 的 240ms debounce。
     * 用户点完清空马上关标签页时，debounce 的 timer 还没到就被卸载，
     * 磁盘上那份会话还在 —— 下次打开又冒出刚才清掉的图。
     */
    clearWorkspaceSession();
  }, []);

  const hasImage = Boolean(sourceDataUrl) || blankCanvas !== null;

  /*
   * 新建画布会**替换**当前图纸 —— 这句话必须提前说，不能让用户按完
   * 才发现刚画的东西没了。只在"真的会丢东西"时才提示：一张刚生成的、
   * 没手改过的图纸重来不心疼；画了格的才需要提醒，并且给出具体数量。
   */
  /*
   * 把引擎的识别结论整理成 FileUpload 要显示的两种标记。
   *
   * 用 `pattern` 而不是 `displayPattern`：描边/手改不会改变"这张图被认成
   * 什么"，那是生成阶段的一次性结论。用 displayPattern 的话，用户每刷一
   * 笔都会重算一次 memo（applyEdits 是全量重建），纯属浪费。
   *
   * 读的是 meta 而不是重新跑检测 —— 检测已经在 generatePattern 里做过
   * 一次了，这里只是把结果搬到界面上。
   */
  const imageDetection = useMemo(() => {
    const meta = pattern?.meta;
    const np = meta?.nativePixel;
    if (!np) return null;
    return {
      nativePixel: np.detected
        ? { cols: np.cols, rows: np.rows, confidence: np.confidence }
        : null,
      watermark:
        np.watermarkDetected && np.watermarkAreaFrac > 0
          ? { areaFrac: np.watermarkAreaFrac }
          : null,
    };
  }, [pattern]);

  /*
   * 换尺寸不再是"替换" —— 图案会按比例搬到新画板上，所以警告改成了
   * "搬运说明书"。原来那句「会被替换掉」在保留内容之后就是错的，会让
   * 用户以为画的东西要没了，从而不敢按。
   *
   * 只在真有内容可搬时才说"搬过去"；空板子照旧说"会换成新尺寸"。
   */
  const replaceWarning = useMemo<string | null>(() => {
    if (!hasImage) return null;
    const hasContent = (displayPattern?.totalBeads ?? 0) > 0;
    const from = blankCanvas
      ? `${blankCanvas.cols} × ${blankCanvas.rows} 的空白画布`
      : '当前图纸';
    if (!hasContent) {
      return blankCanvas
        ? `当前这块 ${from}还是空的，换尺寸只会改变画板大小。`
        : null;
    }
    const bits = [`会按比例搬到新画板上，不用重画`];
    if (editedCount > 0) bits.push(`你手改的 ${editedCount} 格也跟着搬`);
    return `${from}上的图案${bits.join('，')}。缩小太多会裁掉边上的豆。`;
  }, [hasImage, blankCanvas, editedCount, displayPattern]);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <Toaster position="top-center" richColors />

      {/*
       * 新建画布对话框。
       *
       * 默认行列取"当前图纸的实际尺寸"，其次才是参数里的 gridSize ——
       * 用户如果已经有一张 96 格的图，新建时最可能的意图是"再来一张
       * 同样大小的"，而不是回到默认 64。
       */}
      <NewCanvasDialog
        open={newCanvasOpen}
        onOpenChange={setNewCanvasOpen}
        defaultCols={pattern?.cols ?? options.gridSize}
        defaultRows={pattern?.rows ?? options.gridSize}
        defaultBrand={options.brand}
        onCreate={handleCreateBlank}
        replaceWarning={replaceWarning}
      />

      {/*
       * 手机端参数抽屉。
       *
       * 内容直接就是 `paramsNode`（与桌面左栏同一份节点），所以桌面加的
       * 每一个参数都自动出现在这里，不存在"手机上少一个控件"的分裂。
       *
       * 变更**不会**自动关闭抽屉：调参数时最需要看的就是画布变化，抽屉
       * 一关就把判断依据收走了。关闭只有遮罩/Esc/X/右滑四种主动操作。
       */}
      <MobileDrawer
        open={paramsOpen}
        onClose={() => setParamsOpen(false)}
        /*
         * 标题跟着内容走。
         *
         * 空白画布的正文标题是「画布参数」而不是「图案参数」，抽屉头若写死
         * 「02 图案参数」，就会出现「02 图案参数」压着「02 画布参数」两行 ——
         * 序号重复、两个标题又极其相似，读起来像同一句话说了两遍。
         *
         * 跟着走的额外好处：抽屉自带"标题与正文标题相同就收掉正文那行"的
         * 去重逻辑（MobileDrawer 里按文本比对），这里一改成一致，空白画布
         * 也自动少一行，不用另加特例。
         */
        title={blankCanvas ? '02 画布参数' : '02 图案参数'}
        hint={
          isWorking
            ? '重算中…'
            : displayPattern
              ? `${displayPattern.palette.length} 色 · 约 ${Math.round(displayPattern.totalBeads / 100) / 10}k 颗`
              : '实时预览'
        }
        returnFocusTo={paramsBtnRef}
      >
        {paramsNode}
      </MobileDrawer>

      {/* 背景布景：花朵与草木，压在内容之下 */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <PixelGarden opacity={0.55} />
      </div>

      {/* ============================ 顶栏 ============================ */}
      <header className="relative z-20 shrink-0 border-b-2 border-[var(--line-strong)] bg-[var(--paper-raised)]/92 backdrop-blur-[2px]">
        {/*
          手机（<sm）把左右内边距和中间间距收窄一档：390 宽下原来只剩
          358px 给「吉祥物 + 标题」和「历史/导出/主题」两坨，差 2px 装不下，
          标题末尾的「坊」被切掉半个字。收一档后富余 6px。
        */}
        <div className="relative flex items-center justify-between gap-2 px-3 py-2.5 sm:gap-4 sm:px-4">
          {/*
            左：吉祥物 + （手机上）标题。
            这个 div 是 `relative` 的，聊天气泡挂在它下面 —— 气泡要贴着
            鸭子说话，而不是贴着整条顶栏。
          */}
          <div className="relative flex min-w-0 items-center gap-2.5 sm:gap-3">
            <MascotMark brand={options.brand} />
            {/* 手机上标题留在鸭子右边；lg 以上挪到顶栏正中（见下面那块） */}
            <div className="min-w-0 leading-none lg:hidden">
              <h1 className="font-display truncate text-[17px] font-bold tracking-tight text-[var(--ink)] sm:text-[18px]">
                拼豆图纸工坊
              </h1>
              {/* 英文副标在手机上只会挤占空间，藏掉 */}
              <p className="mt-1 hidden font-px text-[9px] uppercase tracking-[0.22em] text-[var(--ink-3)] sm:block">
                perler bead atelier
              </p>
            </div>
            {/*
              吉祥物的随机台词气泡。
              用户原话：「这里面可以加个小宠物的聊天气泡，有几句话随机说
              （有时候出现有时不出现），就是引起兴趣的，就是那种 AI 帮助
              创作的」。它自己管节奏（9–18s 间隔、4.6–6.4s 停留），
              这里只决定挂在哪。
            */}
            <MascotBubble />
          </div>

          {/*
            中：标题。
            用户说「然后拼豆创意工坊这个标题移动到中间也行」。
            用绝对定位居中而不是 flex-1：flex 居中会被左右两侧宽度不同的
            内容推着走（右侧有统计 tag 时会偏），绝对居中才是真居中。
            手机放不下三段，所以只在 lg 以上这样排。
          */}
          <div className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 leading-none lg:block">
            <h1 className="font-display text-center text-[18px] font-bold tracking-tight text-[var(--ink)]">
              拼豆图纸工坊
            </h1>
            <p className="mt-1 text-center font-px text-[9px] uppercase tracking-[0.22em] text-[var(--ink-3)]">
              perler bead atelier
            </p>
          </div>

          {/*
            `shrink-0`：右侧这排按钮**不许被压缩**。
            用户截图（真机 393 逻辑宽）里「历史」被挤成竖排两行（历 / 史），
            按钮高从 31px 涨到 46px，整条顶栏跟着变扭。原因是这个 div 是
            flex 子项、默认 `flex-shrink: 1`，而它内部按钮的文字默认
            `white-space: normal` —— 差 4px 时浏览器优先折文字而不是截标题。
            让位应该由左边的标题承担（它本来就有 `truncate`）。
          */}
          <div className="flex shrink-0 items-center gap-2">
            {displayPattern && (
              <span className="hidden items-center gap-1.5 lg:flex">
                <span className="px-tag px-tag-leaf">
                  {displayPattern.totalBeads} 颗
                </span>
                <span className="px-tag px-tag-ink">
                  {displayPattern.palette.length} 色
                </span>
                <span className="px-tag px-tag-ink">
                  {displayPattern.cols} × {displayPattern.rows}
                </span>
                {editedCount > 0 && (
                  <span
                    className="px-tag px-tag-gold"
                    title="手工改过的格子数（已计入颗数与用料）"
                  >
                    手改 {editedCount}
                  </span>
                )}
              </span>
            )}
            {isLoaded && <HistoryList onRestore={handleRestore} />}
            <PDFExport pattern={displayPattern} brand={options.brand} compact />
            <button
              type="button"
              onClick={toggleTheme}
              className="px-btn px-btn-ghost !px-2.5"
              aria-label={theme === 'dark' ? '切换到日间' : '切换到夜间'}
              title={theme === 'dark' ? '日间工作台' : '夜灯工作台'}
            >
              {theme === 'dark' ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* ============================ 主区 ============================ */}
      {/*
       * 工作台布局：整页锁定视口高度，三栏各自内部滚动。
       *
       * 之前是"页面整体滚动 + 左侧栏无限长"，问题很实在：调一个滑杆要
       * 往下滚半屏才看得到画布的反应，调完再滚回来；用料清单一长，
       * 侧栏能把整个页面撑到三四屏。现在顶栏固定、画布吃掉中间全部
       * 剩余高度，左栏（图 + 参数）和右栏（用料）各自是独立滚动区，
       * 视线永远落在同一个位置 —— 手在左，眼在右，互不打架。
       *
       * 小屏（< lg）退回单列并放开滚动：手机上没有"并排"可言，
       * 强行锁高只会把画布压成一条缝。
       */}
      <main className="relative z-10 min-h-0 flex-1 lg:overflow-hidden">
        {/* 布局说明（两套）
         *
         * 大屏（≥lg）：三块并排 —— 左栏「图 + 参数」独立滚动、中栏图纸
         *   吃掉剩余高度、用料清单在 ≥1800px 时才有第三栏（窄一点的
         *   显示器上三栏会把图纸挤到 500px 以内，反而更难受）。
         *
         * 小屏（<lg）：**顺序重排**成「01 放图 → 04 图纸 → 02 参数 →
         *   03 用料」。原来的顺序是把左栏整坨放在前面，手机上要滑过
         *   一整个参数面板才看得到图纸；而调参数的意义恰恰是看图纸
         *   的反应 —— 所以图纸必须紧跟上传区。
         *   实现用 `contents` 让左栏在手机上"消失成透明"，它的三个
         *   section 直接进入父级 flex，再用 order 重排；大屏时左栏
         *   恢复成 flex 列，order 不再起作用（grid 只按 DOM 顺序放）。
         */}
        {/*
         * 巡游桌宠。
         *
         * 挂成 .wb 的**兄弟**而不是子元素：.wb 在大屏上是 grid，多一个
         * 子元素会占掉一个网格单元（把左栏挤到第二行）。放在外面用
         * absolute 覆盖整块工作区，锚点是相对这块区域的百分比，
         * 与 .wb 的 grid 结构完全解耦。
         *
         * awareness 负责表情：出错 / 重算 / 编辑 / 刷区域 / 无图 / 出图完成
         * 各有一个对应的形态。刷区域和编辑时它还会**主动让开** ——
         * MascotRoamer 的 desk-left-* 锚点带 excludeIn: ['editing','brushing']。
         *
         * 手机（<lg）不显示：54dvh 的画布上再飘一只豆子就真的挡格子了。
         *
         * 左栏收起时也不显示。锚点是照着"左栏在"的布局扫出来的百分比；
         * 左栏一收，画布往左顶、宽出 320px，右侧缝也一起吃紧 —— 实测折叠
         * 状态下 1920 宽 30 秒里压了 2 次画布。硬按包围盒筛会把候选筛到
         * 只剩一两个点（画布几乎占满整行，本来就没留白可站），桌宠就变成
         * 在同一个角落反复闪。折叠是一种"专注看图纸"的姿态，此时它消失
         * 是最干净的解法；展开左栏它自己就回来了。
         */}
        {hasImage && !leftCollapsed && (
          <div className="pointer-events-none absolute inset-0 z-20 hidden lg:block">
            <MascotRoamer
              anchors={WORKBENCH_ANCHORS}
              awareness={awareness}
              baseSize={44}
            />
          </div>
        )}

        {/*
         * 折叠后的还原把手。
         *
         * 左栏收成 0 宽之后，那一侧就是一片空白 —— 用户在画布上画了半天，
         * 想改参数时会先往左看，看到的只有纸面。只靠图纸标题栏里那个按钮
         * 不够：它离左边太远，而且和「刷区域 / 编辑 / 色号」混在一排，
         * 视线扫过去不会注意到。所以原地留一条竖边条，鼠标一靠近就浮出
         * 「展开左栏」。24px 是能舒服点中的最小宽度（WCAG 2.5.8 要求 24）。
         */}
        {hasImage && leftCollapsed && (
          <button
            type="button"
            onClick={toggleFocus}
            className="absolute top-3 bottom-3 left-0 z-30 hidden w-6 items-center justify-center border-r-2 border-[var(--line)] bg-[var(--paper-raised)]/70 text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-hi)] hover:text-[var(--clay)] lg:flex"
            aria-label="展开左侧的图片与参数面板"
            title="展开左栏"
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          </button>
        )}

        <div className={cn('wb', leftCollapsed && 'wb-focus')}>
          {/* ---------------------- 左栏：输入与参数（内部滚动） ---------------------- */}
          <div className="wb-left">
            <Section
              title={blankCanvas ? '空白画布' : '放一张图'}
              hint={
                blankCanvas
                  ? `${blankCanvas.cols} × ${blankCanvas.rows}`
                  : 'JPG / PNG / WebP / GIF'
              }
              /*
               * 折叠入口放在左栏自己的标题栏上。
               *
               * 之前放在画布标题栏（中间那栏的右上角），用户反馈说不好用：
               * 想收起左栏时，视线和鼠标都在左边，按钮却在右侧画布标题上，
               * 每次都要横跨半个屏幕。折叠按钮应该长在**它要折叠的那块**上，
               * 这是就地操作原则 —— 用户截图标注也指的正是这个位置。
               */
              action={
                hasImage ? (
                  /*
                   * 折叠按钮的尺寸。
                   *
                   * 原来是 `!px-1 !py-0.5` + 14px 图标 ≈ 22×22，用户反馈
                   * 「这个折叠按钮也可以大一点」—— 22px 是个"能点中但试探
                   * 一次"的尺寸，而它是个高频开关（收左栏看大图时每次都要按）。
                   * 现在撑到 28×28（图标 16px + 6px 内边距），既是 WCAG 2.5.8
                   * 的 24px 下限之上，又能和右侧的 hint 文字在视觉重量上对齐 ——
                   * 一个纯图标按钮摆在标题栏最右端，太小会像块污渍。
                   */
                  <button
                    type="button"
                    onClick={toggleFocus}
                    /*
                     * `hidden lg:inline-flex` —— 窄屏不显示这个按钮。
                     *
                     * 用户反馈：「如果是瘦版本的，那个收回侧边栏还在，点击却
                     * 没有，这就有点不和谐了」。根因是 `.wb-focus` 那套规则全
                     * 写在 `@media (min-width:64rem)` 里，而窄屏下 `.wb` 是单列
                     * flex（不是 grid）、`.wb-left` 是 `display:contents` ——
                     * 点下去只给 `.wb` 加了 `wb-focus` 类，`grid-template-columns: 0`
                     * 对 flex 容器没有任何作用，左栏宽度也不归它管，于是就成了
                     * "按钮在、按了没反应"。
                     *
                     * 选择"藏掉"而不是"给窄屏另做一套折叠"：窄屏下三块
                     * （01 放一张图 / 04 图纸 / 02 参数）本来就是竖着堆的，图纸
                     * 已经 `order:0` 排在最前、且吃满整宽 —— 收起左栏既不能让
                     * 画板变大，也没有一个像样的"还原"入口（那条 24px 的竖边条
                     * 也是 `hidden lg:flex`）。多做一套容易让用户收起来之后找不
                     * 着路，而这个动作本身在窄屏上没有收益。
                     *
                     * 放在 class 里而不是 CSS 的 `[data-testid=...]` 规则：实测
                     * 那条属性选择器没被编译进产物（dev 的 CSS 逐字节没变），
                     * 而 Tailwind 工具类一直可靠。
                     */
                    className="px-btn px-btn-ghost hidden lg:inline-flex"
                    style={{ width: 32, height: 32, padding: 0, flex: 'none' }}
                    aria-pressed={leftCollapsed}
                    title="收起左侧面板，让图纸占满整行"
                    aria-label="收起左侧的图片与参数面板"
                    data-testid="collapse-left"
                  >
                    <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />
                  </button>
                ) : undefined
              }
              className="order-1"
            >
              {blankCanvas ? (
                <BlankCanvasCard
                  cols={blankCanvas.cols}
                  rows={blankCanvas.rows}
                  brand={options.brand}
                  onResize={() => setNewCanvasOpen(true)}
                  onClear={handleClear}
                />
              ) : (
                <FileUpload
                  onImage={handleImage}
                  onClear={handleClear}
                  previewUrl={sourceDataUrl}
                  imageInfo={imageInfo}
                  detection={imageDetection}
                  disabled={isWorking && !pattern}
                />
              )}

              {/*
               * 「新建空白画布」的入口放在图源区域底部，而不是顶栏。
               *
               * 它和"传一张图"是同一件事的两种做法（决定图纸从哪来），
               * 摆在一起用户才看得懂是二选一。放顶栏会被读成另一个功能。
               */}
              {!blankCanvas && (
                <div className="mt-3 border-t-2 border-dashed border-[var(--line)] pt-3">
                  <button
                    type="button"
                    onClick={() => setNewCanvasOpen(true)}
                    className="px-btn px-btn-sm w-full justify-center"
                    data-testid="new-blank-canvas"
                  >
                    <Grid2x2 className="h-3.5 w-3.5" aria-hidden />
                    从空白画布开始
                  </button>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
                    没有参考图？选一块空板子，用画笔一格一格涂。
                  </p>
                </div>
              )}
            </Section>

            {/* 没图的时候，参数面板只露一个引导，避免空滑杆让人无所适从 */}
            {hasImage ? (
              <Section
                title="调参数"
                hint={isWorking ? '重算中…' : '实时预览'}
                busy={isWorking}
                hideHeader
                /*
                 * 窄屏**不内联渲染**这块 —— 参数已经在叠层抽屉里了。
                 *
                 * 用户原话：「既然在叠层了，竖版的下面就没必要出现了吧」。
                 * 两份一样的控件摆着，坏的还不只是占地方：抽屉里改一项、
                 * 收起抽屉又看到一块长得一样的面板，用户根本分不清哪个是
                 * 真的，改完还怀疑没生效。
                 *
                 * 桌面（lg 以上）仍然内联：左栏与画布并排，改参数时画布
                 * 一直可见，这就是它该在的地方，没必要多点一次。
                 */
                className="order-3 hidden lg:block"
              >
                {/*
                 * 空白画布只有"色号体系"一个参数是有意义的。
                 *
                 * 网格密度决定画布尺寸 —— 空白画布的尺寸由用户在建的时候
                 * 定死了，滑杆在这里是假的；颜色数量 / 精细度 / 成片度 /
                 * 彩度增强全部是引擎参数，空白画布不走引擎，它们一个都
                 * 不会生效。把一堆无效滑杆留给用户，比不给更糟：他会调了
                 * 半天发现画面没反应，然后怀疑整个工具。
                 *
                 * 所以这里换成一个只含品牌选择的窄面板，并把"其余参数对
                 * 空白画布不生效"直接写在界面上。
                 */}
                {paramsNode}
              </Section>
            ) : (
              <div className="px-panel-flat order-3 px-5 py-6">
                <p className="font-px text-[10px] uppercase tracking-[0.2em] text-[var(--ink-3)]">
                  02 · 调参数
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-2)]">
                  上传图片后，这里会出现网格密度、颜色数量、品牌色卡、
                  色块成片度等参数。改动即时生效，不用点「应用」。
                </p>
              </div>
            )}

            {/* 用料清单在窄屏（没有右栏时）留在左栏底部 */}
            {displayPattern && displayPattern.palette.length > 0 && (
              <Section
                title="用料清单"
                hint={`${displayPattern.palette.length} 色`}
                hideHeader
                className="wb-left-legend order-4"
              >
                <ColorLegend
                  palette={displayPattern.palette}
                  brand={options.brand}
                  totalBeads={displayPattern.totalBeads}
                />
              </Section>
            )}
          </div>

          {/* ---------------------- 中栏：图纸（吃满剩余高度） ---------------------- */}
          {/* 手机上必须给一个明确高度：父级是 flex 列，图纸面板内部又是
              flex-1 + min-h-0，没有高度约束时会直接塌成 0 像素。
              62dvh 既能露出画布，又给下面的参数区留出可见的"往下还有东西"，
              用户知道要往下滑。 */}
          <div className="wb-mid order-2 flex min-h-0 min-w-0 flex-col gap-3 lg:order-none">
            <div className="px-panel relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b-2 border-[var(--line)] px-3.5 py-2">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="font-display text-[15px] font-bold tracking-tight">
                    图纸
                  </h2>
                  {/*
                    尺寸在 xl 以下只留格数、不留厘米数：标题栏要塞下整条
                    画布工具条，1024–1279 那段宽度差最后这几十像素就会
                    折行，而折行等于把省下来的那一行又还回去了。
                    格数是拼豆规格的硬信息（决定板子张数），厘米是估算，
                    缩到 xl 以上再显示。
                  */}
                  {displayPattern && (
                    <span className="font-px text-[10px] tracking-wide text-[var(--ink-3)]">
                      {displayPattern.cols} × {displayPattern.rows}
                      {sizeCm ? (
                        <span className="hidden xl:inline">
                          {` · 约 ${sizeCm.w} × ${sizeCm.h} cm`}
                        </span>
                      ) : null}
                    </span>
                  )}
                </div>

                {/*
                 * 画布工具条的槽位 —— 整条工具条（缩放组 + 刷区域/编辑/色号/
                 * 网格/标尺）由 PatternCanvas 通过 portal 送进来。
                 *
                 * 用户分两次标的：先把 Zoom 组指到这块空白（「这个东西位置
                 * 不好，占了一行，下面就会少一行空间给面板」），Zoom 搬走后又
                 * 圈出剩下那排按钮说「这个也移植到上面那一行吧，不然看起来
                 * 很难受，能省空间就省」。合起来就是整条工具条上移，画布上方
                 * 那 31px + 8px gap 全部还给画布。
                 *
                 * 容量核算（1600px 视口实测）：标题栏 1240px 宽，左侧标题组
                 * 224 + 缩放组 237 + 按钮组 294 + gap 28 = 783，余量 457px。
                 * 那句「拖动画布可平移…」的说明按用户要求删掉了
                 * （「这个删了，不用提示的」），正好腾出位置。
                 *
                 * 窄屏放不下，所以槽位带 `hidden lg:flex`；PatternCanvas 用同一个
                 * `isDesktop` 判断，窄屏与无槽位时退回画布上方内联渲染。
                 */}
                <div
                  ref={setZoomSlot}
                  className="ml-auto hidden shrink-0 items-center gap-1.5 lg:flex"
                />
                {/*
                 * 窄屏的「参数」入口。
                 *
                 * 竖屏编辑态下 `.wb-left` 整块不渲染（那是"整屏只剩一个框"
                 * 的规则），于是手机上根本没有地方改参数。不给出路的话，
                 * 用户唯一的办法是退出编辑再滚下去找 —— 而调参数恰恰是他
                 * 一边画一边想做的事。
                 *
                 * 窄屏唯一的参数入口 —— 上面对应那块 02 面板在窄屏是
                 * `hidden`，所以这里必须常驻，不能只在编辑态出现，否则
                 * 非编辑态的手机用户没有任何地方能改参数。
                 *
                 * `lg:hidden`：桌面左栏就在旁边，再加一个按钮是重复入口。
                 * 重复入口的坏处不是"多一个按钮"，而是用户不确定该点哪个。
                 */}
                {hasImage && paramsNode ? (
                  <button
                    ref={paramsBtnRef}
                    type="button"
                    onClick={() => setParamsOpen(true)}
                    className="px-btn px-btn-sm ml-auto shrink-0 justify-center px-2 lg:hidden"
                    data-testid="open-params"
                    title="调整网格、色数、配色和线条"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                    参数
                  </button>
                ) : null}
                {/*
                 * 这里原本还有一个「展开左栏」按钮（收起态才出现）。
                 *
                 * 用户反馈：「当折叠之后，右侧也有一个折叠回去的按钮，其实不需要，
                 * 折叠展开的按钮在最左边有了，右侧的可以删去」—— 折起来之后，
                 * 展开入口只需**一个**：屏幕最左侧那条 24px 竖边条（见上），它
                 * 就长在左栏原来占位的地方，视线往左一看就在，符合"就地操作"。
                 * 再在画布标题栏右侧放第二个，反而让人两个都不确定该点哪个，
                 * 而且它还跟缩放控件、右侧说明抢那一行。
                 */}
              </div>

              <div className="relative flex min-h-0 flex-1 flex-col px-3 pt-3 pb-3">
                {/*
                 * sessionBooting：会话恢复在 effect 里，首帧还看不到
                 * sourceDataUrl。这一帧如果照常渲染空态，用户会先看到
                 * 「还没有图纸」再看到图纸 —— 那正是"刷新像在放动画"的
                 * 观感来源之一。这一帧宁可什么都不画（背景是纸色，
                 * 视觉上就是"正在出图"）。
                 */}
                {sessionBooting ? null : error ? (
                  <ErrorBlock message={error} onRetry={handleClear} />
                ) : !hasImage ? (
                  <EmptyStage
                    onSample={handleImage}
                    onBlank={() => setNewCanvasOpen(true)}
                  />
                ) : (
                  <PatternCanvas
                    /*
                     * 传给画布的必须是**描边后**的结果，不是裸 `pattern`。
                     *
                     * 踩过的坑：一开始这里给的是 `pattern`，画布内部自己
                     * 叠加 edits 画出来。于是开了黑边之后，顶部统计显示
                     * 1925 颗、用料清单也列了黑豆，**画布上却一根黑边都
                     * 没有** —— 数字与画面互相矛盾，是那种最让人怀疑
                     * 工具坏了的错位。
                     *
                     * 顺序与 displayPattern 一致：引擎 → 描边 → 手工编辑。
                     * 画布内部本来就会在传入的 pattern 上叠 edits，所以这里
                     * 只需要把 base 换成描边结果，手绘的豆子仍然盖在黑边之上。
                     */
                    pattern={outlinePattern ?? pattern}
                    brand={options.brand}
                    fill
                    /*
                     * 空白画布下**不给**刷区域能力。
                     *
                     * 刷区域的语义是"把选中的这块交给更高档的精细度算法
                     * 重算" —— 它要跑引擎，输入是原图。空白画布没有原图，
                     * 实测点「应用重建」后颗数还是 0：用户刷了半天、点了
                     * 一下，画面一点没变，和"功能坏了"无法区分。
                     *
                     * PatternCanvas 用 `typeof onBrushesChange === 'function'`
                     * 判断要不要显示刷区域按钮，所以这里不传它就等于关掉。
                     */
                    brushes={blankCanvas ? undefined : brushes}
                    onBrushesChange={blankCanvas ? undefined : setBrushes}
                    regionFeather={regionFeather}
                    onRegionFeatherChange={setRegionFeather}
                    /* 编辑层：传的是引擎原始 pattern，画布内部自己叠加
                       edits 得到显示结果。传给父层的 onEditsChange 再把
                       改动同步上来，父层算 displayPattern 给图例/导出用。 */
                    edits={edits}
                    onEditsChange={setEdits}
                    isWorking={isWorking}
                    onActivityChange={setCanvasActivity}
                    zoomSlot={zoomSlot}
                    /*
                     * 撤销 / 重做 / 还原全部上交给页面级的文档历史栈。
                     *
                     * 画布内部原来自己有一套，但那只认识 edits 和 brushes 两样
                     * 东西 —— 换图、换尺寸、居中、放大改的是整份文档，画布看不见
                     * 也清不掉，撤销一去就把旧网格的下标写到新画布上。详见
                     * `src/hooks/useDocHistory.ts` 开头。
                     */
                    onUndo={docHistory.undo}
                    onRedo={docHistory.redo}
                    onResetEdits={handleResetEdits}
                    canUndoDoc={docHistory.canUndo}
                    canRedoDoc={docHistory.canRedo}
                  />
                )}

                {/*
                 * 吉祥物趴在 **04「图纸」这个框的左下角**。
                 *
                 * 两条弯路记在这里，免得再走：
                 *
                 * 第一版挂在 `inset-x-3 bottom-8` 的壳上（画布宿主 div 内），
                 * 但那个 div 有 padding，壳又被 bottom-8 顶上去 32px，于是
                 * 吉祥物浮在框中间偏上的位置，底下什么线都没有 —— 用户
                 * 反馈"没趴在线上"。
                 *
                 * 第二版改成实测 canvas 的 getBoundingClientRect 去贴画布
                 * 下沿。数学没错，但画布在容器里是居中的：52×64 的图在
                 * 1216px 宽的容器里只占 572px，左右各空 322px，所以它变成
                 * 趴在"图纸格子中间偏左"，而不是框的角上 —— 用户再次指出
                 * 应该是**框**的左下角，不是编辑区的左下角。
                 *
                 * 现在就是最朴素的做法：面板加 `relative`，这里一个
                 * `absolute left-0 bottom-0 h-0` 的壳，壳的这条线 = 面板
                 * 内沿的下边框。PixelMascotPeek 自己用 `bottom:100%` 把
                 * 身体挂到线上、爪子压住线，不需要任何测量。画布平移缩放
                 * 换图它都不用动 —— 它认的是「框」，不是「图」。
                 *
                 * 只在 lg 以上出现：手机上画布只有 62dvh，再塞一只进去
                 * 就真的挡住要看的格子了。
                 */}
                <div className="pointer-events-none absolute bottom-0 left-0 z-20 hidden h-0 lg:block">
                  <PixelMascotPeek size={64} side="left" />
                </div>
              </div>
            </div>
          </div>

          {/* ---------------------- 右栏：用料清单（内部滚动） ---------------------- */}
          {displayPattern && displayPattern.palette.length > 0 && (
            <div className="wb-right order-5">
              <div className="px-panel min-h-0 flex-1 overflow-hidden px-4 py-3.5">
                <ColorLegend
                  fill
                  palette={displayPattern.palette}
                  brand={options.brand}
                  totalBeads={displayPattern.totalBeads}
                />
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ============================ 状态条 ============================ */}
      {/*
        页脚与页头用同一个处理：`/92 + backdrop-blur`。
        原来这里是 `/80` 且没有模糊，而背景布景（PixelGarden）是 full-bleed
        的 —— 底部的草丛和花朵正好压在页脚这条 32px 的带子上，11px 的
        `--ink-3` 灰字直接骑在粉色花瓣上，截图里几乎读不出来。
        不改成完全不透明是因为留一点布景透出来更好看，92% + 模糊就够了。
      */}
      <footer className="relative z-10 shrink-0 border-t-2 border-[var(--line)] bg-[var(--paper-raised)]/92 backdrop-blur-[2px]">
        <div className="flex items-center justify-between gap-x-4 px-4 py-1.5">
          {/* 手机上底栏折成两行会吃掉可视高度（还挤掉图纸），所以只留最短的一句，
              完整说明放到 sm 以上 */}
          <p className="text-[11px] leading-relaxed text-[var(--ink-3)]">
            5mm 标准豆 · 每格 0.5cm
            <span className="hidden sm:inline">
              {' '}· 成品尺寸按此估算 · 备份建议按实际用量的 110% 取整到 10 颗
            </span>
          </p>
          <p className="hidden font-px text-[9px] uppercase tracking-[0.2em] text-[var(--ink-3)] sm:block">
            built for perler people
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ================================================================
 * 以下都是这一页专用的小组件，不对外导出
 * ================================================================ */

/** 顶栏左边的小标记：一个趴着的豆子 */

/**
 * 品牌标（页头左上角那只吉祥物）。
 *
 * 它会自己换造型（戴耳机、跳绳、走动、听歌、画画……每 3–6 秒一换），
 * 点一下会弹出一组「拼豆生图提示词」——用户可以直接复制去豆包 / Qwen
 * 这类免费生图工具，生成更适合转成拼豆图纸的图。
 *
 * 轮播节拍、reduced-motion 降级、后台标签页暂停、弹窗开关，全在
 * `MascotPromptButton` 内部。这里只负责外框：**外框是页面布局的一部分**
 * （尺寸、边框、硬投影、配色），塞进组件里它就没法复用到别处了。
 *
 * 尺寸 40 而不是 26：吉祥物的原生网格是 40×34 个 4px 格，缩到 26px
 * 时每个像素格只剩 0.65 个 CSS 像素，手绘的轮廓会被采样成糊团
 * （scenery 交付时专门提醒过这一点）。40px 刚好 1:1，像素一颗不歪。
 * 外框 size-11 = 44px border-box，减去 2px 边框正好容纳 40px 内容盒。
 */
/**
 * 页头左上角的吉祥物（点开会出提示词弹窗）。
 *
 * 外框**去掉了**。用户两次提到这件事：
 *   1. 「鼠标移动到左上角鼠标可以变成可点击的那种，会好很多」
 *   2. 「然后可以把左上角小宠物的框框去掉，这样看起来比较自由，宠物也能变大一点」
 *
 * 原来那层 `size-11 + clay 底 + 2px 描边 + 硬投影` 是照 shadcn 按钮的思路
 * 套的，但它把一只 40px 的像素鸭子关进 44px 的格子里 —— 四边各只剩 2px
 * 余量，鸭子看着被裁脚，而且那个方块本身也是个视觉噪音（顶栏最左边突然
 * 出现一块陶土色）。
 *
 * 现在鸭子直接以 48px 裸露在纸面上：48 是原生 160×136 网格的 0.3 倍
 * （每格 1.2 CSS px），像素边缘仍然干净 —— 比原来 40px 只大 20%，
 * 但视觉上因为没有边框圈着，显得开阔得多。可点击性由 cursor + 悬停
 * 放大（见 MascotMark 的 button 类名）承担，不靠边框。
 *
 * 尺寸对齐：外框去掉后鸭子占 48×41，与右侧标题的行高不冲突，顶栏高度
 * 不变（49px）。
 */
function MascotMark({ brand }: { brand: string }) {
  return (
    <div className="relative flex shrink-0 items-center justify-center">
      <MascotPromptButton size={48} brand={brand} />
    </div>
  );
}

/** 带编号的区块外壳，把"01/02/03"做成图纸上的章节号 */
function Section({
  title,
  hint,
  busy,
  className,
  hideHeader = false,
  padded = true,
  action,
  children,
}: {
  title: string;
  hint?: string;
  /** 标题栏最右侧的动作按钮（排在手写 hint 左边） */
  action?: React.ReactNode;
  busy?: boolean;
  className?: string;
  /**
   * 里层组件自带同款标题时用（PatternSettings / ColorLegend 自己会画编号标题）。
   * 否则页面上会出现「02 调参数」下面紧接「02 图案参数」这种叠字。
   */
  hideHeader?: boolean;
  padded?: boolean;
  children: React.ReactNode;
}) {
  if (hideHeader) {
    return (
      <section className={cn('px-panel', padded && 'px-4 py-3.5', className)}>
        {children}
      </section>
    );
  }
  return (
    <section className={cn('px-panel', className)}>
      <div className="flex items-center justify-between gap-2 border-b-2 border-[var(--line)] px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          {/*
            标题不许折行。
            动作按钮放大到 32px 后，左栏 320px 宽时标题栏的可用宽度被压掉
            10px，「放一张图」就会被拆成「放一张 / 图」两行 —— 标题栏高度也
            跟着跳。宁可让右侧的 hint 先截断（它本来就是次要说明），也要保证
            标题始终是一行：它是这一块唯一的识别标志。
          */}
          <h2 className="px-section-title whitespace-nowrap">{title}</h2>
        </div>
        {/*
          * hint 在前、action 在后。
          *
          * 反过来的话折叠按钮会挤在「JPG / PNG / WEBP / GIF」这类说明文字的
          * 左边，落在标题栏中间偏右的位置 —— 用户截图标注指的就是这个：折叠
          * 按钮应该贴在**标题栏最右端**（"应该放在这里吧，会好看一点"）。
          * 动作按钮固定在右边缘，说明文字往左让位，右边缘也就成了一条整齐的
          * 竖线，各 section 的按钮位置对得上。
          */}
        <div className="flex min-w-0 shrink items-center gap-1.5">
          {hint && (
            <span
              className={cn(
                'font-px truncate text-[9.5px] tracking-wide',
                busy ? 'text-[var(--clay)]' : 'text-[var(--ink-3)]',
              )}
            >
              {busy && (
                <span className="mr-1.5 inline-block size-1.5 animate-pulse bg-[var(--clay)] align-middle" />
              )}
              {hint}
            </span>
          )}
          <span className="shrink-0">{action}</span>
        </div>
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

/**
 * 空白画布的参数面板。
 *
 * 与 PatternSettings 的取舍见调用点的注释：空白画布不走引擎，所以网格
 * 密度、颜色数量、精细度、成片度、彩度增强全部无效。这里只保留真正
 * 生效的两项 —— 品牌（决定色卡）和尺寸（决定成品多大）。
 *
 * 「尺寸」在这一版是只读展示 + 跳对话框，没做直接改：
 * 改尺寸会重建 cells，用户已经画的格子在尺寸变化下没有合理的映射方式。
 * 与其猜（按比例缩放？保留左上？），不如让他重新建一张 —— 这是明确、
 * 可预期、不会悄悄吃掉工作的行为。
 */
/**
 * 画板校准：居中 / 放大。
 *
 * 两个按钮必须并排且各自说清楚"会不会改变图案大小" —— 这是它们唯一的
 * 区别，也是用户唯一会搞混的地方。所以 hint 直接写进按钮下方，而不是
 * 藏在 tooltip 里（手机上根本没有 hover）。
 */
function CanvasCalibrateRow({
  onCenter,
  onScaleToFit,
  disabled,
}: {
  onCenter: () => void;
  onScaleToFit: () => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-[var(--ink)]">画板校准</span>
        <span className="font-px text-[9px] tracking-[0.14em] text-[var(--ink-3)]">
          不改颜色
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onCenter}
          disabled={disabled}
          title="只是平移，图案大小不变"
          className="px-btn px-btn-sm disabled:opacity-40"
        >
          <AlignCenter className="h-3 w-3" aria-hidden />
          居中
        </button>
        <button
          type="button"
          onClick={onScaleToFit}
          disabled={disabled}
          title="整数倍放大到铺满画板，图案会变大"
          className="px-btn px-btn-sm disabled:opacity-40"
        >
          <Maximize2 className="h-3 w-3" aria-hidden />
          放大约到边
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
        居中只挪位置；放大把每颗豆变成 2×2、3×3 块（只做整数倍，不会出现一半宽一半窄的列）。
      </p>
    </div>
  );
}

function BlankSettings({
  brand,
  onBrandChange,
  cols,
  rows,
  onResize,
  onCenter,
  onScaleToFit,
  canCalibrate,
}: {
  brand: Brand;
  onBrandChange: (b: Brand) => void;
  cols: number;
  rows: number;
  onResize: () => void;
  onCenter: () => void;
  onScaleToFit: () => void;
  canCalibrate: boolean;
}) {
  const cm = estimateSizeCm(cols, rows);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="px-section-title">画布参数</h3>
        </div>
        <span className="px-tag px-tag-clay" style={{ fontSize: 10 }}>
          空白
        </span>
      </div>

      <div className="px-rule" />

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-semibold text-[var(--ink)]">尺寸</span>
          <button type="button" onClick={onResize} className="px-btn px-btn-sm px-btn-ghost !py-0.5">
            <RefreshCw className="h-3 w-3" aria-hidden />
            换尺寸
          </button>
        </div>
        <div className="px-inset flex items-center justify-between gap-2 px-2.5 py-2">
          <span className="text-[13px] font-semibold tabular-nums text-[var(--ink)]">
            {cols} × {rows}
          </span>
          <span className="text-[11.5px] tabular-nums text-[var(--ink-2)]">
            {cols * rows} 格 · 约 {cm.w} × {cm.h} cm
          </span>
        </div>
      </div>

      <CanvasCalibrateRow
        onCenter={onCenter}
        onScaleToFit={onScaleToFit}
        disabled={!canCalibrate}
      />

      <div className="px-rule" />

      <div>
        <p className="mb-1.5 text-[12px] font-semibold text-[var(--ink)]">色号体系</p>
        <div className="grid grid-cols-2 gap-1.5">
          {BRANDS.map((b) => {
            const active = brand === b;
            return (
              <button
                key={b}
                type="button"
                aria-pressed={active}
                onClick={() => onBrandChange(b)}
                title={BRAND_META[b].note}
                className={cn(
                  'border-2 px-2 py-1.5 text-[12px] font-semibold transition-colors duration-75',
                  active
                    ? 'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)]'
                    : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink)] hover:bg-[var(--paper-hi)]',
                )}
              >
                {BRAND_META[b].label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
          色卡里能选哪些色号，按这个品牌的真实豆色来。
        </p>
      </div>

      <div className="border-t-2 border-dashed border-[var(--line)] pt-2.5">
        <p className="text-[11px] leading-relaxed text-[var(--ink-3)]">
          网格密度、颜色数量、精细度算法这些是给「图片生成图纸」用的，
          空白画布不走那套流程，所以这里不提供。
        </p>
      </div>
    </div>
  );
}

/**
 * 空白画布在图源区域的"已选态"卡片。
 *
 * 对应 FileUpload 的已选态：用户已经有一块确定尺寸的空板子，这个位置
 * 就该显示"你选的是什么"，而不是继续挂着上传框 —— 否则用户会以为
 * 还得再传一张图才能开始。
 *
 * 三件事必须在卡片里能一眼看到：
 *   1. 尺寸（这是他刚才在对话框里做的唯一决定）；
 *   2. 怎么开始画（「点画布的编辑按钮」这句话，新用户不知道编辑在哪）；
 *   3. 换尺寸 / 删掉的入口。
 */
function BlankCanvasCard({
  cols,
  rows,
  brand,
  onResize,
  onClear,
}: {
  cols: number;
  rows: number;
  brand: Brand;
  onResize: () => void;
  onClear: () => void;
}) {
  const cm = estimateSizeCm(cols, rows);
  return (
    <div className="space-y-2.5">
      <div className="px-inset flex items-center gap-2.5 p-2.5">
        {/* 缩略：一张按比例的棋盘格，代表"空板子" */}
        <div className="px-checker h-[58px] w-[58px] shrink-0 border border-[var(--line)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Grid2x2 className="h-3.5 w-3.5 shrink-0 text-[var(--clay)]" aria-hidden />
            <span className="truncate text-[13px] font-semibold text-[var(--ink)]">
              空白画布
            </span>
            <span className="px-tag px-tag-ink ml-auto shrink-0" style={{ fontSize: 10 }}>
              {brand}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] font-semibold tabular-nums text-[var(--ink-2)]">
            {cols} × {rows}
            <span className="ml-1.5 font-normal text-[var(--ink-3)]">
              约 {cm.w} × {cm.h} cm
            </span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onResize} className="px-btn px-btn-sm flex-1 justify-center">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          换尺寸
        </button>
        <button
          type="button"
          onClick={onClear}
          className="px-btn px-btn-sm px-btn-danger flex-1 justify-center"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          移除
        </button>
      </div>

      <p className="text-[11.5px] leading-relaxed text-[var(--ink-2)]">
        点画布工具条上的
        <span className="mx-1 px-tag px-tag-clay" style={{ fontSize: 10 }}>
          编辑
        </span>
        开始画：手绘上色、橡皮擦掉、油漆桶填一片，右侧色卡里挑色号。
      </p>
    </div>
  );
}

/**
 * 空状态示例图。
 *
 * 空画布上"你可以传图"这句话说服力很弱 —— 大部分人手上并没有一张
 * 描边干净、色块分明的立绘，传一张手机照片进来，出来一堆噪点，
 * 会以为工具不行。所以直接给四张已经验证过效果的示例，点一下就能
 * 看到完整流程（含 PDF、用料清单），比读任何说明都快。
 *
 * 图放在 public/ 下，用 <img> 直接引用即可；点选后走与上传完全相同的
 * handleImage 路径（读成 dataURL → 解码 → 重算），不搞第二套逻辑。
 */
const SAMPLE_IMAGES = [
  { src: '/samples/cat.png', label: '蓝猫', hint: '立绘 · 描边清晰' },
  { src: '/samples/duck.png', label: '黄鸭', hint: '大面积色块' },
  { src: '/samples/leaf.png', label: '草叶', hint: '细小五官' },
  { src: '/samples/turtle.png', label: '小龟', hint: '块面分割' },
] as const;

/** 空状态：一块空板子 + 一朵花 + 一只趴着的豆，外加几个可以直接点的示例 */
function EmptyStage({
  onSample,
  onBlank,
}: {
  onSample: (
    dataUrl: string,
    info: { width: number; height: number; name: string },
  ) => void;
  onBlank: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const pick = useCallback(
    async (src: string) => {
      setPending(src);
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error('示例图加载失败');
        const blob = await res.blob();
        const name = src.split('/').pop() ?? 'sample.png';

        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === 'string'
              ? resolve(reader.result)
              : reject(new Error('读取失败'));
          reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
          reader.readAsDataURL(blob);
        });

        const dims = await new Promise<{ width: number; height: number }>(
          (resolve, reject) => {
            const img = new Image();
            img.onload = () =>
              resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => reject(new Error('示例图解码失败'));
            img.src = dataUrl;
          },
        );

        // 走与上传完全相同的一条路径，不搞第二套逻辑
        onSample(dataUrl, { ...dims, name });
      } catch {
        /* 静默：示例图拿不到不该挡路，用户仍可正常上传 */
      } finally {
        setPending(null);
      }
    },
    [onSample],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto py-8">
      <PixelEmpty opacity={0.9} />
      <div className="max-w-[360px] text-center">
        <h3 className="font-display text-[16px] font-bold tracking-tight text-[var(--ink)]">
          还没有图纸
        </h3>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          从左边放一张图，或点下面的示例先看看效果。
          人物、宠物、游戏立绘都合适 —— 描边清楚、色块分明的图，拼出来最好看。
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-3)]">
          没有参考图？也可以从一块空板子开始，自己一格一格画。
        </p>
      </div>

      <div className="grid w-full max-w-[380px] grid-cols-4 gap-2">
        {SAMPLE_IMAGES.map((s) => (
          <button
            key={s.src}
            type="button"
            onClick={() => void pick(s.src)}
            disabled={pending !== null}
            title={`用示例图「${s.label}」试试（${s.hint}）`}
            className={cn(
              'group flex flex-col items-stretch gap-1 border-2 border-[var(--line)] bg-[var(--paper-raised)] p-1 text-left transition-[box-shadow,border-color,background-color] duration-100',
              // 示例图四张一排（gap 8px），浮起会撞到相邻格子的边框，只改颜色
              'hover:border-[var(--clay)] hover:bg-[var(--paper-hi)] hover:shadow-[0_3px_0_0_var(--line-strong)]',
              pending !== null && 'opacity-60',
            )}
          >
            <span className="px-checker flex aspect-square items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.src}
                alt={s.label}
                className="max-h-full max-w-full object-contain"
                style={{ imageRendering: 'auto' }}
              />
            </span>
            <span className="truncate text-[11px] font-semibold text-[var(--ink)]">
              {s.label}
            </span>
          </button>
        ))}
      </div>

      {/*
       * 「从空白画布开始」在空状态里必须是**并列选项**，不是藏起来的次级
       * 入口。用户第一次进来看见四个示例图，很自然会以为"必须上传一张图"，
       * 于是想要的像素小人就没了下文。把它摆成和示例同级的按钮。
       */}
      <button
        type="button"
        onClick={onBlank}
        disabled={pending !== null}
        className="px-btn px-btn-sm"
        data-testid="empty-new-blank"
      >
        <Grid2x2 className="h-3.5 w-3.5" aria-hidden />
        从空白画布开始
      </button>

      <div className="flex items-center gap-1.5 font-px text-[9px] tracking-[0.18em] text-[var(--ink-3)]">
        <Sparkles className="size-3" />
        <span>先放图，再调参数</span>
      </div>
    </div>
  );
}

/** 出错时的替换块，别只弹个 toast 就让人对着空白画布发呆 */
function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="px-inset flex min-h-[300px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <p className="max-w-[380px] text-[13px] leading-relaxed text-[var(--ink-2)]">
        {message}
      </p>
      <button type="button" onClick={onRetry} className="px-btn px-btn-sm">
        换一张图
      </button>
    </div>
  );
}

/** 图纸下方的一排读数：颗数 / 色数 / 尺寸 / 平均色差 */
