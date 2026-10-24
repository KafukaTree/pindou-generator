'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { PixelMascot, type MascotMood, type MascotSide } from './PixelMascot';

/* =====================================================================
 * MascotRoamer —— 会自己巡游的桌宠
 *
 * 需求（用户原话）：「这些动画是那种出现一会之后去其他地方等，很随机的，
 * 或者动态感知」「可以在很多地方出现还有很多动画造型」。
 *
 * 所以它做两件事：
 *   ① 在自己负责的容器里挑一个**留白锚点**待一会儿 → 淡出 → 换个锚点
 *      → 淡入 → 再待一会儿，位置随机；
 *   ② 通过 `awareness` 感知页面状态，**立刻**换表情（不是等下一轮）。
 *
 * 为什么位移用两层 transform 而不是 left/top：
 *   相邻是一块 320 格 × 320 格的 canvas，任何触发布局的属性（left / top /
 *   margin）都会让它在吉祥物移动时跟着重排。translate 只走合成层，零布局。
 *
 *   另外 translate 的百分比是相对**元素自身**尺寸的 —— 外层铺满容器
 *   （inset-0），所以 `translateX(37%)` 恰好等于容器宽度的 37%，既保留了
 *   百分比的"resize 不用重算"，又不会触发布局。
 * ===================================================================== */

/** 语义化状态。调用方只说"现在是什么阶段"，不需要知道有哪 9 个 mood。 */
export type MascotAwareness =
  | 'idle'
  | 'empty'
  | 'working'
  | 'done'
  | 'editing'
  | 'brushing'
  | 'error'
  | 'history'
  | 'exporting';

/**
 * 状态 → 表情。
 *
 * 每一个都是按"这个状态下吉祥物在干什么"选的，不是随机配的：
 */
export const MASCOT_AWARENESS_MOOD: Readonly<
  Record<MascotAwareness, MascotMood>
> = {
  /* 待机：就是它本来的样子，不表演。 */
  idle: 'idle',
  /* 空状态：还没图可看，安静站着等，不要抢"传图"的注意力。 */
  empty: 'idle',
  /* 算图中：来回踱步。等待需要一个"它在替我干活"的动势，踱步比站着更耐看。 */
  working: 'walk',
  /* 出图完成：开心。这是整条流程里唯一值得庆祝的时刻。 */
  done: 'happy',
  /* 编辑模式：手里拿着笔。表情本身就是"我也在画"的暗示。 */
  editing: 'draw',
  /* 刷区域：凑近打量。review 是眯眼审视的样子，对应"正在看这块区域"。 */
  brushing: 'review',
  /* 算失败：睡着了。不是嘲笑用户，是"算不动了，先歇会儿"的低干扰表达。 */
  error: 'sleep',
  /* 历史抽屉打开：一起翻旧图纸，同样是打量/回看的样子。 */
  history: 'review',
  /* 导出中：哼歌等着。导出是纯等待，给一个不催人的表情。 */
  exporting: 'music',
};

/** 一个候选驻留点。坐标是**容器百分比**（0–100），不是像素。 */
export interface MascotAnchor {
  /** 稳定 id，测试轨迹和日志都用它。 */
  id: string;
  /** 中心点横向位置，容器宽度的百分比。 */
  x: number;
  /** 中心点纵向位置，容器高度的百分比。 */
  y: number;
  /** 仅当 awareness === 'idle' 时生效；真实状态永远优先于锚点性格。 */
  mood?: MascotMood;
  /** 朝向。想让它看着画布就把 side 设成画布在的方向。 */
  side?: MascotSide;
  /** 尺寸系数，乘在 baseSize 上（会被 clamp 回 32–56）。 */
  scale?: number;
  /** 容器窄于这个宽度时该锚点不参与（桌面锚点不该在手机上生效）。 */
  minWidth?: number;
  /** 容器宽于这个宽度时该锚点不参与。 */
  maxWidth?: number;
  /**
   * 这些状态下不要来这里。
   * 「动态感知」的实义就是它 —— 用户正在编辑/刷区域时，画布附近的锚点
   * 全部把它排除，于是它会自动挪到画布外的安全点，不会在用户正在看的
   * 格子上晃。
   */
  excludeIn?: readonly MascotAwareness[];
}

