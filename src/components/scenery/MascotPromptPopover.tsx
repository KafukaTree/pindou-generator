"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { PixelMascot } from "./PixelMascot";
import { cn } from "@/lib/utils";

/**
 * MascotPromptPopover — 「让 AI 先画一张能拼的图」弹窗。
 *
 * 由页头吉祥物触发。给出可直接复制的**中文**提示词，让外部生图工具
 * （豆包 / 元宝 / 即梦 / Qwen…）先产出一张**这个引擎吃得进去**的源图。
 *
 * ---------------------------------------------------------------------------
 * 一、每条提示词都同时兼容三种给法（用户 m09026）
 * ---------------------------------------------------------------------------
 * 用户原话：「每个提示词都要包容进，参考图｜知名IP｜用户描述，兼容就会比较好」。
 *
 * 所以**取消了原来那个「图生图 · 参考图」独立分组**。按「文生图 / 图生图」分组
 * 是把这个功能的内部实现暴露给用户：他得先判断自己属于哪一类，判断错了就拿到
 * 一段根本用不上的提示词。现在每条提示词开头都是同一段 `OPEN`，用 ①②③④ 四个
 * 条件分支覆盖四种输入，用户不用做任何前置判断。
 *
 * 第 ④ 条来自用户同一条需求里的另一句：「如果没有用户个人描述或者参考图就追问
 * 用户」。它让提示词在信息不足时是**会问话的**，而不是硬编一张不相干的图出来。
 *
 * ---------------------------------------------------------------------------
 * 二、能改的地方必须一眼看见（用户 m09026）
 * ---------------------------------------------------------------------------
 * 用户原话：「要用户自己描述填写的部分要有重点强调，不然用户看不见」。
 *
 * 表达方式改过两轮，**最新一轮（用户 m09327）推翻了上一轮**，别再往回改：
 *
 *  第一轮：正文里写 `【一朵蘑菇】（把这里换成你想画的东西）` —— 带一句真实示例，
 *          理由是「几乎不要用户在特定部位补位语言」，一个字不改也能出图。
 *  第二轮（现行）：用户原话「要画的是 [ ] 这里应该写待填写，不然给豆包豆包直接
 *          生成了」。
 *
 * 第一轮错在哪：示例词是真的会被模型当成需求。豆包看到「要画的是：【一朵蘑菇】」，
 * 直接画一朵蘑菇交差 —— 用户以为自己拿到的是模板，实际拿到的是一张别人点好的菜。
 * 「不用改也能用」在文案上是优点，在生成结果上是**错误答案**，而且用户很难意识到
 * 是这个原因。
 *
 * 现在的做法：
 * - 正文里那个位置是 `【待填写】`，**不含任何具体事物**，模型没法照着画；
 * - 弹窗顶部有一个输入框，用户写的词由 `build(subject)` 拼进正文；
 * - 没填时复制按钮**禁用**并显示「先写要画什么」—— 从物理上堵住"拿模板直接发"；
 * - `【待填写】` 仍由 `Highlighted` 渲染成麦黄底 + 加粗，位置一眼可见。
 *
 * `build(subject)` 是函数而不是模板字符串：占位符替换（`{subject}`）在上一版被
 * 用户否掉过，但那是**否掉用花括号当占位符**，不是否掉"填一个词生成一句话"。
 * 用户要的是能填、且填之前不许发出去。
 *
 * ---------------------------------------------------------------------------
 * 三、原理（写给维护者，界面上不再展示）
 * ---------------------------------------------------------------------------
 * 用户 m09026 逐字：「我觉得这种为什么xxxx，这个框没必要」，所以弹窗底部那块
 * 三段式「为什么每条都在强调纯色背景」已经删掉。道理留在这里，改提示词时对照：
 *
 *  1. 引擎按格做多数表决。颜色边界若跨在格子中间，两侧像素各占一半，表决会把
 *     它判给面积更大的邻色 —— 抗锯齿的过渡带就是这么变成脏灰边的。所以要在
 *     源头消灭过渡带（`no anti-aliasing`），而不是指望后期修。
 *  2. 颜色名额是硬上限（滑杆 4–48，默认 16）。渐变背景每一档过渡色都各占一个
 *     名额，正主（脸、衣服、眼睛）反而分不到色，最后全身糊成一个色调。
 *  3. 小于半格的高反差小结构（眼睛高光、瞳孔）会被邻色吃掉。引擎会在**源图**上
 *     预先检测这类结构、按重要程度预留豆子（lib/pattern/features.ts），但前提是
 *     它在源图里**本来就存在且够干净** —— 512px 里只有 3px 的眼睛，检测得到也
 *     放不进一颗豆。所以"粗描边 + 大色块"是物理约束，不是审美。
 *
 * 约束的**排列顺序**也按「多容易被违背」排（这个顺序是本文件最容易被改错的地方）：
 *
 *   三种给法 → 要画什么 → 背景规定 → 像素规格 → 颜色规定 → 负面约束
 *
 * 反例是更早那版：`flat solid background` 埋在尾巴一长串并列的末尾。模型对长串
 * 末尾的权重明显更弱，实测最常被违背的恰恰是背景（出来带渐变、光晕、地面阴影），
 * 因为那是训练数据里"好看的图"的默认长相 —— 必须明文压制，而且要放前面。
 */

