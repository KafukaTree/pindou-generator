'use client';

/**
 * 笔刷按钮（图形化的笔宽 + 当前色）
 * ---------------------------------------------------------------
 * 用户原话：
 *   「那个表示颜色收起的按钮可以改成设置，不过不要写设置，我的想法是
 *     一个按钮，是能代表笔刷粗细和颜色的图形，粗的时候就粗一点，细的
 *     时候就细一点，然后颜色变的时候也跟着变」
 *
 * 所以这不是一个"图标"，是一个**像素化的笔头剖面**：
 *
 *   · 笔画出来的粗细 = 笔宽（1–4 格），画在 24×24 的格子里；
 *   · 笔身的颜色 = 当前色号；
 *   · 外面套一个圆圈表示"笔尖覆盖范围"，半径同样跟笔宽走。
 *
 * 为什么这么做比写"设置"两个字好：
 *   1. 按钮本身就是当前状态的**读数** —— 不用点开、不用看文案，
 *      扫一眼就知道"我这一笔画多粗、什么色"。
 *   2. 它是唯一一个同时承载两个维度的地方：工具条上其余按钮都是
 *      开关或动作，只有这里需要"值"。
 *   3. 用户在画布上看到的光标形状要和这个按钮一致（见 PixelBrushCursor），
 *      两处同一个形状，认知成本为零。
 *
 * 交互是两段式：点一下展开浮层（粗细 4 档 + 色卡），选完自动收起。
 * 不直接把 4 档铺在工具条上 —— 那会多占 100px，而工具条在标题栏里
 * 已经满了；也不把色卡直接塞进来 —— 291 色是竖栏和浮层的职责。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Slider } from '@/components/ui/slider';
import { PixelSwatch } from '@/components/scenery';
import { MAX_BRUSH_WIDTH, MIN_BRUSH_WIDTH } from './usePatternCanvas';

export interface BrushSizeButtonProps {
  /** 当前笔宽（直径，格），1–4 */
  width: number;
  /** 改笔宽 */
  onWidthChange: (width: number) => void;
  /** 当前色 hex（无当前色时为 null，按钮画成空笔） */
  hex: string | null;
  /** 当前色号，显示在浮层里 */
  code: string | null;
  /** 是否处于编辑模式（非编辑态下这个按钮不出现） */
  className?: string;
}

/**
 * 笔头图形。
 *
 * 24×24 的格子里画一支"朝右下"的笔：
 *   · 笔尖那块圆形色块 = 笔宽，直径 3/6/9/12 对应 1–4；
 *   · 笔杆是一条 4px 宽的斜柄，颜色同当前色（深浅各一半，显得有体积）。
 *
 * 全部整数坐标 —— 这个站里的像素图形从不落在半像素上，否则在 1x 屏上
 * 会糊成灰边（和吉祥物、光标同一套规矩）。
 */
function BrushGlyph({
  width,
  color,
  size = 24,
}: {
  width: number;
  color: string;
  size?: number;
}) {
  /*
   * 笔尖直径映射到图形：1–16 格 → 3–14 px。
   *
   * 线性映射会出问题：1→3、16→14 差 11px，但 1 和 2 之间只差 0.7px，
   * 细的那几档在图标上看不出区别。改用开方压缩，让低档位之间有肉眼可见的
   * 差距（1→3、2→5、4→7、8→10、16→14），而高档位不会把笔杆整个吃掉。
   */
  const clamped = Math.max(MIN_BRUSH_WIDTH, Math.min(MAX_BRUSH_WIDTH, width));
  const t = Math.sqrt((clamped - MIN_BRUSH_WIDTH) / (MAX_BRUSH_WIDTH - MIN_BRUSH_WIDTH));
  const d = Math.round(3 + t * 11);
  const r = d / 2;
  // 笔尖圆心坐在右下角，笔杆从左上斜插进来
  const tipX = 16;
  const tipY = 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      aria-hidden
      style={{ display: 'block' }}
    >
      {/* 笔杆：从 (4,4) 到笔尖的一条 5px 宽斜条，用两段矩形拼出斜面 */}
      <rect x={4} y={3} width={5} height={11} fill={color} opacity={0.55} />
      <rect x={3} y={4} width={11} height={5} fill={color} opacity={0.55} />
      {/* 笔尖：外圈描边 + 实心色块，直径跟笔宽走 */}
      <circle
        cx={tipX}
        cy={tipY}
        r={r + 1}
        fill="var(--line-strong)"
        opacity={0.9}
      />
      <circle cx={tipX} cy={tipY} r={r} fill={color} />
    </svg>
  );
}

