'use client';

import { Badge } from '@/components/ui/badge';

interface ColorSwatch {
  hex: string;
  rgb: { r: number; g: number; b: number };
  code: string;
}

interface ColorPaletteProps {
  colors: ColorSwatch[];
  title?: string;
}

export function ColorPalette({ colors, title = 'Color Palette' }: ColorPaletteProps) {
  if (!colors || colors.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">No colors to display</div>
    );
  }

  return (
    <div className="space-y-2">
      {title && <h3 className="text-sm font-medium">{title}</h3>}
      <div className="flex flex-wrap gap-2">
        {colors.map((color, index) => (
          <div
            key={index}
            className="group relative"
          >
            <div
              className="h-8 w-8 rounded-md border shadow-sm transition-transform group-hover:scale-110"
              style={{ backgroundColor: color.hex }}
            />
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-xs shadow-md opacity-0 transition-opacity group-hover:opacity-100 z-10">
              <div className="font-medium">{color.code}</div>
              <div className="text-muted-foreground">
                RGB({color.rgb.r}, {color.rgb.g}, {color.rgb.b})
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ColorLegendProps {
  colors: ColorSwatch[];
  counts?: Record<string, number>;
}

export function ColorLegend({ colors, counts }: ColorLegendProps) {
  if (!colors || colors.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Color Legend</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {colors.map((color, index) => (
          <div
            key={index}
            className="flex items-center gap-2 rounded-md border p-2"
          >
            <div
              className="h-6 w-6 rounded shadow-sm"
              style={{ backgroundColor: color.hex }}
            />
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium">{color.code}</div>
              {counts && counts[color.code] !== undefined && (
                <div className="text-xs text-muted-foreground">
                  {counts[color.code]} beads
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
