'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * PixelMascot — the app's original IP: a chubby bead duck.
 *
 * The mascot is not tied to the header. It is a small sticker you drop
 * anywhere: it can walk along a divider (PixelMascotWalk), haul itself up
 * over a panel edge (PixelMascotPeek), or stand somewhere and draw
 * (mood="draw"). The component itself never sets position, so the caller
 * always owns placement.
 *
 * Sprite provenance. The art is authored on a 40x34 cell grid with a 4px
 * cell (viewBox 160x136). Every shape is an axis-aligned <rect> on integer
 * coordinates and only a handful of flat colours are used, so edges stay
 * razor sharp at any zoom with no half-cell rim.
 *
 * The colours are fixed bead hexes from this project's own card (MARD A21
 * body / A18 mitten wing / A10 bill and feet / A14 lower mandible / H16
 * features / H18 paper). They are deliberately NOT themed: a mascot that
 * changed colour with the page would stop being the same character.
 *
 * ---------------------------------------------------------------------
 * Animation
 * ---------------------------------------------------------------------
 * The sprite is split into layers that move independently — that is what
 * makes it feel alive without any raster frames:
 *
 *   body           bobs one cell at a time
 *   eyes           blinks (skipped when the pose already has shut eyes)
 *   wingL / wingR  the mitten wings flap
 *   float          sleep z / music notes drift up and fade
 *   rope           jump rope stays planted while the body rises
 *   pen            nib jots up and down while drawing
 *   footA / footB  walk feet alternate, in opposite phase
 *
 * Everything is CSS `steps()` so it moves in whole cells, which keeps the
 * pixel-art feel instead of turning the sprite into smooth vector mush.
 * Pass `animate={false}` to freeze it; `prefers-reduced-motion: reduce`
 * disables every animation.
 */

/** A single bead: [x, y, width, height, colour]. All values are integers. */
export type PxRect = readonly [number, number, number, number, string];

export type MascotMood =
  | 'idle'     // standing, wings up, blinking
  | 'happy'    // arc eyes, big smile
  | 'sleep'    // eyes shut, drifting z
  | 'music'    // headphones on, notes drifting
  | 'review'   // holding a paper sheet
  | 'jump'     // skipping rope
  | 'walk'     // mid-stride, legs alternating
  | 'peek'     // half a body, paws hooked on an edge
  | 'draw';    // pen in paw, drawing on the canvas

/** Which side of its box the mascot is anchored to. */
export type MascotSide = 'left' | 'right';

export interface PixelMascotProps {
  /** Which way the sprite faces. 'left' mirrors it. Defaults to 'right'. */
  side?: MascotSide;
  /** Rendered width in px. Height follows the sprite aspect ratio. */
  size?: number;
  /** Extra classes — use these to position the mascot (the component is not
   *  positioned itself, so the caller decides where it stands). */
  className?: string;
  /** Pose / expression. Defaults to 'idle'. */
  mood?: MascotMood;
  /** When provided the mascot becomes an accessible image with this label. */
  title?: string;
  /** Idle animation (bob / blink / wing flap / drifting props). Default true. */
  animate?: boolean;
  /** How to draw the sprite.
   *   'svg' — inline pixel art, animates via CSS (default). Respects
   *           `prefers-reduced-motion`, so prefer this inside the app.
   *   'gif' — the baked animated GIF from /public, for places that cannot run
   *           CSS animations (README, OG cards, emails, chat previews).
   *           A GIF cannot be paused by CSS, so combining it with
   *           `animate={false}` falls back to the static SVG.
   */
  render?: 'svg' | 'gif';
  /** Add a slow float so the mascot hovers on the page. Default false. */
  float?: boolean;
}

const VIEW_W = 160;
const VIEW_H = 136;
/** Grid dimensions in CELLS (one bead = CELL px). */
const GRID_W = 40;
/** Empty grid rows below the lowest painted cell, per pose. */
const PAD_PEEK = 4;
const PAD_WALK = 1;

/** Baked animated GIFs — same sprite, same pulse, no CSS needed. */
const GIF_SRC: Record<MascotMood, string> = {
  idle: '/mascot-idle.gif',
  happy: '/mascot-happy.gif',
  sleep: '/mascot-sleep.gif',
  music: '/mascot-music.gif',
  review: '/mascot-review.gif',
  jump: '/mascot-jump.gif',
  walk: '/mascot-walk.gif',
  peek: '/mascot-peek.gif',
  draw: '/mascot-draw.gif',
};

interface PoseLayers {
  body: readonly PxRect[];
  eyes?: readonly PxRect[];
  wingL?: readonly PxRect[];
  wingR?: readonly PxRect[];
  float?: readonly PxRect[];
  rope?: readonly PxRect[];
  pen?: readonly PxRect[];
  footA?: readonly PxRect[];
  footB?: readonly PxRect[];
  /** Peek paws: drawn last and never animated, so they stay on the edge. */
  paw?: readonly PxRect[];
}

