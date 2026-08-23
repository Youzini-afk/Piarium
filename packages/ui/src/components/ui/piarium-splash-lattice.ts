import { markBox } from './piarium-mark-perspective';
import {
  CAMERA_FLOOR_TRANSFORM,
  floorInscribedRadius,
  floorReach,
  HORIZON_RISE_PX,
} from './piarium-splash-camera';

/**
 * The splash floor: a grid put into the camera's floor plane, with the cube standing on one of its cells.
 *
 * The floor and the mark agree because neither owns any geometry of its own. The floor receives the
 * camera as a CSS transform, the mark is projected through the same camera into SVG, and a cell is
 * exactly the cube's edge with the cube's base centred on one cell, so the cube's footprint *is* a floor
 * cell and the lines leaving its base corners are the floor's own lines. Three earlier attempts each
 * failed at that seam; there is no seam left to fail at.
 *
 * The floor keeps the default flat `transform-style`, so its cells are rasterised once and mapped by a
 * single projective transform. That is what makes perspective cost the same as the isometric version it
 * replaces, rather than promoting several hundred cells into a 3D rendering context during startup, when
 * the machine is already at its busiest.
 */

export type PiariumSplashMode = 'boot' | 'switch';
export type PiariumSplashDirection = 'forward' | 'backward';

/**
 * Cube edge in pixels, and therefore the floor's cell size, which is what registers the two.
 *
 * One value for every viewport, not a breakpoint pair. A floor cell is a size in the scene, so on a
 * narrow viewport the right answer is fewer cells on screen rather than smaller ones — and a fixed edge
 * is what lets the two hosts that cannot run the projection embed an exact cube instead of a resized
 * approximation of one, since a perspective drawing does not survive being scaled.
 */
export const CUBE_EDGE_PX = 96;

/**
 * Cells behind the cube and in front of it, along each floor axis.
 *
 * Wildly asymmetric on purpose. Receding cells compress toward the horizon, so covering the screen above
 * the origin takes many of them; approaching cells magnify, so a few cover everything below. Stretching
 * the floor equally in both directions would push its near corner through the camera and invert it.
 *
 * `BEHIND` stops well short of the horizon, because the rows there are already about a tenth as tall on
 * screen as the first one and hundreds more would buy nothing. The floor is faded out before that edge
 * instead — see `GROUND_FADE_RISE_PX`.
 *
 * `AHEAD` has a hard ceiling near thirteen: past that the near corner passes the camera plane, the
 * projection divides by zero and the image turns inside out. Nine leaves room and still puts the near
 * corner well below any window's bottom edge.
 *
 * Together these cover roughly 2700 by 4600 CSS pixels of window at 576 cells, which is the same element
 * count the isometric version reached at its largest.
 */
const GROUND_CELLS_BEHIND = 14;
const GROUND_CELLS_AHEAD = 9;

/** Cells per axis: the ones behind, the cube's own, and the ones in front. */
const GROUND_AXIS = GROUND_CELLS_BEHIND + 1 + GROUND_CELLS_AHEAD;
/** Floor-space extent from the origin, in each of the two directions. */
const GROUND_BEHIND_PX = (GROUND_CELLS_BEHIND + 0.5) * CUBE_EDGE_PX;
const GROUND_AHEAD_PX = (GROUND_CELLS_AHEAD + 0.5) * CUBE_EDGE_PX;

/** Where the cube stands, as a share of viewport height. Low enough to leave the far floor room. */
const GROUND_ORIGIN_Y_PCT = 56;

export interface GroundShape {
  /** Cells per axis. */
  readonly axis: number;
  /** Cell edge in pixels, equal to the cube's edge. */
  readonly cellPx: number;
  /** Zero-based row and column of the cell the cube stands on. */
  readonly originCell: number;
  /**
   * Pre-transform offset that puts the cube's base centre on the floor's origin.
   *
   * Half a cell past a whole number of cells, because the cube's base is centred on the origin, so the
   * origin has to be a cell's centre and not a corner. Anchoring on a corner instead is what made the
   * cube straddle four cells in an earlier attempt.
   */
  readonly offsetPx: number;
}

/**
 * The floor, fixed rather than measured.
 *
 * Nothing here depends on the viewport. The floor is deliberately larger than any window it has to
 * cover, so resizing reveals a different part of the same grid instead of rebuilding it, and the two
 * hosts that paint before any module is evaluated can embed the same numbers as the two that import
 * them. `piarium-splash-lattice.test.ts` checks the coverage claim against the camera.
 */