interface PromptItem {
  id: string;
  /** 中文：这条适合什么 */
  fit: string;
  /**
   * 要不要用户先填主体词才能复制。
   *
   * 参考图类条目（整理已有像素画、转自己的 logo）不需要 —— 主体就是那张图，
   * 让用户再写一句纯属多余；其余条目必须填，否则正文里只有 `【待填写】`。
   */
  needsSubject: boolean;
  /** 入参是用户填的主体词（可能为空），返回可直接粘进生图工具的正文。 */
  text: (subject: string) => string;
  /** 可选的中文补充提醒 */
  note?: string;
}

interface PromptGroup {
  id: string;
  label: string;
  blurb: string;
  /** 主体输入框的占位示例，按分组给不同的，让用户知道"这里填多大粒度"。 */
  hint: string;
  items: readonly PromptItem[];
}

/* ===========================================================================
 * 固定段落。一条只压一个**实测会出的毛病**，不长篇大论。
 * ===========================================================================
 * 上一版每条固定约束都写成 40–70 字长句，一条提示词 341–431 字里约 290 字是这些
 * 套话，主体信息只占一成半。约束之间互相稀释，模型把注意力平均分给七八条并列
 * 要求，反而哪条都不够硬。现在固定部分压到 ~180 字，主体回到句子的主位。
 */

/**
 * 三路兼容 + 缺信息就追问。**每条**提示词都以这段开头。
 *
 * 写成条件分支而不是并列陈述：模型对「如果是 A 就…」这种形式的遵循度，明显高于
 * 把所有情况揉成一句长描述。四条分支的顺序按用户最可能的行为排：大多数人手上
 * 会有一张想照着做的东西，所以「有参考图」放第一。
 */
const OPEN =
  "先判断我给了什么：① 我附了参考图 → 以参考图为准画，保持主体、姿态、朝向和主要配色，不换造型，不添加原图里没有的东西；" +
  "② 我说了一个知名角色、动漫、游戏或品牌的名字 → 按它官方设定里的经典形象画，保留最好认的那几个特征；" +
  "③ 我只用一句话说了要画什么 → 就按我的描述画；" +
  "④ 我上面三样都没给 → 先别画，回我一句「你想画什么？可以发一张参考图、说一个角色名，或者用一句话描述」。";

/** 背景：这些样本里最统一的一条，也是能进引擎的前提。必须排在画面内容之后。 */
const BG =
  "背景是一整片纯色平涂（flat solid background），整张背景上下左右都不能有深浅变化，不要渐变、纹理、阴影、地面或任何场景装饰。";

/** 像素规格：格大、对齐、硬边。 */
const GRID =
  "像素格子要大（整张图约 100 格宽）并严格对齐成网格，色块边缘是阶梯状直角锯齿（no anti-aliasing），不要柔化模糊过渡。";

/** 色块：面数少、面积大、用色阶跳变代替渐变。 */
const BLOCK = "色块要大块平涂，明暗只用 2 到 3 档色阶跳变，不要抖动噪点。";

/** 构图：正方形、居中、留白。 */
const FRAME = "正方形构图，主体居中、正面、完整，四周留白。";

/** 负面：平台水印我们控制不了，所以只能显式要求不要出现文字类内容。 */
const NEG = "不要文字、水印、签名、边框。";