/**
 * 笔宽提示语。
 *
 * 用户嫌 4 档"太保守"，改成 1–16 连续可调。连续之后就不能再给每一档配
 * 文案了（16 条没人读），改成按区间给一句话定位用途。
 */
function widthHint(width: number): string {
  if (width <= 1) return '单格 · 修边缘、点眼睛';
  if (width <= 3) return '小手笔 · 日常涂色';
  if (width <= 6) return '中笔 · 填色块';
  if (width <= 10) return '大笔 · 铺背景';
  return '特大笔 · 一把刷一片';
}

/**
 * 像素滑杆的类名修正。
 *
 * 与 PatternSettings 里那份同源：globals.css 的 `.px-slider` 规则写在
 * `@layer components`，Tailwind utilities 层在它之后输出，shadcn Slider
 * 自带的 `h-1.5` / `rounded-full` / `bg-white` 会把像素风整条盖掉。
 * 用任意变体 + `!` 抢回来，与站里其它滑杆视觉一致。
 */
const SLIDER_CLASSES = [
  'px-slider',
  '[&_[data-slot=slider-track]]:!h-2 [&_[data-slot=slider-track]]:!rounded-none',
  '[&_[data-slot=slider-track]]:!border-2 [&_[data-slot=slider-track]]:!border-[var(--line-strong)]',
  '[&_[data-slot=slider-track]]:!bg-[var(--paper-sunken)]',
  '[&_[data-slot=slider-range]]:!bg-[var(--clay)]',
  '[&_[data-slot=slider-thumb]]:!h-5 [&_[data-slot=slider-thumb]]:!w-4',
  '[&_[data-slot=slider-thumb]]:!rounded-none [&_[data-slot=slider-thumb]]:!border-2',
  '[&_[data-slot=slider-thumb]]:!border-[var(--line-strong)] [&_[data-slot=slider-thumb]]:!bg-[var(--paper-hi)]',
  '[&_[data-slot=slider-thumb]]:!shadow-[0_3px_0_0_var(--line-strong)]',
  '[&_[data-slot=slider-thumb]]:hover:!bg-[var(--clay)]',
].join(' ');

