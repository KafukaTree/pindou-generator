'use client';

import { useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { ColorPalette } from '@/components/ColorPalette';
import { quantizeColors, rgbToHexString } from '@/lib/quantization';
import { hexToRgb } from '@/lib/colors';

interface ColorQuantizationProps {
  imageData: ImageData | null;
  colorCount: number;
  onColorCountChange: (count: number) => void;
  quantizedColors: { hex: string; rgb: { r: number; g: number; b: number }; code: string }[];
  onQuantizedColorsChange: (colors: { hex: string; rgb: { r: number; g: number; b: number }; code: string }[]) => void;
}

export function ColorQuantization({
  imageData,
  colorCount,
  onColorCountChange,
  quantizedColors,
  onQuantizedColorsChange,
}: ColorQuantizationProps) {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleQuantize = () => {
    if (!imageData) return;

    setIsProcessing(true);

    // Use setTimeout to allow UI to update
    setTimeout(() => {
      const result = quantizeColors(imageData, colorCount);

      const colors = result.palette.map((color) => ({
        hex: rgbToHexString(color.r, color.g, color.b),
        rgb: { r: color.r, g: color.g, b: color.b },
        code: '',
      }));

      onQuantizedColorsChange(colors);
      setIsProcessing(false);
    }, 50);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Number of Colors</Label>
          <span className="text-sm text-muted-foreground">{colorCount}</span>
        </div>
        <Slider
          value={[colorCount]}
          onValueChange={([value]) => onColorCountChange(value)}
          min={4}
          max={32}
          step={1}
          disabled={!imageData}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>4 colors</span>
          <span>32 colors</span>
        </div>
      </div>

      <button
        onClick={handleQuantize}
        disabled={!imageData || isProcessing}
        className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {isProcessing ? 'Processing...' : 'Apply Quantization'}
      </button>

      {quantizedColors.length > 0 && (
        <ColorPalette
          colors={quantizedColors.map((c) => ({
            ...c,
            code: c.code || '—',
          }))}
          title="Quantized Palette"
        />
      )}
    </div>
  );
}

interface ColorCountSelectorProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}

export function ColorCountSelector({
  value,
  onChange,
  min = 4,
  max = 32,
  disabled = false,
}: ColorCountSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Colors</Label>
        <span className="text-sm font-medium">{value}</span>
      </div>
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
      />
    </div>
  );
}
