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
  X,
} from 'lucide-react';

import { FileUpload } from '@/components/image-upload/FileUpload';
import { NewCanvasDialog } from '@/components/blank-canvas/NewCanvasDialog';
import { PatternSettings } from '@/components/settings/PatternSettings';
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
import { readStorage, writeStorage } from '@/hooks/useLocalStorage';
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
   */
  /*
   * 初始值直接同步读 localStorage，不要放进 useEffect。
   *
   * 放 effect 里的话首帧渲染的是"展开"，第二帧才收起来 —— 用户会看到
   * 左栏闪一下再消失。readStorage 内部已处理 SSR（window 不存在时返回
   * 默认值），所以这里可以同步读。useState 的惰性初始化函数只跑一次，
   * 也不会每次渲染都碰 localStorage。
   */
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(
    () => readStorage<boolean>(FOCUS_KEY, false) === true,
  );

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
    },
    [],
  );

  // 源图变化 → 解码
  useEffect(() => {
    /*
     * 空白画布下 sourceDataUrl 是 null，但**不能**顺手把 pattern 清掉 ——
     * 空白画布的图纸是直接造出来的，不走引擎。这个分支原来只判断
     * sourceDataUrl，创建空白画布时会把刚造好的图纸又抹成 null，
     * 表现就是"点了新建，中间一片空白，还以为没生效"。
     */
    if (!sourceDataUrl && blankCanvas) return;
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
    setPattern(makeBlankPattern(blankCanvas.cols, blankCanvas.rows, options));
    setIsWorking(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blankCanvas]);

  /* ---------------------------------------------------------------
   * 历史：只在"图案真的变了"之后记一条
   * --------------------------------------------------------------- */
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
    if (editedCount === 0) return pattern;
    return applyEdits(pattern, edits, options.brand);
  }, [pattern, edits, editedCount, options.brand]);

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
      setSourceDataUrl(null);
      setImageInfo(null);
      sourceRef.current = null;
      imageDataRef.current = null;
      sourceEdgeRef.current = 0;
      setError(null);
      setBrushes([]);
      setEdits(EMPTY_EDITS);
      setOptions((prev) => ({ ...prev, brand }));
      setBlankCanvas({ cols, rows, id: makeBlankId() });
      // 记一笔历史时不要让"签名相同"挡住
      lastRecordedRef.current = '';
      toast.success(`已新建 ${cols} × ${rows} 的空白画布，点「编辑」开始画`);
    },
    [],
  );

  const handleClear = useCallback(() => {
    setSourceDataUrl(null);
    setBlankCanvas(null);
    setImageInfo(null);
    setPattern(null);
    setError(null);
    setBrushes([]);
    setEdits(EMPTY_EDITS);
  }, []);

  const hasImage = Boolean(sourceDataUrl) || blankCanvas !== null;

  /*
   * 新建画布会**替换**当前图纸 —— 这句话必须提前说，不能让用户按完
   * 才发现刚画的东西没了。只在"真的会丢东西"时才提示：一张刚生成的、
   * 没手改过的图纸重来不心疼；画了格的才需要提醒，并且给出具体数量。
   */
  const replaceWarning = useMemo<string | null>(() => {
    if (!hasImage) return null;
    if (blankCanvas && editedCount > 0) {
      return `当前这张 ${blankCanvas.cols} × ${blankCanvas.rows} 的空白画布上已经画了 ${editedCount} 格，新建会把它替换掉。`;
    }
    if (blankCanvas) {
      return `当前这块 ${blankCanvas.cols} × ${blankCanvas.rows} 的空白画布会被替换掉。`;
    }
    return '新建画布会替换掉当前这张从图片生成的图纸（原图仍留在历史记录里，可以随时恢复）。';
  }, [hasImage, blankCanvas, editedCount]);

  const sizeCm = pattern?.meta.sizeCm ?? null;

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

      {/* 背景布景：花朵与草木，压在内容之下 */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <PixelGarden opacity={0.55} />
      </div>

      {/* ============================ 顶栏 ============================ */}
      <header className="relative z-20 shrink-0 border-b-2 border-[var(--line-strong)] bg-[var(--paper-raised)]/92 backdrop-blur-[2px]">
        <div className="relative flex items-center justify-between gap-4 px-4 py-2.5">
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

          <div className="flex items-center gap-2">
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
              index="01"
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
                    className="px-btn px-btn-ghost"
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
                index="02"
                title="调参数"
                hint={isWorking ? '重算中…' : '实时预览'}
                busy={isWorking}
                hideHeader
                className="order-3"
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
                {blankCanvas ? (
                  <BlankSettings
                    brand={options.brand}
                    onBrandChange={(brand) => setOptions((prev) => ({ ...prev, brand }))}
                    cols={blankCanvas.cols}
                    rows={blankCanvas.rows}
                    onResize={() => setNewCanvasOpen(true)}
                  />
                ) : (
                  <PatternSettings
                    value={options}
                    onChange={setOptions}
                    actualCols={pattern?.cols}
                    actualRows={pattern?.rows}
                    sizeCm={sizeCm}
                    isWorking={isWorking}
                  />
                )}
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
                index="03"
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
                  <span className="px-section-no">04</span>
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
                {error ? (
                  <ErrorBlock message={error} onRetry={handleClear} />
                ) : !hasImage ? (
                  <EmptyStage
                    onSample={handleImage}
                    onBlank={() => setNewCanvasOpen(true)}
                  />
                ) : (
                  <PatternCanvas
                    pattern={pattern}
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
      <footer className="relative z-10 shrink-0 border-t-2 border-[var(--line)] bg-[var(--paper-raised)]/80">
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
  index,
  title,
  hint,
  busy,
  className,
  hideHeader = false,
  padded = true,
  action,
  children,
}: {
  index: string;
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
          <span className="px-section-no shrink-0">{index}</span>
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
function BlankSettings({
  brand,
  onBrandChange,
  cols,
  rows,
  onResize,
}: {
  brand: Brand;
  onBrandChange: (b: Brand) => void;
  cols: number;
  rows: number;
  onResize: () => void;
}) {
  const cm = estimateSizeCm(cols, rows);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="px-section-no" aria-hidden>
            02
          </span>
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
              'group flex flex-col items-stretch gap-1 border-2 border-[var(--line)] bg-[var(--paper-raised)] p-1 text-left transition-[transform,border-color] duration-100',
              'hover:-translate-y-0.5 hover:border-[var(--clay)] active:translate-y-0',
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