const POSES: Record<MascotMood, PoseLayers> = {
  idle: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,84,4,'#FFE395'],
      [40,64,84,4,'#FFE395'],
      [36,68,48,4,'#FFE395'],
      [84,68,16,4,'#1D1414'],
      [100,68,28,4,'#FFE395'],
      [36,72,12,4,'#FFE395'],
      [48,72,20,4,'#1D1414'],
      [68,72,60,4,'#FFE395'],
      [36,76,92,4,'#FFE395'],
      [36,80,92,4,'#FFE395'],
      [36,84,20,4,'#FFE395'],
      [64,84,28,4,'#FFE395'],
      [100,84,28,4,'#FFE395'],
      [36,88,20,4,'#FFE395'],
      [64,88,28,4,'#FFE395'],
      [100,88,28,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,36,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,28,4,'#FFE395'],
      [40,100,60,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [56,84,8,4,'#1D1414'],
      [92,84,8,4,'#1D1414'],
      [56,88,8,4,'#1D1414'],
      [92,88,8,4,'#1D1414'],
    ],
    wingL: [
      [16,72,8,4,'#FEBE7D'],
      [12,76,16,4,'#FEBE7D'],
      [12,80,16,4,'#FEBE7D'],
      [12,84,20,4,'#FEBE7D'],
      [8,88,28,4,'#FEBE7D'],
      [8,92,32,4,'#FEBE7D'],
      [12,96,28,4,'#FEBE7D'],
      [20,100,20,4,'#FEBE7D'],
    ],
    wingR: [
      [140,72,8,4,'#FEBE7D'],
      [136,76,16,4,'#FEBE7D'],
      [136,80,16,4,'#FEBE7D'],
      [132,84,20,4,'#FEBE7D'],
      [128,88,28,4,'#FEBE7D'],
      [124,92,32,4,'#FEBE7D'],
      [124,96,28,4,'#FEBE7D'],
      [124,100,20,4,'#FEBE7D'],
    ],
  },
  happy: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,84,4,'#FFE395'],
      [40,64,84,4,'#FFE395'],
      [36,68,48,4,'#FFE395'],
      [84,68,16,4,'#1D1414'],
      [100,68,28,4,'#FFE395'],
      [36,72,12,4,'#FFE395'],
      [48,72,20,4,'#1D1414'],
      [68,72,60,4,'#FFE395'],
      [36,76,92,4,'#FFE395'],
      [36,80,92,4,'#FFE395'],
      [36,84,16,4,'#FFE395'],
      [56,84,8,4,'#FFE395'],
      [68,84,20,4,'#FFE395'],
      [92,84,8,4,'#FFE395'],
      [104,84,24,4,'#FFE395'],
      [40,88,12,4,'#FFE395'],
      [68,88,20,4,'#FFE395'],
      [104,88,20,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,36,4,'#FFE395'],
      [36,96,4,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,32,4,'#FFE395'],
      [32,100,68,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [52,84,4,4,'#1D1414'],
      [64,84,4,4,'#1D1414'],
      [88,84,4,4,'#1D1414'],
      [100,84,4,4,'#1D1414'],
      [52,88,16,4,'#1D1414'],
      [88,88,16,4,'#1D1414'],
    ],
    wingL: [
      [16,68,8,4,'#FEBE7D'],
      [12,72,16,4,'#FEBE7D'],
      [12,76,16,4,'#FEBE7D'],
      [12,80,20,4,'#FEBE7D'],
      [8,84,28,4,'#FEBE7D'],
      [8,88,32,4,'#FEBE7D'],
      [12,92,28,4,'#FEBE7D'],
      [16,96,20,4,'#FEBE7D'],
    ],
    wingR: [
      [140,68,8,4,'#FEBE7D'],
      [136,72,16,4,'#FEBE7D'],
      [136,76,16,4,'#FEBE7D'],
      [132,80,20,4,'#FEBE7D'],
      [128,84,28,4,'#FEBE7D'],
      [124,88,32,4,'#FEBE7D'],
      [124,92,28,4,'#FEBE7D'],
      [128,96,20,4,'#FEBE7D'],
    ],
  },
  sleep: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,84,4,'#FFE395'],
      [40,64,44,4,'#FFE395'],
      [84,64,16,4,'#1D1414'],
      [100,64,24,4,'#FFE395'],
      [36,68,12,4,'#FFE395'],
      [48,68,20,4,'#1D1414'],
      [68,68,60,4,'#FFE395'],
      [36,72,92,4,'#FFE395'],
      [36,76,92,4,'#FFE395'],
      [36,80,92,4,'#FFE395'],
      [36,84,16,4,'#FFE395'],
      [68,84,20,4,'#FFE395'],
      [104,84,24,4,'#FFE395'],
      [36,88,92,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,36,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,28,4,'#FFE395'],
      [40,100,60,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [52,84,16,4,'#1D1414'],
      [88,84,16,4,'#1D1414'],
    ],
    wingL: [
      [12,80,16,4,'#FEBE7D'],
      [8,84,24,4,'#FEBE7D'],
      [8,88,28,4,'#FEBE7D'],
      [8,92,32,4,'#FEBE7D'],
      [12,96,28,4,'#FEBE7D'],
      [20,100,20,4,'#FEBE7D'],
    ],
    wingR: [
      [136,80,16,4,'#FEBE7D'],
      [132,84,24,4,'#FEBE7D'],
      [128,88,28,4,'#FEBE7D'],
      [124,92,32,4,'#FEBE7D'],
      [124,96,28,4,'#FEBE7D'],
      [124,100,20,4,'#FEBE7D'],
    ],
    float: [
      [124,20,12,4,'#1D1414'],
      [132,24,4,4,'#1D1414'],
      [128,28,4,4,'#1D1414'],
      [124,32,12,4,'#1D1414'],
    ],
  },
  music: {
    body: [
      [56,40,40,4,'#1D1414'],
      [44,44,8,4,'#FFE395'],
      [52,44,4,4,'#1D1414'],
      [56,44,40,4,'#FFE395'],
      [96,44,4,4,'#1D1414'],
      [100,44,20,4,'#FFE395'],
      [44,48,8,4,'#FFE395'],
      [52,48,4,4,'#1D1414'],
      [56,48,40,4,'#FFE395'],
      [96,48,4,4,'#1D1414'],
      [100,48,20,4,'#FFE395'],
      [44,52,4,4,'#FFE395'],
      [48,52,4,4,'#1D1414'],
      [52,52,48,4,'#FFE395'],
      [100,52,4,4,'#1D1414'],
      [104,52,16,4,'#FFE395'],
      [44,56,4,4,'#FFE395'],
      [48,56,4,4,'#1D1414'],
      [52,56,48,4,'#FFE395'],
      [100,56,4,4,'#1D1414'],
      [104,56,16,4,'#FFE395'],
      [32,60,20,4,'#1D1414'],
      [52,60,48,4,'#FFE395'],
      [100,60,20,4,'#1D1414'],
      [120,60,4,4,'#FFE395'],
      [32,64,4,4,'#1D1414'],
      [36,64,8,4,'#F0D958'],
      [44,64,4,4,'#1D1414'],
      [48,64,36,4,'#FFE395'],
      [84,64,16,4,'#1D1414'],
      [100,64,4,4,'#FFE395'],
      [104,64,4,4,'#1D1414'],
      [108,64,8,4,'#F0D958'],
      [116,64,4,4,'#1D1414'],
      [120,64,4,4,'#FFE395'],
      [32,68,4,4,'#1D1414'],
      [36,68,8,4,'#F0D958'],
      [44,68,24,4,'#1D1414'],
      [68,68,36,4,'#FFE395'],
      [104,68,4,4,'#1D1414'],
      [108,68,8,4,'#F0D958'],
      [116,68,4,4,'#1D1414'],
      [120,68,8,4,'#FFE395'],
      [32,72,16,4,'#1D1414'],
      [48,72,56,4,'#FFE395'],
      [104,72,16,4,'#1D1414'],
      [120,72,8,4,'#FFE395'],
      [32,76,16,4,'#1D1414'],
      [48,76,56,4,'#FFE395'],
      [104,76,16,4,'#1D1414'],
      [120,76,8,4,'#FFE395'],
      [32,80,16,4,'#1D1414'],
      [48,80,56,4,'#FFE395'],
      [104,80,16,4,'#1D1414'],
      [120,80,8,4,'#FFE395'],
      [36,84,16,4,'#FFE395'],
      [68,84,20,4,'#FFE395'],
      [104,84,24,4,'#FFE395'],
      [36,88,92,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,36,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,28,4,'#FFE395'],
      [40,100,60,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [52,84,16,4,'#1D1414'],
      [88,84,16,4,'#1D1414'],
    ],
    wingL: [
      [12,80,16,4,'#FEBE7D'],
      [8,84,24,4,'#FEBE7D'],
      [8,88,28,4,'#FEBE7D'],
      [8,92,32,4,'#FEBE7D'],
      [12,96,28,4,'#FEBE7D'],
      [20,100,20,4,'#FEBE7D'],
    ],
    wingR: [
      [136,80,16,4,'#FEBE7D'],
      [132,84,24,4,'#FEBE7D'],
      [128,88,28,4,'#FEBE7D'],
      [124,92,32,4,'#FEBE7D'],
      [124,96,28,4,'#FEBE7D'],
      [124,100,20,4,'#FEBE7D'],
    ],
    float: [
      [132,8,4,4,'#1D1414'],
      [132,12,4,4,'#1D1414'],
      [128,16,8,4,'#1D1414'],
      [144,16,4,4,'#1D1414'],
      [144,20,4,4,'#1D1414'],
      [140,24,8,4,'#1D1414'],
    ],
  },
  review: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [104,32,4,4,'#FFFDF0'],
      [108,32,12,4,'#1D1414'],
      [120,32,24,4,'#FFFDF0'],
      [68,36,24,4,'#FFE395'],
      [104,36,40,4,'#FFFDF0'],
      [68,40,24,4,'#FFE395'],
      [104,40,4,4,'#FFFDF0'],
      [108,40,28,4,'#1D1414'],
      [136,40,8,4,'#FFFDF0'],
      [44,44,60,4,'#FFE395'],
      [104,44,40,4,'#FFFDF0'],
      [44,48,60,4,'#FFE395'],
      [104,48,4,4,'#FFFDF0'],
      [108,48,28,4,'#1D1414'],
      [136,48,8,4,'#FFFDF0'],
      [44,52,60,4,'#FFE395'],
      [104,52,40,4,'#FFFDF0'],
      [44,56,60,4,'#FFE395'],
      [104,56,4,4,'#FFFDF0'],
      [108,56,28,4,'#1D1414'],
      [136,56,8,4,'#FFFDF0'],
      [40,60,64,4,'#FFE395'],
      [104,60,40,4,'#FFFDF0'],
      [40,64,64,4,'#FFE395'],
      [104,64,40,4,'#FFFDF0'],
      [36,68,48,4,'#FFE395'],
      [84,68,16,4,'#1D1414'],
      [100,68,4,4,'#FFE395'],
      [104,68,40,4,'#FFFDF0'],
      [36,72,12,4,'#FFE395'],
      [48,72,20,4,'#1D1414'],
      [68,72,60,4,'#FFE395'],
      [36,76,92,4,'#FFE395'],
      [36,80,88,4,'#FFE395'],
      [36,84,20,4,'#FFE395'],
      [64,84,28,4,'#FFE395'],
      [100,84,24,4,'#FFE395'],
      [36,88,20,4,'#FFE395'],
      [64,88,28,4,'#FFE395'],
      [100,88,24,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,40,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,32,4,'#FFE395'],
      [40,100,60,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [56,84,8,4,'#1D1414'],
      [92,84,8,4,'#1D1414'],
      [56,88,8,4,'#1D1414'],
      [92,88,8,4,'#1D1414'],
    ],
    wingL: [
      [12,80,16,4,'#FEBE7D'],
      [8,84,24,4,'#FEBE7D'],
      [8,88,28,4,'#FEBE7D'],
      [8,92,32,4,'#FEBE7D'],
      [12,96,28,4,'#FEBE7D'],
      [20,100,20,4,'#FEBE7D'],
    ],
    wingR: [
      [144,68,8,4,'#FEBE7D'],
      [132,72,20,4,'#FEBE7D'],
      [128,76,28,4,'#FEBE7D'],
      [124,80,32,4,'#FEBE7D'],
      [124,84,32,4,'#FEBE7D'],
      [124,88,28,4,'#FEBE7D'],
      [128,92,20,4,'#FEBE7D'],
    ],
  },
  jump: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,44,4,'#FFE395'],
      [84,60,16,4,'#1D1414'],
      [100,60,24,4,'#FFE395'],
      [40,64,8,4,'#FFE395'],
      [48,64,20,4,'#1D1414'],
      [68,64,56,4,'#FFE395'],
      [36,68,92,4,'#FFE395'],
      [36,72,92,4,'#FFE395'],
      [40,76,12,4,'#FFE395'],
      [56,76,8,4,'#FFE395'],
      [68,76,20,4,'#FFE395'],
      [92,76,8,4,'#FFE395'],
      [104,76,20,4,'#FFE395'],
      [40,80,12,4,'#FFE395'],
      [68,80,20,4,'#FFE395'],
      [104,80,20,4,'#FFE395'],
      [36,84,20,4,'#FFE395'],
      [56,84,32,4,'#F77C31'],
      [88,84,40,4,'#FFE395'],
      [36,88,4,4,'#FFE395'],
      [40,88,56,4,'#F77C31'],
      [96,88,32,4,'#FFE395'],
      [32,92,68,4,'#F77C31'],
      [100,92,28,4,'#FFE395'],
      [32,96,68,4,'#F77C31'],
      [100,96,28,4,'#FFE395'],
      [36,100,60,4,'#F77C31'],
      [96,100,28,4,'#FFE395'],
      [40,104,8,4,'#FFE395'],
      [48,104,36,4,'#F77C31'],
      [84,104,40,4,'#FFE395'],
      [44,108,12,4,'#FFE395'],
      [56,108,24,4,'#FD543D'],
      [80,108,40,4,'#FFE395'],
      [44,112,20,4,'#FFE395'],
      [64,112,12,4,'#FD543D'],
      [76,112,44,4,'#FFE395'],
      [44,116,76,4,'#FFE395'],
      [44,120,76,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [52,76,4,4,'#1D1414'],
      [64,76,4,4,'#1D1414'],
      [88,76,4,4,'#1D1414'],
      [100,76,4,4,'#1D1414'],
      [52,80,16,4,'#1D1414'],
      [88,80,16,4,'#1D1414'],
    ],
    wingL: [
      [24,56,8,4,'#FEBE7D'],
      [20,60,12,4,'#FEBE7D'],
      [20,64,12,4,'#FEBE7D'],
      [12,68,4,4,'#FEBE7D'],
      [20,68,12,4,'#FEBE7D'],
      [8,72,8,4,'#FEBE7D'],
      [20,72,16,4,'#FEBE7D'],
      [8,76,8,4,'#FEBE7D'],
      [20,76,20,4,'#FEBE7D'],
      [12,80,4,4,'#FEBE7D'],
      [20,80,20,4,'#FEBE7D'],
    ],
    wingR: [
      [132,56,8,4,'#FEBE7D'],
      [132,60,12,4,'#FEBE7D'],
      [132,64,12,4,'#FEBE7D'],
      [132,68,12,4,'#FEBE7D'],
      [148,68,4,4,'#FEBE7D'],
      [128,72,16,4,'#FEBE7D'],
      [148,72,8,4,'#FEBE7D'],
      [124,76,20,4,'#FEBE7D'],
      [148,76,8,4,'#FEBE7D'],
      [124,80,20,4,'#FEBE7D'],
      [148,80,4,4,'#FEBE7D'],
    ],
    rope: [
      [64,0,12,4,'#F77C31'],
      [88,0,12,4,'#F77C31'],
      [52,4,16,4,'#F77C31'],
      [96,4,16,4,'#F77C31'],
      [40,8,16,4,'#F77C31'],
      [108,8,16,4,'#F77C31'],
      [28,12,16,4,'#F77C31'],
      [120,12,16,4,'#F77C31'],
      [20,16,12,4,'#F77C31'],
      [132,16,12,4,'#F77C31'],
      [16,20,4,4,'#F77C31'],
      [144,20,4,4,'#F77C31'],
      [16,24,4,4,'#F77C31'],
      [144,24,4,4,'#F77C31'],
      [16,28,4,4,'#F77C31'],
      [144,28,4,4,'#F77C31'],
      [16,32,4,4,'#F77C31'],
      [144,32,4,4,'#F77C31'],
      [16,36,4,4,'#F77C31'],
      [144,36,4,4,'#F77C31'],
      [16,40,4,4,'#F77C31'],
      [144,40,4,4,'#F77C31'],
      [16,44,4,4,'#F77C31'],
      [144,44,4,4,'#F77C31'],
      [16,48,4,4,'#F77C31'],
      [144,48,4,4,'#F77C31'],
      [16,52,4,4,'#F77C31'],
      [144,52,4,4,'#F77C31'],
      [16,56,4,4,'#F77C31'],
      [144,56,4,4,'#F77C31'],
      [16,60,4,4,'#F77C31'],
      [144,60,4,4,'#F77C31'],
      [16,64,4,4,'#F77C31'],
      [144,64,4,4,'#F77C31'],
      [16,68,4,4,'#F77C31'],
      [144,68,4,4,'#F77C31'],
      [16,72,4,4,'#F77C31'],
      [144,72,4,4,'#F77C31'],
      [16,76,4,4,'#F77C31'],
      [144,76,4,4,'#F77C31'],
      [16,80,4,4,'#F77C31'],
      [144,80,4,4,'#F77C31'],
      [16,84,20,4,'#F77C31'],
      [128,84,20,4,'#F77C31'],
    ],
  },
  walk: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,84,4,'#FFE395'],
      [40,64,84,4,'#FFE395'],
      [36,68,48,4,'#FFE395'],
      [84,68,16,4,'#1D1414'],
      [100,68,28,4,'#FFE395'],
      [36,72,12,4,'#FFE395'],
      [48,72,20,4,'#1D1414'],
      [68,72,60,4,'#FFE395'],
      [36,76,92,4,'#FFE395'],
      [36,80,92,4,'#FFE395'],
      [36,84,20,4,'#FFE395'],
      [64,84,28,4,'#FFE395'],
      [100,84,28,4,'#FFE395'],
      [36,88,20,4,'#FFE395'],
      [64,88,28,4,'#FFE395'],
      [100,88,28,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,36,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,28,4,'#FFE395'],
      [40,100,60,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
    ],
    eyes: [
      [56,84,8,4,'#1D1414'],
      [92,84,8,4,'#1D1414'],
      [56,88,8,4,'#1D1414'],
      [92,88,8,4,'#1D1414'],
    ],
    wingL: [
      [16,76,8,4,'#FEBE7D'],
      [12,80,16,4,'#FEBE7D'],
      [12,84,16,4,'#FEBE7D'],
      [8,88,24,4,'#FEBE7D'],
      [8,92,32,4,'#FEBE7D'],
      [12,96,28,4,'#FEBE7D'],
      [20,100,20,4,'#FEBE7D'],
    ],
    wingR: [
      [140,72,8,4,'#FEBE7D'],
      [136,76,16,4,'#FEBE7D'],
      [136,80,16,4,'#FEBE7D'],
      [132,84,20,4,'#FEBE7D'],
      [128,88,28,4,'#FEBE7D'],
      [124,92,32,4,'#FEBE7D'],
      [124,96,28,4,'#FEBE7D'],
      [124,100,20,4,'#FEBE7D'],
    ],
    footA: [
      [52,124,12,4,'#F77C31'],
      [52,128,12,4,'#F77C31'],
    ],
    footB: [
      [92,124,12,4,'#E06A2A'],
    ],
  },
  peek: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,44,4,'#FFE395'],
      [84,60,20,4,'#1D1414'],
      [104,60,20,4,'#FFE395'],
      [40,64,4,4,'#FFE395'],
      [44,64,24,4,'#1D1414'],
      [68,64,56,4,'#FFE395'],
      [36,68,92,4,'#FFE395'],
      [36,72,92,4,'#FFE395'],
      [36,76,16,4,'#FFE395'],
      [64,76,24,4,'#FFE395'],
      [100,76,28,4,'#FFE395'],
      [36,80,16,4,'#FFE395'],
      [64,80,24,4,'#FFE395'],
      [100,80,28,4,'#FFE395'],
      [36,84,16,4,'#FFE395'],
      [64,84,24,4,'#FFE395'],
      [100,84,28,4,'#FFE395'],
      [36,88,92,4,'#FFE395'],
      [36,92,20,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,40,4,'#FFE395'],
      [36,96,4,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,32,4,'#FFE395'],
      [32,100,68,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [52,104,48,4,'#F77C31'],
      [100,104,12,4,'#FFE395'],
      [56,108,40,4,'#F77C31'],
      [96,108,12,4,'#FFE395'],
      [56,112,28,4,'#F77C31'],
      [84,112,24,4,'#FFE395'],
      [56,116,52,4,'#FFE395'],
    ],
    eyes: [
      [52,76,12,4,'#1D1414'],
      [88,76,12,4,'#1D1414'],
      [52,80,12,4,'#1D1414'],
      [88,80,12,4,'#1D1414'],
      [52,84,12,4,'#1D1414'],
      [88,84,12,4,'#1D1414'],
    ],
    paw: [
      [28,104,24,4,'#FEBE7D'],
      [112,104,24,4,'#FEBE7D'],
      [28,108,28,4,'#FEBE7D'],
      [108,108,28,4,'#FEBE7D'],
      [28,112,28,4,'#FEBE7D'],
      [108,112,28,4,'#FEBE7D'],
      [32,116,24,4,'#FEBE7D'],
      [108,116,24,4,'#FEBE7D'],
    ],
  },
  draw: {
    body: [
      [76,24,8,4,'#FFE395'],
      [60,28,8,4,'#FFE395'],
      [76,28,8,4,'#FFE395'],
      [92,28,8,4,'#FFE395'],
      [64,32,8,4,'#FFE395'],
      [76,32,8,4,'#FFE395'],
      [88,32,8,4,'#FFE395'],
      [68,36,24,4,'#FFE395'],
      [68,40,24,4,'#FFE395'],
      [44,44,76,4,'#FFE395'],
      [44,48,76,4,'#FFE395'],
      [44,52,76,4,'#FFE395'],
      [44,56,76,4,'#FFE395'],
      [40,60,84,4,'#FFE395'],
      [40,64,84,4,'#FFE395'],
      [36,68,12,4,'#FFE395'],
      [48,68,20,4,'#1D1414'],
      [68,68,52,4,'#FFE395'],
      [36,72,48,4,'#FFE395'],
      [84,72,16,4,'#1D1414'],
      [100,72,20,4,'#FFE395'],
      [36,76,84,4,'#FFE395'],
      [36,80,84,4,'#FFE395'],
      [36,84,84,4,'#FFE395'],
      [124,84,4,4,'#FFE395'],
      [36,88,20,4,'#FFE395'],
      [64,88,28,4,'#FFE395'],
      [100,88,20,4,'#FFE395'],
      [124,88,4,4,'#FFE395'],
      [40,92,16,4,'#FFE395'],
      [56,92,32,4,'#F77C31'],
      [88,92,4,4,'#FFE395'],
      [100,92,16,4,'#FFE395'],
      [120,92,8,4,'#FFE395'],
      [40,96,56,4,'#F77C31'],
      [96,96,32,4,'#FFE395'],
      [40,100,60,4,'#F77C31'],
      [100,100,24,4,'#FFE395'],
      [32,104,68,4,'#F77C31'],
      [100,104,24,4,'#FFE395'],
      [36,108,60,4,'#F77C31'],
      [96,108,24,4,'#FFE395'],
      [44,112,4,4,'#FFE395'],
      [48,112,36,4,'#F77C31'],
      [84,112,36,4,'#FFE395'],
      [44,116,12,4,'#FFE395'],
      [56,116,24,4,'#FD543D'],
      [80,116,40,4,'#FFE395'],
      [44,120,20,4,'#FFE395'],
      [64,120,12,4,'#FD543D'],
      [76,120,44,4,'#FFE395'],
      [56,124,12,4,'#F77C31'],
      [92,124,12,4,'#F77C31'],
      [56,128,12,4,'#F77C31'],
      [92,128,12,4,'#F77C31'],
    ],
    eyes: [
      [56,88,8,4,'#1D1414'],
      [92,88,8,4,'#1D1414'],
      [92,92,8,4,'#1D1414'],
    ],
    wingL: [
      [12,80,16,4,'#FEBE7D'],
      [8,84,24,4,'#FEBE7D'],
      [8,88,28,4,'#FEBE7D'],
      [8,92,32,4,'#FEBE7D'],
      [12,96,28,4,'#FEBE7D'],
      [20,100,20,4,'#FEBE7D'],
    ],
    wingR: [
      [132,52,8,4,'#FEBE7D'],
      [128,56,16,4,'#FEBE7D'],
      [128,60,20,4,'#FEBE7D'],
      [124,64,28,4,'#FEBE7D'],
      [124,68,32,4,'#FEBE7D'],
      [124,72,32,4,'#FEBE7D'],
      [124,76,28,4,'#FEBE7D'],
      [128,80,20,4,'#FEBE7D'],
    ],
    pen: [
      [144,12,8,4,'#1D1414'],
      [144,16,8,4,'#1D1414'],
      [140,20,8,4,'#1D1414'],
      [140,24,8,4,'#1D1414'],
      [136,28,8,4,'#1D1414'],
      [136,32,8,4,'#1D1414'],
      [132,36,8,4,'#1D1414'],
      [132,40,8,4,'#1D1414'],
      [128,44,8,4,'#1D1414'],
      [128,48,8,4,'#1D1414'],
      [124,52,8,4,'#1D1414'],
      [124,56,4,4,'#1D1414'],
      [124,60,4,4,'#1D1414'],
      [120,68,4,4,'#1D1414'],
      [120,72,4,4,'#1D1414'],
      [120,76,4,4,'#1D1414'],
      [120,80,8,4,'#1D1414'],
      [120,84,4,4,'#1D1414'],
      [120,88,4,4,'#1D1414'],
      [116,92,4,4,'#1D1414'],
    ],
  },
};