export const GROUND_SHAPE: GroundShape = {
  axis: GROUND_AXIS,
  cellPx: CUBE_EDGE_PX,
  originCell: GROUND_CELLS_BEHIND,
  offsetPx: GROUND_BEHIND_PX,
};

/** How far the floor's extremes land from the origin on screen, under the shared camera. */
export const GROUND_REACH = floorReach(GROUND_BEHIND_PX, GROUND_AHEAD_PX);

/**
 * Where the floor stops being drawn and where it starts fading into the background, both as screen pixels
 * above the origin.
 *
 * The far edge is a real edge, and on a tall window it lands mid-screen, so it has to be faded rather
 * than merely masked at the periphery. The ramp covers the last few rows, which are the ones already too
 * compressed to read as separate cells — which is what a horizon looks like anyway.
 */
const GROUND_FADE_ROWS = 4;
export const GROUND_EDGE_RISE_PX = GROUND_REACH.farRise;
export const GROUND_FADE_RISE_PX = floorReach(
  GROUND_BEHIND_PX - GROUND_FADE_ROWS * CUBE_EDGE_PX,
  GROUND_AHEAD_PX,
).farRise;

/**
 * How far from the cube's feet the exit reveals the app one cell at a time.
 *
 * The floor's cells are the cover inside this radius: they are opaque, so as each one shrinks away the
 * app shows through the hole it leaves. That only works where the screen is actually paved with cells at
 * full opacity, which bounds the radius twice over — by the floor's projected outline, which is a
 * quadrilateral and cannot reach the corners of a rectangular window, and by the horizon ramp, past which
 * the cells are no longer opaque enough to hide anything.
 *
 * Beyond it the backdrop is the cover and resolves with a fade instead. That is the same region the
 * peripheral falloff already treats as atmosphere, so a soft edge there is in keeping.
 */
export const GROUND_REVEAL_RADIUS_PX = Math.floor(Math.min(
  floorInscribedRadius(GROUND_BEHIND_PX, GROUND_AHEAD_PX),
  GROUND_FADE_RISE_PX,
));

const CELL_EXIT_MS = 520;
const MARK_EXIT_MS = 520;
/** The cube makes contact before the first floor tile starts moving. */
const BOOT_PRESS_LEAD_MS = 240;
/** Widest per-cell delay either mode schedules. */
const MAX_CELL_DELAY_MS = 520;

/** How long a caller must keep the splash mounted after asking it to leave. */
export const SPLASH_EXIT_DURATION_MS = BOOT_PRESS_LEAD_MS
  + MAX_CELL_DELAY_MS
  + Math.max(CELL_EXIT_MS, MARK_EXIT_MS);
/** The reduced-motion path replaces every staged animation with one fade of the whole cover. */
export const SPLASH_REDUCED_EXIT_DURATION_MS = 260;

/**
 * The reveal's own timings.
 *
 * The hole opens roughly as fast as the cell wave travels, so a cell has usually gone by the time the
 * hole reaches it; the backdrop then fades once the hole has stopped growing, and finishes before the
 * outermost cells do, so those are seen coming apart against the app rather than against flat colour.
 */
const REVEAL_MS = 480;
const BACKDROP_FADE_MS = 260;
/** Soft edge on the hole. Wide enough not to read as a circle, narrow enough not to leak past the cells. */
const REVEAL_EDGE_PX = 64;

/** Fraction of cells that join the idle breathing. */
const BREATHE_SHARE = 0.1;
const BREATHE_SPREAD_MS = 2200;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface SplashCell {
  readonly key: string;
  readonly delayMs: number;
  readonly breatheDelayMs: number | null;
  /** Floor-space displacement during exit. The camera projects it with the tile, so it stays on-plane. */
  readonly scatterXPx: number;
  readonly scatterYPx: number;
}

/**
 * Per-cell exit delay.
 *
 * `boot` radiates from the cell the cube stands on, so the floor comes apart outward from its feet.
 * Measured in floor space, so under perspective the wavefront races away toward the horizon rather than
 * expanding as a flat circle on screen.
 *
 * `switch` sweeps along one floor axis and flips with the direction, so switching back is visibly the
 * reverse of switching forward. A slight cross-axis skew keeps the sweep from landing as one hard edge.
 */