/**
 * 用户没填时显示在正文里的占位词。
 *
 * **这个值必须是"待填写"这种非名词**，不能是「一朵蘑菇」之类的示例 ——
 * 用户 m09327 实测过：豆包看到「要画的是：一朵蘑菇」就直接画蘑菇，
 * 用户拿到一张不是自己要的图，还以为模板就是这样。
 */
const PLACEHOLDER = "待填写";

/**
 * 把用户填的词包成 `【】`：既让 `Highlighted` 认得出它是可改区域，
 * 也让模型把它读成"这是用户点名要的主体"。
 *
 * 顺手剥掉用户自己打的括号 —— 输入框里粘进「【猫】」时不该变成「【【猫】】」。
 */
function spot(word: string): string {
  const clean = word.replace(/^[【\[]+/, "").replace(/[】\]]+$/, "").trim();
  return `【${clean || PLACEHOLDER}】`;
}

/**
 * 拼一条提示词 —— 返回**函数**，入参是用户填的主体词。
 *
 * 为什么是函数而不是拼好的字符串：那个位置现在是 `【待填写】`，用户写的词
 * 要在复制/预览时才能拼进去。固定段落（OPEN/BG/GRID/…）仍然只有一份，
 * 十二个条目共享，改一处就全改。
 */
function build(parts: {
  /** 把主体词拼进这句话。`s` 已经是 `【词】` 形式，直接嵌进句子即可。 */
  subject: (s: string) => string;
  colors: string;
  extra?: string;
}): (subject: string) => string {
  return (subject) => {
    const s = spot(subject);
    return [
      OPEN,
      `要画的是：${parts.subject(s)}`,
      BG,
      GRID,
      BLOCK,
      `${parts.colors}。`,
      FRAME,
      parts.extra ?? "",
      NEG,
    ]
      .filter(Boolean)
      .join("");
  };
}


