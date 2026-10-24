'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PixelMascot } from './PixelMascot';
import { cn } from '@/lib/utils';

/**
 * MascotPromptPopover — 「让 AI 先画一张能拼的图」弹窗。
 *
 * 由页头吉祥物触发。给出可直接复制的英文提示词，让外部生图工具
 * （豆包 / Qwen / 即梦 / Midjourney…）先产出一张**这个引擎吃得进去**的源图。
 *
 * ---------------------------------------------------------------------------
 * 为什么这些词这么写（这一节比提示词本身更值钱，换任何模型都成立）
 * ---------------------------------------------------------------------------
 * 引擎不是"把图变糊"，而是**按格多数表决 + 特征保护**：
 *
 *  1. 颜色边界跨在格子中间时，两侧像素各占一半，表决会把它判给面积更大的
 *     邻色 —— 抗锯齿的中间色就是这么变成灰边的。所以要在源头消灭过渡带，
 *     而不是指望后期修：`no anti-aliasing` / `hard edges`。
 *  2. 颜色名额是硬上限（滑杆 4–48，默认 16）。渐变背景、柔和阴影的每一档
 *     过渡色都各占一个名额，正主反而分不到色。所以 `flat solid background`
 *     / `limited palette` / `no gradients` 直接决定色数能否花在主体上。
 *  3. 小于半格的高反差小结构（眼睛高光、瞳孔）会被邻色吃掉。引擎会在
 *     **源图**上预先检测这类结构、按重要程度预留豆子（lib/pattern/features.ts），
 *     但前提是它在源图里**本来就存在且够干净**——512px 里只有 3px 的眼睛，
 *     检测得到也放不进一颗豆。所以"粗描边 + 大色块"是物理约束，不是审美。
 */

interface PromptItem {
  id: string;
  /** 中文：这条适合什么 */
  fit: string;
  /** 英文正文，可直接粘进生图工具 */
  text: string;
  /** 可选的中文补充提醒 */
  note?: string;
}

interface PromptGroup {
  id: string;
  label: string;
  blurb: string;
  items: readonly PromptItem[];
}

/**
 * 共用尾巴。这几条是"能不能进引擎"的物理条件，每条提示词都不能省。
 *
 * 注意这里**不含** limited palette —— 每条提示词自己写色数（8/12/16…），
 * 因为在尾巴里再写一遍会出现 "limited palette of 8 colors, ..., limited
 * color palette, ..." 这种自我重复，模型会当成两个不同的约束。
 */
const TAIL =
  'flat solid background, clean hard pixel edges, no anti-aliasing, no gradients, no soft shadows, no text, no watermark';