export const buildSplashCells = (
  mode: PiariumSplashMode,
  direction: PiariumSplashDirection,
  breathe: boolean,
  random: () => number = Math.random,
): SplashCell[] => {
  const { axis, originCell } = GROUND_SHAPE;
  const cells: SplashCell[] = [];
  // The cube does not stand in the middle of the grid, so the furthest cell from it is whichever corner
  // is furthest — which is the one diagonally behind it.
  const maxRadius = Math.hypot(
    Math.max(originCell, axis - 1 - originCell),
    Math.max(originCell, axis - 1 - originCell),
  ) || 1;
  const skew = 0.22;

  for (let row = 0; row < axis; row += 1) {
    for (let col = 0; col < axis; col += 1) {
      let fraction: number;
      if (mode === 'boot') {
        fraction = Math.hypot(col - originCell, row - originCell) / maxRadius;
      } else {
        const along = direction === 'forward' ? col : axis - 1 - col;
        fraction = (along + row * skew) / (axis * (1 + skew));
      }
      const dx = col - originCell;
      const dy = row - originCell;
      const radius = Math.hypot(dx, dy);
      let scatterXPx: number;
      let scatterYPx: number;
      if (mode === 'boot') {
        // Nearby tiles move just enough to expose the app; tiles further out travel farther so the floor
        // opens like a field of diamonds rather than collapsing into a small circular dimple. The motion
        // is authored in floor space and projected once by the parent camera.
        const magnitude = radius === 0
          ? 0
          : CUBE_EDGE_PX * (0.18 + 0.36 * clamp(radius / 6, 0, 1));
        scatterXPx = radius === 0 ? 0 : Math.round((dx / radius) * magnitude);
        scatterYPx = radius === 0 ? 0 : Math.round((dy / radius) * magnitude);
      } else {
        // A profile change keeps its directional sweep instead of borrowing the startup's radial burst.
        scatterXPx = Math.round(CUBE_EDGE_PX * 0.28) * (direction === 'forward' ? 1 : -1);
        scatterYPx = 0;
      }
      cells.push({
        key: `${row}-${col}`,
        delayMs: Math.round(clamp(fraction, 0, 1) * MAX_CELL_DELAY_MS),
        breatheDelayMs: breathe && random() < BREATHE_SHARE
          ? Math.round(random() * BREATHE_SPREAD_MS)
          : null,
        scatterXPx,
        scatterYPx,
      });
    }
  }

  return cells;
};

/**
 * Geometry for the floor element.
 *
 * `transform-origin: 0 0` pins the element's own origin wherever the stylesheet positions it, and the
 * translate, applied before the camera, slides the grid so the cube's cell centre is the point that
 * lands there.
 */
const GROUND_STYLE = {
  gridTemplateColumns: `repeat(${GROUND_SHAPE.axis}, ${GROUND_SHAPE.cellPx}px)`,
  gridTemplateRows: `repeat(${GROUND_SHAPE.axis}, ${GROUND_SHAPE.cellPx}px)`,
  transform: `${CAMERA_FLOOR_TRANSFORM} translate(${-GROUND_SHAPE.offsetPx}px, ${-GROUND_SHAPE.offsetPx}px)`,
} as const;

export interface SplashPlaneColors {
  /**
   * The cover's own background. Not optional: a splash whose job is to hide an unpainted frame cannot
   * be transparent, and each host's background comes from a different source.
   */
  readonly background: string;
  /** Floor line colour. Strong enough to read: an early attempt used 12% and vanished. */
  readonly line: string;
  /** Fill a breathing cell reaches at the top of its pulse. */
  readonly cell: string;
  /**
   * Ink for the mark and the status line. Omitted by hosts that draw no mark, which is also the only
   * case where it goes unused.
   */
  readonly stroke?: string;
}

/**
 * Piarium's own splash palette.
 *
 * Every colour is a `--splash-*` custom property that `packages/web/index.html` sets before paint from
 * the persisted theme. Reading the live theme instead would let the mark follow a theme change that the
 * floor and the background could not, and a cover that is half one palette and half another looks broken
 * in a way that a cover uniformly in one palette does not.
 *
 * Shared rather than restated per host so the two that embed generated output can be compared against
 * it exactly.
 */
