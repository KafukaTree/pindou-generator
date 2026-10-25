'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PixelMascot } from './PixelMascot';
import { cn } from '@/lib/utils';

/**
 * MascotPromptPopover — 「让 AI 先画一张能拼的图」弹窗。
 *
 * 由页头吉祥物触发。给出可直接复制的**中文**提示词，让外部生图工具
 * （豆包 / 元宝 / 即梦 / Qwen…）先产出一张**这个引擎吃得进去**的源图。
 *
 * ---------------------------------------------------------------------------
 * 为什么正文是中文而不是英文
 * ---------------------------------------------------------------------------
 * 用户原话（m08868）：「现在的提示词不好，英文太多，用户可能看不懂（变成中英的
 * 会比较好，默认中文）……因为面向大众市场」。
 *
 * 这不是妥协。豆包 / 元宝 / 即梦 / Qwen 的中文语料占优，对中文提示词的理解
 * 不比英文差；而 40 个英文单词挤在一起，非英语用户既看不懂也无法校对哪里该改。
 * 英文技术词（no anti-aliasing / flat solid background / chunky pixels）以括号
 * 形式保留 —— 一部分模型对这类固定术语确实更敏感，而且它们是这一行的行话，
 * 用中文硬译反而失真。
 *
 * 同一条用户需求还有一句：「几乎不要用户在特定地方补位语言才是合适的提示词」。
 * 所以下面每一条都是**完整可用**的句子：主体位置已经用「一只橘猫」这类示例词
 * 填好，用户直接复制就能发；想换就往那句话里换词，不必先在英文模板里
 * 找到一个 `{subject}` token 再替换。**不要再引入任何占位符。**
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
  /** 正文，可直接粘进生图工具。中文为主，英文术语放括号里。 */
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

/* ===========================================================================
 * 提示词的装配顺序（这个顺序本身就是一条设计决策）
 * ===========================================================================
 * AI 出图样本（r1–r7）共同的规格是：一整片纯色平背景、约 100 格宽的粗网格、
 * 硬边、色块大而少、主体居中。要让模型复现这些，约束的**排列顺序**必须和
 * 「这件事有多容易被违背」一致：
 *
 *   主体是什么 → 背景规定 → 像素规格 → 颜色规定 → 负面约束
 *
 * 反例是之前那版：把 `flat solid background` 埋在尾巴的一长串并列末尾。模型对
 * 长串末尾的权重要弱得多，实测最常被违背的恰恰是背景（出来带渐变、带光晕、
 * 带地面阴影），因为那是训练数据里"好看的图"的默认长相——**必须明文压制**，
 * 而且要放在前面。
 */

/**
 * 固定约束的写法：一条只压一个失败模式，且尽量短。
 *
 * 之前的版本每条都写成 40–70 字的长句，一条完整提示词 341–431 字里约 290 字
 * 是这些固定约束 —— 主体信息只占一成半。这是错的：约束之间互相稀释，模型
 * 会把注意力平均分给七八条并列要求，反而哪条都不够硬；用户自己也读不出
 * 哪句是他真该改的。
 *
 * 现在的原则是**一条约束对应一个实测会出的毛病**（去掉了"光晕"这种从没
 * 单独出现过的，也去掉了"点阵纹理/细线"这类其实被 no anti-aliasing 覆盖的）。
 * 固定部分从 ~290 字压到 ~170 字，主体回到句子的主位。
 */

/** 背景：这 7 张样本最统一的一条，也是进引擎的前提。必须排在最前面。 */
const BG =
  '背景是一整片纯色平涂（flat solid background），整张背景上下左右都不能有深浅变化，不要渐变、纹理、阴影、地面或任何场景装饰';

/** 像素规格：格大、对齐、硬边。 */
const GRID =
  '像素格子要大（整张图约 100 格宽）并严格对齐成网格，色块边缘是阶梯状直角锯齿（no anti-aliasing），不要柔化模糊过渡';

/** 色块：面数少、面积大、用色阶跳变代替渐变。 */
const BLOCK = '色块要大块平涂，明暗只用 2 到 3 档色阶跳变，不要抖动噪点';

/** 构图：正方形、居中、留白。 */
const FRAME = '正方形构图，主体居中、正面、完整，四周留白';

