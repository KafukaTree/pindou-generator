/**
 * OKLab 感知色彩空间
 * ---------------------------------------------------------------
 * 为什么不用 RGB 欧氏距离：sRGB 空间的距离与人眼感知严重不符
 * （绿色通道权重过高，暗部差异被放大）。拼接图案时这会让
 * "看起来完全不同的颜色被判为相近"，出现脏色带。
 *
 * OKLab 是 Björn Ottosson 提出的感知均匀空间，直接用欧氏距离
 * 近似 ΔE，代价极低（几次乘法），非常适合逐像素匹配 291 色色卡。
 */

export type Rgb = { r: number; g: number; b: number };
export type Oklab = { L: number; a: number; b: number };

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** sRGB 分量 (0-255) → 线性光 (0-1) */
export function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** 线性光 (0-1) → sRGB 分量 (0-255) */
export function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp255(s * 255);
}

/** 解析 #RRGGBB（容忍省略 #、大小写、3 位缩写） */
export function parseHex(hex: string): Rgb | null {
  if (!hex) return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * RGB → #RRGGBB
 * 关键修复：原始实现没有钳制范围，quantize 库会输出 256 这类越界值，
 * 导致产出 `#100C8DC`（7 位、非法 CSS 颜色）让整个色块变透明。
 * 这里强制钳制并补齐两位。
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (v: number) => {
    const clamped = clamp255(Number.isFinite(v) ? v : 0);
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

/** RGB(0-255) → OKLab */
export function rgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** OKLab → RGB(0-255)，用于抖动误差反算 */
export function oklabToRgb(lab: Oklab): Rgb {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: linearToSrgb(lr),
    g: linearToSrgb(lg),
    b: linearToSrgb(lb),
  };
}

/**
 * 感知色差平方（ΔE_OK²）
 * 对亮度差异略加权：拼豆成品在环境光下，明度错配比色相错配更刺眼。
 */
export function deltaE2(x: Oklab, y: Oklab): number {
  const dL = (x.L - y.L) * 1.15;
  const da = x.a - y.a;
  const db = x.b - y.b;
  return dL * dL + da * da + db * db;
}

export function deltaE(x: Oklab, y: Oklab): number {
  return Math.sqrt(deltaE2(x, y));
}

/** 预乘 alpha 的合成（保留给背景混合用） */
export function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** 线性光下的相对亮度（用于自动选择黑/白标签色） */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) +
    0.7152 * srgbToLinear(rgb.g) +
    0.0722 * srgbToLinear(rgb.b)
  );
}

/** WCAG 对比度 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 给豆子上的色号选最清晰的字色。
 * 原始实现用 (0.299R+0.587G+0.114B)/255 > 0.5 这种伽马空间近似，
 * 在中灰和饱和色块上会选错边。这里用真实对比度比较。
 */
export function readableInkFor(rgb: Rgb): '#231A11' | '#FFFDF6' {
  const dark = contrastRatio(rgb, { r: 0x23, g: 0x1a, b: 0x11 });
  const light = contrastRatio(rgb, { r: 0xff, g: 0xfd, b: 0xf6 });
  // 对比度接近时倾向深色字，避免亮底白字发虚
  return dark >= light * 0.92 ? '#231A11' : '#FFFDF6';
}
