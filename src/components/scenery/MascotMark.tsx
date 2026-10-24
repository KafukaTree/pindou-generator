'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { PixelMascot, type MascotMood } from './PixelMascot';
import { MascotPromptPopover } from './MascotPromptPopover';

/**
 * MascotMark — 页头左上角那个小吉祥物。
 *
 * 它自己会换造型：每隔几秒在几个姿势之间轮换，节拍是"慢"的（3–6 秒一个），
 * 因为那个位置只有 40×40，动得太快会变成闪烁而不是生动。
 *
 * 三条必须自己处理的规矩，调用方不需要关心：
 *
 *  1. `prefers-reduced-motion: reduce` → 定格在 happy，**完全不轮播**。
 *  2. `document.hidden` → 计时暂停且不累计。标签页在后台挂一下午，
 *     切回来时它应该接着刚才那个姿势待着，而不是立刻跳十几次。
 *     实现里每一跳都会检查 `document.hidden`，隐藏期间不倒计时。
 *  3. 卸载后不留定时器。
 *
 * 尺寸：默认 40。这不是随便取的 —— 吉祥物原生于 40×34 个 4px 格
 * （viewBox 160×136），40px 时每格正好 1 个 CSS 像素，像素边缘落得整整齐齐。
 * 26px 会让每格只剩 0.65px，手绘轮廓被采样成糊团。
 */

/** 轮播顺序。第一个是"休息姿势"，也是 reduced-motion 下的定格姿势。 */
const DEFAULT_MOODS: readonly MascotMood[] = [
  'happy',
  'headphones',
  'jumpRope',
  'walk',
  'music',
  'draw',
  'review',
];

/** 每个造型停留多久（毫秒）。范围而不是定值，避免看出规律。 */
const DEFAULT_DWELL: readonly [number, number] = [3200, 5600];

export interface MascotMarkProps {
  /** 渲染宽度，默认 40。改它会破坏 1:1 像素网格，除非你确知后果。 */
  size?: number;
  /** 轮播的造型列表。默认 happy → headphones → jumpRope → walk → music → draw → review。 */
  moods?: readonly MascotMood[];
  /** 每个造型停留时间范围，默认 [3200, 5600] 毫秒。 */
  dwellMs?: readonly [number, number];
  /** 关掉轮播、只显示 `moods[0]`。默认 true（跟着系统偏好自动降级）。 */
  cycle?: boolean;
  /** 点击回调。给了才渲染成按钮。 */
  onClick?: () => void;
  /** 额外类名，挂到最外层元素上。 */
  className?: string;
  /** 无障碍描述。纯装饰时可省略。 */
  title?: string;
  /** 可注入的随机源，测试用固定种子。 */
  random?: () => number;
}

/**
 * 页头吉祥物本体（不含外框、不含 popover）。
 * 外框（clay 底 + 2px 边 + 硬投影）由调用方提供 —— 那是布局，不是这个组件的事。
 */
export function MascotMark({
  size = 40,
  moods = DEFAULT_MOODS,
  dwellMs = DEFAULT_DWELL,
  cycle = true,
  onClick,
  className,
  title,
  random = Math.random,
}: MascotMarkProps) {
  /* 轮播索引。reduced-motion 下不推进，但它只是"当前第几个姿势"，
     具体显示哪个在渲染期推导，避免 effect 里 setState。 */
  const [index, setIndex] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  /* 系统偏好：只听系统设置，不提供手动开关 —— 用户已经在系统里表达过一次。 */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /* 轮播循环。每一跳都重新读 document.hidden，隐藏期间不计时。 */
  const latest = useRef({ moods, dwellMs, random });
  useEffect(() => {
    latest.current = { moods, dwellMs, random };
  });

  const active = cycle && !reduceMotion && moods.length > 1;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer = 0;

    const schedule = () => {
      const { dwellMs: d, random: rnd } = latest.current;
      const [lo, hi] = d;
      const span = Math.max(0, hi - lo);
      const wait = lo + rnd() * span;
      let remaining = wait;
      let last = performance.now();

      const tick = () => {
        if (!alive) return;
        const now = performance.now();
        /* 标签页在后台：时间不走，等它回来再接着算。 */
        if (typeof document !== 'undefined' && !document.hidden) {
          remaining -= now - last;
        }
        last = now;
        if (remaining <= 0) {
          setIndex((i) => (i + 1) % latest.current.moods.length);
          schedule();
          return;
        }
        timer = window.setTimeout(tick, Math.min(140, Math.max(16, remaining)));
      };
      timer = window.setTimeout(tick, Math.min(140, remaining));
    };

    schedule();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [active]);

  /* 渲染期推导：reduced-motion 或关掉轮播时永远钉在第一个姿势。
     index 可能指向被裁掉的越界项（moods 换了），夹一下。 */
  const safeIndex = active ? Math.min(index, Math.max(0, moods.length - 1)) : 0;
  const mood = moods[safeIndex] ?? 'happy';

  /* 造型自己也得动起来 —— 耳机点头、绳子在转。
     reduced-motion 下 `animate` 直接关掉，连 CSS keyframes 都不注入。 */
  const sprite = <PixelMascot mood={mood} size={size} animate={!reduceMotion} />;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={className}
        aria-label={title ?? '吉祥物：点开拼豆创作提示词'}
        title={title}
      >
        {sprite}
      </button>
    );
  }

  return (
    <span className={className} aria-hidden={!title} aria-label={title}>
      {sprite}
    </span>
  );
}

/* =====================================================================
 * 全包版：mark + 弹窗 + open state 全在一个组件里
 *
 * page.tsx 里把原来的 `MascotMark()` 局部函数整个换成这一个标签即可，
 * 不需要在页面里加任何 useState。
 * ===================================================================== */

export interface MascotPromptButtonProps {
  /** 吉祥物宽度，默认 40（页头的正确值）。 */
  size?: number;
  /** 当前品牌，会写进提示词里（"色号体系约 N 色"）。 */
  brand?: string;
  /** 外层类名。 */
  className?: string;
  /** 轮播造型，透传给 MascotMark。 */
  moods?: readonly MascotMood[];
  /** 停留时间范围，透传。 */
  dwellMs?: readonly [number, number];
}

/**
 * 页头那个"点了会说话"的吉祥物。
 *
 * ```tsx
 * <MascotPromptButton brand={options.brand} />
 * ```
 *
 * 外框（`size-11` + clay 底 + 2px 描边 + 硬投影）故意留在调用方 ——
 * 那是页面布局的一部分，塞进组件里会让它没法复用到别的位置。
 */
export function MascotPromptButton({
  size = 40,
  brand,
  className,
  moods,
  dwellMs,
}: MascotPromptButtonProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <>
      <MascotMark
        size={size}
        moods={moods}
        dwellMs={dwellMs}
        className={className}
        onClick={toggle}
      />
      <MascotPromptPopover open={open} onOpenChange={setOpen} brand={brand} />
    </>
  );
}