/** 负面：平台水印我们控制不了，所以只能显式要求不要出现文字类内容。 */
const NEG = '不要文字、水印、签名、边框';

/**
 * 拼装一条完整提示词。
 *
 * 注意这里**没有占位符**：主体句由各条目自己写全（「一只橘猫」这类示例词），
 * 用户复制即可直接发，想换主体就在那句话里换词。
 */
function prompt(parts: {
  subject: string;
  colors: string;
  tail?: string;
}): string {
  return [parts.subject, BG, GRID, BLOCK, parts.colors, FRAME, parts.tail, NEG]
    .filter(Boolean)
    .join('，');
}

/**
 * 「图生图」组专用拼装：必须先声明"参考我上传的这张图"，再讲只改什么、不改什么。
 * 这是与纯文生图完全不同的指令结构 —— 文生图是"从无到有"，图生图是"保留主体，
 * 只替换表现手法"。写成同一种句式，模型会把参考图也当成风格参考而重画主体。
 */
function refPrompt(parts: { keep: string; convert: string; colors: string }): string {
  return [
    '参考我上传的这张图',
    parts.keep,
    parts.convert,
    BG,
    GRID,
    BLOCK,
    parts.colors,
    FRAME,
    NEG,
  ].join('，');
}

const GROUPS: readonly PromptGroup[] = [
  {
    id: 'pixel',
    label: '像素画 · 拼豆专用',
    blurb:
      '没有任何参考图、纯靠一句话让 AI 从零画出来。成品可以直接转成图纸，成功率最高，建议先试这组。',
    items: [
      {
        id: 'pixel-grid',
        fit: '标准起步：小图标、挂件、钥匙扣这类 32 格上下的图案。',
        text: prompt({
          subject:
            '像素画，一只橘猫，正面坐着，静止站姿，8-bit 风格，粗描边，轮廓完整清晰',
          colors: '最多用 14 种颜色',
        }),
        note: '想换成别的东西，直接把「一只橘猫」这四个字换掉即可，句子其余部分不用动。',
      },
      {
        id: 'pixel-mid',
        fit: '中等复杂：小动物、食物、简单小场景，48 格左右，细节和可拼性最平衡。',
        text: prompt({
          subject:
            '像素画，一个蘑菇小屋，正面，居中，画面里只有这一个主体，16-bit 风格，粗而干净的描边',
          colors: '用 12 到 18 种颜色，同一种颜色只出现一个色号',
        }),
      },
      {
        id: 'pixel-rescue',
        fit: '出来的图「有点像像素画但边缘发糊」时，用这段重新生成来救。',
        text: prompt({
          subject:
            '严格的像素画，每一个像素都是完美的正方形并对齐到可见的网格上，一只橘猫，正面，孤立在画面中央',
          colors: '最多用 16 种颜色',
          tail: '这不是"像素风滤镜"，而是真正的低分辨率像素图（真正的 pixel art，不是 pixelated filter）',
        }),
        note: '关键是"无抗锯齿"和"无平滑"要同时出现；只写一个，模型常理解成风格而不是技术要求。',
      },
    ],
  },
  {
    id: 'reference',
    label: '图生图 · 参考图',
    blurb:
      '手上已经有一张图（照片、手绘草图、别人的画、已经生成的像素画），要把它变成能拼的拼豆图纸。用法：先把图传给豆包/元宝，再把下面的提示词贴上去。',
    items: [
      {
        id: 'ref-photo',
        fit: '照片转拼豆：真人照、宠物照、物品照，想做成纪念款。',
        text: refPrompt({
          keep:
            '保持原图里主体的样子、姿态、朝向和主要配色，不要换掉主体，也不要增加原图里没有的东西',
          convert:
            '把它转换成一幅像素画：把照片里的明暗和细节简化为大块的平涂色块，去掉毛发、布纹、噪点这类细碎质感，只保留能辨认出主体的关键形状',
          colors: '最多用 16 种颜色',
        }),
        note: '照片直接转通常要丢很多细节；主体在画面里越居中、越大，成品越好。',
      },
      {
        id: 'ref-sketch',
        fit: '草图 / 手绘 / 线稿转拼豆：自己画的、或是从别处描的轮廓。',
        text: refPrompt({
          keep: '完全保持原图画的东西和它的轮廓，不要重新设计造型，不要添加原图没有的细节',
          convert:
            '把这些线条变成像素画的硬边轮廓，线要加粗到至少一格的宽度，线条内部填成平涂色块，并把线条的抖动和不规整处拉直成阶梯状直角',
          colors: '最多用 12 种颜色',
        }),
        note: '线条太细是手绘转拼豆最常失败的原因 —— 一根发丝宽的线在 64 格里放不进一颗豆，一定要它加粗。',
      },
      {
        id: 'ref-pixel',
        fit: '已有像素画优化：本来就是像素画，但格子大小不一、边缘发糊、颜色太多。',
        text: refPrompt({
          keep: '保持原图的内容、构图和配色不变，不要重画主体',
          convert:
            '把这张图重新整理成规整的像素画：统一所有像素格的大小，让它们严格对齐到同一个网格，消除大小不一和错位的像素，把所有发糊的边缘改成硬边的直角锯齿',
          colors: '把颜色数量压缩到 16 种以内，面积很小的杂色直接合并到邻近的主色里',
        }),
        note: '这一条正是为了修「AI 直出的像素画不够规整」——整理完再传进来，转换会干净很多。',
      },
      {
        id: 'ref-scene',
        fit: '多主体 / 场景转拼豆：一张照片里有人有背景，或想要一整幅画。',
        text: refPrompt({
          keep: '保持原图里各个主体的相对位置和大小关系，不要删掉主体，也不要增加新的主体',
          convert:
            '把整个场景简化成像素画：把背景里杂乱的细节合并成几大块纯色，只保留能认出场景的轮廓，去掉所有细碎纹理',
          colors: '最多用 20 种颜色',
        }),
        note: '场景图拼出来格数需求比单个主体大得多。52 格以内做单个主体，场景建议 96 格以上。',
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
        text: prompt({
          subject:
            '像素画全身人物立绘，一个穿黄色卫衣的短发女孩，正面站姿，双脚分开站立，手臂与身体之间留出空隙，轮廓清楚，整圈有统一的深色描边，平涂上色、每个颜色只用 2 到 3 档明暗',
          colors: '用 16 到 20 种颜色',
        }),
        note: '「手臂与身体之间留出空隙」很重要：手贴身时手臂会和躯干融成一整块，缩小后结构就没了。',
      },
      {
        id: 'char-bust',
        fit: '头像 / 半身：适合做 64 格以内的徽章、杯垫。',
        text: prompt({
          subject:
            '像素画人物头像，一个戴眼镜的短发男生，正面，只画头和肩膀，构图左右对称，眼睛要大并且每只眼睛只用一颗白色高光像素，头发、皮肤、衣服各用一组分明的色块，深色粗描边',
          colors: '最多用 14 种颜色',
        }),
        note: '「每只眼睛只用一颗白色高光像素」能让眼睛活下来 —— 眼睛是缩小后最先糊掉的特征。',
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
        fit: '猫狗这类宠物的全身或头像，想做纪念款时用。',
        text: prompt({
          subject:
            '像素画，一只柴犬的全身，正面，对称坐着，剪影粗壮好辨认；毛发不要一根根画，而是简化成几大块平涂色块，形状圆润友好，深色粗描边，不要任何毛绒质感',
          colors: '用 8 到 14 种颜色，颜色取自这只狗真实的毛色',
        }),
        note: '「不要一根根画毛」是宠物图失败的头号原因：一根根毛会变成几百个碎像素，引擎只能合并成一片糊面。',
      },
      {
        id: 'animal-face',
        fit: '动物小图标、表情包风格的圆脸。',
        text: prompt({
          subject:
            '可爱的像素画动物圆脸图标，一只橘猫，正中构图，正面，左右对称，眼睛又大又简单，鼻子很小，细节尽量少，黑色描边，不要阴影',
          colors: '最多用 6 种颜色',
        }),
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
        text: prompt({
          subject:
            '复古电子游戏精灵图，一个手持木剑的勇者，NES 时代的 8-bit 风格，正面，单帧静止姿势，严格对齐网格，像素块粗大，黑色粗描边',
          colors: '用 8 到 12 种饱和度较高的颜色',
        }),
        note: '「单帧静止姿势」能避免模型画成多帧拼一张的 sprite sheet，那种图没法直接进引擎。',
      },
      {
        id: 'game-monster',
        fit: '怪物、龙、机甲这类形状复杂的角色。',
        text: prompt({
          subject:
            '像素画怪物角色，一只长着三只眼睛的紫色史莱姆，正面，居中，剪影粗壮好辨认，把复杂结构简化成几大块形状，深色粗描边，只用两档平涂明暗',
          colors: '用 14 种颜色',
          tail: '不要发光、不要粒子特效',
        }),
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
        text: prompt({
          subject:
            '像素画图标，一杯冒着热气的咖啡，只画这一个物体，居中，正面略微四分之三视角，轮廓干净好辨认，大块平涂颜色，深色粗描边，只在一侧用两档明暗',
          colors: '最多用 8 种颜色',
        }),
      },
      {
        id: 'object-letter',
        fit: '字母 / 数字 / 小招牌，适合做名字牌、门牌。',
        text: prompt({
          subject:
            '像素画，一个大写字母 A，只画这一个字符，居中，用方块几何结构拼出字形，笔画粗细一致，转角是直角，单色平涂，背景用一种对比明显的纯色',
          colors: '最多用 4 种颜色',
          tail: '不要发光、不要投影，字形保持左右对称',
        }),
        note: '一定要写「只画这一个字符」；写成单词时模型会排成一整行，字宽和行距都不稳。',
      },
      {
        id: 'object-logo',
        fit: '把已有 logo / 图标转成拼豆版（要用上面的「图生图」方式，先把 logo 传上去）。',
        text: refPrompt({
          keep: '只保留这个 logo 的轮廓特征和主色，不要改成别的形状，也不要添加新元素',
          convert:
            '把 logo 简化成像素画：去掉所有细节、渐变和细线，笔画加粗到至少一格宽，整体对齐到严格网格，居中放在画面里',
          colors: '最多用 10 种颜色',
        }),
        note: '纯文生图做 logo 基本不可控，这条一定要配参考图用。',
      },
    ],
  },
];