const GROUPS: readonly PromptGroup[] = [
  {
    id: 'pixel',
    label: '像素画 · 拼豆专用',
    blurb:
      '想直接拿到一张"格子感"的图，转成图纸几乎一步到位。这类成功率最高，建议先从这里试。',
    items: [
      {
        id: 'pixel-grid',
        fit: '标准起步：32×32 上下的小图标、挂件、钥匙扣图案。',
        text: `pixel art sprite of a {subject}, front view, idle pose, 8-bit style, exactly 16 blocks wide, chunky square pixels, bold black outline, limited palette of 14 colors, ${TAIL}`,
        note: '换成你要画的东西即可。「exactly 16 blocks wide」是让模型去数格子，比只写 32×32 更有效。',
      },
      {
        id: 'pixel-mid',
        fit: '中等复杂：小动物、食物、小场景，48×48 左右，细节与可拼性平衡最好。',
        text: `16-bit pixel art of a {subject}, centered, front facing, sitting pose, 48 by 48 grid, crisp square pixels, thick clean outline, distinct flat color blocks, limited color palette of 12 to 18 colors, no dithering, ${TAIL}`,
      },
      {
        id: 'pixel-rescue',
        fit: '已经"有点像像素画但边缘发糊"的图，用这段重生成来救。',
        text: `strict pixel art, every pixel is a perfect square, aligned to a visible grid, no smoothing, flat colors only, hard stepped edges, {subject}, front view, isolated on a plain background, limited palette of 16 colors, ${TAIL}`,
        note: '关键是 no anti-aliasing 与 no smoothing 同时出现；只写一个，模型常理解成风格而不是技术约束。',
      },
    ],
  },
  {
    id: 'character',
    label: '人物 · 立绘',
    blurb: '全身或半身人像。正面、描边清楚、色块分明的立绘，转出来最像原图。',
    items: [
      {
        id: 'char-full',
        fit: '全身立绘：角色、cos、自画像，站姿正面。',
        text: `pixel art full-body character sprite, {subject}, front view, standing straight, arms slightly away from body, clear silhouette, bold uniform outline around the whole figure, flat cel shading with 2 to 3 tones per color, limited palette of 16 to 20 colors, no thin lines, ${TAIL}`,
        note: '「arms slightly away from body」很重要：手贴身时手臂会与躯干融成一块，缩小后结构就没了。',
      },
      {
        id: 'char-bust',
        fit: '头像 / 半身：适合做 64 格以内的徽章、杯垫。',
        text: `pixel art bust portrait of {subject}, front facing, head and shoulders only, symmetrical framing, large eyes with a single white highlight pixel, distinct color blocks for hair skin and clothes, thick dark outline, limited palette under 14 colors, ${TAIL}`,
        note: '「a single white highlight pixel」能让眼睛活下来 —— 眼睛是缩小后最先糊掉的特征。',
      },
    ],
  },
  {
    id: 'animal',
    label: '宠物 · 动物',
    blurb: '猫狗、鸟、鱼。动物比人宽容，只要轮廓干净，几乎都能拼出来。',
    items: [
      {
        id: 'pet',
        fit: '真实宠物的头像或全身，想做纪念款时用。',
        text: `pixel art of a {subject}, front view, full body, sitting symmetrically, bold graphic silhouette, simplified fur as large flat color blocks (no individual hairs), rounded friendly shapes, thick outline, limited palette of 8 to 14 colors picked from the subject's real colors, no texture, ${TAIL}`,
        note: '「no individual hairs」是宠物图失败的头号原因：一根根毛会变成几百个碎像素，引擎只能合并成糊面。',
      },
      {
        id: 'animal-face',
        fit: '动物小图标 / 表情包风格的圆脸。',
        text: `cute pixel art animal face icon of a {subject}, perfectly centered, front facing, symmetric, big simple eyes, small nose, minimal details, 24 by 24 grid, very limited palette of 6 colors, black outline, no shading, ${TAIL}`,
      },
    ],
  },
  {
    id: 'game',
    label: '游戏 · 动漫角色',
    blurb: '精灵、怪物、道具、致敬经典 8-bit 的角色。',
    items: [
      {
        id: 'game-sprite',
        fit: '经典游戏精灵：RPG 小怪、勇者、宝箱、药水。',
        text: `retro video game sprite of a {subject}, NES-era 8-bit style, front view, static idle frame, strict grid alignment, chunky pixels, bold black outline, limited palette of 8 to 12 saturated colors, no drop shadow, ${TAIL}`,
        note: '「static idle frame」能避免模型画成 sprite sheet（多帧拼一张），那种图没法直接进引擎。',
      },
      {
        id: 'game-monster',
        fit: '怪物 / 龙 / 机甲这类形状复杂的角色。',
        text: `pixel art monster character, {subject}, front view, centered, aggressive readable silhouette, simplified anatomy with large distinct shapes, thick outline, two-tone flat shading only, limited palette of 14 colors, no glow, no particles, ${TAIL}`,
      },
    ],
  },
  {
    id: 'object',
    label: '小物件 · 图标 · 文字牌',
    blurb: '食物、植物、文具、logo、字母牌。形状简单，成品率最高。',
    items: [
      {
        id: 'object-item',
        fit: '单件物品：一杯咖啡、一片叶子、一个蘑菇、一台游戏机。',
        text: `pixel art icon of a {subject}, single object, centered, front or slight 3/4 view, clean recognizable silhouette, large flat color areas, bold outline, subtle 2-tone shading on one side only, limited palette of 8 colors, ${TAIL}`,
      },
      {
        id: 'object-letter',
        fit: '字母 / 数字 / 小招牌，适合做名字牌、门牌。',
        text: `pixel art of the letter "{letter}", single character, centered, blocky geometric construction, thick uniform stroke, sharp corners, flat single color on a plain contrasting solid background, no outline effects, no shadow, symmetry preserved, no anti-aliasing, no gradients`,
        note: '一定要写「single character」；写成单词时模型会排成一整行，字宽和行距都不稳。',
      },
      {
        id: 'object-logo',
        fit: '把已有 logo / 图标转成拼豆版（配"图生图 / 参考图"使用）。',
        text: `simplify this logo into pixel art, keep the recognizable silhouette and exact color identity, reduce to a limited palette of under 10 flat colors, remove all fine detail, gradients and thin lines, thicken outlines, align everything to a strict pixel grid, centered on a plain solid background, no anti-aliasing, no shadows`,
        note: '这条要配参考图用；纯文生图请把 logo 的特征直接写进描述。',
      },
    ],
  },
];

