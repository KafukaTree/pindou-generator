'use client';

import { useRef, useEffect, useCallback } from 'react';
import { Brand, hexToRgb } from '@/lib/colors';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

interface PatternCell {
  hex: string;
  brandCode: string;
}

interface PatternCanvasProps {
  gridSize: number;
  pattern: PatternCell[][];
  brand: Brand;
  onDownload?: () => void;
}

export function PatternCanvas({
  gridSize,
  pattern,
  brand,
  onDownload,
}: PatternCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawPattern = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Pattern is now always gridSize x gridSize
    const rows = gridSize;
    const cols = gridSize;
    if (rows === 0 || cols === 0) return;

    // Calculate cell size to fit within max dimensions
    const maxCanvasSize = 500;
    const cellSize = Math.floor(maxCanvasSize / gridSize);
    const labelFontSize = Math.max(8, Math.floor(cellSize * 0.3));
    const labelPadding = Math.floor(cellSize * 0.05);

    // Set canvas size (no padding)
    const canvasWidth = gridSize * cellSize;
    const canvasHeight = gridSize * cellSize;

    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }

    // Clear canvas
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw cells
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const cell = pattern[row]?.[col];
        if (!cell) continue;

        const x = col * cellSize;
        const y = row * cellSize;

        // Draw cell background
        ctx.fillStyle = cell.hex || '#cccccc';
        ctx.fillRect(x, y, cellSize, cellSize);

        // Draw border
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, cellSize, cellSize);

        // Draw color code
        if (cell.brandCode && cellSize > 15) {
          ctx.fillStyle = getContrastColor(cell.hex);
          ctx.font = `${labelFontSize}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          const code = cell.brandCode;
          const maxWidth = cellSize - labelPadding * 2;

          if (ctx.measureText(code).width > maxWidth) {
            const parts = code.split(/([A-Z]+)/).filter(Boolean);
            if (parts.length >= 2) {
              ctx.fillText(
                parts[0],
                x + cellSize / 2,
                y + cellSize / 2 - labelFontSize / 2
              );
              ctx.fillText(
                parts.slice(1).join(''),
                x + cellSize / 2,
                y + cellSize / 2 + labelFontSize / 2
              );
            } else {
              ctx.fillText(
                code.substring(0, Math.ceil(code.length / 2)),
                x + cellSize / 2,
                y + cellSize / 2 - labelFontSize / 2
              );
              ctx.fillText(
                code.substring(Math.ceil(code.length / 2)),
                x + cellSize / 2,
                y + cellSize / 2 + labelFontSize / 2
              );
            }
          } else {
            ctx.fillText(code, x + cellSize / 2, y + cellSize / 2);
          }
        }
      }
    }
  }, [gridSize, pattern]);

  useEffect(() => {
    drawPattern();
  }, [drawPattern]);

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create a temporary canvas with watermark
    const tempCanvas = document.createElement('canvas');
    const padding = 30;
    tempCanvas.width = canvas.width + padding * 2;
    tempCanvas.height = canvas.height + padding + 20;
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return;

    // Fill white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Draw pattern
    ctx.drawImage(canvas, padding, padding);

    // Draw watermark
    ctx.fillStyle = '#999999';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('by KafukaTree', tempCanvas.width / 2, tempCanvas.height - 8);

    const link = document.createElement('a');
    link.download = `perler-pattern-${brand}-${Date.now()}.png`;
    link.href = tempCanvas.toDataURL('image/png');
    link.click();

    onDownload?.();
  }, [brand, onDownload]);

  if (!pattern || pattern.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-muted rounded-lg">
        <p className="text-muted-foreground">No pattern generated yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="border rounded-lg overflow-hidden bg-white">
        <canvas
          ref={canvasRef}
          className="w-full h-auto"
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      </div>
      <button
        onClick={handleDownload}
        className="w-full rounded-md bg-secondary px-4 py-2 text-secondary-foreground hover:bg-secondary/90"
      >
        Download Pattern Image
      </button>
    </div>
  );
}

// Helper to get contrasting text color
function getContrastColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#000000';

  // Calculate relative luminance
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

interface GridSizeSelectorProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}

export function GridSizeSelector({
  value,
  onChange,
  min = 10,
  max = 100,
  disabled = false,
}: GridSizeSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Grid Size</Label>
        <span className="text-sm font-medium">{value} × {value}</span>
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