/** Poses whose eyes are already shut must not blink. */
const CAN_BLINK: Record<MascotMood, boolean> = {
  idle: true,
  happy: true,
  sleep: false,
  music: false,
  review: true,
  jump: true,
  walk: true,
  peek: true,
  draw: true,
};

/* Keyframes live inside the SVG so the component stays drop-in: no edits to
   globals.css, no class-name collisions with the rest of the app. */
const ANIM_CSS = `
.mascot-bob { animation: mascot-bob 2.4s steps(1, end) infinite; }
.mascot-blink { animation: mascot-blink 5.2s steps(1, end) infinite; }
.mascot-wing-l { animation: mascot-flap 1.6s steps(1, end) infinite; }
.mascot-wing-r { animation: mascot-flap 1.6s steps(1, end) infinite 0.1s; }
.mascot-float { animation: mascot-drift 2.8s steps(6, end) infinite; }
.mascot-pen { animation: mascot-jot 0.9s steps(1, end) infinite; }
.mascot-foot-a { animation: mascot-stride 0.9s steps(1, end) infinite; }
.mascot-foot-b { animation: mascot-stride 0.9s steps(1, end) infinite 0.45s; }

@keyframes mascot-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}
@keyframes mascot-blink {
  0%, 93%, 100% { opacity: 1; }
  94%, 97% { opacity: 0; }
}
@keyframes mascot-flap {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}
@keyframes mascot-drift {
  0% { transform: translate(0, 0); opacity: 0; }
  20% { opacity: 1; }
  100% { transform: translate(12px, -32px); opacity: 0; }
}
@keyframes mascot-jot {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(-4px, 4px); }
}
@keyframes mascot-stride {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
@media (prefers-reduced-motion: reduce) {
  .mascot-bob, .mascot-blink, .mascot-wing-l, .mascot-wing-r, .mascot-float,
  .mascot-pen, .mascot-foot-a, .mascot-foot-b, .mascot-hover,
  .mascot-walker {
    animation: none;
  }
}
`;