/** 通用负面词。有 negative prompt 框就一起粘，效果更稳。 */
const NEGATIVE =
  'blurry, anti-aliased, smooth, gradient, soft shading, glow, drop shadow, photorealistic, 3d render, jpeg artifacts, noisy texture, thin lines, text, watermark, signature, extra limbs, deformed';

export interface MascotPromptPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前色卡品牌，用于在文案里说一句实话。 */
  brand?: string;
}

/** 每个品牌色卡实际都是 291 色 —— 只在界面上提一句，不参与提示词正文。 */
const BRAND_COLORS: Record<string, number> = {
  MARD: 291,
  COCO: 291,
  漫漫: 291,
  盼盼: 291,
  咪小窝: 291,
};

function CopyButton({ text, id }: { text: string; id: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    let next: 'done' | 'fail' = 'done';
    try {
      /* clipboard API 在非 https、无用户手势、或 iframe 里会被拒，必须有兜底。 */
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'fail';
    }
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`复制提示词 ${id}`}
      className={cn(
        'shrink-0 border-2 px-2 py-1 font-px text-[10px] leading-none transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--clay)]',
        state === 'done'
          ? 'border-[var(--leaf)] bg-[var(--leaf-soft)] text-[var(--leaf-deep)]'
          : state === 'fail'
            ? 'border-[var(--bloom)] bg-[var(--bloom-soft)] text-[var(--bloom)]'
            : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink-2)] hover:bg-[var(--paper-sunken)] hover:text-[var(--ink)]',
      )}
    >
      {state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}
    </button>
  );
}

/** 自绘的像素风关闭按钮 —— Dialog 自带那个是 lucide 圆角叉，和本设计系的方角硬边不搭。 */
function PixelClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="关闭"
      className="shrink-0 border-2 border-[var(--line-strong)] bg-[var(--paper-raised)] p-1.5 text-[var(--ink-2)] transition-colors hover:bg-[var(--clay)] hover:text-[var(--paper-hi)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--clay)]"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden
        className="px-art"
        shapeRendering="crispEdges"
      >
        <rect x="1" y="1" width="2" height="2" fill="currentColor" />
        <rect x="3" y="3" width="2" height="2" fill="currentColor" />
        <rect x="5" y="5" width="2" height="2" fill="currentColor" />
        <rect x="7" y="7" width="2" height="2" fill="currentColor" />
        <rect x="7" y="1" width="2" height="2" fill="currentColor" />
        <rect x="5" y="3" width="2" height="2" fill="currentColor" />
        <rect x="3" y="5" width="2" height="2" fill="currentColor" />
        <rect x="1" y="7" width="2" height="2" fill="currentColor" />
      </svg>
    </button>
  );
}

/**
 * 提示词正文块：左侧一道陶土色硬边。
 *
 * 这里**故意用等宽系统字体而不是 --font-pixel**：Silkscreen 只有大写字形，
 * 40 个英文单词的提示词渲染成全大写后基本没法校对（用户要改 {subject}、
 * 要确认 no anti-aliasing 有没有漏）。像素字体留给短标签用。
 */
