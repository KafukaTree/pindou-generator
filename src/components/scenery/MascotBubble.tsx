'use client';

/**
 * 页头聊天气泡
 * ---------------------------------------------------------------
 * 用户原话：「这里面可以加个小宠物的聊天气泡，有几句话随机说（有时候出现
 * 有时不出现），就是引起兴趣的，就是那种 AI 帮助创作的」。
 *
 * 所以这不是"提示条"，是**吉祥物在说话**。设计上要满足四点：
 *
 *  1. **偶尔出现**：间隔 9–18s 随机，显示 4.6–6.4s。留白比出镜重要 ——
 *     常驻的话它就从"小惊喜"变成了"顶栏的另一行字"。
 *  2. **说完就收**：淡出后立刻卸载（不是 opacity:0 留在 DOM 里），
 *     否则命中的点击/无障碍朗读都会指着一条看不见的气泡。
 *  3. **不抢操作**：`pointer-events: none`。气泡飘在标题文字上方，
 *     若可点击会挡住标题、也会挡住它下面那块区域。
 *  4. **尊重减弱动效**：`prefers-reduced-motion` 下干脆不说话。
 *     随机浮现的装饰对这类用户就是干扰源，`px-bob` 那套也一样关掉。
 *
 * 文案走的是"AI 帮着出主意"的口吻，不说"点击这里"这类指令 —— 它只是
 * 路过嘟囔一句，点不点都行。真正能点的是气泡**左边那只鸭子**（页头主
 * 吉祥物按钮），那是另一个组件的职责。
 */

import { useEffect, useRef, useState } from 'react';

/** 随机台词。全部是「路过嘟囔一句」的语气，没有一条要求用户做动作。 */
const LINES = [
  '先把眼睛抠准，整张图就活了。',
  '颜色别贪多，12 色以内最像手作。',
  '这张图的渐变，得靠抖色骗眼睛。',
  '网格 96 是细节和耐心的分水岭。',
  '阴影用深一档，比加黑边好看。',
  '小图做大，大图做精 —— 别反过来。',
  '背景留白也是构图的一部分。',
  '腮红那两颗，千万别被算法省掉。',
  '拼的时候从深色铺到浅色，好找。',
  '同一块板，先拼轮廓再填内部。',
  '我看到一条 1 格宽的线，有点危险。',
  /*
   * 下面这两条是"钩子"。

   * 用户要求：「移动到上面可以说，点击我获取提示词哦」—— 气泡不能只是
   * 自言自语，得让人知道鸭子本身是个入口（点开是拼豆生图提示词弹窗）。
   * 放在最后两条、且只占 12 句里的 2 句：偶尔提示一次是发现感，
   * 每轮都喊就是广告了。
   */
  '点我一下，给你一份能直接喂给 AI 的提示词。',
  '想不出画什么？我这儿存着几条好用的提示词。',
] as const;

/** 出现间隔（ms）与停留时长（ms）的取值区间。 */
const GAP_MS: readonly [number, number] = [9000, 18000];
const DWELL_MS: readonly [number, number] = [4600, 6400];

/** 在 [min, max] 里取随机整数。 */
const pickInt = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (max - min + 1));

/** 随机挑一句（避免和上一句重复）。 */
function pickLine(prev: string | null): string {
  if (LINES.length < 2) return LINES[0];
  let next = LINES[pickInt(0, LINES.length - 1)];
  // 连续两次说同一句会显得很笨，重摇一次即可（LINES 有 12 条，撞车率低）
  if (next === prev) next = LINES[pickInt(0, LINES.length - 1)];
  return next;
}

export interface MascotBubbleProps {
  /** 关闭后不再说话（例如用户已经在弹窗里看提示词了） */
  enabled?: boolean;
  className?: string;
}

/**
 * 一个"有时候出现"的对话气泡。
 *
 * 为什么用两条 `setTimeout` 串起来而不是 `setInterval`：间隔本身是随机的，
 * interval 只能固定周期；而且每轮都要重新抽台词和时长。
 *
 * 清理逻辑必须把两个 timer 都清掉 —— 组件卸载（切主题导致 header 重挂载时
 * 并不罕见）或 `enabled` 变化时如果漏掉正在等待的那条，下一次 setState 会
 * 打在已卸载的组件上。
 */
