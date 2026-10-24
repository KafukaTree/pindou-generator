/**
 * 拼豆色卡引擎
 * ---------------------------------------------------------------
 * 核心设计变更（相对原始实现）：
 *
 * 1. **图案颜色 = 真实豆子颜色**。原始实现先用 quantize 求任意 RGB 调色板，
 *    再用调色板颜色作画、却用"最接近的品牌色号"做标签 —— 屏幕上看到的
 *    颜色和要买的豆子颜色根本不是一个东西（实测 #FFC7DB vs #E8C8DC，
 *    色号 E18 实际是 #FFC7DB 而画面上是凭空生成的粉色）。
 *    现在直接在 291 色真实色卡里做最近邻，画面颜色、色号、实物三者一致。
 *
 * 2. **OKLab 最近邻**，而非 sRGB 欧氏距离。
 *
 * 3. **可选"品牌可用色"约束**：不同品牌色号覆盖不同，选色时只在该品牌
 *    真正拥有的色号里挑，避免给出买不到的色号。
 */

import rawMapping from '@/lib/colorMapping.json';
import {
  parseHex,
  rgbToHex,
  rgbToOklab,
  deltaE2,
  type Oklab,
  type Rgb,
} from './oklab';

export const BRANDS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'] as const;
export type Brand = (typeof BRANDS)[number];

export const BRAND_META: Record<Brand, { label: string; note: string }> = {
  MARD: { label: 'MARD', note: '国内拼豆主流品牌，色号 A/B/C… 体系' },
  COCO: { label: 'COCO', note: '常见补充品牌' },
  漫漫: { label: '漫漫', note: '色号多为数字与字母组合' },
  盼盼: { label: '盼盼', note: '色号以数字为主' },
  咪小窝: { label: '咪小窝', note: '色号以数字为主' },
};

type RawEntry = Record<'MARD' | 'COCO' | '漫漫' | '盼盼' | '咪小窝', string>;

/** 一种真实可购买的豆子 */
export interface BeadColor {
  /** 规范化 #RRGGBB */
  hex: string;
  rgb: Rgb;
  lab: Oklab;
  /** 该品牌的色号 */
  code: string;
  /** 在色卡里的稳定索引（用于 pattern 里存整数而非字符串） */
  index: number;
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

interface CardEntry {
  hex: string;
  rgb: Rgb;
  lab: Oklab;
  codes: RawEntry;
}

const CARD: CardEntry[] = (() => {
  const mapping = rawMapping as Record<string, RawEntry>;
  const entries: CardEntry[] = [];
  for (const [rawHex, codes] of Object.entries(mapping)) {
    const rgb = parseHex(rawHex);
    if (!rgb) continue;
    entries.push({
      hex: rgbToHex(rgb.r, rgb.g, rgb.b),
      rgb,
      lab: rgbToOklab(rgb.r, rgb.g, rgb.b),
      codes,
    });
  }
  // 按色号排序让索引稳定、可预测
  entries.sort((a, b) => {
    const ca = a.codes.MARD || '';
    const cb = b.codes.MARD || '';
    return ca.localeCompare(cb, 'en', { numeric: true });
  });
  return entries;
})();

/** 某品牌全部可用色（去重色号，同色号取色卡中第一个） */
function buildBrandPalette(brand: Brand): BeadColor[] {
  const seen = new Set<string>();
  const pal: BeadColor[] = [];
  CARD.forEach((entry, i) => {
    const code = entry.codes[brand];
    // 个别条目该品牌无对应色号（值为 '-' 或空），跳过以免生成买不到的色号
    if (!code || code === '-' || seen.has(code)) return;
    seen.add(code);
    pal.push({
      hex: entry.hex,
      rgb: entry.rgb,
      lab: entry.lab,
      code,
      index: i,
    });
  });
  return pal;
}

const brandPaletteCache = new Map<Brand, BeadColor[]>();

export function getBrandPalette(brand: Brand): BeadColor[] {
  let pal = brandPaletteCache.get(brand);
  if (!pal) {
    pal = buildBrandPalette(brand);
    brandPaletteCache.set(brand, pal);
  }
  return pal;
}

/** 全部色卡（五品牌合并的物理豆子集合），用于跨品牌对照 */
export function getAllBeads(): BeadColor[] {
  return CARD.map((e, i) => ({
    hex: e.hex,
    rgb: e.rgb,
    lab: e.lab,
    code: e.codes.MARD,
    index: i,
  }));
}

/** 某色卡条目在所有品牌下的色号 */
export function getCodesForHex(hex: string): Partial<Record<Brand, string>> {
  const rgb = parseHex(hex);
  if (!rgb) return {};
  const norm = rgbToHex(rgb.r, rgb.g, rgb.b);
  const entry = CARD.find((e) => e.hex === norm);
  return entry ? { ...entry.codes } : {};
}

// ---------------------------------------------------------------------------
// 最近邻
// ---------------------------------------------------------------------------

/**
 * 在给定色卡中找感知最近的颜色。
 * 291 色线性扫描 × 每格一次 = 50×50 网格 725 次距离计算，
 * 完全可接受；若将来上到 200×200 再考虑 kd-tree。
 */
export function nearestBead(
  lab: Oklab,
  palette: BeadColor[],
): { bead: BeadColor; dist2: number } {
  let best = palette[0];
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = deltaE2(lab, palette[i].lab);
    if (d < bestD) {
      bestD = d;
      best = palette[i];
    }
  }
  return { bead: best, dist2: bestD };
}

/** 直接按 RGB 找最近的品牌豆子 */
export function nearestBeadForRgb(rgb: Rgb, brand: Brand): BeadColor {
  const pal = getBrandPalette(brand);
  return nearestBead(rgbToOklab(rgb.r, rgb.g, rgb.b), pal).bead;
}

// ---------------------------------------------------------------------------
// 差异说明
// ---------------------------------------------------------------------------

/** 把色差翻译成人话，供 UI 提示"这个颜色还原得不太准" */
export function describeColorGap(dist2: number): {
  level: 'exact' | 'close' | 'loose' | 'poor';
  label: string;
} {
  // dist2 是 OKLab 距离平方；经验阈值
  if (dist2 < 0.0004) return { level: 'exact', label: '高度还原' };
  if (dist2 < 0.0018) return { level: 'close', label: '接近' };
  if (dist2 < 0.006) return { level: 'loose', label: '略有偏差' };
  return { level: 'poor', label: '偏差较大' };
}