function PromptBlock({ text, accent }: { text: string; accent: string }) {
  return (
    <pre
      className={cn(
        'mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-l-2 bg-[var(--paper-raised)]',
        'px-2 py-1.5 text-[11px] leading-[1.6] text-[var(--ink)]',
        /* 不能用 font-mono：globals.css 把 --font-mono 指到了 --font-pixel（Silkscreen），
           那套字体只有大写字形，整段提示词会被渲染成全大写，无法校对。 */
        'font-[ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace]',
        accent,
      )}
    >
      {text}
    </pre>
  );
}

export function MascotPromptPopover({ open, onOpenChange, brand }: MascotPromptPopoverProps) {
  const [activeGroup, setActiveGroup] = useState(GROUPS[0].id);
  const group = useMemo(
    () => GROUPS.find((g) => g.id === activeGroup) ?? GROUPS[0],
    [activeGroup],
  );

  const paletteNote = brand
    ? `${brand} 色卡共 ${BRAND_COLORS[brand] ?? 291} 个色号可选，但一次转换通常只用到 8–20 个。`
    : '一次转换通常只用到 8–20 个色号。';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          /* sm: 前缀必须显式覆盖，否则 Dialog 基类的 sm:max-w-lg(512px) 会赢过无前缀的 max-w */
          'flex w-full flex-col gap-0',
          /*
           * 高度：桌面端封顶 760px 而不是撑满 88vh —— 1000px 高的视口里 88vh=880 会让弹窗
           * 顶到上下边缘、看着像全屏网页，而且把「这只是一张提示卡片」的分量感弄没了。
           * 移动端用 dvh（地址栏收放时可视高度会变，vh 会算多），并留 2rem 上下呼吸。
           * 头两块（标题栏、分组页签）是 shrink-0，只有正文滚动，所以滚到底一定看得全。
           */
          'max-h-[min(88vh,760px)]',
          'supports-[height:100dvh]:max-h-[min(760px,calc(100dvh-2rem))]',
          'max-w-[calc(100vw-1.5rem)] sm:max-w-[min(780px,calc(100vw-1.5rem))]',
          'rounded-none border-2 border-[var(--line-strong)] bg-[var(--paper-raised)] p-0',
          'shadow-[var(--shadow-px-lg)] duration-0 outline-none',
        )}
      >
        {/* ───────────────── 头部 ───────────────── */}
        <div className="flex shrink-0 items-center gap-2.5 border-b-2 border-[var(--line-strong)] bg-[var(--paper-sunken)] px-3 py-2">
          {/*
           * size=40 是唯一干净的值：原生 40×34 格、每格 4px → size=40 时
           * 恰好 1.000 CSS px/格。缩到 32 会变成 0.8，轮廓被采样成糊团。
           * 所以外框放到 48（40 + 2px 边框 ×2 + 4px 内边距），而不是压小图。
           */}
          <div className="flex size-12 shrink-0 items-center justify-center border-2 border-[var(--line-strong)] bg-[var(--clay)]">
            <PixelMascot size={40} mood="review" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="font-display text-[14px] leading-tight font-bold text-[var(--ink)]">
              让 AI 先画一张「能拼」的图
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-[11.5px] leading-snug text-[var(--ink-2)]">
              复制英文提示词到豆包 / Qwen / 即梦 / Midjourney，把生成的图传进来，图纸会干净很多。
            </DialogDescription>
          </div>
          <PixelClose onClose={() => onOpenChange(false)} />
        </div>

        {/* ───────────────── 分组页签 ───────────────── */}
        <div role="tablist" aria-label="提示词分类" className="shrink-0 border-b-2 border-[var(--line)] px-2 py-2">
          <div className="flex flex-wrap gap-1.5">
            {GROUPS.map((g) => {
              const on = g.id === group.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setActiveGroup(g.id)}
                  className={cn(
                    'border-2 px-2.5 py-1.5 text-[11px] leading-none transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--clay)]',
                    on
                      ? 'border-[var(--line-strong)] bg-[var(--clay)] font-bold text-[var(--paper-hi)]'
                      : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]',
                  )}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ───────────────── 正文 ───────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <p className="mb-2.5 text-[11.5px] leading-relaxed text-[var(--ink-3)]">{group.blurb}</p>

          <ul className="flex flex-col gap-2">
            {group.items.map((item) => (
              <li
                key={item.id}
                className="border-2 border-[var(--line)] bg-[var(--paper)] px-2.5 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11.5px] leading-relaxed text-[var(--ink-2)]">{item.fit}</p>
                  <CopyButton text={item.text} id={item.id} />
                </div>
                <PromptBlock text={item.text} accent="border-[var(--clay)]" />
                {item.note ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
                    <span aria-hidden className="mr-1 text-[var(--clay)]">
                      ↳
                    </span>
                    {item.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {/* ─────────── 为什么这样写（这个功能真正的价值所在） ─────────── */}
          <section className="mt-3.5 border-2 border-[var(--line-strong)] bg-[var(--paper-sunken)] px-3 py-2.5">
            <h3 className="font-display text-[12.5px] font-bold text-[var(--ink)]">
              为什么每条都在强调「纯色背景 + 少量颜色 + 干净描边」
            </h3>
            <div className="mt-2 flex flex-col gap-2 text-[11.5px] leading-relaxed text-[var(--ink-2)]">
              <p>
                <strong className="text-[var(--ink)]">① 抗锯齿边缘会变成灰边。</strong>{' '}
                转换时每格会对它覆盖的源图像素做多数表决。颜色边界若跨在格子中间，两侧像素各占一半，
                表决会把它判给旁边面积更大的颜色 —— 那条原本半透明的过渡带就成了脏灰边。
                所以要让模型直接画硬边，而不是让它画得好看再指望我们修。
              </p>
              <p>
                <strong className="text-[var(--ink)]">② 渐变背景会偷走颜色名额。</strong>{' '}
                颜色数量是硬上限（可调 4–48，默认 16）。渐变背景里每一档过渡色都各占一个名额，
                正主（脸、衣服、眼睛）反而分不到色，最后全身糊成一个色调。
              </p>
              <p>
                <strong className="text-[var(--ink)]">③ 小特征要够大才活得下来。</strong>{' '}
                比半格还小的眼睛高光、瞳孔，会被旁边的面积更大的颜色吃掉。引擎会在源图上先找出这类
                结构、按重要程度预留豆子（所以眼睛一般不会丢），但它只能保住源图里
                <em className="text-[var(--ink)]">本来就存在且够清楚</em>的东西。
                所以「粗描边 + 大色块」是物理约束，不是审美。
              </p>
              <p className="border-t-2 border-[var(--line)] pt-2 text-[var(--ink-3)]">
                {paletteNote}
                另外请尽量选正方形、主体居中的构图：细长画面被压到同样格数时，
                短边只剩十来个格子，细节会整片消失。
              </p>
            </div>
          </section>

          {/* ─────────── 负面词 ─────────── */}
          <section className="mt-2.5 border-2 border-[var(--line)] bg-[var(--paper)] px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11.5px] leading-relaxed text-[var(--ink-2)]">
                工具有 negative prompt（负面词）框的话，把这段也粘进去，效果更稳：
              </p>
              <CopyButton text={NEGATIVE} id="negative" />
            </div>
            <PromptBlock text={NEGATIVE} accent="border-[var(--bloom)]" />
          </section>

          <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
            提示词里的{' '}
            <code className="border border-[var(--line)] bg-[var(--paper-raised)] px-1 font-mono text-[10px] text-[var(--ink)]">
              {'{subject}'}
            </code>{' '}
            与{' '}
            <code className="border border-[var(--line)] bg-[var(--paper-raised)] px-1 font-mono text-[10px] text-[var(--ink)]">
              {'{letter}'}
            </code>{' '}
            是占位符，换成你要画的东西就好。英文对这些模型更有效，所以正文保持英文。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default MascotPromptPopover;
