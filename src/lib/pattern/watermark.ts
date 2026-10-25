/**
 * AI 生成水印检测
 * ===============================================================
 * 输入是豆包 / 元宝 / 千问这类 AI 作图工具直出的图，右下角带一行
 * 半透明文字水印（「豆包 AI 生成」「元宝 AI 生成」，或一个图标 + 文字）。
 *
 * 用户明确要求：**只检测，不自动改图**。转了之后那个带水印的像素块
 * 用户自己用橡皮擦抹一下就行 —— 自动填背景反而会把好像素改坏。
 * 所以这里只返回"水印在哪、多大、像不像"，交给 UI 去提示。
 *
 * 曾经实现过 `clearWatermark()`（用周边背景中位色填充），用户看过之后
 * 明确说不要：「不加水印去除了吧，用户自己用橡皮去除也一样」。这个模块
 * 的职责就定格在**检测**，不提供任何改图像的函数。
 *
 * 判据（怎么把水印和"画面本来就有东西"分开）
 * ---------------------------------------------------------------
 * 走过的死路，别再走：
 *   - **整块角落找亮度偏离**：右下角 32%×32% 的区域里必然有角色身体
 *     或图案，偏离像素一大片，包围盒直接糊到整个角落，算出来的面积
 *     7 张图全都一样是 10.3%，被"面积 ≤ 6%"的规则一刀切掉。
 *     根因是判据本身没区分"水印"和"画面内容"。
 *   - **局部残差（L − boxmean(L)）**：水印笔画细（2–4px）残差确实大，
 *     但画面里的轮廓线、眼睛、花纹残差一样大，max/med 在 67–4107
 *     之间乱跳，没有阈值可用。
 *
 * 有效的是**"紧贴右下角的窄窗 + 行方向文字带"**：
 *   水印的排版特征是"几行字横着排"，按行聚合就会出现一段
 *   **连续的中等占比行**（每行 4%–85% 的像素偏离底色，且连续很长）。
 *   画面内容要么完全不碰这个极窄的角落（占比 0%），要么是整片实体色
 *   （占比 >85%），都不会形成这种"中等而连续"的带。
 *
 *   实测（窗口 20% 宽 × 14% 高，贴右下角）：
 *     7 张参考图 devFrac 8.4%–16.1%，连续带长 46–70 行 → 全部命中
 *     4 张照片   devFrac 0.0%，连续带长 0            → 全部拒绝
 *     照片的 16 种"内容顶到右下角"硬负例（各种裁切）也全是 0%
 *   → devFrac ≥ 5% 且 连续带 ≥ 8 行，两侧余量都很大。
 */

/** 检测到的水印区域 */
export interface WatermarkRegion {
  /** 包围盒（像素坐标，含端点） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 面积占全图比例 0–1（实测水印 0.4%–3.6%） */
  areaFrac: number;
  /** 与背景的亮度偏离方向：1 = 更亮，-1 = 更暗 */
  polarity: 1 | -1;
  /** 信度 0–1 */
  confidence: number;
}