export interface MascotRoamerProps {
  /** 候选驻留点。至少一个；尺寸/状态不符的会被过滤掉。 */
  anchors: readonly MascotAnchor[];
  /** 当前页面状态，驱动表情。默认 'idle'。 */
  awareness?: MascotAwareness;
  /** 基准尺寸 px，内部 clamp 到 32–56。默认 44。 */
  baseSize?: number;
  /** 单次驻留时长范围 ms。默认 [6000, 14000]。 */
  dwellMs?: readonly [number, number];
  /** 单次换位时长范围 ms。默认 [500, 1200]。 */
  travelMs?: readonly [number, number];
  /** 可注入随机源（0–1）。默认 Math.random；测试传固定种子即可复现轨迹。 */
  random?: () => number;
  /** 关掉就固定停在第一个锚点，不跑计时器。 */
  enabled?: boolean;
  className?: string;
  /** 给了就变成可访问图片，否则纯装饰。 */
  title?: string;
  /** 每次真正**停稳**（淡入完成）时回调一次，测试用它记录轨迹。 */
  onAnchorChange?: (anchor: MascotAnchor, mood: MascotMood) => void;
}

const FADE_MS = 220;
const MIN_SIZE = 32;
const MAX_SIZE = 56;
/** 宽度变化小于这个值不重新过滤锚点，避免拖窗口时来回抖。 */
const WIDTH_HYSTERESIS = 24;

const clampSize = (n: number) => Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));

/** 在 [a,b] 里取一个随机数。 */
const pick = (rnd: () => number, [a, b]: readonly [number, number]) =>
  a + rnd() * (b - a);

/**
 * 会暂停的 sleep。
 *
 * `document.hidden` 期间**不累计时间** —— 标签页在后台开着十小时，回来时
 * 它应该还站在原地，而不是瞬间连跳几十次。实现是 120ms 一跳的轮询，精度
 * 足够（我们只在意"待了 6–14 秒"这个量级）。
 */
function sleep(ms: number, alive: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let remaining = ms;
    let last = performance.now();
    const tick = () => {
      if (!alive()) return resolve();
      const now = performance.now();
      if (typeof document !== 'undefined' && !document.hidden) {
        remaining -= now - last;
      }
      last = now;
      if (remaining <= 0) return resolve();
      window.setTimeout(tick, Math.min(120, Math.max(16, remaining)));
    };
    window.setTimeout(tick, Math.min(120, ms));
  });
}

