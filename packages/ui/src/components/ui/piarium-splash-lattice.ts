import { LOGO_COS30, LOGO_SIN30 } from './piarium-logo-geometry';

/**
 * Lattice sizing and exit choreography for the splash.
 *
 * Kept out of the component file so the geometry can be tested directly, and because a module that
 * exports both a component and plain functions defeats fast refresh.
 */

export type PiariumSplashMode = 'boot' | 'switch';
export type PiariumSplashDirection = 'forward' | 'backward';

/** Target on-screen cell edge. Larger on a pointer-sized viewport so the lattice stays legible. */
const CELL_TARGET_DESKTOP = 86;
const CELL_TARGET_COMPACT = 62;
const MIN_AXIS_CELLS = 4;
const MAX_AXIS_CELLS = 16;

export const CELL_EXIT_MS = 400;
export const MARK_EXIT_MS = 420;
/** Widest per-cell delay either mode schedules. */
const MAX_CELL_DELAY_MS = 460;

/** How long a caller must keep the splash mounted after asking it to leave. */
export const SPLASH_EXIT_DURATION_MS = MAX_CELL_DELAY_MS + Math.max(CELL_EXIT_MS, MARK_EXIT_MS);
/** The reduced-motion path replaces every staged animation with one fade of the whole cover. */
export const SPLASH_REDUCED_EXIT_DURATION_MS = 260;

/** Fraction of cells that join the idle breathing. */
const BREATHE_SHARE = 0.12;
const BREATHE_SPREAD_MS = 2000;

export interface LatticeShape {
  readonly cols: number;
  readonly rows: number;
  readonly cellPx: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Size the lattice so the projected rhombus still covers the viewport.
 *
 * The isometric matrix sends a `w` by `h` rectangle to a rhombus `cos30 * (w + h)` wide and
 * `sin30 * (w + h)` tall, so satisfying both axes is what decides the side length. The extra factor
 * keeps the viewport's corners inside the rhombus rather than just its edges.
 */
export const resolveLatticeShape = (viewportWidth: number, viewportHeight: number): LatticeShape => {
  const cellPx = viewportWidth >= 768 ? CELL_TARGET_DESKTOP : CELL_TARGET_COMPACT;
  const required = Math.max(viewportWidth / LOGO_COS30, viewportHeight / LOGO_SIN30);
  const side = (required / 2) * 1.5;
  const axis = clamp(Math.round(side / cellPx), MIN_AXIS_CELLS, MAX_AXIS_CELLS);
  return { cols: axis, rows: axis, cellPx };
};

export interface SplashCell {
  readonly key: string;
  readonly delayMs: number;
  readonly breatheDelayMs: number | null;
}

/**
 * Per-cell exit delay.
 *
 * `boot` radiates from the centre, which is where the mark is, so the lattice falls away from it.
 * Because the delay is measured in lattice space and the lattice is sheared, the wavefront follows
 * the cube's own axes on screen rather than a screen-space circle.
 *
 * `switch` sweeps along one lattice axis and flips with the direction, so switching back is visibly
 * the reverse of switching forward. A slight row skew keeps the sweep from landing as one hard edge.
 */
export const buildSplashCells = (
  shape: LatticeShape,
  mode: PiariumSplashMode,
  direction: PiariumSplashDirection,
  breathe: boolean,
  random: () => number = Math.random,
): SplashCell[] => {
  const cells: SplashCell[] = [];
  const centerCol = (shape.cols - 1) / 2;
  const centerRow = (shape.rows - 1) / 2;
  const maxRadius = Math.hypot(centerCol, centerRow) || 1;
  const skew = 0.18;

  for (let row = 0; row < shape.rows; row += 1) {
    for (let col = 0; col < shape.cols; col += 1) {
      let fraction: number;
      if (mode === 'boot') {
        fraction = Math.hypot(col - centerCol, row - centerRow) / maxRadius;
      } else {
        const along = direction === 'forward' ? col : shape.cols - 1 - col;
        fraction = (along + row * skew) / (shape.cols + shape.rows * skew);
      }
      cells.push({
        key: `${row}-${col}`,
        delayMs: Math.round(clamp(fraction, 0, 1) * MAX_CELL_DELAY_MS),
        breatheDelayMs: breathe && random() < BREATHE_SHARE
          ? Math.round(random() * BREATHE_SPREAD_MS)
          : null,
      });
    }
  }

  return cells;
};
