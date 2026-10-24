'use client';

import type { CSSProperties } from 'react';

/**
 * One bead colour square. Deliberately square-cornered and flat: the only
 * chrome is a 2px ink border, which thickens into a clay ring when selected.
 * The selection ring is a box-shadow (not an outline) so it survives any
 * parent with `overflow: hidden` — colour trays are usually scrollable.
 */

export interface PixelSwatchProps {
  /** Bead colour, e.g. `#FFE395`. */
  hex: string;
  /** Optional code shown in the corner, e.g. `A26`. */
  code?: string;
  /** Edge length in px. Defaults to 20. */
  size?: number;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  className?: string;
}

/** Expand `#abc` / `abc` / `#aabbcc` to a 6-digit lowercase hex, or null. */
function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return ('#' + raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2]).toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return '#' + raw.toLowerCase();
  return null;
}

/** sRGB relative luminance, 0..1. Used to decide whether a label needs ink or paper. */
function luminance(hex: string): number {
  const norm = normalizeHex(hex);
  if (!norm) return 0;
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(norm.slice(1, 3), 16));
  const g = channel(parseInt(norm.slice(3, 5), 16));
  const b = channel(parseInt(norm.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Label colour for a bead hex. Both options are FIXED colours rather than theme
 * variables: the swatch colour itself never changes with the theme, so the text
 * must not either.
 *
 * 0.21 is not a guess — it is the threshold that maximises the WORST-CASE
 * contrast across all 291 colours of the project's bead card (measured: worst
 * 3.96:1, median far higher). A 0.5 threshold — the intuitive "light vs dark"
 * split — scores only 2.16:1 on the worst colour, because the palette is dense
 * in the mid-to-dark range.
 */
function contrastInkFor(hex: string): string {
  return luminance(hex) > 0.21 ? '#2A1F17' : '#FFFBF2';
}

/** A square of bead colour, optionally labelled with its code. */
export function PixelSwatch({
  hex,
  code,
  size = 20,
  selected = false,
  disabled = false,
  title,
  onClick,
  className,
}: PixelSwatchProps) {
  const ringStyle: CSSProperties = selected
    ? { borderColor: 'var(--clay)', boxShadow: '0 0 0 2px var(--clay-soft)' }
    : { borderColor: 'var(--line-strong)' };

  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: normalizeHex(hex) ?? hex,
    borderStyle: 'solid',
    borderWidth: 2,
    borderRadius: 0,
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? 'not-allowed' : onClick ? 'pointer' : 'default',
    ...ringStyle,
  };

  // Only label swatches with room for it; below ~18px a code becomes a smudge.
  // The size is pinned at 8px rather than scaled: a code is read at a glance and
  // a proportional size makes small trays look inconsistent.
  //
  // The label colour is a FIXED pair, not a theme variable. Bead hexes do not
  // change with the theme, so the text contrast must not either: pairing
  // `var(--ink)` with a fixed swatch turned near-white codes invisible in dark
  // mode (dark `--ink` is nearly white).
  const showCode = Boolean(code) && size >= 18;
  const codeInk = contrastInkFor(hex);

  const inner = (
    <>
      {showCode && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            right: 2,
            bottom: 1,
            fontSize: 8,
            lineHeight: 1,
            letterSpacing: '-0.02em',
            color: codeInk,
            fontFamily: 'var(--font-pixel), ui-monospace, monospace',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {code}
        </span>
      )}
    </>
  );

  const classes = ['px-swatch', className].filter(Boolean).join(' ');

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        style={{ ...style, position: 'relative', display: 'inline-block', padding: 0 }}
        onClick={onClick}
        disabled={disabled}
        title={title ?? code ?? hex}
        aria-label={title ?? code ?? hex}
        aria-pressed={selected}
        data-selected={selected ? '' : undefined}
      >
        {inner}
      </button>
    );
  }

  return (
    <span
      className={classes}
      style={{ ...style, position: 'relative', display: 'inline-block' }}
      title={title ?? code ?? hex}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      data-selected={selected ? '' : undefined}
    >
      {inner}
    </span>
  );
}
