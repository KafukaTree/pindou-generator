'use client';

import quantize from 'quantize';

// Extract pixels from image data
export function extractPixels(imageData: ImageData): { r: number; g: number; b: number }[] {
  const pixels: { r: number; g: number; b: number }[] = [];
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    // Skip transparent pixels
    if (data[i + 3] < 128) continue;

    pixels.push({
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
    });
  }

  return pixels;
}

// Convert pixels to [r,g,b] arrays for quantize
export function pixelsToRgbArrays(
  pixels: { r: number; g: number; b: number }[]
): [number, number, number][] {
  return pixels.map(p => [p.r, p.g, p.b]);
}

// Convert quantize result to our format
export interface QuantizedColor {
  r: number;
  g: number;
  b: number;
  proportion: number;
}

export interface QuantizationResult {
  palette: QuantizedColor[];
  colorCounts: Map<string, number>;
  pixelLabels: Uint8Array; // Index into palette
}

export function quantizeColors(
  imageData: ImageData,
  numColors: number
): QuantizationResult {
  // Sample pixels (limit for performance)
  const maxSamples = 10000;
  const pixels = extractPixels(imageData);

  // Sample if too many pixels
  let sampledPixels: { r: number; g: number; b: number }[];
  if (pixels.length > maxSamples) {
    sampledPixels = [];
    const step = Math.floor(pixels.length / maxSamples);
    for (let i = 0; i < pixels.length; i += step) {
      sampledPixels.push(pixels[i]);
    }
  } else {
    sampledPixels = pixels;
  }

  const rgbArrays = pixelsToRgbArrays(sampledPixels);

  // Quantize
  const colorMap = quantize(rgbArrays, Math.min(numColors, rgbArrays.length));

  if (!colorMap) {
    return {
      palette: [],
      colorCounts: new Map(),
      pixelLabels: new Uint8Array(0),
    };
  }

  // Build palette
  const palette: QuantizedColor[] = colorMap.palette().map(([r, g, b]) => ({
    r,
    g,
    b,
    proportion: 0,
  }));

  // Count pixels for each color in original image
  const colorCounts = new Map<string, number>();
  const pixelLabels = new Uint8Array(pixels.length);

  for (let i = 0; i < pixels.length; i++) {
    const pixel = pixels[i];
    const nearestPixel = colorMap.nearest([pixel.r, pixel.g, pixel.b]);
    // Find the palette index that matches this pixel
    const label = palette.findIndex(
      (c) => c.r === nearestPixel[0] && c.g === nearestPixel[1] && c.b === nearestPixel[2]
    );
    if (label >= 0) {
      pixelLabels[i] = label;
      const hex = `${nearestPixel[0]},${nearestPixel[1]},${nearestPixel[2]}`;
      colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
    }
  }

  // Calculate proportions
  const total = pixels.length;
  for (const [hex, count] of colorCounts) {
    const idx = palette.findIndex(
      (c) => `${c.r},${c.g},${c.b}` === hex
    );
    if (idx >= 0) {
      palette[idx].proportion = count / total;
    }
  }

  return { palette, colorCounts, pixelLabels };
}

// Helper to convert RGB to hex
export function rgbToHexString(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('').toUpperCase();
}

// Get color statistics
export function getColorStats(
  imageData: ImageData
): { width: number; height: number; totalPixels: number } {
  return {
    width: imageData.width,
    height: imageData.height,
    totalPixels: imageData.data.length / 4,
  };
}
