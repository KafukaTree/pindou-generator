import colorMapping from './colorMapping.json';

// Type definitions for color data
export interface ColorMapping {
  [hex: string]: {
    MARD: string;
    COCO: string;
    漫漫: string;
    盼盼: string;
    咪小窝: string;
  };
}

export interface BrandColors {
  MARD: Map<string, string>; // hex -> code
  COCO: Map<string, string>;
  漫漫: Map<string, string>;
  盼盼: Map<string, string>;
  咪小窝: Map<string, string>;
}

export type Brand = 'MARD' | 'COCO' | '漫漫' | '盼盼' | '咪小窝';

export const BRANDS: Brand[] = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'];

// Convert hex to RGB
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Convert RGB to hex
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// Build brand color maps for faster lookup
export function buildBrandColors(): BrandColors {
  const mapping = colorMapping as ColorMapping;

  return {
    MARD: new Map(Object.entries(mapping).map(([hex, brands]) => [hex.toUpperCase(), brands.MARD])),
    COCO: new Map(Object.entries(mapping).map(([hex, brands]) => [hex.toUpperCase(), brands.COCO])),
    漫漫: new Map(Object.entries(mapping).map(([hex, brands]) => [hex.toUpperCase(), brands.漫漫])),
    盼盼: new Map(Object.entries(mapping).map(([hex, brands]) => [hex.toUpperCase(), brands.盼盼])),
    咪小窝: new Map(Object.entries(mapping).map(([hex, brands]) => [hex.toUpperCase(), brands.咪小窝])),
  };
}

// Calculate Euclidean distance between two colors
export function colorDistance(
  rgb1: { r: number; g: number; b: number },
  rgb2: { r: number; g: number; b: number }
): number {
  return Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
    Math.pow(rgb1.g - rgb2.g, 2) +
    Math.pow(rgb1.b - rgb2.b, 2)
  );
}

// Find the closest color from a brand palette
export function findClosestColor(
  targetRgb: { r: number; g: number; b: number },
  brandColors: Map<string, string>
): { hex: string; code: string; distance: number } {
  let closestHex = '';
  let closestCode = '';
  let minDistance = Infinity;

  for (const [hex, code] of brandColors) {
    const brandRgb = hexToRgb(hex);
    if (!brandRgb) continue;

    const distance = colorDistance(targetRgb, brandRgb);
    if (distance < minDistance) {
      minDistance = distance;
      closestHex = hex;
      closestCode = code;
    }
  }

  return { hex: closestHex, code: closestCode, distance: minDistance };
}

// Match a color to all brands
export function matchColorToAllBrands(
  targetRgb: { r: number; g: number; b: number },
  brandColors: BrandColors
): Record<Brand, { hex: string; code: string; distance: number }> {
  const result: Record<Brand, { hex: string; code: string; distance: number }> = {} as Record<Brand, { hex: string; code: string; distance: number }>;

  for (const brand of BRANDS) {
    const match = findClosestColor(targetRgb, brandColors[brand]);
    result[brand] = match;
  }

  return result;
}

// Get all available colors for a brand
export function getAllColorsForBrand(brand: Brand): { hex: string; code: string }[] {
  const mapping = colorMapping as ColorMapping;
  return Object.entries(mapping).map(([hex, brands]) => ({
    hex: hex.toUpperCase(),
    code: brands[brand]
  }));
}

// Color mapping singleton instance
let cachedBrandColors: BrandColors | null = null;

export function getBrandColors(): BrandColors {
  if (!cachedBrandColors) {
    cachedBrandColors = buildBrandColors();
  }
  return cachedBrandColors;
}