export function MascotBubble({ enabled = true, className }: MascotBubbleProps) {
  const [line, setLine] = useState<string | null>(null);
  /*
   * 上一句放在 ref 里，不放 state。

   * 如果它是 state，`setLastLine(next)` 会让 effect 的依赖变化、effect 重跑，
   * 于是刚排好的两条 timer 被清掉又重排 —— 表现为"第一句能出来，之后间隔
   * 越拖越长甚至再也不出"。ref 不参与依赖比较，只用来避免连续重复。
   */
  const lastLineRef = useRef<string | null>(null);

  useEffect(() => {
    // 关闭时根本不排期；正在显示的那句由下面的渲染条件收掉（不在 effect 里
    // setState —— 同步 setState 会触发级联渲染，react-hooks 也报
    // `set-state-in-effect`）。
    if (!enabled) return;
    // 减弱动效：不开口。装饰性随机内容对这类用户是负担，不是惊喜。
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce.matches) return;

    let appearTimer: ReturnType<typeof setTimeout>;
    let hideTimer: ReturnType<typeof setTimeout>;
    let alive = true;

    const schedule = () => {
      appearTimer = setTimeout(() => {
        if (!alive) return;
        const next = pickLine(lastLineRef.current);
        lastLineRef.current = next;
        setLine(next);
        hideTimer = setTimeout(() => {
          if (!alive) return;
          setLine(null); // 卸载气泡，不是只改透明度
          schedule(); // 说完排下一轮
        }, pickInt(DWELL_MS[0], DWELL_MS[1]));
      }, pickInt(GAP_MS[0], GAP_MS[1]));
    };
    schedule();

    return () => {
      alive = false;
      clearTimeout(appearTimer);
      clearTimeout(hideTimer);
    };
  }, [enabled]);

  if (!enabled || !line) return null;

  return (
    <div
      // role=status 而不是 alert：这是氛围信息，不该打断读屏用户当前的任务
      role="status"
      aria-live="polite"
      className={[
        /*
         * 贴在鸭子**右侧**、垂直居中，而不是下方。
         *
         * 先试过 `top-full`（挂在鸭子底下）：顶栏只有 49px 高，鸭子占 44px，
         * 气泡 35px 高，溢出去正好压住下面「01 放一张图」的标题栏 ——
         * 截图里看着像贴纸贴歪了。放在右侧则完全落在顶栏内，那段横向
         * 空间（顶栏标题已居中到别处）本来就是空的。
         *
         * `pointer-events-none`：它飘在顶栏上空，可点击的话会挡掉下面的
         * 标题；真要互动，左边那只鸭子本身就是按钮。
         *
         * `hidden lg:block`：手机上鸭子右边紧跟着就是标题（顶栏标题只在
         * lg 以上居中），放气泡会盖住「拼豆图纸工坊」。这是锦上添花的
         * 细节，不值得为它挤掉站名。
         */
        'pointer-events-none absolute left-full top-1/2 z-30 ml-2 hidden -translate-y-1/2 lg:block',
        /*
         * 必须给 `w-max`。
         *
         * 挂载点是一个只有 40px 宽（鸭子）的 flex 容器，absolute 元素的
         * 收缩宽度按那个容器的可用宽度算 —— 只写 max-w 的话它会被压成
         * 48px 宽、每行一个字、184px 高的一根面条（实测）。
         * `w-max` 让它按文字自然宽度展开，max-w 再兜住最长的台词，
         * 免得横穿到右侧的统计 tag 上。
         */
        'w-max max-w-[min(16rem,52vw)]',
        'px-rise',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="relative px-2.5 py-1.5 text-[11.5px] leading-relaxed"
        style={{
          background: 'var(--paper-hi)',
          color: 'var(--ink)',
          border: '2px solid var(--line-strong)',
          boxShadow: 'var(--shadow-px)',
        }}
      >
        {/*
          气泡的小尖角。用两个绝对定位的方块叠出来：
          外层 6×6 旋转 45° 画边框，内层 4×4 盖住朝向气泡的那半条边 ——
          纯 CSS 三角（border 技巧）在这里不行，它画不出 2px 的硬边。
        */}
        <span
          aria-hidden
          className="absolute top-1/2 -left-[6px] block size-[6px] -translate-y-1/2 rotate-45"
          style={{
            background: 'var(--paper-hi)',
            borderBottom: '2px solid var(--line-strong)',
            borderLeft: '2px solid var(--line-strong)',
          }}
        />
        {line}
      </div>
    </div>
  );
}