/* Used by the <img> variant, so it lives in its own block. */
const HOVER_CSS = `
.mascot-hover { animation: mascot-hover 3.2s steps(1, end) infinite; }
@keyframes mascot-hover {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
@media (prefers-reduced-motion: reduce) { .mascot-hover { animation: none; } }
`;

/* The walker slides across its track in whole-cell steps, so it never looks
   like a smoothly gliding vector sprite. */
const WALK_CSS = `
.mascot-track { position: relative; display: block; width: 100%; overflow: hidden; }
.mascot-walker {
  position: absolute;
  bottom: 0;
  left: 0;
  animation-name: mascot-walk-across;
  animation-timing-function: steps(28, end);
  animation-iteration-count: infinite;
}
@keyframes mascot-walk-across {
  0% { left: -16%; }
  100% { left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .mascot-walker { left: 42%; animation: none; }
}
`;

function Rects({ list }: { list?: readonly PxRect[] }) {
  if (!list) return null;
  return (
    <>
      {list.map(([x, y, w, h, fill], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
      ))}
    </>
  );
}

export function PixelMascot({
  side = 'right',
  size = 96,
  className,
  mood = 'idle',
  title,
  animate = true,
  render = 'svg',
  float = false,
}: PixelMascotProps) {
  const height = Math.round((size * VIEW_H) / VIEW_W);
  const pose = POSES[mood] ?? POSES.idle;
  const on = (name: string) => (animate ? name : undefined);

  /* ---- GIF variant: the same sprite, pre-rendered frame by frame ----
     A GIF cannot be paused by CSS, so `animate={false}` deliberately falls
     back to the static SVG instead of shipping a moving image to someone who
     asked for stillness. */
  if (render === 'gif' && animate) {
    const img = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={GIF_SRC[mood] ?? GIF_SRC.idle}
        width={size}
        height={height}
        alt={title ?? ''}
        aria-hidden={title ? undefined : true}
        className={['px-art', className].filter(Boolean).join(' ')}
        style={side === 'left' ? { transform: 'scaleX(-1)' } : undefined}
      />
    );
    if (!float) return img;
    return (
      <span className="mascot-hover-wrap" style={{ display: 'inline-block' }}>
        <style>{HOVER_CSS}</style>
        {img}
      </span>
    );
  }

  return (
    <svg
      className={['px-art', className].filter(Boolean).join(' ')}
      width={size}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      shapeRendering="crispEdges"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={side === 'left' ? { transform: 'scaleX(-1)' } : undefined}
    >
      {title ? <title>{title}</title> : null}
      {animate ? <style>{ANIM_CSS}</style> : null}
      <Rects list={pose.rope} />
      <g className={on('mascot-bob')}>
        <Rects list={pose.body} />
        <g className={on('mascot-wing-l')}><Rects list={pose.wingL} /></g>
        <g className={on('mascot-wing-r')}><Rects list={pose.wingR} /></g>
        <g className={on(CAN_BLINK[mood] ? 'mascot-blink' : '')}>
          <Rects list={pose.eyes} />
        </g>
        <g className={on('mascot-foot-a')}><Rects list={pose.footA} /></g>
        <g className={on('mascot-foot-b')}><Rects list={pose.footB} /></g>
        <g className={on('mascot-pen')}><Rects list={pose.pen} /></g>
      </g>
      <g className={on('mascot-float')}>
        <Rects list={pose.float} />
      </g>
      <Rects list={pose.paw} />
    </svg>
  );
}