export const PIARIUM_SPLASH_COLORS: SplashPlaneColors = {
  background: 'var(--splash-background, var(--color-background, #151313))',
  line: 'var(--splash-lattice-line, rgba(255, 255, 255, 0.22))',
  // Kept faint, and opaque: the cells are the cover, so a translucent pulse would open a hole in it at
  // every peak. The token is the background with a little ink mixed in rather than ink over transparency,
  // and the fallback is the plain background, so a host that forgets to define it loses the pulse instead
  // of the cover.
  cell: 'var(--splash-cell-pulse, var(--splash-background, #151313))',
  stroke: 'var(--splash-stroke)',
};

/** The same palette, as the projected mark needs it. */
export const PIARIUM_MARK_COLORS = {
  stroke: 'var(--splash-stroke)',
  faceFill: 'var(--splash-face-fill)',
  cellFill: 'var(--splash-cell-fill)',
  // The faces are translucent washes, so the floor would otherwise show straight through the cube.
  occlusionFill: PIARIUM_SPLASH_COLORS.background,
} as const;

/**
 * The splash's visual rules, as one string.
 *
 * Four surfaces paint a splash and only two of them can import anything, so the rules would otherwise
 * exist in four hand-maintained copies. The React component and the VS Code webview call this;
 * `index.html` and `mini-chat.html` embed its output verbatim, and the geometry tests assert those copies
 * still equal it exactly.
 *
 * Emitted without leading indentation so an embedded copy can match character for character.
 */
