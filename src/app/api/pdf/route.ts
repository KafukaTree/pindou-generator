import { NextRequest, NextResponse } from 'next/server';
import { jsPDF } from 'jspdf';

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function normalizeHex(hex: string): string {
  if (!hex) return '#cccccc';
  if (hex.startsWith('#')) return hex;
  if (hex.startsWith('rgb')) {
    const match = hex.match(/\d+/g);
    if (match && match.length >= 3) {
      const r = parseInt(match[0]).toString(16).padStart(2, '0');
      const g = parseInt(match[1]).toString(16).padStart(2, '0');
      const b = parseInt(match[2]).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
  }
  return '#cccccc';
}

interface PatternCell {
  hex: string;
  brandCode: string;
}

interface PDFRequestBody {
  pattern: PatternCell[][];
  gridSize: number;
  brand: string;
  colors: { hex: string; code: string; count: number }[];
  title?: string;
  showColorCodes?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body: PDFRequestBody = await request.json();

    const { pattern, gridSize, brand, colors, title = 'Perler Bead Pattern', showColorCodes = true } = body;

    if (!pattern || !gridSize || !brand) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Create PDF document (A4 size: 210mm x 297mm)
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 15;

    // Cover page
    doc.setFontSize(24);
    doc.text(title, pageWidth / 2, 40, { align: 'center' });

    doc.setFontSize(14);
    doc.text(`Brand: ${brand}`, pageWidth / 2, 55, { align: 'center' });

    doc.setFontSize(12);
    doc.text(`Grid Size: ${gridSize} × ${gridSize}`, pageWidth / 2, 65, { align: 'center' });
    doc.text(`Colors Used: ${colors.length}`, pageWidth / 2, 73, { align: 'center' });

    // Calculate bead counts
    const totalBeads = colors.reduce((sum, c) => sum + c.count, 0);
    doc.text(`Total Beads: ${totalBeads}`, pageWidth / 2, 81, { align: 'center' });

    // Watermark
    doc.setFontSize(10);
    doc.setTextColor(150);
    doc.text('by KafukaTree', pageWidth / 2, 90, { align: 'center' });

    // Pattern grid page
    doc.addPage();
    doc.setFontSize(16);
    doc.text('Pattern', pageWidth / 2, 20, { align: 'center' });

    const gridStartY = 30;
    const maxGridWidth = pageWidth - margin * 2;
    const maxGridHeight = pageHeight - gridStartY - margin;
    const cellSize = Math.min(maxGridWidth / gridSize, maxGridHeight / gridSize);
    const gridWidth = cellSize * gridSize;
    const gridHeight = cellSize * gridSize;
    const gridStartX = (pageWidth - gridWidth) / 2;

    // Draw grid with borders for all cells
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const cell = pattern[row]?.[col];
        const x = gridStartX + col * cellSize;
        const y = gridStartY + row * cellSize;

        // Draw cell background first
        if (cell?.hex) {
          const normalizedHex = normalizeHex(cell.hex);
          doc.setFillColor(normalizedHex);
          doc.rect(x, y, cellSize, cellSize, 'F');
        } else {
          doc.setFillColor(255, 255, 255);
          doc.rect(x, y, cellSize, cellSize, 'F');
        }

        // Draw grid lines (stroke) for all cells
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.1);
        doc.rect(x, y, cellSize, cellSize, 'S');

        // Draw color code if enabled
        if (showColorCodes && cell?.brandCode && cellSize > 4) {
          const rgb = cell.hex ? hexToRgb(cell.hex) : null;
          const luminance = rgb ? (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 : 0;
          doc.setTextColor(luminance > 0.5 ? 0 : 255);
          doc.setFontSize(Math.min(8, cellSize * 0.25));
          doc.text(cell.brandCode, x + cellSize / 2, y + cellSize / 2, {
            align: 'center',
            baseline: 'middle',
          });
        }
      }
    }

    // Watermark on pattern page
    doc.setFontSize(10);
    doc.setTextColor(150);
    doc.text('by KafukaTree', pageWidth / 2, pageHeight - 10, { align: 'center' });

    // Color legend page(s)
    doc.addPage();
    doc.setFontSize(16);
    doc.text('Color Legend', pageWidth / 2, 20, { align: 'center' });

    const legendStartY = 35;
    const swatchSize = 10;
    const legendColWidth = 60;
    const legendRowHeight = 18;
    const legendColsPerRow = 3;
    const legendGapX = 10;
    const legendGapY = 5;
    const maxRowsPerPage = Math.floor((pageHeight - legendStartY - margin) / (legendRowHeight + legendGapY));

    let legendCol = 0;
    let legendRow = 0;
    let itemsOnCurrentPage = 0;

    for (const color of colors) {
      // Check if we need a new page
      if (legendRow >= maxRowsPerPage) {
        doc.addPage();
        legendRow = 0;
        itemsOnCurrentPage = 0;
      }

      const x = margin + legendCol * (legendColWidth + legendGapX);
      const y = legendStartY + legendRow * (legendRowHeight + legendGapY);

      // Color swatch - normalize hex color
      const normalizedHex = normalizeHex(color.hex);
      doc.setFillColor(normalizedHex);
      doc.rect(x, y, swatchSize, swatchSize, 'F');

      // Border for swatch
      doc.setDrawColor(180, 180, 180);
      doc.setLineWidth(0.1);
      doc.rect(x, y, swatchSize, swatchSize, 'S');

      // Color code and count
      doc.setTextColor(0);
      doc.setFontSize(9);
      doc.text(color.code, x + swatchSize + 4, y + 4);
      doc.text(`x${color.count}`, x + swatchSize + 4, y + 9);

      legendCol++;
      itemsOnCurrentPage++;
      if (legendCol >= legendColsPerRow) {
        legendCol = 0;
        legendRow++;
      }
    }

    // Watermark on legend page
    doc.setFontSize(10);
    doc.setTextColor(150);
    doc.text('by KafukaTree', pageWidth / 2, pageHeight - 10, { align: 'center' });

    // Return PDF as buffer
    const pdfOutput = doc.output('arraybuffer');
    const pdfBuffer = Buffer.from(pdfOutput);

    return new NextResponse(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="perler-pattern-${brand}-${Date.now()}.pdf`,
      },
    });
  } catch (error) {
    console.error('PDF generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate PDF' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Use POST to generate PDF',
    requiredFields: ['pattern', 'gridSize', 'brand'],
    optionalFields: ['colors', 'title', 'showColorCodes'],
  });
}