export interface WatermarkResult {
  detected: boolean;
  /** 检测到的区域；detected=false 时为 null */
  region: WatermarkRegion | null;
  /** 窄窗内偏离底色的像素占比 0–1，实测水印 8.4%–16.1%、照片 0% */
  devFrac: number;
  /** 最长的一段"中等占比连续行"（行数），实测水印 46–70、照片 0 */
  bandRun: number;
  /** 没命中的原因，便于自检 */
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

/** 探测窗：贴右下角的 20% 宽 × 14% 高 */
const WIN_FRAC_X = 0.20;
const WIN_FRAC_Y = 0.14;
/** 偏离底色的判定阈值（sRGB 通道单位） */
const DEV_THRESHOLD = 10;
/** 行占比落在 (LOW, HIGH) 之间算"文字带行" */
const BAND_SHARE_LOW = 0.04;
const BAND_SHARE_HIGH = 0.85;
/** 门禁：偏离占比下限 / 连续带行数下限 */
const MIN_DEV_FRAC = 0.05;
const MIN_BAND_RUN = 8;

/*
 * 门禁：偏离占比的**上限**。
 *
 * 这条是补测出来的，原版只有下限，结果像素画全线误报。实测：
 *
 *   真水印（4 张 AI 直出图）  devFrac 8.4% / 8.5% / 10.6% / 12.1%
 *   无水印像素画（12 张）     devFrac 38.6% ~ 82.6%  → 全部被误判为有水印
 *
 * 误报的 12 张里有 8 张是自建的"右下角故意塞满色块"的硬负例，信度
 * 打出 1.0（满分），比真水印的 0.63–0.77 还高 —— 说明"更大的偏离面积"
 * 在原判据里是**加分项**，方向正好反了。
 *
 * 为什么会反：水印是一层薄字**压在同一片底色上**，偏离像素只能是少数；
 * 而右下角颜色杂乱说明那里是画面内容本身，不是压上去的一层字。所以
 * 偏离占比超过 25% 时，"底色"这个参照系根本没成立，整段统计无效。
 *
 * 25% 的位置：真水印最高 12.1%、误报最低 38.6%，取中间偏上留足余量。
 */
const MAX_DEV_FRAC = 0.25;

/**
 * 检测右下角水印。
 *
 * 返回 detected=false 时**什么都没发生** —— 检测不到就不动图。
 */
export function detectWatermark(img: ImageData): WatermarkResult {
  const { width: w, height: h, data } = img;
  if (w < 40 || h < 40) {
    return {
      detected: false,
      region: null,
      devFrac: 0,
      bandRun: 0,
      reason: 'tiny',
    };
  }

  const cw = Math.max(24, Math.round(w * WIN_FRAC_X));
  const ch = Math.max(24, Math.round(h * WIN_FRAC_Y));
  const wx = w - cw;
  const wy = h - ch;

  // 1) 窗口内的主色（水印是压在大量同色背景上的，主色就是那层背景）。
  //    5bit 分桶求众数，桶号 <<3 还原成该桶的左下角，足够当参照色。
  const counts = new Map<number, number>();
  for (let y = wy; y < h; y++) {
    for (let x = wx; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 16) continue;
      const key =
        ((data[o] >> 3) << 10) |
        ((data[o + 1] >> 3) << 5) |
        (data[o + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let plateKey = 0;
  let plateCount = 0;
  for (const [k, v] of counts) {
    if (v > plateCount) {
      plateCount = v;
      plateKey = k;
    }
  }
  if (!plateCount) {
    return {
      detected: false,
      region: null,
      devFrac: 0,
      bandRun: 0,
      reason: 'no-plate',
    };
  }
  const pr = ((plateKey >> 10) & 31) << 3;
  const pg = ((plateKey >> 5) & 31) << 3;
  const pb = (plateKey & 31) << 3;

  // 2) 逐像素判"偏离底色"，同时按行聚合
  const dev = new Uint8Array(cw * ch);
  let picked = 0;
  let sumSign = 0;
  let bx0 = w;
  let by0 = h;
  let bx1 = -1;
  let by1 = -1;
  for (let y = wy; y < h; y++) {
    for (let x = wx; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 16) continue;
      /*
       * 亮度 + 色度一起看：半透明白/黑蒙版只有亮度动、色相基本不变；
       * 而"画面里另一种颜色"通常色度也一起变。
       * 两个都超阈值才算偏离，能少捡进画面里同亮度的其他颜色。
       */
      const dL =
        0.2126 * (data[o] - pr) +
        0.7152 * (data[o + 1] - pg) +
        0.0722 * (data[o + 2] - pb);
      const da = data[o] - pr - (data[o + 1] - pg);
      const db = data[o + 1] - pg - (data[o + 2] - pb);
      const score = Math.max(
        Math.abs(dL),
        Math.abs(da) * 1.2,
        Math.abs(db) * 1.2,
      );
      if (score <= DEV_THRESHOLD) continue;
      dev[(y - wy) * cw + (x - wx)] = 1;
      picked++;
      sumSign += dL >= 0 ? 1 : -1;
      if (x < bx0) bx0 = x;
      if (y < by0) by0 = y;
      if (x > bx1) bx1 = x;
      if (y > by1) by1 = y;
    }
  }

  // 3) 行占比 → 最长"文字带"连续段
  let bandRun = 0;
  let run = 0;
  for (let y = 0; y < ch; y++) {
    let c = 0;
    for (let x = 0; x < cw; x++) c += dev[y * cw + x];
    const share = c / cw;
    if (share > BAND_SHARE_LOW && share < BAND_SHARE_HIGH) {
      run++;
      if (run > bandRun) bandRun = run;
    } else {
      run = 0;
    }
  }

  const devFrac = picked / (cw * ch);
  if (devFrac < MIN_DEV_FRAC || devFrac > MAX_DEV_FRAC || bandRun < MIN_BAND_RUN) {
    return {
      detected: false,
      region: null,
      devFrac,
      bandRun,
      reason:
        devFrac < MIN_DEV_FRAC
          ? `quiet(${(devFrac * 100).toFixed(1)}%)`
          : devFrac > MAX_DEV_FRAC
            ? `busy(${(devFrac * 100).toFixed(1)}%)`
            : `no-band(run ${bandRun})`,
    };
  }

  const areaFrac = ((bx1 - bx0 + 1) * (by1 - by0 + 1)) / (w * h);
  const polarity: 1 | -1 = sumSign >= 0 ? 1 : -1;
  // 信度：两个门禁各自的余量归一化后取平均
  const conf =
    0.5 * Math.min(1, (devFrac - MIN_DEV_FRAC) / (0.18 - MIN_DEV_FRAC)) +
    0.5 * Math.min(1, (bandRun - MIN_BAND_RUN) / (50 - MIN_BAND_RUN));

  return {
    detected: true,
    region: {
      x0: bx0,
      y0: by0,
      x1: bx1,
      y1: by1,
      areaFrac,
      polarity,
      confidence: Math.max(0, Math.min(1, conf)),
    },
    devFrac,
    bandRun,
  };
}