const GROUPS: readonly PromptGroup[] = [
  {
    id: "icon",
    label: "图标 · 挂件",
    blurb:
      "最小的那一档，32～48 格。挂件、钥匙扣、冰箱贴、徽章都是这一类 —— 只放一个主体，越小越好看。",
    hint: "蘑菇 / 字母 A / 一只小猫头像",
    items: [
      {
        id: "icon-basic",
        needsSubject: true,
        fit: "通用起步：随便什么东西想做成小挂件，都从这条开始。",
        text: build({
          subject: (s) => `${s}，只画这一个主体，居中，正面略微四分之三视角，轮廓干净好辨认，深色粗描边，只在一侧用两档明暗。`,
          colors: "最多用 8 到 10 种颜色",
        }),
        note: "只放一个主体。塞两三个东西进去，每个都会小到只剩几颗豆。",
      },
      {
        id: "icon-letter",
        needsSubject: true,
        fit: "字母、数字、小招牌 —— 名字牌、门牌、桌牌。",
        text: build({
          subject: (s) => `${s}，只画这一个字符，居中，用方块几何结构拼出字形，笔画粗细一致，转角是直角，单色平涂。`,
          colors: "最多用 4 种颜色",
          extra: "不要发光、不要投影，字形保持左右对称。",
        }),
        note: "一定要保留「只画这一个字符」。写成单词时模型会排成一整行，字宽和行距都不稳。",
      },
      {
        id: "icon-upgrade",
        needsSubject: false,
        fit: "手上已经有一张像素画，但格子大小不一、边缘发糊、颜色太多 —— 要配参考图用。",
        text: build({
          subject: () =>
            "我上传的这张像素画 —— 这条务必使用上面 ① 的方式，以我传的图为准，不要重画主体、不要改变内容和构图。把它重新整理成规整的像素画：统一所有像素格的大小、让它们严格对齐到同一个网格、消除大小不一和错位的像素，把所有发糊的边缘改成硬边直角锯齿，面积很小的杂色合并进邻近的主色。",
          colors: "把颜色数量压缩到 16 种以内",
        }),
        note: "这条是给「AI 直出的像素画不够规整」用的：先整理干净，再传进来转换效果最好。",
      },
    ],
  },
  {
    id: "character",
    label: "人物 · 立绘",
    blurb: "全身或半身人像。正面、描边清楚、色块分明的立绘，转出来最像原图。",
    hint: "穿黄卫衣的短发女孩 / 某个游戏角色名",
    items: [
      {
        id: "char-full",
        needsSubject: true,
        fit: "全身立绘：角色、自画像、cos 照、游戏人物。",
        text: build({
          subject: (s) => `${s}，全身正面站姿，双脚分开站立，手臂与身体之间留出空隙，轮廓清楚，整圈有统一的深色描边，平涂上色、每个颜色只用两档明暗。`,
          colors: "用 16 到 20 种颜色",
        }),
        note: "「手臂与身体之间留出空隙」很重要：手贴身时手臂会和躯干融成一整块，缩小后结构就没了。",
      },
      {
        id: "char-bust",
        needsSubject: true,
        fit: "头像 / 半身：64 格以内的徽章、杯垫。",
        text: build({
          subject: (s) => `${s}，只画头和肩膀，正面，构图左右对称，眼睛要大并且每只眼睛只用一颗白色高光像素，头发、皮肤、衣服各用一组分明的色块，深色粗描边。`,
          colors: "最多用 14 种颜色",
        }),
        note: "「每只眼睛只用一颗白色高光像素」能让眼睛活下来 —— 眼睛是缩小后最先糊掉的特征。",
      },
    ],
  },
  {
    id: "animal",
    label: "宠物 · 动物",
    blurb: "猫狗、鸟、鱼。动物比人宽容，只要轮廓干净，几乎都能拼出来。",
    hint: "一只柴犬 / 橘猫的圆脸",
    items: [
      {
        id: "pet",
        needsSubject: true,
        fit: "猫狗这类宠物的全身或头像，想做纪念款时用 —— 配一张宠物照片效果更好。",
        text: build({
          subject: (s) =>
            `${s}，正面，对称坐着，剪影粗壮好辨认；毛发不要一根根画，而是简化成几大块平涂色块，形状圆润友好，深色粗描边，不要任何毛绒质感。（如果你另外传了宠物照片，就照照片里的那只画，颜色跟着照片）`,
          colors: "用 8 到 14 种颜色，颜色取自它真实的毛色",
        }),
        note: "「不要一根根画毛」是宠物图失败的头号原因：一根根毛会变成几百个碎像素，引擎只能合并成一片糊面。",
      },
      {
        id: "animal-face",
        needsSubject: true,
        fit: "动物小图标、表情包风格的圆脸。",
        text: build({
          subject: (s) => `${s}，正中构图，正面，左右对称，眼睛又大又简单，鼻子很小，细节尽量少，黑色描边，不要阴影。`,
          colors: "最多用 6 种颜色",
        }),
      },
    ],
  },
  {
    id: "game",
    label: "游戏 · 动漫角色",
    blurb:
      "精灵、怪物、道具、致敬经典 8-bit 的角色。说个名字就行，不用描述长相。",
    hint: "手持木剑的勇者 / 三眼紫色史莱姆",
    items: [
      {
        id: "game-sprite",
        needsSubject: true,
        fit: "经典游戏精灵：RPG 小怪、勇者、宝箱、药水。",
        text: build({
          subject: (s) => `${s}，复古电子游戏精灵图，NES 时代的 8-bit 风格，正面，单帧静止姿势，严格对齐网格，像素块粗大，黑色粗描边。`,
          colors: "用 8 到 12 种饱和度较高的颜色",
        }),
        note: "「单帧静止姿势」能避免模型画成多帧拼一张的 sprite sheet，那种图没法直接进引擎。",
      },
      {
        id: "game-monster",
        needsSubject: true,
        fit: "怪物、龙、机甲这类形状复杂的角色。",
        text: build({
          subject: (s) => `${s}，正面，居中，剪影粗壮好辨认，把复杂结构简化成几大块形状，深色粗描边，只用两档平涂明暗。`,
          colors: "用 14 种颜色",
          extra: "不要发光、不要粒子特效。",
        }),
      },
    ],
  },
  {
    id: "object",
    label: "物件 · 招牌",
    blurb: "食物、植物、文具、自己的 logo。形状简单，成品率最高。",
    hint: "冒热气的咖啡杯 / 一片叶子",
    items: [
      {
        id: "object-item",
        needsSubject: true,
        fit: "单件物品：一杯咖啡、一片叶子、一台游戏机。",
        text: build({
          subject: (s) => `${s}，只画这一个物体，居中，正面略微四分之三视角，轮廓干净好辨认，大块平涂颜色，深色粗描边，只在一侧用两档明暗。`,
          colors: "最多用 8 种颜色",
        }),
      },
      {
        id: "object-logo",
        needsSubject: false,
        fit: "把已有 logo / 图标转成拼豆版 —— 这条必须真的把图传上去。",
        text: build({
          subject: () =>
            "我上传的那张 logo —— 这条务必使用上面 ① 的方式，以图为准：只保留它的轮廓特征和主色，不要改成别的形状，也不要添加新元素；去掉所有细节、渐变和细线，笔画加粗到至少一格宽，整体对齐到严格网格，居中放在画面里。",
          colors: "最多用 10 种颜色",
        }),
        note: "纯用嘴描述做 logo 基本不可控，这条一定要配参考图。",
      },
    ],
  },
  {
    id: "scene",
    label: "多主体 · 场景",
    blurb: "合影、小场景、一整幅画。人越多每个人越小，格数要开大。",
    hint: "坐在窗边看书的女孩 / 三个人并排的合影",
    items: [
      {
        id: "scene-single",
        needsSubject: true,
        fit: "一个人 / 一个主体，但带背景场景（窗边、房间、街角）。",
        text: build({
          subject: (s) => `${s}，保持各个主体的相对位置和大小关系，不要删掉主体也不要增加新的主体；把背景里杂乱的细节合并成几大块纯色，只保留能认出场景的轮廓。`,
          colors: "最多用 20 种颜色",
        }),
        note: "场景图要的格数比单个主体大得多：52 格以内做单个主体，场景建议 96 格以上。",
      },
      {
        id: "scene-group",
        needsSubject: true,
        fit: "多人合影、全家福、团队照。",
        text: build({
          subject: (s) => `${s}，每个人都要完整可辨认，人与人之间留出空隙不要粘连，每个人的衣服和皮肤各用分明的色块，整圈有统一的深色描边。`,
          colors: "用 16 到 24 种颜色",
        }),
        note: "三到四个人是 96 格的上限，再多就只剩色块了。",
      },
    ],
  },
];

