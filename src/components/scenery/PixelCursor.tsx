'use client';

/**
 * Pixel-art tool glyphs: 12x12 art grid, 2px cells, viewBox 0 0 24 24.
 *
 * Strictly one colour. Every painted cell is `currentColor`; the interior
 * "highlights" are HOLES rather than painted cells. That is deliberate: a hole
 * lets whatever sits behind show through, so the same glyph reads on a cream
 * toolbar button, on the dark-theme surface, and knocked out of a filled clay
 * active button. A painted `var(--paper-raised)` highlight would vanish on the
 * active state, because there the button's own foreground IS paper-raised.
 *
 * No paths, no rounding, no gradients: every edge lands on an integer.
 */

/** [x, y, width, height] on the 24x24 art grid. */
type IconRect = readonly [number, number, number, number];

export type PixelCursorKind = 'pencil' | 'eraser' | 'picker' | 'brush' | 'fill';

export interface PixelCursorProps {
  kind: PixelCursorKind;
  /** Rendered edge length in px. Defaults to 24. */
  size?: number;
  className?: string;
}

const ICONS: Record<PixelCursorKind, readonly IconRect[]> = {
  pencil: [
    [14, 0, 8, 2],
    [14, 2, 8, 2],
    [14, 4, 6, 2],
    [12, 6, 6, 2],
    [10, 8, 6, 2],
    [8, 10, 6, 2],
    [6, 12, 6, 2],
    [4, 14, 6, 2],
    [2, 16, 6, 2],
    [0, 18, 4, 2],
    [0, 20, 2, 2],
  ],
  eraser: [
    [12, 2, 10, 2],
    [10, 4, 12, 2],
    [8, 6, 12, 2],
    [6, 8, 12, 2],
    [4, 10, 6, 2],
    [16, 10, 2, 2],
    [4, 12, 12, 2],
    [2, 14, 10, 2],
  ],
  picker: [
    [16, 2, 8, 2],
    [16, 4, 2, 2],
    [22, 4, 2, 2],
    [16, 6, 2, 2],
    [22, 6, 2, 2],
    [16, 8, 8, 2],
    [18, 10, 4, 2],
    [16, 12, 4, 2],
    [14, 14, 4, 2],
    [12, 16, 4, 2],
    [10, 18, 4, 2],
    [8, 20, 2, 2],
    [6, 22, 4, 2],
  ],
  brush: [
    [10, 0, 6, 2],
    [10, 2, 6, 2],
    [10, 4, 6, 2],
    [10, 6, 6, 2],
    [8, 8, 10, 2],
    [4, 10, 18, 2],
    [4, 12, 18, 2],
    [4, 14, 18, 2],
    [4, 16, 18, 2],
    [4, 18, 2, 2],
    [8, 18, 2, 2],
    [12, 18, 2, 2],
    [16, 18, 2, 2],
    [20, 18, 2, 2],
  ],
  fill: [
    [8, 2, 4, 2],
    [2, 6, 4, 2],
    [18, 6, 4, 2],
    [2, 8, 2, 2],
    [20, 8, 2, 2],
    [2, 10, 2, 2],
    [6, 10, 12, 2],
    [20, 10, 2, 2],
    [2, 12, 2, 2],
    [20, 12, 2, 2],
    [4, 14, 2, 2],
    [18, 14, 2, 2],
    [4, 16, 2, 2],
    [18, 16, 2, 2],
    [4, 18, 4, 2],
    [16, 18, 4, 2],
    [6, 20, 12, 2],
  ],
};

/**
 * Fine detail that only survives at larger sizes. Below 24px a 2x2 cell is under
 * 2 CSS px and these turn into stray specks — the eraser's rubber crumbs read as
 * noise rather than as crumbs, so they are dropped instead of smudged.
 */
const DETAIL: Partial<Record<PixelCursorKind, readonly IconRect[]>> = {
  eraser: [
    [2, 18, 2, 2],
    [10, 20, 2, 2],
  ],
};

/** Smallest rendered edge at which DETAIL is drawn. */
const DETAIL_MIN_SIZE = 24;

/** Accessible names, kept next to the art so a bare icon is never unlabelled. */
const LABELS: Record<PixelCursorKind, string> = {
  pencil: '铅笔',
  eraser: '橡皮',
  picker: '取色器',
  brush: '画笔',
  fill: '填充',
};

/** Every tool, in toolbar order. Handy for mapping instead of repeating the union. */
export const PIXEL_CURSOR_KINDS: readonly PixelCursorKind[] = [
  'pencil',
  'eraser',
  'picker',
  'brush',
  'fill',
];

export function PixelCursor({ kind, size = 24, className }: PixelCursorProps) {
  // Detail is dropped rather than smudged at small sizes: a 2x2 crumb at 16px is
  // sub-pixel and reads as dirt on the icon.
  const detail = size >= DETAIL_MIN_SIZE ? DETAIL[kind] : undefined;
  const rects = detail ? [...ICONS[kind], ...detail] : ICONS[kind];

  return (
    <svg
      className={['px-art', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      role="img"
      aria-label={LABELS[kind]}
      focusable="false"
    >
      {rects.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill="currentColor" />
      ))}
    </svg>
  );
}
