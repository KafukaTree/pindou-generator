'use client';

import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 手机式左侧抽屉（社交媒体那种：往左滑出叠层，右边留一条半透明阴影）。
 *
 * 用户原话：「我觉得可以做成手机式的那种侧边栏，就是像社交媒体软件一样，
 * 往左滑就会出现叠层，但是只有左边大半个屏幕被占用，右边是偏阴影」。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"覆盖层"而不是"折叠进流式布局"
 * ---------------------------------------------------------------------------
 *
 * 02 图案参数这块在手机上有 1260px 高，比一屏还高。它无论塞在画板上方还是
 * 下方，都只能露出碎片，用户得来回拉才能看到"调了参数之后画布变成什么样"
 * —— 而这恰恰是调参数时唯一的判断依据（用户原话：「还要来回拉才能看到算法
 * 修改的结果」）。
 *
 * 覆盖层不参与流式布局：抽屉开合时画布尺寸**一动不动**，没有重排、没有
 * cellPx 重算（那会连带三层 canvas 全部重绘，手机上看得见卡顿）。
 *
 * ---------------------------------------------------------------------------
 * 交互约定
 * ---------------------------------------------------------------------------
 *
 * - 点遮罩关闭。这是社交媒体侧边栏的肌肉记忆，不需要教。
 * - Esc 关闭。和本组件外所有其它 Esc 行为一样（画布那套是"先关浮层再退编辑"）。
 * - 打开时焦点移到抽屉内第一个可聚焦元素，关闭后还给触发按钮。
 *   不还焦点的话，键盘用户关掉抽屉后焦点会掉到 body 上，Tab 从页面开头重新
 *   数 —— 那是可访问性缺陷，不是小事。
 * - 抽屉内不可滚动时锁 body 滚动这件事**不做**：本组件只用在已经
 *   `overflow:hidden` 的编辑态里，再加一层 body 锁会跟 PatternCanvas 那边的
 *   滚动恢复逻辑打架。抽屉自己的内容区单独 scroll。
 *
 * ---------------------------------------------------------------------------
 * 手势
 * ---------------------------------------------------------------------------
 *
 * 只在**从抽屉内**向右滑时关闭（左边缘回扫）。不做"从屏幕左缘右滑打开"
 * —— 那个手势在 iOS Safari 里被浏览器自己的"后退"占了，抢不过来，硬做只会
 * 变成"用户想关抽屉结果退出了整个页面"。
 */

export interface MobileDrawerProps {
  /** 是否展开 */
  open: boolean;
  /** 请求关闭（点遮罩 / Esc / 右滑 / 关闭按钮）。父组件负责把 open 置 false */
  onClose: () => void;
  /** 抽屉顶部标题栏的文字，例如「02 图案参数」 */
  title: React.ReactNode;
  /** 标题栏右侧的补充信息（例如色数、尺寸），小字 */
  hint?: React.ReactNode;
  /**
   * 关闭后把焦点还给它。
   *
   * 传触发按钮的 ref。不传也能用，只是关掉之后焦点会落到 body。
   */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
  /** 抽屉正文。直接塞 PatternSettings 之类的表单即可，本组件不做任何过滤 */
  children: React.ReactNode;
  className?: string;
}

/**
 * 抽屉宽度：`min(86vw, 420px)`。
 *
 * 390 屏 → 335px，右侧留 55px 遮罩。那 55px 是刻意留的：它必须够宽到让用户
 * 一眼看出"后面还有画布"（否则遮罩看起来像纯装饰），又不能宽到让画布上的
 * 格子还能点什么（半透明白遮罩下点中一个 4px 格子纯属误触）。
 *
 * 420px 的上限是给平板/横屏的：86vw 在 768 宽上是 660px，那边的抽屉不需要
 * 那么宽 —— 参数区是单列表单，超过 420px 只会让滑杆长得离谱。
 *
 * 取整到整数（`Math.round` 由 CSS 的 calc/min 自己完成）：不用 86vw 直接
 * 落地，是因为 390 × 0.86 = 335.4，小数宽在某些 DPR 下会多占 1px 触发横向
 * 溢出 —— 这里用 `min()` 交给浏览器，但父层加了 `overflow:hidden` 兜底。
 */
const DRAWER_WIDTH = 'min(86vw, 420px)';