/** 通用负面词。有 negative prompt 输入框就一起粘进去，效果更稳。 */
const NEGATIVE =
  '模糊、柔化、平滑过渡、渐变、柔和阴影、发光、投影、照片写实、3D 渲染、JPEG 压缩噪点、细碎纹理、细线条、文字、水印、签名、抖动噪点（dithering）、多余的肢体、变形';


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
 * 整句渲染成全大写后基本没法校对 —— 中文没有大小写，但混在里面的
 * no anti-aliasing 会被写成 NO ANTI-ALIASING，反而更费劲。像素字体留给短标签。
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
              复制一段提示词到豆包 / 元宝 / 即梦，把生成的图传进来，图纸会干净很多。想照着自己的图做，用「图生图」那一组。
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

          <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
            每条都是<strong className="text-[var(--ink-2)]">可以直接发的完整句子</strong>，主体位置已经填好示例词（比如「一只橘猫」）。
            想换成自己要的东西，就把那句话里的主体换掉，其余不用动 —— 不用去找任何占位符。
            正文用中文，是因为豆包 / 元宝 / 即梦这些模型读中文不比英文差；
            括起来的英文术语是这一行的固定说法，留着能让模型更准确地理解技术要求。
          </p>

          {/* ─────────── 什么样的图适合本工具（管理预期） ─────────── */}
          <section className="mt-2.5 border-2 border-[var(--line)] bg-[var(--paper-sunken)] px-2.5 py-2">
            <h3 className="font-display text-[12px] font-bold text-[var(--ink)]">什么样的图最适合本工具</h3>
            <div className="mt-1.5 grid grid-cols-1 gap-1.5 text-[11px] leading-relaxed text-[var(--ink-2)] sm:grid-cols-2">
              <p>
                <span aria-hidden className="mr-1 text-[var(--leaf)]">✔</span>
                背景是一整片纯色、格子清晰、色块大、主体居中完整。
              </p>
              <p>
                <span aria-hidden className="mr-1 text-[var(--bloom)]">✘</span>
                手机照片直出、背景杂乱、大片渐变、细节很碎 —— 也能转，但会丢掉不少东西。
              </p>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
              判断标准很简单：把图缩小成一张 32×32 的缩略图，还认得出是什么，就能拼得好看。
            </p>
          </section>

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

        </div>
      </DialogContent>
    </Dialog>
  );
}

export default MascotPromptPopover;
