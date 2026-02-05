'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Brand } from '@/lib/colors';

interface PatternCell {
  hex: string;
  brandCode: string;
}

interface QuantizedColor {
  hex: string;
  rgb: { r: number; g: number; b: number };
  code: string;
}

interface PDFExportProps {
  pattern: PatternCell[][];
  gridSize: number;
  brand: Brand;
  quantizedColors?: QuantizedColor[];
  colorCounts?: Record<string, number>;
  disabled?: boolean;
}

export function PDFExport({
  pattern,
  gridSize,
  brand,
  quantizedColors = [],
  disabled = false,
}: PDFExportProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [showColorCodes, setShowColorCodes] = useState(true);

  // Get color counts from pattern
  const getColorCounts = (): { hex: string; code: string; count: number }[] => {
    const counts: Record<string, number> = {};
    const rows = pattern.length;
    const cols = pattern[0]?.length || 0;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = pattern[row]?.[col];
        if (cell?.brandCode) {
          counts[cell.brandCode] = (counts[cell.brandCode] || 0) + 1;
        }
      }
    }

    // Use quantizedColors for color mapping, with counts from pattern
    return quantizedColors.map((color) => ({
      hex: color.hex || '#cccccc',
      code: color.code,
      count: counts[color.code] || 0,
    })).filter(c => c.count > 0);
  };

  const handleDownload = async () => {
    if (!pattern || pattern.length === 0) return;

    setIsGenerating(true);

    try {
      const colors = getColorCounts();

      const response = await fetch('/api/pdf', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pattern,
          gridSize,
          brand,
          colors,
          title: `Perler Bead Pattern - ${brand}`,
          showColorCodes,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to generate PDF');
      }

      const blob = await response.blob();

      // Download the file
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `perler-pattern-${brand}-${Date.now()}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('PDF download error:', error);
      alert(error instanceof Error ? error.message : 'Failed to download PDF');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="show-color-codes"
          checked={showColorCodes}
          onChange={(e) => setShowColorCodes(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <Label htmlFor="show-color-codes" className="text-sm cursor-pointer">
          Show color codes in PDF
        </Label>
      </div>
      <Button
        onClick={handleDownload}
        disabled={disabled || isGenerating || !pattern?.length}
      >
        {isGenerating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Generating PDF...
          </>
        ) : (
          <>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </>
        )}
      </Button>
    </div>
  );
}
