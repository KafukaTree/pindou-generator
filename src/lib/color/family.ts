/**
 * 色卡分组：按色系
 * ===============================================================
 * 用户原话：
 *   「然后我觉得排布的话默认是那种经典的渐变颜色的色系顺序，什么赤橙
 *     黄绿那种，不然不好定位，再者才是，按照编号顺序，还要有几个常用
 *     （用过的）显示出来，就比较完美了」
 *
 * 这条需求背后的真实痛点是**定位**：291 个色号按 `A01 A02 A03…` 排，
 * 用户想找一个"稍微偏橙的黄色"必须在 A 组和 G 组之间来回翻——编号是
 * 印刷厂的分类逻辑，不是找色的逻辑。而色相是人的第一直觉。
 *
 * 所以这里做的事：把每个色按 **OKLab 色相角** 归到 12 个色系里，组内按
 * 明度从浅到深排 —— 摊开来看就是一条从红到玫红的环形渐变，每个色系内部
 * 是"同色相不同深浅"的竖直渐变。要找"偏橙的黄色"，找到黄那一列往下扫
 * 即可，不用记编号。
 *
 * 为什么用 OKLab 而不是 HSV/HSL：
 *   HSV 的色相在感知上极不均匀 —— 黄色占了整整 60°，而青色只有 20°，
 *   用 HSV 分组会把 20% 的色塞进"黄"里、把一大堆绿塞进"青"里。
 *   OKLab 的色相角是感知均匀的，30° 一段切下去各段视觉体量相当。
 *   全站所有距离计算（最近色、ΔE、混色判定）也都在 OKLab 里，同一套
 *   坐标不引入第二套"颜色观"。
 */

import type { BeadColor } from './palette';

/**
 * 一个色系。
 *
 * `label` 是中文名（界面语言中文优先），`hue` 是该组的中心色相角，
 * 只用于排序和调试时对得上号。
 */
export interface ColorFamily {
  /** 稳定 id，用于 React key 和折叠状态持久化 */
  id: string;
  /** 中文组名，显示在色卡分隔条上 */
  label: string;
  /** 代表色（该组最饱和的一颗），做分隔条上的小色点 */
  swatch: string;
  colors: BeadColor[];
}

/**
 * 12 个色系，从红起、绕一圈到玫红。
 *
 * 边界取 `[30i - 15, 30i + 15)`，i = 0…11 —— 也就是每个色系以 30° 的整数倍
 * 为中心、左右各 15°。这样切的好处是**红正好被 0° 边界对半分**：纯红
 * （H≈0）落在第一组正中，而不是被切成"0° 属于橙、359° 属于红"两半。
 *
 * 命名按中文里最顺口的叫法，不用"橙黄/黄橙"这种渐变色卡术语：
 * 用户说的是"赤橙黄绿"，那就红橙黄绿青蓝紫一路排下去，中间插进
 * 黄绿/青绿/天蓝/蓝紫/玫红几个过渡带（OKLab 里它们确实是独立的感知色域，
 * 合进邻组会让"找色"变难）。
 */
const FAMILIES: { id: string; label: string; center: number }[] = [
  { id: 'red', label: '红', center: 0 },
  { id: 'orange', label: '橙', center: 30 },
  { id: 'yellow', label: '黄', center: 60 },
  { id: 'yellow-green', label: '黄绿', center: 90 },
  { id: 'green', label: '绿', center: 120 },
  { id: 'spring', label: '青绿', center: 150 },
  { id: 'cyan', label: '青', center: 180 },
  { id: 'azure', label: '天蓝', center: 210 },
  { id: 'blue', label: '蓝', center: 240 },
  { id: 'indigo', label: '蓝紫', center: 270 },
  { id: 'violet', label: '紫', center: 300 },
  { id: 'magenta', label: '玫红', center: 330 },
];

