'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Toaster, toast } from 'sonner';
import { FileUpload } from '@/components/image-upload/FileUpload';
// import { AIGeneration } from '@/components/ai-generation/AIGeneration';
import { ColorQuantization } from '@/components/ColorQuantization';
import { PatternCanvas, GridSizeSelector } from '@/components/pattern-rendering/PatternCanvas';
import { BrandSelector } from '@/components/pattern-rendering/BrandSelector';
import { PDFExport } from '@/components/pdf-export/PDFExport';
import { HistoryList } from '@/components/history/HistoryList';
import { ColorPalette, ColorLegend } from '@/components/ColorPalette';
import { Brand, getBrandColors, matchColorToAllBrands, BRANDS } from '@/lib/colors';
import { quantizeColors, rgbToHexString } from '@/lib/quantization';
import { useHistory, PatternHistoryItem } from '@/hooks/useHistory';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface QuantizedColor {
  hex: string;
  rgb: { r: number; g: number; b: number };
  code: string;
}

interface PatternCell {
  hex: string;
  brandCode: string;
}

export default function Home() {
  // Image state
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [aspectRatio, setAspectRatio] = useState<number>(1); // width / height

  // Settings state (pending values before Apply)
  const [gridSize, setGridSize] = useState(50);
  const [colorCount, setColorCount] = useState(16);
  const [brand, setBrand] = useState<Brand>('MARD');
  // Applied settings state (committed values)
  const [appliedGridSize, setAppliedGridSize] = useState(50);
  const [appliedColorCount, setAppliedColorCount] = useState(16);
  const [appliedBrand, setAppliedBrand] = useState<Brand>('MARD');
  const settingsChangedRef = useRef(false);

  // Check if settings have changed
  const hasPendingChanges = gridSize !== appliedGridSize ||
                            colorCount !== appliedColorCount ||
                            brand !== appliedBrand;

  // Quantized colors
  const [quantizedColors, setQuantizedColors] = useState<QuantizedColor[]>([]);

  // Pattern data
  const [pattern, setPattern] = useState<PatternCell[][]>([]);

  // History
  const { history, isLoaded, addToHistory } = useHistory();

  // Process image when it's loaded
  const handleFileSelect = useCallback((file: File, previewUrl: string) => {
    setImageUrl(previewUrl);
    loadImageData(previewUrl);
  }, []);

  const loadImageData = (url: string) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Pad image to square with white background
      const maxSize = Math.min(500, Math.max(img.width, img.height));
      canvas.width = maxSize;
      canvas.height = maxSize;

      // Fill with white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, maxSize, maxSize);

      // Calculate scaling to fit image in center
      const scale = Math.min(maxSize / img.width, maxSize / img.height);
      const scaledWidth = img.width * scale;
      const scaledHeight = img.height * scale;
      const offsetX = (maxSize - scaledWidth) / 2;
      const offsetY = (maxSize - scaledHeight) / 2;

      // Draw image centered
      ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

      const data = ctx.getImageData(0, 0, maxSize, maxSize);
      setImageData(data);

      // Auto-quantize with default settings
      setTimeout(() => {
        quantizeAndGenerate(data);
      }, 100);
    };
    img.src = url;
  };

  // Generate pattern grid
  const generatePattern = useCallback((
    data: ImageData,
    quantizationResult: { palette: { r: number; g: number; b: number }[] },
    selectedBrand: Brand,
    size: number
  ) => {
    const brandColors = getBrandColors();
    const result = quantizationResult;
    const currentGridSize = size;

    // Create a map of palette colors for matching
    const paletteColors = result.palette.map((color) => ({
      rgb: { r: color.r, g: color.g, b: color.b },
      hex: rgbToHexString(color.r, color.g, color.b),
    }));

    // Helper to find closest palette color
    const findClosestPaletteColor = (pixelRgb: { r: number; g: number; b: number }) => {
      let minDistance = Infinity;
      let closestColor = paletteColors[0];

      for (const paletteColor of paletteColors) {
        const dr = pixelRgb.r - paletteColor.rgb.r;
        const dg = pixelRgb.g - paletteColor.rgb.g;
        const db = pixelRgb.b - paletteColor.rgb.b;
        const distance = dr * dr + dg * dg + db * db;

        if (distance < minDistance) {
          minDistance = distance;
          closestColor = paletteColor;
        }
      }
      return closestColor;
    };

    const newPattern: PatternCell[][] = [];
    const { width, height } = data;

    for (let row = 0; row < currentGridSize; row++) {
      newPattern[row] = [];
      for (let col = 0; col < currentGridSize; col++) {
        // Map grid cell to image pixel
        const srcX = Math.floor((col / currentGridSize) * width);
        const srcY = Math.floor((row / currentGridSize) * height);
        const pixelIndex = (srcY * width + srcX) * 4;

        const pixelRgb = {
          r: data.data[pixelIndex],
          g: data.data[pixelIndex + 1],
          b: data.data[pixelIndex + 2],
        };

        // Find closest palette color (not raw pixel color)
        const closestPaletteColor = findClosestPaletteColor(pixelRgb);

        // Find closest brand color based on the palette color (not raw pixel)
        const match = matchColorToAllBrands(closestPaletteColor.rgb, brandColors);

        newPattern[row][col] = {
          hex: closestPaletteColor.hex,  // Use quantized palette color
          brandCode: match[selectedBrand]?.code || '—',
        };
      }
    }

    // Store pattern with dimensions
    setPattern(newPattern);

    // Update Used Colors based on the quantization palette and brand
    const updatedColors = result.palette.map((color) => {
      const hex = rgbToHexString(color.r, color.g, color.b);
      const match = matchColorToAllBrands({ r: color.r, g: color.g, b: color.b }, brandColors);
      return {
        hex,
        rgb: { r: color.r, g: color.g, b: color.b },
        code: match[selectedBrand]?.code || '—',
      };
    });
    setQuantizedColors(updatedColors);

    // Add to history
    if (imageUrl) {
      // Generate preview URL for history
      const previewCanvas = document.createElement('canvas');
      const previewCtx = previewCanvas.getContext('2d');
      if (previewCtx) {
        previewCanvas.width = 100;
        previewCanvas.height = 100;

        // Draw small preview using currentGridSize
        for (let row = 0; row < currentGridSize && row < 100; row++) {
          for (let col = 0; col < currentGridSize && col < 100; col++) {
            const cell = newPattern[row]?.[col];
            if (!cell) continue;
            previewCtx.fillStyle = cell.hex || '#cccccc';
            previewCtx.fillRect(
              Math.floor((col / currentGridSize) * 100),
              Math.floor((row / currentGridSize) * 100),
              Math.ceil(100 / currentGridSize) + 1,
              Math.ceil(100 / currentGridSize) + 1
            );
          }
        }

        const previewUrl = previewCanvas.toDataURL('image/png');
        addToHistory({
          previewUrl,
          settings: { gridSize: currentGridSize, colorCount, brand: selectedBrand },
        });
      }
    }
  }, [colorCount, brand, imageUrl, addToHistory]);

  // Quantize colors and generate pattern
  const quantizeAndGenerate = useCallback((data: ImageData, size?: number) => {
    const result = quantizeColors(data, colorCount);

    // Get brand colors
    const brandColors = getBrandColors();
    const brandSpecificColors = result.palette.map((color) => {
      const hex = rgbToHexString(color.r, color.g, color.b);
      const match = matchColorToAllBrands({ r: color.r, g: color.g, b: color.b }, brandColors);
      return {
        hex,
        rgb: { r: color.r, g: color.g, b: color.b },
        code: match[brand]?.code || '—',
      };
    });

    setQuantizedColors(brandSpecificColors);
    generatePattern(data, result, brand, size !== undefined ? size : gridSize);
  }, [colorCount, brand, gridSize, generatePattern]);

  // Handle settings changes - only apply when settingsChangedRef is set
  useEffect(() => {
    if (imageData && settingsChangedRef.current) {
      settingsChangedRef.current = false;
      // Re-quantize and generate with new settings
      quantizeAndGenerate(imageData);
    }
  }, [appliedColorCount, appliedBrand, imageData, quantizeAndGenerate, colorCount, brand, gridSize]);

  // Apply button handler
  const handleApplySettings = useCallback(() => {
    setAppliedGridSize(gridSize);
    setAppliedColorCount(colorCount);
    setAppliedBrand(brand);
    settingsChangedRef.current = true;
    if (imageData) {
      quantizeAndGenerate(imageData);
    }
    toast.success('Settings applied');
  }, [gridSize, colorCount, brand, imageData, quantizeAndGenerate]);

  // Handle AI image generation
  /*
  const handleAIGenerated = useCallback((url: string) => {
    setImageUrl(url);
    loadImageData(url);
    toast.success('AI image generated!');
  }, []);
  */

  // Restore from history
  const handleRestore = useCallback((item: PatternHistoryItem) => {
    setGridSize(item.settings.gridSize);
    setColorCount(item.settings.colorCount);
    setBrand(item.settings.brand);
    setAppliedGridSize(item.settings.gridSize);
    setAppliedColorCount(item.settings.colorCount);
    setAppliedBrand(item.settings.brand);
    toast.info('Pattern settings restored');
  }, []);

  // Clear image
  const handleClear = useCallback(() => {
    setImageUrl(null);
    setImageData(null);
    setPattern([]);
    setQuantizedColors([]);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="top-center" />

      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">PinDou Generator</h1>
            <Badge variant="secondary">Beta</Badge>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">by KafukaTree</span>
            {isLoaded && <HistoryList onRestore={handleRestore} />}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column - Settings */}
          <div className="space-y-6">
            {/* Image Upload */}
            <Card>
              <CardHeader>
                <CardTitle>1. Upload Image</CardTitle>
              </CardHeader>
              <CardContent>
                <FileUpload
                  onFileSelect={handleFileSelect}
                  onClear={handleClear}
                  previewUrl={imageUrl}
                />
              </CardContent>
            </Card>

            {/* AI Generation */}
            {/*
            <AIGeneration
              onImageGenerated={handleAIGenerated}
              disabled={!imageUrl}
            />
            */}

            {/* Pattern Settings */}
            {imageUrl && (
              <Card>
                <CardHeader>
                  <CardTitle>2. Pattern Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <GridSizeSelector
                    value={gridSize}
                    onChange={setGridSize}
                    disabled={!imageUrl}
                  />

                  <Separator />

                  <ColorQuantization
                    imageData={imageData}
                    colorCount={colorCount}
                    onColorCountChange={setColorCount}
                    quantizedColors={quantizedColors}
                    onQuantizedColorsChange={setQuantizedColors}
                  />

                  <Separator />

                  <BrandSelector
                    value={brand}
                    onChange={setBrand}
                    disabled={!imageUrl}
                  />

                  <Button
                    onClick={handleApplySettings}
                    className="w-full"
                    variant={hasPendingChanges ? "default" : "secondary"}
                    disabled={!hasPendingChanges}
                  >
                    {hasPendingChanges ? 'Apply Changes' : 'Settings Applied'}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Color Legend */}
            {quantizedColors.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Used Colors</CardTitle>
                </CardHeader>
                <CardContent>
                  <ColorLegend
                    colors={quantizedColors}
                    counts={quantizedColors.reduce((acc, c) => {
                      if (c.code && c.code !== '—') {
                        acc[c.code] = (acc[c.code] || 0) + 1;
                      }
                      return acc;
                    }, {} as Record<string, number>)}
                  />
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Column - Pattern Preview */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Pattern Preview</span>
                  {pattern.length > 0 && (
                    <div className="flex gap-2">
                      <PDFExport
                        pattern={pattern}
                        gridSize={appliedGridSize}
                        brand={appliedBrand}
                        quantizedColors={quantizedColors}
                      />
                    </div>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!imageUrl ? (
                  <div className="flex items-center justify-center h-96 bg-muted rounded-lg">
                    <div className="text-center text-muted-foreground">
                      <p className="text-lg font-medium">No image loaded</p>
                      <p className="text-sm">Upload an image or generate one with AI to get started</p>
                    </div>
                  </div>
                ) : (
                  <PatternCanvas
                    gridSize={appliedGridSize}
                    pattern={pattern}
                    brand={appliedBrand}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t mt-12">
        <div className="container mx-auto px-4 py-6 text-center text-sm text-muted-foreground">
          <p>Perler Bead Pattern Generator</p>
          <p className="mt-1">
            Supports: {BRANDS.join(', ')}
          </p>
          <p className="mt-2 text-xs opacity-60">
            Created by KafukaTree
          </p>
        </div>
      </footer>
    </div>
  );
}