export const splashPlaneCss = (
  colors: SplashPlaneColors,
  options: { withMark: boolean },
): string => {
  const ink = colors.stroke ?? colors.line;
  const projectedMark = options.withMark ? markBox(CUBE_EDGE_PX) : null;

  const markRules = options.withMark
    ? `
/* The mark is placed by the cube's base centre, not by its box. Under perspective the projected cube is
   asymmetric — the near corner grows, the far corner shrinks — so the base centre is nowhere near the
   box's middle, and anchoring on the box or on its bottom edge is what left the cube hovering in three
   earlier attempts. The translate is measured from the projection, and it is a constant only because the
   cube's edge is. */
.pi-splash-mark {
position: absolute;
left: 50%;
top: ${GROUND_ORIGIN_Y_PCT}%;
translate: ${projectedMark?.originTranslate};
transform-origin: ${(projectedMark?.originFraction.x ?? 0) * 100}% ${(projectedMark?.originFraction.y ?? 0) * 100}%;
display: block;
line-height: 0;
}
/* The translate is a share of this box, so the box has to be exactly the drawing. An svg is inline by
   default, which puts it on a baseline with descender space under it, and the cube would then stand that
   many pixels above the floor for no visible reason. */
.pi-splash-mark svg {
display: block;
}
/* The glyph on the open top, breathing. The rest of the cube holds still: the mark is the one thing the
   eye is meant to settle on, and animating the faces as well made it restless. */
.pi-splash-glyph {
animation: pi-splash-glyph-pulse 1.8s ease-in-out infinite;
}
@keyframes pi-splash-glyph-pulse {
0%, 100% { filter: drop-shadow(0 0 0 transparent); }
50% { filter: drop-shadow(0 0 4px ${ink}); }
}
/* The one animated floor element during the wait state is the cube's own footprint. It is positioned in
   floor coordinates and receives the same camera as every cell, so the glyph pulse has a physical answer
   on the plane rather than a separate screen-space glow. */
.pi-splash:not([data-mode='switch']) .pi-splash-ground::after {
content: '';
position: absolute;
left: ${GROUND_SHAPE.offsetPx - CUBE_EDGE_PX / 2}px;
top: ${GROUND_SHAPE.offsetPx - CUBE_EDGE_PX / 2}px;
box-sizing: border-box;
width: ${CUBE_EDGE_PX}px;
height: ${CUBE_EDGE_PX}px;
pointer-events: none;
background: ${colors.background};
box-shadow: inset 0 0 0 1px ${ink};
opacity: 0.32;
animation: pi-splash-contact-pulse 1.8s ease-in-out infinite;
}
@keyframes pi-splash-contact-pulse {
0%, 100% { opacity: 0.22; background: ${colors.background}; }
50% { opacity: 0.72; background: ${colors.cell}; }
}
.pi-splash-status {
position: absolute;
left: 50%;
top: calc(${GROUND_ORIGIN_Y_PCT}% + 52px);
translate: -50% 0;
min-height: 1rem;
max-width: 32ch;
font-size: 11px;
font-weight: 600;
letter-spacing: 0.11em;
text-transform: uppercase;
text-align: center;
color: ${ink};
opacity: 0;
animation: pi-splash-status-in 480ms 700ms ease both;
}
@keyframes pi-splash-status-in { to { opacity: 0.5; } }
.pi-splash:not([data-mode='switch'])[data-leaving='true'] .pi-splash-mark {
animation: pi-splash-mark-press ${MARK_EXIT_MS}ms cubic-bezier(0.3, 0, 0.2, 1) both;
}
.pi-splash[data-mode='switch'][data-leaving='true'] .pi-splash-mark {
animation: pi-splash-mark-out ${MARK_EXIT_MS}ms 60ms cubic-bezier(0.4, 0, 0.3, 1) both;
}
.pi-splash[data-leaving='true'] .pi-splash-status {
animation: pi-splash-status-out 180ms ease both;
}
.pi-splash:not([data-mode='switch'])[data-leaving='true'] .pi-splash-ground::after {
animation: pi-splash-contact-press 360ms cubic-bezier(0.3, 0, 0.2, 1) both;
}
@keyframes pi-splash-mark-press {
0% { opacity: 1; transform: scaleX(1) scaleY(1); }
72% { opacity: 1; transform: scaleX(0.94) scaleY(0.18); }
100% { opacity: 0; transform: scaleX(0.9) scaleY(0.06); }
}
@keyframes pi-splash-contact-press {
0% { opacity: 0.35; transform: scale(1); }
55% { opacity: 0.9; transform: scale(0.72); }
100% { opacity: 0; transform: scale(0.24); }
}
@keyframes pi-splash-mark-out {
to { opacity: 0; }
}
@keyframes pi-splash-status-out {
to { opacity: 0; transform: translateY(5px); }
}`
    : '';

  const reducedMarkRules = options.withMark
    ? `,
.pi-splash[data-leaving='true'] .pi-splash-mark,
.pi-splash[data-leaving='true'] .pi-splash-status,
.pi-splash:not([data-mode='switch']) .pi-splash-ground::after,
.pi-splash-glyph,
.pi-splash-status`
    : '';

  const reducedStatusRule = options.withMark
    ? `
.pi-splash-status { opacity: 0.5; }`
    : '';

  // Percentages of the cover's own alpha would have to be re-derived per window; absolute radii keep the
  // plateau exactly as wide as the region the reveal is allowed to open, which is a fixed number of pixels.
  const falloff = [
    `rgba(0,0,0,1) ${GROUND_REVEAL_RADIUS_PX}px`,
    `rgba(0,0,0,0.55) ${GROUND_REVEAL_RADIUS_PX * 3}px`,
    `rgba(0,0,0,0.3) ${GROUND_REVEAL_RADIUS_PX * 5}px`,
  ].join(', ');
  const vignette = `radial-gradient(circle at 50% ${GROUND_ORIGIN_Y_PCT}%, ${falloff})`;
  const hole = `radial-gradient(circle at 50% ${GROUND_ORIGIN_Y_PCT}%, rgba(0,0,0,0) var(--pi-splash-open, 0px), rgba(0,0,0,1) calc(var(--pi-splash-open, 0px) + ${REVEAL_EDGE_PX}px))`;

  return `
.pi-splash {
position: fixed;
inset: 0;
z-index: 9998;
overflow: hidden;
}
.pi-splash[data-leaving='true'] { pointer-events: none; }

/* The cover is the floor's cells, not this element.
   That is the whole exit: each cell is opaque, so when one shrinks away the app shows through the gap it
   leaves, and the staggered delays turn that into a wave travelling out from the cube's feet. An opaque
   container would have made the same wave reveal nothing — the lines would vanish and the screen would
   stay a flat colour until the element was removed, which is a hard cut. */
/* A registered custom property, so it interpolates. Read with a zero fallback too: without @property the
   hole never opens and the backdrop resolves with its fade alone, which is the previous behaviour rather
   than a hole in the middle of the cover. */
@property --pi-splash-open {
syntax: '<length>';
inherits: false;
initial-value: 0px;
}
/* The floor is a quadrilateral in projection and a window is a rectangle, so the cells cannot cover the
   screen's corners. The backdrop covers everything they miss, and the hole opens from the cube's feet so
   that where the cells *are* the cover, they are the only cover. */
.pi-splash-backdrop {
position: absolute;
inset: 0;
background: ${colors.background};
-webkit-mask-image: ${hole};
mask-image: ${hole};
}
/* Boot only, which is also the default: the three hosts that paint before any module is evaluated set no
   mode, and boot is the only thing they cover. A profile switch sweeps its cells along one floor axis
   instead of radiating, so a hole opening from the middle would be travelling the wrong way; there the
   backdrop just fades and the sweep reads as a wipe over it. */
.pi-splash:not([data-mode='switch'])[data-leaving='true'] .pi-splash-backdrop {
animation:
pi-splash-open ${REVEAL_MS}ms ${BOOT_PRESS_LEAD_MS}ms cubic-bezier(0.25, 0.6, 0.3, 1) both,
pi-splash-backdrop-out ${BACKDROP_FADE_MS}ms ${BOOT_PRESS_LEAD_MS + REVEAL_MS}ms ease both;
}
.pi-splash[data-mode='switch'][data-leaving='true'] .pi-splash-backdrop {
animation: pi-splash-backdrop-out ${REVEAL_MS + BACKDROP_FADE_MS}ms ease both;
}
@keyframes pi-splash-open {
to { --pi-splash-open: ${GROUND_REVEAL_RADIUS_PX}px; }
}
@keyframes pi-splash-backdrop-out {
to { opacity: 0; }
}

/* Two fades, on two untransformed wrappers, because they answer two different questions and a mask
   applies in its own element's coordinate space. Masking the floor itself meant a local circle came out
   a sheared ellipse once the camera had run, and the screen's corners were cut first: the floor visibly
   stopped short of them. Nesting instead multiplies the two alphas without needing mask-composite. */
.pi-splash-ground-clip {
position: absolute;
inset: 0;
overflow: hidden;
-webkit-mask-image: ${vignette};
mask-image: ${vignette};
}
/* The horizon. Receding floor points crowd toward a line ${Math.round(HORIZON_RISE_PX)}px above the
   origin and never reach it, so a floor drawn to any finite depth always ends somewhere, and on a tall
   window that end lands mid-screen where the peripheral fade cannot reach it. Anchoring the ramp to the
   origin's own percentage keeps it in place at every window size. */
.pi-splash-horizon {
position: absolute;
inset: 0;
overflow: hidden;
-webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0) calc(${GROUND_ORIGIN_Y_PCT}% - ${Math.round(GROUND_EDGE_RISE_PX)}px), rgba(0,0,0,1) calc(${GROUND_ORIGIN_Y_PCT}% - ${Math.round(GROUND_FADE_RISE_PX)}px));
mask-image: linear-gradient(to bottom, rgba(0,0,0,0) calc(${GROUND_ORIGIN_Y_PCT}% - ${Math.round(GROUND_EDGE_RISE_PX)}px), rgba(0,0,0,1) calc(${GROUND_ORIGIN_Y_PCT}% - ${Math.round(GROUND_FADE_RISE_PX)}px));
}
/* Flat transform style on purpose: the cells are rasterised once and mapped by a single projective
   transform, rather than each becoming a participant in a 3D rendering context. */
.pi-splash-ground {
position: absolute;
left: 50%;
top: ${GROUND_ORIGIN_Y_PCT}%;
display: grid;
transform-origin: 0 0;
grid-template-columns: ${GROUND_STYLE.gridTemplateColumns};
grid-template-rows: ${GROUND_STYLE.gridTemplateRows};
transform: ${GROUND_STYLE.transform};
}
/* Opaque, because these cells are the cover. Two edges each, so neighbours do not stack into a 2px rule. */
.pi-splash-cell {
background: ${colors.background};
box-shadow: inset -1px -1px 0 ${colors.line};
transform-origin: center;
}
/* Idle breathing starts late on purpose: a fast start never reaches it, so it only ever appears when
   there is genuinely something to wait for. Both ends are opaque colours: a translucent pulse would have
   punched a hole in the cover for half of every cycle. */
.pi-splash-cell[data-breathe='true'] {
animation: pi-splash-breathe 2.8s ease-in-out infinite;
animation-delay: calc(1.2s + var(--pi-breathe-delay));
}
@keyframes pi-splash-breathe {
0%, 100% { background: ${colors.background}; }
50% { background: ${colors.cell}; }
}
/* Declared after the breathing rule so equal specificity lets the exit win without !important. */
.pi-splash[data-leaving='true'] .pi-splash-cell {
animation: pi-splash-cell-out ${CELL_EXIT_MS}ms cubic-bezier(0.32, 0, 0.24, 1) both;
animation-delay: var(--pi-cell-delay);
}
.pi-splash:not([data-mode='switch'])[data-leaving='true'] .pi-splash-cell {
animation-delay: calc(var(--pi-cell-delay) + ${BOOT_PRESS_LEAD_MS}ms);
}
/* Each cell moves in the floor's own coordinate system before the parent camera projects it. On screen
   the squares therefore stay registered as perspective diamonds while the wave pushes them away from the
   cube's footprint. Opacity holds for the first half so the separation is visible before they dissolve. */
@keyframes pi-splash-cell-out {
0% { background: ${colors.background}; }
32%, 55% { opacity: 1; background: ${colors.cell}; }
to {
opacity: 0;
background: ${colors.cell};
transform: translate(var(--pi-cell-scatter-x, 0px), var(--pi-cell-scatter-y, 0px)) scale(0.56);
}
}
${markRules}

/* Reduced motion drops the staged animation for one fade of the whole cover. It must still show the
   cover: hiding it would put the unpainted first frame back. */
@media (prefers-reduced-motion: reduce) {
.pi-splash-cell,
.pi-splash[data-leaving='true'] .pi-splash-cell,
.pi-splash[data-leaving='true'] .pi-splash-backdrop,
.pi-splash:not([data-mode='switch'])[data-leaving='true'] .pi-splash-backdrop${reducedMarkRules} {
animation: none;
}${reducedStatusRule}
.pi-splash { transition: opacity ${SPLASH_REDUCED_EXIT_DURATION_MS}ms ease; }
.pi-splash[data-leaving='true'] { opacity: 0; }
}
`;
};