export function BrushSizeButton({
  width,
  onWidthChange,
  hex,
  code,
  className,
}: BrushSizeButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /*
   * 浮层自己的 DOM 引用。
   *
   * **必须单独持有**：浮层 portal 到 document.body，不在 rootRef 的子树里。
   * 只判 `rootRef.contains(target)` 的话，点在浮层内部也会被当成"点外面"
   * —— 实测表现为"一点任何档位，浮层就关掉、宽度完全没变"（pointerdown
   * 先关、浮层卸载、click 根本没机会触发）。
   */
  const popRef = useRef<HTMLDivElement | null>(null);

  /*
   * 点外面关掉。
   *
   * 用 pointerdown 而不是 click：拖动画布时手指抬起的位置可能在浮层外，
   * click 会因为"按下和抬起不在同一元素"而丢失，导致浮层关不掉。
   *
   * 注意**不监听 Escape** —— 画布那边 Esc 是"退出编辑模式"，两个都响应
   * 的话用户按一下会同时关浮层和退出编辑，比不响应更糟。
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const label = hex ? `笔刷：直径 ${width} 格 · ${code ?? ''}` : '笔刷设置';

  return (
    <div ref={rootRef} className={['relative', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="px-btn px-btn-sm inline-flex items-center gap-1"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-testid="brush-size-button"
      >
        <BrushGlyph width={width} color={hex ?? 'var(--paper-sunken)'} size={18} />
        <span className="font-px text-[11px] font-bold" style={{ color: 'var(--ink)' }}>
          {width}
        </span>
        <span style={{ color: 'var(--ink-3)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open &&
        createPortal(
          /*
           * 浮层挂在 body 上（portal）而不是按钮里。
           *
           * 按钮在 04 标题栏内，那个容器有 `overflow: hidden`（标题栏不
           * 允许内容溢出），浮层若留在里面会被裁掉下半截 —— 实测只能看到
           * 第一行。portal 到 body + fixed 定位，位置从按钮的
           * getBoundingClientRect 算，滚动和窗口变化时跟着重算。
           */
          <BrushPopover
            panelRef={popRef}
            anchorRef={rootRef}
            width={width}
            hex={hex}
            code={code}
            onPick={onWidthChange}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/** 浮层本体：粗细分档 + 当前色大样。色卡本体由父级色板负责，这里不重复。 */
function BrushPopover({
  panelRef,
  anchorRef,
  width,
  hex,
  code,
  onPick,
  onClose,
}: {
  /** 浮层自身节点，父级用它判断"点的是不是浮层内部" */
  panelRef: React.RefObject<HTMLDivElement | null>;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  width: number;
  hex: string | null;
  code: string | null;
  onPick: (w: number) => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 默认贴在按钮正下方、左对齐；右边界溢出时向左翻
      const PANEL_W = 248;
      let left = r.left;
      if (left + PANEL_W > window.innerWidth - 8) left = window.innerWidth - PANEL_W - 8;
      setPos({ left: Math.max(8, left), top: r.bottom + 6 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef]);

  if (!pos) return null;

  return (
    <div
      ref={panelRef}
      className="px-panel z-50 flex flex-col gap-2 p-2.5"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: 248,
        background: 'var(--paper-raised)',
      }}
      role="dialog"
      aria-label="笔刷设置"
    >
      <div className="flex items-center gap-2">
        <BrushGlyph width={width} color={hex ?? 'var(--paper-sunken)'} size={22} />
        <div className="flex min-w-0 flex-col leading-none">
          <span className="font-px text-[11px] font-bold" style={{ color: 'var(--ink)' }}>
            直径 {width} 格
          </span>
          <span className="mt-1 text-[10px]" style={{ color: 'var(--ink-3)' }}>
            {widthHint(width)}
            {code ? ` · ${code}` : ''}
          </span>
        </div>
        {hex && <PixelSwatch hex={hex} size={22} className="ml-auto" />}
      </div>

      {/*
        滑动条而不是档位按钮阵。

        用户原话：「太保守了，可以做个滑动条然后跟进到 1-16 直径的吧」。
        连续档位下按钮阵不成立（16 个按钮铺不下），而且滑杆还有个按钮阵
        给不了的反馈：拖动时画布上的预览环实时跟着变粗变细，能直接看到
        下一笔会有多粗 —— 这是"手感"的一部分，不是参数面板。
      */}
      <div className="px-0.5 pt-1" data-testid="brush-width-slider">
        <div className={SLIDER_CLASSES}>
          <Slider
            value={[width]}
            min={MIN_BRUSH_WIDTH}
            max={MAX_BRUSH_WIDTH}
            step={1}
            onValueChange={([n]) => onPick(n)}
            aria-label="笔刷直径（格）"
          />
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="font-px text-[9px] tabular-nums" style={{ color: 'var(--ink-3)' }}>
            {MIN_BRUSH_WIDTH}
          </span>
          <span className="text-[9px]" style={{ color: 'var(--ink-3)' }}>
            拖动调节
          </span>
          <span className="font-px text-[9px] tabular-nums" style={{ color: 'var(--ink-3)' }}>
            {MAX_BRUSH_WIDTH}
          </span>
        </div>
      </div>

      <p className="text-[10px] leading-snug" style={{ color: 'var(--ink-3)' }}>
        换色在右侧色板里点，取色器也能直接吸取画面上的颜色。
      </p>

      <button
        type="button"
        className="px-btn px-btn-ghost px-btn-sm self-end"
        onClick={onClose}
        data-testid="brush-popover-close"
      >
        收起
      </button>
    </div>
  );
}