/**
 * 无彩色阈值（OKLab 彩度）。
 *
 * 0.022 以下视为"没有色相"。
 *
 * 这个值是逐档扫着色卡定出来的（见下表，数字是 OKLab 彩度）：
 *
 *   #FFFFFF 0.000  #EDEDED 0.000  #D9D9D9 0.000   ← 纯中性
 *   #FCF7F8 0.006  #F1EDED 0.004  #EEE9EA 0.006   ← 暖白/冷白
 *   #B0A9AC 0.009  #D8D5CE 0.010  #CFD7D3 0.010   ← 中性浅灰
 *   #CECDD5 0.011  #89858C 0.011  #757D78 0.012   ← 中性中灰
 *   #9A9D94 0.013  #48464E 0.014  #949FA3 0.014   ← 中性深灰
 *   #E3E1EE 0.018  #FFF5ED 0.015                  ← 还读作白/灰
 *   ─────────────── 0.022 分界 ───────────────
 *   #BCC6B8 0.022  #D8C7D1 0.023                  ← 开始看得出偏绿/偏紫
 *   #B4A497 0.026  #C5B2BC 0.026                  ← 明显灰棕 / 灰紫
 *
 * 所以 0.022 正好切在"看得出色偏"的门槛上。
 *
 * 试过 0.045：`#BEDDFF`（浅蓝）`#F2D9BA`（米色）都被吸进灰组，灰组变成
 * 一锅杂色。试过 0.06 / 0.08 更糟。试过 0.012：太紧，`#E3E1EE`
 * `#FFF5ED` 这种明显是白/灰的色被推进了紫组和红组。
 *
 * 也考虑过用"相对饱和度"（C / 该明度下 sRGB 色域边界），因为浅色的
 * 色域边界很窄、同一个 C 在深色里可能不显眼 —— 但实测下来，浅色区
 * 相对饱和度反而失真更厉害：`#FDFBFF`（几乎纯白）的相对饱和度是 1.00，
 * 会被判成"极鲜艳"。固定阈值在这个色卡上更稳。
 */
const ACHROMATIC_CHROMA = 0.022;

/**
 * 无彩色内部再分三档：白 / 灰 / 黑。
 *
 * 不直接按明度排成一个长条，是因为"白、灰、黑"在找色时的语义完全不同：
 * 找白是找"最亮的那个"（做高光、眼睛），找灰是找"中性过渡"，找黑是找
 * "轮廓"。三档分开，每档内部按明度排，扫一眼就到位。
 *
 * 分界 0.88 / 0.28（按色卡实际分布定的）：
 *   · 0.88 以上：`#FFFFFF`(1.000) `#FDFBFF`(0.991) `#F1EDED`(0.949)
 *     `#EDEDED`(0.946) `#D9D9D9`(0.885) —— 最后这颗仍读作白（浅灰白），
 *     一颗白豆的明度落在 0.88–1.00 是合理的；
 *   · 0.88–0.28：`#B0A9AC`(0.742) `#89858C`(0.622) `#757D78`(0.581)
 *     `#55514C`(0.437) `#2F2B2F`(0.295) —— 中性灰的完整跨度；
 *   · 0.28 以下：`#1D1414`(0.203) `#000000`(0.000) —— 屏幕上读作黑。
 *
 * 原来的 0.90/0.35 把 `#D9D9D9` 和 `#2F2B2F` 分错了边（前者进灰、后者进灰
 * 但其实已经读作黑），实测时灰组第一颗是米色、黑组第一颗是墨蓝，很困惑。
 */
const WHITE_MIN_L = 0.88;
const BLACK_MAX_L = 0.28;

/** 把 0–360 的色相角落到 `[30i - 15, 30i + 15)` 里的那一组 */
function familyIndexOf(hue: number): number {
  // +345 等价于 -15，让红居中
  const shifted = (hue + 345) % 360;
  return Math.floor(shifted / 30);
}

/**
 * 把品牌色卡拆成「常用 → 白 → 灰 → 黑 → 12 个色系」。
 *
 * `favorites` 是调用方传入的"最近用过的色号"列表（按使用时间倒序）。
 * 它出现在最前面是有意的：改一张已经画了一半的图，用户 90% 的时间在
 * 复用刚才用过的几个色，把它们钉在顶部等于省掉每次翻色卡的十几秒。
 *
 * @param colors  品牌色卡（`getBrandPalette` 的返回值）
 * @param favorites 最近用过的色号（按时间倒序，最多取前 18 个）
 */