export function MascotRoamer({
  anchors,
  awareness = 'idle',
  baseSize = 44,
  dwellMs = [6000, 14000],
  travelMs = [500, 1200],
  random = Math.random,
  enabled = true,
  className,
  title,
  onAnchorChange,
}: MascotRoamerProps) {
  /* ---- 容器宽度：只用来筛锚点，不参与定位 ----
     定位永远走百分比，所以 resize 不需要重算；这里读宽度纯粹是为了知道
     "现在该用桌面锚点还是手机锚点"。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - w) > WIDTH_HYSTERESIS ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---- 系统的减少动态偏好 ----
     只听系统设置，不做手动开关：用户已经在系统里表达过一次了。 */
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /* ---- 候选池：按宽度 + 当前状态过滤 ---- */
  const pool = useMemo(() => {
    const fits = anchors.filter((a) => {
      if (a.minWidth != null && width > 0 && width < a.minWidth) return false;
      if (a.maxWidth != null && width > 0 && width > a.maxWidth) return false;
      return true;
    });
    const allowed = fits.filter(
      (a) => !(a.excludeIn?.includes(awareness) ?? false),
    );
    /* 全被排除了也别消失：退回不限状态的那批，再退回全部。一只会突然
       蒸发又出现的吉祥物比"稍微站错位置"更让人在意。 */
    if (allowed.length) return allowed;
    if (fits.length) return fits;
    return anchors.slice(0, 1);
  }, [anchors, width, awareness]);

  const poolKey = useMemo(() => pool.map((a) => a.id).join('|'), [pool]);

  /* ---- 巡游状态 ----
     只存"本意"，不存"结果"：`still`（减少动态 / 关闭）时希望它钉在第一个
     锚点且常亮 —— 这个结果在渲染时直接推导出来，不靠 effect 回写 state，
     否则每次开关都会多一次级联渲染。 */
  const [index, setIndex] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);

  /* 循环里要读"最新"的 props，但不想让它们成为 effect 依赖（否则每次父层
     重渲染都会把巡游重置回起点）。React 19 的编译器规则禁止在 render 期间
     写 ref，所以统一在一个无依赖 effect 里同步 —— 它在每次提交后跑，晚于
     render，早于用户能看到的下一帧。 */
  const latest = useRef({
    pool,
    random,
    dwellMs,
    travelMs,
    onAnchorChange,
  });
  useEffect(() => {
    latest.current = { pool, random, dwellMs, travelMs, onAnchorChange };
  });

  const still = reduceMotion || !enabled;
  /** 锚点越界（状态变化把当前点过滤掉了）时夹回 0，同样是渲染期推导。 */
  const safeIndex = still ? 0 : Math.min(index, Math.max(0, pool.length - 1));
  const visible = still ? true : !fadeOut;

  /**
   * 主循环：驻留 → 淡出 → 换位 → 淡入 → 驻留…
   *
   * 换位发生在**完全透明**的 220ms 里，所以用户看到的是"消失 → 在别处
   * 出现"，而不是一只滑过整个屏幕的鸭子。
   */
  useEffect(() => {
    if (still) return;
    let alive = true;
    const isAlive = () => alive;

    (async () => {
      // 首帧先亮一下，别让它在页面刚打开时躲着。
      setFadeOut(false);
      await sleep(pick(latest.current.random, latest.current.dwellMs), isAlive);
      while (isAlive()) {
        // 1) 淡出
        setFadeOut(true);
        await sleep(FADE_MS, isAlive);
        if (!isAlive()) return;

        // 2) 在"看不见"的时候换位置
        setIndex((prev) => {
          const list = latest.current.pool;
          if (list.length <= 1) return 0;
          const next = Math.floor(latest.current.random() * (list.length - 1));
          // 跳过自己：连续两次停同一个点的观感是"它没动"。
          return next >= prev ? next + 1 : next;
        });
        await sleep(pick(latest.current.random, latest.current.travelMs), isAlive);
        if (!isAlive()) return;

        // 3) 淡入
        setFadeOut(false);
        await sleep(pick(latest.current.random, latest.current.dwellMs), isAlive);
      }
    })();

    return () => {
      alive = false;
    };
    /* poolKey 变化（换宽度档 / 换状态排除了一批）时重启循环是**故意**的：
       当前锚点可能已经不该站了，与其等它站完，不如立刻重选。 */
  }, [still, poolKey]);

  const anchor = pool[safeIndex];

  /* 停稳后回报一次（测试靠它记录轨迹）。 */
  const reportedRef = useRef<string>('');
  useEffect(() => {
    if (!anchor) return;
    if (!visible) return;
    const mood: MascotMood =
      awareness === 'idle'
        ? (anchor.mood ?? MASCOT_AWARENESS_MOOD.idle)
        : MASCOT_AWARENESS_MOOD[awareness];
    const key = `${anchor.id}|${mood}|${visible}`;
    if (reportedRef.current === key) return;
    reportedRef.current = key;
    latest.current.onAnchorChange?.(anchor, mood);
  }, [anchor, visible, awareness]);

  const mood: MascotMood = anchor
    ? awareness === 'idle'
      ? (anchor.mood ?? MASCOT_AWARENESS_MOOD.idle)
      : MASCOT_AWARENESS_MOOD[awareness]
    : MASCOT_AWARENESS_MOOD[awareness];

  const size = clampSize(Math.round(baseSize * (anchor?.scale ?? 1)));
  const travel = travelMs[1];

  const style: CSSProperties = {
    /* 锚点表为空（调用方传了 []）时居中兜底 —— 落在 0,0 会被 -50% 的居中位移
       推出左上角，只剩四分之一只豆子露在边上，比不显示还难看。 */
    transform: `translate(${anchor?.x ?? 50}%, ${anchor?.y ?? 50}%)`,
    opacity: visible ? 1 : 0,
    transition: still
      ? undefined
      : `transform ${travel}ms steps(12, end), opacity ${FADE_MS}ms linear`,
    willChange: still ? undefined : 'transform, opacity',
  };

  return (
    <div
      ref={rootRef}
      data-mascot-roamer=""
      data-mascot-anchor={anchor?.id ?? ''}
      data-mascot-visible={visible ? '1' : '0'}
      aria-hidden
      className={[
        'pointer-events-none absolute inset-0',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 两层嵌套，缺一不可：
          · 外层 **必须铺满容器**（inset-0）。translate 的百分比是按元素
            自身盒子算的 —— 外层要是只有吉祥物那么大，`translate(96%)`
            就只有 42px 而不是容器宽度的 96%（这个 bug 第一版就踩了，
            吉祥物整个贴在左上角）。铺满之后外层宽度 = 容器宽度，
            百分比才真的等于"容器百分比"。
          · 内层用 -50%/-50% 把吉祥物**中心**对到锚点上。 */}
      <div className="absolute inset-0" style={style}>
        <div
          className="absolute left-0 top-0"
          style={{ transform: 'translate(-50%, -50%)' }}
        >
          <PixelMascot
            size={size}
            mood={mood}
            side={anchor?.side ?? 'right'}
            animate={!reduceMotion}
            title={title}
          />
        </div>
      </div>
    </div>
  );
}

