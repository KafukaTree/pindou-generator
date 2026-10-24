'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { Moon, Sun, Sparkles } from 'lucide-react';

import { FileUpload } from '@/components/image-upload/FileUpload';
import { PatternSettings } from '@/components/settings/PatternSettings';
import { PatternCanvas } from '@/components/pattern-rendering/PatternCanvas';
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
  PixelMascot,
  PixelMascotPeek,
  PixelEmpty,
} from '@/components/scenery';

import {
  compressSourceDataUrl,
  useHistory,
  type HistoryItem,
  type HistoryVersion,
} from '@/hooks/useHistory';
import {
  generatePattern,
  imageDataFromSource,
  patternToThumbnail,
  type GenerateOptions,
  type PatternResult,
} from '@/lib/pattern/generate';
import type { Brand } from '@/lib/color/palette';
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

  // ---- 输出 --------------------------------------------------------------
  const [pattern, setPattern] = useState<PatternResult | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [sourceDataUrl]);

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
  }, [sourceDataUrl, optionsKey, imageReady, ensureSource]);

  /* ---------------------------------------------------------------
   * 历史：只在"图案真的变了"之后记一条
   * --------------------------------------------------------------- */
  const lastRecordedRef = useRef<string>('');
  useEffect(() => {
    if (!pattern || !imageInfo || !sourceDataUrl) return;
    const signature = `${optionsKey}|${pattern.cols}x${pattern.rows}|${pattern.totalBeads}`;
    if (lastRecordedRef.current === signature) return;
    lastRecordedRef.current = signature;

    const preview = patternToThumbnail(pattern, 132);
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
      const compact = await compressSourceDataUrl(sourceDataUrl).catch(
        () => sourceDataUrl,
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
        cols: pattern.cols,
        rows: pattern.rows,
        totalBeads: pattern.totalBeads,
        colorCount: pattern.palette.length,
        sourceMeta: imageInfo
          ? { width: imageInfo.width, height: imageInfo.height, name: imageInfo.name }
          : undefined,
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
  }, [pattern, options, optionsKey, sourceDataUrl, addToHistory, imageInfo]);

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
      setSourceDataUrl(item.sourceDataUrl);
      setOptions((prev) => ({ ...prev, ...v.settings }));
      setImageInfo(
        (prev) =>
          prev ??
          (item.sourceMeta
            ? { ...item.sourceMeta }
            : { width: 0, height: 0, name: '历史图案' }),
      );
      setBrushes([]);
      // 历史里不存手工覆盖层（它是按格子下标存的，跨图无意义），
      // 恢复历史即恢复"引擎原始结果"，覆盖层必须清掉
      setEdits(EMPTY_EDITS);
      // 恢复时不要被"签名相同"挡住
      lastRecordedRef.current = '';
      toast.success(`已恢复 ${v.cols} × ${v.rows} 的图纸`);
    },
    [],
  );

  const handleClear = useCallback(() => {
    setSourceDataUrl(null);
    setImageInfo(null);
    setPattern(null);
    setError(null);
    setBrushes([]);
    setEdits(EMPTY_EDITS);
  }, []);

  const hasImage = Boolean(sourceDataUrl);

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
   */
  const editedCount = useMemo(() => editCount(edits), [edits]);
  const displayPattern = useMemo(() => {
    if (!pattern) return null;
    if (editedCount === 0) return pattern;
    return applyEdits(pattern, edits, options.brand);
  }, [pattern, edits, editedCount, options.brand]);

  const sizeCm = pattern?.meta.sizeCm ?? null;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <Toaster position="top-center" richColors />

      {/* 背景布景：花朵与草木，压在内容之下 */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <PixelGarden opacity={0.55} />
      </div>

      {/* ============================ 顶栏 ============================ */}
      <header className="relative z-20 shrink-0 border-b-2 border-[var(--line-strong)] bg-[var(--paper-raised)]/92 backdrop-blur-[2px]">
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <MascotMark />
            <div className="min-w-0 leading-none">
              <h1 className="font-display truncate text-[17px] font-bold tracking-tight text-[var(--ink)] sm:text-[18px]">
                拼豆图纸工坊
              </h1>
              {/* 英文副标在手机上只会挤占空间，藏掉 */}
              <p className="mt-1 hidden font-px text-[9px] uppercase tracking-[0.22em] text-[var(--ink-3)] sm:block">
                perler bead atelier
              </p>
            </div>
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
        <div className="wb">
          {/* ---------------------- 左栏：输入与参数（内部滚动） ---------------------- */}
          <div className="wb-left">
            <Section
              index="01"
              title="放一张图"
              hint="JPG / PNG / WebP / GIF"
              className="order-1"
            >
              <FileUpload
                onImage={handleImage}
                onClear={handleClear}
                previewUrl={sourceDataUrl}
                imageInfo={imageInfo}
                disabled={isWorking && !pattern}
              />
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
                <PatternSettings
                  value={options}
                  onChange={setOptions}
                  actualCols={pattern?.cols}
                  actualRows={pattern?.rows}
                  sizeCm={sizeCm}
                  isWorking={isWorking}
                />
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
            <div className="px-panel flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b-2 border-[var(--line)] px-3.5 py-2">
                <div className="flex items-baseline gap-2.5">
                  <span className="px-section-no">04</span>
                  <h2 className="font-display text-[15px] font-bold tracking-tight">
                    图纸
                  </h2>
                  {displayPattern && (
                    <span className="font-px text-[10px] tracking-wide text-[var(--ink-3)]">
                      {displayPattern.cols} × {displayPattern.rows}
                      {sizeCm ? ` · 约 ${sizeCm.w} × ${sizeCm.h} cm` : ''}
                    </span>
                  )}
                </div>
                <p className="hidden text-[11px] text-[var(--ink-3)] md:block">
                  拖动画布可平移，滚轮缩放，悬停看色号
                </p>
              </div>

              <div className="relative flex min-h-0 flex-1 flex-col px-3 pt-3 pb-3">
                {error ? (
                  <ErrorBlock message={error} onRetry={handleClear} />
                ) : !hasImage ? (
                  <EmptyStage onSample={handleImage} />
                ) : (
                  <PatternCanvas
                    pattern={pattern}
                    brand={options.brand}
                    fill
                    brushes={brushes}
                    onBrushesChange={setBrushes}
                    regionFeather={regionFeather}
                    onRegionFeatherChange={setRegionFeather}
                    /* 编辑层：传的是引擎原始 pattern，画布内部自己叠加
                       edits 得到显示结果。传给父层的 onEditsChange 再把
                       改动同步上来，父层算 displayPattern 给图例/导出用。 */
                    edits={edits}
                    onEditsChange={setEdits}
                    isWorking={isWorking}
                  />
                )}

                {/*
                 * 吉祥物从画布下沿探出头来看图。
                 *
                 * 「看」需要位置关系才成立 —— 它得贴着画布边缘，否则
                 * 只是页面上多了一张贴纸。PixelMascotPeek 用
                 * `bottom: 100%` 把身体挂在最近的定位祖先的**上边缘**，
                 * 于是这里塞一个高度 0 的定位壳放在画布底部：
                 * 壳的顶边 = 画布下沿，吉祥物的爪子正好压在那条线上，
                 * 身体探进画布内部。
                 *
                 * 放左下角而不是右上角：画布居中显示，四角本来就是空
                 * 棋盘格，左下角不会压住"拖动画布可平移…"那行提示，
                 * 也不会挡到图纸本身。尺寸 64 是原生网格 40 格的整数倍
                 * （64/40 = 1.6 个 CSS 像素/格），轮廓仍是整格。
                 *
                 * 只在 lg 以上出现：手机上画布只有 54dvh，再塞一个
                 * 吉祥物进去就真的挡住要看的格子了。
                 */}
                <div className="pointer-events-none absolute inset-x-3 bottom-8 z-20 hidden h-0 lg:block">
                  <PixelMascotPeek size={64} side="left" />
                </div>
              </div>
            </div>

            {/* 图纸下方的读数条：把"这张图到底要多少豆"讲清楚 */}
            {displayPattern && (
              <div className="shrink-0">
                <StatsBar pattern={displayPattern} brand={options.brand} />
              </div>
            )}
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
function MascotMark() {
  /*
   * 尺寸 40 而不是 26：吉祥物的原生网格是 40×34 个 4px 格，缩到 26px
   * 时每个像素格只剩 0.65 个 CSS 像素，手绘的轮廓会被采样成糊团
   * （scenery 交付时专门提醒过这一点）。40px 刚好 1:1，像素一颗不歪。
   */
  return (
    <div className="relative flex size-11 items-center justify-center border-2 border-[var(--line-strong)] bg-[var(--clay)] shadow-[var(--shadow-px-btn)]">
      <PixelMascot size={40} mood="happy" />
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
  children,
}: {
  index: string;
  title: string;
  hint?: string;
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
        <div className="flex items-baseline gap-2.5">
          <span className="px-section-no">{index}</span>
          <h2 className="px-section-title">{title}</h2>
        </div>
        {hint && (
          <span
            className={cn(
              'font-px text-[9.5px] tracking-wide',
              busy ? 'text-[var(--clay)]' : 'text-[var(--ink-3)]',
            )}
          >
            {busy && (
              <span className="mr-1.5 inline-block size-1.5 animate-pulse bg-[var(--clay)] align-middle" />
            )}
            {hint}
          </span>
        )}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
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
}: {
  onSample: (
    dataUrl: string,
    info: { width: number; height: number; name: string },
  ) => void;
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
function StatsBar({
  pattern,
  brand,
}: {
  pattern: PatternResult;
  brand: Brand;
}) {
  /*
   * 五个读数在手机上排成三行会吃掉 170px 可视高度（相当于半个图纸），
   * 而"平均色差"和"品牌色卡"是给进阶用户看的核对信息 —— 手机上藏起来，
   * 图纸标题条里已经写着品牌，色差也早有定论。sm 以上全部展开。
   */
  const stats = [
    { label: '总颗数', value: pattern.totalBeads.toLocaleString('zh-CN'), key: true },
    { label: '色号数', value: String(pattern.palette.length), key: true },
    {
      label: '成品尺寸',
      // 窄格子里 "约 32 × 27 CM" 会折成三行，去掉"约"用 cm 小写更紧凑
      value: `${pattern.meta.sizeCm.w}×${pattern.meta.sizeCm.h}cm`,
      key: true,
    },
    {
      label: '平均色差',
      // ΔE 越小越忠实；0.04 以下人眼基本分辨不出偏差
      value: pattern.meanDeltaE.toFixed(3),
      key: false,
    },
    { label: '品牌色卡', value: brand, key: false },
  ];

  return (
    <div className="px-panel-flat grid grid-cols-3 gap-px bg-[var(--line)] sm:grid-cols-5 lg:flex lg:flex-wrap lg:items-stretch lg:gap-0 lg:divide-x-2 lg:divide-[var(--line)] lg:bg-transparent">
      {stats.map((s) => (
        <div
          key={s.label}
          className={cn(
            'bg-[var(--paper-raised)] px-3 py-2 lg:flex-1 lg:px-4 lg:py-3',
            !s.key && 'max-sm:hidden',
          )}
        >
          <p className="font-px text-[9px] uppercase tracking-[0.16em] text-[var(--ink-3)]">
            {s.label}
          </p>
          <p className="mt-1 font-px text-[13px] font-bold tabular-nums whitespace-nowrap text-[var(--ink)]">
            {s.value}
          </p>
        </div>
      ))}
    </div>
  );
}