export function groupByFamily(
  colors: BeadColor[],
  favorites: string[] = [],
): ColorFamily[] {
  const fam: ColorFamily[] = FAMILIES.map((f) => ({
    id: f.id,
    label: f.label,
    swatch: '',
    colors: [],
  }));
  const white: BeadColor[] = [];
  const gray: BeadColor[] = [];
  const black: BeadColor[] = [];

  for (const bead of colors) {
    const { L, a, b } = bead.lab;
    const chroma = Math.hypot(a, b);
    if (chroma <= ACHROMATIC_CHROMA) {
      if (L >= WHITE_MIN_L) white.push(bead);
      else if (L <= BLACK_MAX_L) black.push(bead);
      else gray.push(bead);
      continue;
    }
    let hue = (Math.atan2(b, a) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const idx = familyIndexOf(hue);
    (fam[idx] ?? fam[0]).colors.push(bead);
  }

  /*
   * 组内排序：明度降序（浅 → 深）。
   *
   * 同色相下明度单调，视觉上就是一列干净的渐变。同明度再按彩度降序，
   * 让"艳的那个"排在"灰的那个"前面 —— 拼豆实际选色时更常用饱和色。
   */
  const byLight = (x: BeadColor, y: BeadColor) =>
    y.lab.L - x.lab.L || Math.hypot(y.lab.a, y.lab.b) - Math.hypot(x.lab.a, x.lab.b);
  for (const f of fam) f.colors.sort(byLight);
  white.sort(byLight);
  gray.sort(byLight);
  black.sort(byLight);

  /*
   * 分隔条上的小色点取该组"最饱和的一颗"。
   *
   * 不取平均值：平均值在色相上会被两端的色拉向中间、明度也被中和，
   * 结果是一排看起来都差不多的灰点，失去"这一组是什么色"的指示作用。
   * 最饱和的那颗才是这一组的身份。
   */
  const markOf = (list: BeadColor[]) => {
    let best = list[0];
    let bestC = -1;
    for (const bead of list) {
      const c = Math.hypot(bead.lab.a, bead.lab.b);
      if (c > bestC) {
        bestC = c;
        best = bead;
      }
    }
    return best?.hex ?? '';
  };

  /*
   * 白/灰/黑三组不能用"最饱和"当代表色 —— 它们的彩度本来就接近 0，
   * 挑出来的是组里唯一带点色偏的那颗（实测：白组代表色成了 `#FAF4C8`
   * 米黄、灰组成了 `#A58767` 棕、黑组成了 `#1C334D` 墨蓝），
   * 分隔条上的小色点看起来完全不像"白/灰/黑"。
   *
   * 这三组的身份就是明度本身：白组取最浅那颗、黑组取最深那颗、
   * 灰组取中点那颗。
   */
  const byLightnessEnd = (list: BeadColor[], end: 'light' | 'dark' | 'mid') => {
    if (list.length === 0) return '';
    const sorted = [...list].sort((x, y) => y.lab.L - x.lab.L);
    if (end === 'light') return sorted[0].hex;
    if (end === 'dark') return sorted[sorted.length - 1].hex;
    return sorted[Math.floor(sorted.length / 2)].hex;
  };

  const out: ColorFamily[] = [];

  /* 常用：只保留仍在当前品牌色卡里存在的色号（换品牌后旧色号会失效） */
  if (favorites.length > 0) {
    const byCode = new Map(colors.map((b) => [b.code, b]));
    const used = favorites
      .map((code) => byCode.get(code))
      .filter((b): b is BeadColor => Boolean(b))
      .slice(0, 18);
    if (used.length > 0) {
      out.push({
        id: 'recent',
        label: '常用',
        swatch: used[0].hex,
        /* 常用组不重排 —— 按使用时间倒序本身就是它的意义 */
        colors: used,
      });
    }
  }

  const achromatic: { id: string; label: string; list: BeadColor[] }[] = [
    { id: 'white', label: '白', list: white },
    { id: 'gray', label: '灰', list: gray },
    { id: 'black', label: '黑', list: black },
  ];
  for (const group of achromatic) {
    if (group.list.length === 0) continue;
    out.push({
      id: group.id,
      label: group.label,
      swatch: byLightnessEnd(
        group.list,
        group.id === 'white' ? 'light' : group.id === 'black' ? 'dark' : 'mid',
      ),
      colors: group.list,
    });
  }

  for (const f of fam) {
    if (f.colors.length === 0) continue;
    out.push({ ...f, swatch: markOf(f.colors) });
  }

  return out;
}

/**
 * 按色号排序（原来的分组方式）。
 *
 * 保留它是因为两种排法各有各的场景：
 *   · 色系 = 找色（"我要一个偏橙的黄"）
 *   · 色号 = 补货（"图纸上写 F19，我手里 F19 不够了，找 F18/F20 替代"，
 *     或者照着别人的成品图逐个对货号）
 * 用户的诉求是"默认色系、再者才是编号顺序"，所以这是个切换而不是替换。
 *
 * 分组前缀取色号的字母段（`A05` → `A`，`YX11` → `YX`），和改造前的
 * 逻辑一致 —— 那套前缀本来就是印厂的分色族，有它的道理。
 */
export function groupByCode(colors: BeadColor[]): ColorFamily[] {
  const groups: ColorFamily[] = [];
  for (const bead of colors) {
    const match = /^[A-Z]+/.exec(bead.code);
    const prefix = match ? match[0] : '#';
    const last = groups[groups.length - 1];
    if (last && last.id === prefix) last.colors.push(bead);
    else groups.push({ id: prefix, label: prefix, swatch: bead.hex, colors: [bead] });
  }
  return groups;
}