/**
 * A deterministic stand-in for `Math.random`, so the emitted pre-paint script is stable.
 *
 * Regenerating the embedded copies has to produce the same bytes or every regeneration would show up as
 * a diff and the verbatim-copy tests would fail for no reason. A plain multiplicative generator is
 * enough: the only thing riding on it is which tenth of the cells breathe.
 */
const stableRandom = (): (() => number) => {
  let state = 0x2f6e2b1;
  return () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
};

/**
 * The pre-paint script that fills the floor, for hosts that build their document as text.
 *
 * `index.html` and `mini-chat.html` embed this verbatim and the geometry tests assert the copies still
 * match. The cell attributes are baked from `buildSplashCells` rather than recomputed in the emitted
 * script: the delay pattern is the one thing that visibly ties the floor's exit to the cube it radiates
 * from, and a second implementation of it in a string is exactly how that drifts.
 *
 * The cells are emitted by a script rather than as markup because five hundred spans of literal HTML in
 * two files is a worse thing to maintain than one generated line, and the script is synchronous in
 * `body`, so the floor is still there for the first paint.
 */
export const splashGroundScript = (elementId: string): string => {
  const cells = buildSplashCells('boot', 'forward', true, stableRandom());
  const delays = cells.map((cell) => cell.delayMs).join(',');
  const breathes = cells.map((cell) => cell.breatheDelayMs ?? -1).join(',');
  const scatterXs = cells.map((cell) => cell.scatterXPx).join(',');
  const scatterYs = cells.map((cell) => cell.scatterYPx).join(',');

  return `(function(){
var ground=document.getElementById('${elementId}');
if(!ground)return;
var delays=[${delays}];
var breathes=[${breathes}];
var scatterXs=[${scatterXs}];
var scatterYs=[${scatterYs}];
var buffer='';
for(var i=0;i<delays.length;i++){
var style='--pi-cell-delay:'+delays[i]+'ms;--pi-cell-scatter-x:'+scatterXs[i]+'px;--pi-cell-scatter-y:'+scatterYs[i]+'px';
if(breathes[i]>=0)style+=';--pi-breathe-delay:'+breathes[i]+'ms';
buffer+='<span class="pi-splash-cell" data-breathe="'+(breathes[i]>=0?'true':'false')+'" style="'+style+'"></span>';
}
ground.innerHTML=buffer;
})();`;
};