/* =====================================================================
 * Placement helpers
 *
 * PixelMascot never positions itself, which is correct for a component you
 * drop into arbitrary layouts — but "walking along a line" and "peeking over
 * an edge" need more than a mood, so they ship as tiny wrappers.
 * ===================================================================== */

export interface PixelMascotWalkProps {
  /** Rendered width of the duck in px. Defaults to 64. */
  size?: number;
  /** Seconds for one full crossing. Defaults to 16. */
  duration?: number;
  /** Walk the other way (right to left). Defaults to false. */
  reverse?: boolean;
  /** Put this on a wrapper; the track itself is always full width. */
  className?: string;
  /** Optional accessible label. Decorative by default. */
  title?: string;
  /** Optional caption rendered on the track, e.g. a divider label. */
  children?: ReactNode;
}

/**
 * A duck walking along a line. Drop it above a divider:
 *
 *   <div className="relative">
 *     <PixelMascotWalk size={56} />
 *     <hr />
 *   </div>
 *
 * The track is `width:100%` and clips, so nothing ever sticks out of the
 * layout. Motion is stepped, and it parks in the middle under reduced motion.
 */
export function PixelMascotWalk({
  size = 64,
  duration = 16,
  reverse = false,
  className,
  title,
  children,
}: PixelMascotWalkProps) {
  const cell = size / GRID_W;
  /* the walk sprite leaves 1 empty row(s) under its feet; trim the
     track by that much so it steps ON the line rather than above it. */
  const height = Math.round((size * VIEW_H) / VIEW_W) - Math.round(PAD_WALK * cell);
  const walkerStyle: CSSProperties = {
    animationDuration: `${duration}s`,
    animationDirection: reverse ? 'reverse' : 'normal',
  };
  return (
    <span
      className={['mascot-track', className].filter(Boolean).join(' ')}
      style={{ height }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <style>{WALK_CSS}</style>
      {children ? (
        <span className="mascot-track-label" style={{ position: 'absolute', left: 0, bottom: 0 }}>
          {children}
        </span>
      ) : null}
      <span className="mascot-walker" style={walkerStyle}>
        <PixelMascot mood="walk" size={size} animate title={undefined} />
      </span>
    </span>
  );
}

export interface PixelMascotPeekProps {
  /** Rendered width in px. Defaults to 72. */
  size?: number;
  /** Which side of the edge it hauls itself up on. Defaults to 'left'. */
  side?: MascotSide;
  /** Extra classes for fine-tuning. */
  className?: string;
  /** Optional accessible label. Decorative by default. */
  title?: string;
  /** Override the animation. */
  animate?: boolean;
}

/**
 * A duck peeking over a surface. The sprite is already cut flat at the waist
 * with both paws hooked on the line, so you only need to sit it on top of an
 * edge — no clipping required:
 *
 *   <section style={{ position: 'relative' }}>
 *     <PixelMascotPeek size={80} side="right" />
 *     ...panel content...
 *   </section>
 *
 * It is absolutely positioned against the nearest positioned ancestor and
 * hangs one cell below the top edge so the paws appear to grip it.
 */
export function PixelMascotPeek({
  size = 72,
  side = 'left',
  className,
  title,
  animate = true,
}: PixelMascotPeekProps) {
  /* One source cell in rendered px. The sprite's own bottom N rows are empty,
     so pull it down by exactly those rows — then the paws land ON the edge
     instead of hovering above it. */
  const cell = size / GRID_W;
  const style: CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    marginBottom: -PAD_PEEK * cell,
    width: size,
    [side]: 0,
    pointerEvents: 'none',
  } as CSSProperties;
  return (
    <span className={['mascot-peek', className].filter(Boolean).join(' ')} style={style}>
      <PixelMascot mood="peek" size={size} side={side} animate={animate} title={title} />
    </span>
  );
}

export default PixelMascot;