/** 通用负面词。有 negative prompt 输入框就一起粘进去，效果更稳。 */
const NEGATIVE =
  "模糊、柔化、平滑过渡、渐变、柔和阴影、发光、投影、照片写实、3D 渲染、JPEG 压缩噪点、细碎纹理、细线条、文字、水印、签名、抖动噪点（dithering）、多余的肢体、变形";

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

function CopyButton({
  text,
  id,
  locked,
}: {
  text: string;
  id: string;
  /** 还没填主体词时为 true：禁用并说明原因。 */
  locked?: boolean;
}) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (locked) return;
    let next: "done" | "fail" = "done";
    try {
      /* clipboard API 在非 https、无用户手势、或 iframe 里会被拒，必须有兜底。 */
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
    } catch {
      next = "fail";
    }
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  }, [text, locked]);

  /*
   * 没填主体时按钮是**禁用**的，不是"复制了但不提示"。
   *
   * 用户 m09327 的坑：正文里带示例词时，用户直接复制发出去，豆包就画了那个
   * 示例。禁用比警告有效 —— 警告是一次性的弹条，用户滑过去就忘了；按钮
   * 按不动是每次都要面对的硬墙，而且标签直接写着该怎么办。
   */
  if (locked) {
    return (
      <span
        className="shrink-0 border-2 border-dashed border-[var(--line)] px-2 py-1 font-px text-[10px] leading-none text-[var(--ink-3)]"
        title="先在上面写「要画什么」，这段提示词里那个位置需要你的内容"
      >
        先写要画什么
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`复制提示词 ${id}`}
      className={cn(
        "shrink-0 border-2 px-2 py-1 font-px text-[10px] leading-none transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--clay)]",
        state === "done"
          ? "border-[var(--leaf)] bg-[var(--leaf-soft)] text-[var(--leaf-deep)]"
          : state === "fail"
            ? "border-[var(--bloom)] bg-[var(--bloom-soft)] text-[var(--bloom)]"
            : "border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink-2)] hover:bg-[var(--paper-sunken)] hover:text-[var(--ink)]",
      )}
    >
      {state === "done" ? "已复制" : state === "fail" ? "复制失败" : "复制"}
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
 * 把提示词里的 `【…】` 渲染成麦黄高亮块。
 *
 * 用户原话：「要用户自己描述填写的部分要有重点强调，不然用户看不见」。
 * 用 `<mark>` 而不是加粗：整段正文已经是等宽小字，只加粗在密集中文里不够跳，
 * 底色对比才让人能一眼扫到「哦这里是我要改的」。
 *
 * 用 `split` 保留捕获组 —— 正则里带了括号，分隔符本身也会留在数组里。
 */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(【[^】]*】)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith("【") && p.endsWith("】") ? (
          <mark
            key={i}
            className="bg-[var(--gold-soft)] px-[3px] font-bold text-[var(--gold-deep)]"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/**
 * 提示词正文块：左侧一道硬边，`【】` 高亮。
 *
 * 这里**故意用等宽系统字体而不是 --font-pixel**：Silkscreen 只有大写字形，整句
 * 渲染成全大写后基本没法校对 —— 中文没有大小写，但混在里面的 no anti-aliasing
 * 会被写成 NO ANTI-ALIASING，反而更费劲。像素字体留给短标签。
 */
function PromptBlock({ text, accent }: { text: string; accent: string }) {
  return (
    <pre
      className={cn(
        "mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-l-2 bg-[var(--paper-raised)]",
        "px-2 py-1.5 text-[11px] leading-[1.6] text-[var(--ink)]",
        /* 不能用 font-mono：globals.css 把 --font-mono 指到了 --font-pixel（Silkscreen），
           那套字体只有大写字形，整段提示词会被渲染成全大写，无法校对。 */
        'font-[ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace]',
        accent,
      )}
    >
      <Highlighted text={text} />
    </pre>
  );
}

export function MascotPromptPopover({
  open,
  onOpenChange,
  brand,
}: MascotPromptPopoverProps) {
  const [activeGroup, setActiveGroup] = useState(GROUPS[0].id);
  /**
   * 用户填的主体词。**所有分组共享同一个值** —— 他换页签只是在换"画多大、
   * 什么构图"，要画的东西没变；每切一次就清空会让人白写。
   */
  const [subject, setSubject] = useState("");
  const group = useMemo(
    () => GROUPS.find((g) => g.id === activeGroup) ?? GROUPS[0],
    [activeGroup],
  );

  const filled = subject.trim().length > 0;

  const paletteNote = brand
    ? `${brand} 色卡共 ${BRAND_COLORS[brand] ?? 291} 个色号可选，但一次转换通常只用到 8–20 个。`
    : "一次转换通常只用到 8–20 个色号。";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          /* sm: 前缀必须显式覆盖，否则 Dialog 基类的 sm:max-w-lg(512px) 会赢过无前缀的 max-w */
          "flex w-full flex-col gap-0",
          /*
           * 高度：桌面端封顶 760px 而不是撑满 88vh —— 1000px 高的视口里 88vh=880 会让弹窗
           * 顶到上下边缘、看着像全屏网页，而且把「这只是一张提示卡片」的分量感弄没了。
           * 移动端用 dvh（地址栏收放时可视高度会变，vh 会算多），并留 2rem 上下呼吸。
           * 头两块（标题栏、分组页签）是 shrink-0，只有正文滚动，所以滚到底一定看得全。
           */
          "max-h-[min(88vh,760px)]",
          "supports-[height:100dvh]:max-h-[min(760px,calc(100dvh-2rem))]",
          "max-w-[calc(100vw-1.5rem)] sm:max-w-[min(780px,calc(100vw-1.5rem))]",
          "rounded-none border-2 border-[var(--line-strong)] bg-[var(--paper-raised)] p-0",
          "shadow-[var(--shadow-px-lg)] duration-0 outline-none",
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
              先在框里写要画什么，再挑一条最接近的提示词整段复制走。
              发一张参考图、说一个角色名、或用一句话描述，三种都给得上。
            </DialogDescription>
          </div>
          <PixelClose onClose={() => onOpenChange(false)} />
        </div>

        {/* ───────────────── 分组页签 ───────────────── */}
        <div
          role="tablist"
          aria-label="提示词分类"
          className="shrink-0 border-b-2 border-[var(--line)] px-2 py-2"
        >
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
                    "border-2 px-2.5 py-1.5 text-[11px] leading-none transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--clay)]",
                    on
                      ? "border-[var(--line-strong)] bg-[var(--clay)] font-bold text-[var(--paper-hi)]"
                      : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
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
          <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
            {group.blurb}
          </p>

          {/*
            主体输入框。这是整个弹窗唯一的必填项 —— 用户 m09327 指出正文里
            放示例词会让豆包直接画那个示例，所以改成让他自己写一句。

            放在正文最上面、页签的正下方：他先看到「分成哪几类」，接着就是
            「要画什么」，然后才读条目。顺序反过来的话，用户会先读到一堆
            「【待填写】」，不知道要先填什么。
          */}
          <label
            className={cn(
              "mb-2.5 flex items-center gap-2 border-2 px-2 py-1.5",
              filled
                ? "border-[var(--line-strong)] bg-[var(--paper-raised)]"
                : "border-[var(--clay)] bg-[var(--clay-soft)]",
            )}
          >
            <span className="shrink-0 font-px text-[10px] leading-none text-[var(--ink-2)]">
              要画的是
            </span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={group.hint}
              maxLength={60}
              className="min-w-0 flex-1 bg-transparent px-0.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)]"
            />
            {filled ? (
              <button
                type="button"
                onClick={() => setSubject("")}
                aria-label="清空"
                className="shrink-0 px-1 font-px text-[10px] leading-none text-[var(--ink-3)] hover:text-[var(--clay)]"
              >
                清空
              </button>
            ) : null}
          </label>

          <p
            className={cn(
              "mb-2.5 border-l-2 px-2 py-1.5 text-[11px] leading-relaxed text-[var(--ink-2)]",
              filled
                ? "border-[var(--leaf)] bg-[var(--leaf-soft)]"
                : "border-[var(--gold)] bg-[var(--gold-soft)]",
            )}
          >
            {filled ? (
              <>
                下面的提示词已经带上你说的「
                <mark className="bg-[var(--paper-hi)] px-[3px] font-bold text-[var(--gold-deep)]">
                  {subject.trim()}
                </mark>
                」了 —— 挑一条最像你想要的，整段复制走，一个字都不用改。
              </>
            ) : (
              <>
                先在上面写一句
                <strong className="text-[var(--ink)]">要画什么</strong>
                ，下面的提示词里那个位置现在是{" "}
                <mark className="bg-[var(--paper-hi)] px-[3px] font-bold text-[var(--gold-deep)]">
                  【待填写】
                </mark>
                —— 没填就直接发，AI 会把「待填写」本身当成你要的东西。
              </>
            )}
          </p>

          <ul className="flex flex-col gap-2">
            {group.items.map((item) => {
              const text = item.text(subject);
              const locked = item.needsSubject && !filled;
              return (
              <li
                key={item.id}
                className="border-2 border-[var(--line)] bg-[var(--paper)] px-2.5 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11.5px] leading-relaxed text-[var(--ink-2)]">
                    {item.fit}
                  </p>
                  <CopyButton text={text} id={item.id} locked={locked} />
                </div>
                <PromptBlock text={text} accent="border-[var(--clay)]" />
                {item.note ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
                    <span aria-hidden className="mr-1 text-[var(--clay)]">
                      ↳
                    </span>
                    {item.note}
                  </p>
                ) : null}
              </li>
              );
            })}
          </ul>

          {/* ─────────── 一句话管理预期（不再展开成三段原理） ─────────── */}
          <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
            <span aria-hidden className="mr-1 text-[var(--leaf)]">
              ✔
            </span>
            背景纯色、格子清晰、色块大 → 最好拼。
            <span aria-hidden className="mx-1.5 text-[var(--bloom)]">
              ✘
            </span>
            照片直出、背景杂乱、大片渐变 → 也能转，但会丢掉不少东西。
            {paletteNote}
          </p>

          {/* ─────────── 负面词 ─────────── */}
          <section className="mt-2.5 border-2 border-[var(--line)] bg-[var(--paper)] px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11.5px] leading-relaxed text-[var(--ink-2)]">
                工具有负面词（negative
                prompt）框的话，把这段也粘进去，效果更稳：
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