/* =====================================================================
 * 工作台默认锚点表
 *
 * 坐标全部是 `<main>`（page.tsx:570，`relative`）的百分比。这些点是拿真实
 * DOM 跑距离变换扫出来的**留白区**：把 main 里所有文字/控件/canvas 的包围盒
 * 标成障碍，再找离障碍最远的点。逐个核对过 1600×1000 与 390×844 两个视口。
 *
 * 硬约束（都在 1600×1000 / 390×844 上实测过）：
 *   · 不进入画布矩形 —— 画布尺寸随网格密度和视口变，百分比锚点跟不住它的
 *     边缘，站在旁边而不是里面才稳；
 *   · 不压页头品牌标记（MascotMark，40px）和画布左下的 PixelMascotPeek(64)；
 *   · 只落在面板内的空白（画布两侧的棋盘格留白、区块下方），不压文字。
 * ===================================================================== */
export const WORKBENCH_ANCHORS: readonly MascotAnchor[] = [
  /* ================================================================
   * 这些坐标不是拍的，是**扫出来的**。
   *
   * 做法：在真实页面上把 main 里所有文字/控件/canvas/Peek/页头 logo 的
   * 包围盒取出来当障碍，然后按 1% 步进遍历整张网格，对每个候选点检查
   * "在**本档所有视口**上都零重叠"，再按到最近障碍的间隙排序。
   * 吉祥物占地按 46×39（最大 scale 1.05）算，比实际略保守。
   *
   * 为什么必须分三档：左栏是固定 320px，画布是 `1fr` —— "左栏和画布
   * 之间那条缝"左边界永远在 332px，右边界却从 466（1024 宽）长到
   * 684（2560 宽）。任何单一百分比都做不到同时在两档命中，而且
   * ≥1800px 会多出右栏，缝的位置整体内缩。
   *
   * 每档的视口集合：
   *   narrow  390 / 414 / 430 / 600 / 768 / 820
   *   desk    1024 / 1180 / 1280 / 1366 / 1440 / 1600 / 1792
   *   wide    1800 / 1920 / 2200 / 2560 / 3000
   * 每个锚点都在这整组上实测零碰撞（.work/shots/anchor-check.json）。
   * ================================================================ */

  /* ---- 窄屏 < 1024px ------------------------------------------------
     单列布局，卡片把纵向空间吃满了，只剩顶部那条横带（y≈4–19%）
     是真留白；x=90% 附近间隙最大（55–62px）。 */
  { id: 'narrow-top-left', x: 48, y: 7, side: 'left', scale: 0.9, maxWidth: 1023 },
  { id: 'narrow-top-mid', x: 70, y: 7, side: 'right', scale: 0.9, maxWidth: 1023 },
  { id: 'narrow-top-right', x: 90, y: 12, side: 'left', scale: 0.9, maxWidth: 1023 },

  /* ---- 中屏 1024–1799px：左栏 + 画布 --------------------------------
     最空旷的是 x≈31–33% 那条左缝（间隙 75–80px），纵向从 18% 到 69%
     整段都干净；右侧 x=96% 也有一条（间隙 46px）；读数条上方
     x≈31%/y≈64% 还有一个中等空隙。 */
  /* 这三个站在左栏与画布之间的缝里 —— 也就是工具栏旁边。用户开始在画布上
     作画（editing / brushing）时把它们从候选里摘掉，它就自动换到右边那条缝，
     不会在用户正要点的那排按钮边上来回晃。这就是"动态感知"的实义：
     不是换个表情，而是让开。 */
  { id: 'desk-left-high', x: 32, y: 26, side: 'right', scale: 1, minWidth: 1024, maxWidth: 1799, excludeIn: ['editing', 'brushing'] },
  { id: 'desk-left-mid', x: 33, y: 44, side: 'right', scale: 1.05, minWidth: 1024, maxWidth: 1799, excludeIn: ['editing', 'brushing'] },
  { id: 'desk-left-low', x: 32, y: 64, side: 'right', scale: 1, minWidth: 1024, maxWidth: 1799, excludeIn: ['editing', 'brushing'] },
  { id: 'desk-right-high', x: 96, y: 28, side: 'left', scale: 1, minWidth: 1024, maxWidth: 1799 },
  { id: 'desk-right-low', x: 96, y: 62, side: 'left', scale: 1.05, minWidth: 1024, maxWidth: 1799 },

  /* ---- 宽屏 ≥1800px：多了右栏，画布两侧的缝内缩 ---------------------
     左边 x≈21% 纵向 13–77% 全干净，间隙最大 99px；右下 x≈85%/y≈80%
     是整页最空的一块（间隙 111px）；顶部 x≈40–58%/y≈6% 还有一条。 */
  { id: 'wide-left-high', x: 21, y: 24, side: 'right', scale: 1, minWidth: 1800 },
  { id: 'wide-left-low', x: 21, y: 58, side: 'right', scale: 1.05, minWidth: 1800 },
  { id: 'wide-top', x: 46, y: 6, side: 'left', scale: 0.9, minWidth: 1800 },
  { id: 'wide-right-high', x: 79, y: 34, side: 'left', scale: 1, minWidth: 1800 },
  { id: 'wide-right-low', x: 85, y: 80, side: 'left', scale: 1.05, minWidth: 1800 },
];

/** 状态枚举的运行时清单（测试与文档用，避免对着类型手抄）。 */
export const MASCOT_AWARENESS_LIST: readonly MascotAwareness[] = [
  'idle',
  'empty',
  'working',
  'done',
  'editing',
  'brushing',
  'error',
  'history',
  'exporting',
];

/** 给调用方做开关时用：这个状态该显示什么表情。 */
export function moodForAwareness(awareness: MascotAwareness): MascotMood {
  return MASCOT_AWARENESS_MOOD[awareness];
}