/** 右滑关闭的判定：位移超过抽屉宽度的 30%，或者甩得够快 */
const SWIPE_CLOSE_RATIO = 0.3;
const SWIPE_CLOSE_VELOCITY = 0.5; // px/ms

export function MobileDrawer({
  open,
  onClose,
  title,
  hint,
  returnFocusTo,
  children,
  className,
}: MobileDrawerProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  /** 手势起点（打开时 pointerdown 才有值） */
  const swipeRef = React.useRef<{
    pointerId: number;
    x: number;
    y: number;
    t: number;
    /** 是否已判定为"横向滑动"（判定后要吃掉后续 pointermove 的默认行为） */
    horizontal: boolean;
  } | null>(null);
  /** 拖动中的实时位移，用于跟手（不开动画时直接改 translate） */
  const [dragX, setDragX] = React.useState(0);

  /**
   * 打开时把焦点送进抽屉。
   *
   * 为什么用 `requestAnimationFrame` 而不是直接调：抽屉是 `open` 才挂载的，
   * 同一个 commit 里 panelRef 刚被赋值，元素还没进布局树，`focus()` 会被
   * 忽略（Safari 上尤其明显）。等一帧再聚焦就稳。
   *
   * `preventScroll: true` 是必须的：手机编辑态下画布滚动容器就在下面，默认
   * 的 focus 会把整个页面滚到抽屉位置，用户看到的是"点开参数，画布跳走了"。
   */
  React.useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /**
   * 关闭时把焦点还给触发按钮。
   *
   * 依赖 open 从 true → false 的这一拍：上面那个 effect 的清理函数在"关"和
   * "卸载"两种情况下都会跑，分不清是哪种，所以这里单独写一个 effect，只在
   * 真正关闭（open === false 且之前开过）时还焦点。
   */
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    returnFocusTo?.current?.focus({ preventScroll: true });
  }, [open, returnFocusTo]);

  /** Esc 关闭。用 capture 抢在画布那套 window keydown 之前处理 */
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 抽屉里的输入框正在编辑时，Esc 先归输入框（比如清掉输入）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // 关闭时清掉跟手位移，否则下次打开会先闪一帧旧位置
  React.useEffect(() => {
    if (!open) setDragX(0);
  }, [open]);

  /**
   * 收掉正文里那份重复的标题。
   *
   * 抽屉头部已经写着「02 图案参数」，而 PatternSettings / BlankSettings 自带
   * 一行同款标题（序号 + .px-section-title）。实测 320/360/390/430 四档全部
   * 是上下两行一样的字，白占 31px，而且第一眼看上去像渲染重了。
   *
   * 为什么用运行时比对而不是写死 CSS：空白画布那块正文标题是「画布参数」，
   * 与抽屉的「图案参数」**不同**，那时两行各有信息，不该收。所以必须比文本。
   *
   * 比对时把抽屉标题开头的序号剥掉（"02 图案参数" → "图案参数"）再比。
   * 命中的是该标题所在的**行**（序号 + 标题那个 flex），同级右侧的「重算中」/
   * 「空白」标记留着 —— 它们是状态，不是标题重复。
   *
   * 用 class 而不是内联 style / 属性选择器：class 选择器在 Tailwind 产物里
   * 稳定编得进去，属性选择器踩过坑（`[data-testid="collapse-left"]` 那条
   * 一直编不进产物）。而内联 style 会被 React 的 style diff 覆盖掉。
   */
  React.useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body) return;
    const heading = body.querySelector<HTMLElement>('h2.px-section-title, h3.px-section-title');
    const row = heading?.parentElement;
    if (!row) return;
    const headingText = (heading.textContent || '').trim();
    const titleText =
      typeof title === 'string' ? title.replace(/^\s*\d+\s*/, '').trim() : null;
    if (!titleText || headingText !== titleText) return;
    row.classList.add('px-drawer-dup-title');
    return () => row.classList.remove('px-drawer-dup-title');
  }, [open, title]);

  const onPointerDown = (e: React.PointerEvent) => {
    // 只在主键/单指时接管
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      horizontal: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // 先判方向：竖向更大的话交给抽屉内容自己滚，别抢
    if (!s.horizontal) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        swipeRef.current = null;
        return;
      }
      s.horizontal = true;
      // 判定为横滑之后再捕获指针，避免挡掉内部的点击
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    // 只允许往右拖（右滑关闭），往左拖视为已到底，位移归 0
    setDragX(Math.max(0, dx));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || s.pointerId !== e.pointerId) return;
    if (!s.horizontal) {
      setDragX(0);
      return;
    }
    const dx = Math.max(0, e.clientX - s.x);
    const dt = Math.max(1, performance.now() - s.t);
    const panelW = panelRef.current?.getBoundingClientRect().width ?? 320;
    const fast = dx / dt > SWIPE_CLOSE_VELOCITY;
    if (dx > panelW * SWIPE_CLOSE_RATIO || fast) {
      onClose();
    }
    setDragX(0);
  };

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex"
      data-testid="mobile-drawer"
      // 抽屉本身铺满可视区，但只有遮罩那部分可点；面板从左侧滑入
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : '参数抽屉'}
    >
      {/*
        遮罩：点它关闭。
        用 `<button>` 而不是 `<div onClick>` —— 键盘可以 Tab 到、Enter 能触发，
        而且不用额外加 role/tabindex。视觉上它是半透明的，所以在按钮里塞
        aria-label。
      */}
      <button
        type="button"
        aria-label="关闭参数面板"
        data-testid="drawer-mask"
        onClick={onClose}
        className="px-mask absolute inset-0 h-full w-full cursor-default border-0 p-0"
        style={{
          background: 'rgba(43, 30, 20, 0.42)',
          // 像素风的遮罩不用模糊（这个视觉语言里没有一处 backdrop-filter 到画布级别）
        }}
      />

      {/*
        面板本体。
        translate 用 inline style 而不是动画类：跟手拖动时要能实时改到自定义值，
        动画类只负责"从 -100% 到 0"的入场。`dragX` 为 0 时挂 .px-drawer 走入场。

        焦点 outline 用 `focus-visible` 交给浏览器默认的描边 —— 面板本身是
        tabindex=-1 的容器，只有程序化聚焦会命中，不该画框。
      */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative flex h-full max-h-full flex-col bg-[var(--paper-raised)] outline-none',
          dragX === 0 && 'px-drawer',
          className,
        )}
        style={{
          width: DRAWER_WIDTH,
          flex: 'none',
          borderRight: '2px solid var(--line-strong)',
          boxShadow: 'var(--shadow-px)',
          translate: dragX ? `${dragX}px 0` : undefined,
          // 拖动中不要入场动画，否则每帧都被 animation 覆盖
          animation: dragX ? 'none' : undefined,
        }}
      >
        {/*
          标题栏：照搬工作台 Section 的样式（序号 + 标题 + hint + 关闭按钮）。
          不复用 Section 组件：那个在 page.tsx 里是私有函数，而且它自带
          面板外框 —— 抽屉已经是面板了，再套一层会双层边框。
        */}
        <div className="flex shrink-0 items-center gap-2.5 border-b-2 border-[var(--line)] px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
            <h2 className="font-display truncate text-[15px] font-bold tracking-tight">
              {title}
            </h2>
            {hint && (
              <span
                className="font-px shrink-0 text-[10px] tracking-wider"
                style={{ color: 'var(--ink-3)' }}
              >
                {hint}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
            className="px-btn px-btn-ghost"
            style={{ width: 32, height: 32, padding: 0, flex: 'none' }}
          >
            <X className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>

        {/*
          正文区：自己滚。
          `overscrollBehavior: 'contain'` 防止滑到底之后继续把页面带跑 ——
          手机上这个细节决定了"拖滑杆"和"翻页面"的手感边界。

          `touchAction: 'pan-y'` 是右滑关闭能work的前提，实测踩到的坑：
          默认 `auto` 时，手指横向一划浏览器就判定成"横向平移"，在 85px
          处直接抛 `pointercancel` 把后续 pointermove 全掐掉 —— 手势永远
          走不到 onPointerUp 的判定逻辑（探针里只看到 pointercancel:0）。
          声明 `pan-y` 等于告诉浏览器"竖向归你、横向归我"，pointermove 就
          能连续收到。代价是正文区不能横向滑动 —— 这里全是单列表单，
          本来也不需要。
        */}
        <div
          ref={bodyRef}
          className="px-drawer-body min-h-0 flex-1 overflow-y-auto px-3 py-3"
          style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default MobileDrawer;
