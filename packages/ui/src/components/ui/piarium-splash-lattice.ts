/**
 * The splash ground plane: sizing, projection, and exit choreography.
 *
 * This began as an isometric lattice sharing the mark's own projection, on the theory that the cube
 * would read as a region of it. It did not. Isometric is an axonometric projection: parallel lines
 * stay parallel, there is no vanishing point, and cell density is uniform everywhere, so a screen
 * full of it reads as wallpaper rather than as space. Two further defects compounded it. The lattice
 * was sized to cover the viewport's edges but not its corners, so it ended in plain view as a
 * diamond. And a single faint line weight with no falloff gave the eye nothing to read depth from.
 *
 * So the plane is now genuinely perspectival. It converges, its cells foreshorten with distance, and
 * a radial mask both removes its real boundary and concentrates it around the mark, which is what
 * makes the mark look placed on it rather than in front of it.
 *
 * Kept out of the component file so the geometry can be tested directly, and because a module that
 * exports both a component and plain functions defeats fast refresh.
 */

export type PiariumSplashMode = 'boot' | 'switch';
export type PiariumSplashDirection = 'forward' | 'backward';

/**
 * Viewing angle. Shallow enough that the far cells compress into a horizon, steep enough that the
 * near cells still read as a floor rather than as a wall.
 */
const PLANE_TILT_DEG = 68;
const PLANE_PERSPECTIVE_PX = 1100;
/** Where the plane's centre sits vertically, which is where the mark stands on it. */
const PLANE_ORIGIN_Y_PCT = 58;

/**
 * Cell edge in plane-local space, before projection.
 *
 * Generous, for two reasons. The tilt compresses the plane vertically by roughly `cos(tilt)`, so a
 * cell renders far smaller than it measures here. And a larger cell covers the required area with
 * fewer elements: this runs during startup, where several hundred animated nodes is a cost the user
 * pays exactly when the machine is busiest.
 */
const CELL_TARGET_DESKTOP = 170;
const CELL_TARGET_COMPACT = 110;

/**
 * How far past the viewport the plane extends, in viewport multiples.
 *
 * Perspective coverage has no tidy closed form: the projected footprint depends on the tilt, the
 * perspective distance, and where the origin sits. Over-provisioning and masking the result is both
 * simpler and more robust than solving it, and the mask has to be there regardless so the plane does
 * not end visibly. Depth needs more slack than width because the tilt compresses it.
 */
const PLANE_WIDTH_FACTOR = 2;
const PLANE_DEPTH_FACTOR = 2;

const MIN_AXIS_CELLS = 6;
const MAX_AXIS_CELLS = 22;

const CELL_EXIT_MS = 460;
const MARK_EXIT_MS = 460;
/** Widest per-cell delay either mode schedules. */
const MAX_CELL_DELAY_MS = 520;

/** How long a caller must keep the splash mounted after asking it to leave. */
export const SPLASH_EXIT_DURATION_MS = MAX_CELL_DELAY_MS + Math.max(CELL_EXIT_MS, MARK_EXIT_MS);
/** The reduced-motion path replaces every staged animation with one fade of the whole cover. */
export const SPLASH_REDUCED_EXIT_DURATION_MS = 260;

/** Fraction of cells that join the idle breathing. */
const BREATHE_SHARE = 0.1;
const BREATHE_SPREAD_MS = 2200;

export interface PlaneShape {
  readonly cols: number;
  readonly rows: number;
  readonly cellPx: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Size the plane so its projection runs past every edge of the viewport.
 *
 * The mask fades the outer region out well before the real boundary, so the only requirement here is
 * to be generously too big. Being too small is the visible failure; being too large costs empty
 * elements that the mask hides anyway, which is why the axis counts are capped rather than exact.
 */
export const resolvePlaneShape = (viewportWidth: number, viewportHeight: number): PlaneShape => {
  const cellPx = viewportWidth >= 768 ? CELL_TARGET_DESKTOP : CELL_TARGET_COMPACT;
  const cols = clamp(
    Math.ceil((viewportWidth * PLANE_WIDTH_FACTOR) / cellPx),
    MIN_AXIS_CELLS,
    MAX_AXIS_CELLS,
  );
  const rows = clamp(
    Math.ceil((viewportHeight * PLANE_DEPTH_FACTOR) / cellPx),
    MIN_AXIS_CELLS,
    MAX_AXIS_CELLS,
  );
  return { cols, rows, cellPx };
};

export interface SplashCell {
  readonly key: string;
  readonly delayMs: number;
  readonly breatheDelayMs: number | null;
}

/**
 * Per-cell exit delay.
 *
 * `boot` radiates from where the mark stands, so the floor comes apart outward from it. Measured in
 * plane space rather than screen space, which under perspective means the wavefront visibly races
 * away toward the horizon instead of expanding as a flat circle.
 *
 * `switch` sweeps across the plane and flips with the direction, so switching back is visibly the
 * reverse of switching forward. A slight depth skew keeps the sweep from landing as one hard edge.
 */
export const buildSplashCells = (
  shape: PlaneShape,
  mode: PiariumSplashMode,
  direction: PiariumSplashDirection,
  breathe: boolean,
  random: () => number = Math.random,
): SplashCell[] => {
  const cells: SplashCell[] = [];
  const centerCol = (shape.cols - 1) / 2;
  const centerRow = (shape.rows - 1) / 2;
  const maxRadius = Math.hypot(centerCol, centerRow) || 1;
  const skew = 0.22;

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

/** The transform that turns the flat grid into a receding floor. */
const PLANE_TRANSFORM = `translate(-50%, -50%) rotateX(${PLANE_TILT_DEG}deg)`;

/**
 * Removes the plane's boundary and concentrates it around the mark.
 *
 * This is what supplies the sense of space that projection alone cannot: without falloff the eye
 * sees a grid of uniform strength that stops somewhere, and with it the grid appears to continue
 * past where it is drawn.
 */
const PLANE_MASK =
  'radial-gradient(115% 78% at 50% 44%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.92) 26%, rgba(0,0,0,0.45) 58%, rgba(0,0,0,0) 84%)';

/** Contact shadow under the mark, matching the plane's foreshortening so the mark looks seated. */
const MARK_CONTACT_SHADOW =
  'radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.28) 45%, rgba(0,0,0,0) 100%)';

export interface SplashPlaneColors {
  /**
   * The cover's own background. Not optional: a splash whose job is to hide an unpainted frame cannot
   * be transparent, and each host's background comes from a different source.
   */
  readonly background: string;
  /** Grid line colour. Strong enough to read: the first attempt used 12% and vanished. */
  readonly line: string;
  /** Fill a breathing cell reaches at the top of its pulse. */
  readonly cell: string;
  /** Status line colour. Omitted by hosts with no status line. */
  readonly status?: string;
}

/**
 * The splash's visual rules, as one string.
 *
 * Four surfaces paint a splash and only two of them can import anything, so the rules would otherwise
 * exist in four hand-maintained copies of increasingly fiddly perspective CSS. The React component
 * and the VS Code webview call this; `index.html` and `mini-chat.html` embed its output verbatim, and
 * `piarium-logo-geometry.test.ts` asserts those copies still equal it exactly.
 *
 * Emitted without leading indentation so an embedded copy can match character for character.
 */
export const splashPlaneCss = (
  colors: SplashPlaneColors,
  options: { withMark: boolean },
): string => {
  const markRules = options.withMark
    ? `
.pi-splash-center {
position: absolute;
left: 50%;
top: 50%;
translate: -50% -50%;
display: flex;
flex-direction: column;
align-items: center;
gap: 18px;
padding: 0 24px;
text-align: center;
}
.pi-splash-mark {
position: relative;
display: block;
}
/* Seats the mark on the plane. Wider than tall, because the plane is foreshortened. */
.pi-splash-mark::after {
content: '';
position: absolute;
left: 50%;
bottom: 2%;
width: 96%;
height: 26%;
translate: -50% 0;
border-radius: 50%;
background: ${MARK_CONTACT_SHADOW};
pointer-events: none;
}
.pi-splash[data-leaving='true'] .pi-splash-center {
animation: pi-splash-mark-out ${MARK_EXIT_MS}ms 60ms cubic-bezier(0.4, 0, 0.3, 1) both;
}
@keyframes pi-splash-mark-out {
to { opacity: 0; transform: translateY(-10px) scale(1.05); }
}
.pi-splash-status {
min-height: 1rem;
max-width: 32ch;
font-size: 11px;
font-weight: 600;
letter-spacing: 0.11em;
text-transform: uppercase;
color: ${colors.status ?? colors.line};
opacity: 0;
animation: pi-splash-status-in 480ms 700ms ease both;
}
@keyframes pi-splash-status-in { to { opacity: 0.5; } }`
    : '';

  const reducedMarkRules = options.withMark
    ? `,
.pi-splash[data-leaving='true'] .pi-splash-center,
.pi-splash-status`
    : '';

  const reducedStatusRule = options.withMark
    ? `
.pi-splash-status { opacity: 0.5; }`
    : '';

  return `
.pi-splash {
position: fixed;
inset: 0;
z-index: 9998;
overflow: hidden;
background: ${colors.background};
perspective: ${PLANE_PERSPECTIVE_PX}px;
perspective-origin: 50% 44%;
}
.pi-splash[data-leaving='true'] { pointer-events: none; }

.pi-splash-plane {
position: absolute;
left: 50%;
top: ${PLANE_ORIGIN_Y_PCT}%;
display: grid;
transform-origin: center;
transform: ${PLANE_TRANSFORM};
transform-style: preserve-3d;
-webkit-mask-image: ${PLANE_MASK};
mask-image: ${PLANE_MASK};
}
/* Two edges per cell, so neighbours do not stack into a 2px rule. */
.pi-splash-cell {
box-shadow: inset -1px -1px 0 ${colors.line};
}
/* Idle breathing starts late on purpose: a fast start never reaches it, so it only ever appears
   when there is genuinely something to wait for. */
.pi-splash-cell[data-breathe='true'] {
animation: pi-splash-breathe 2.8s ease-in-out infinite;
animation-delay: calc(1.2s + var(--pi-breathe-delay));
}
@keyframes pi-splash-breathe {
0%, 100% { background: transparent; }
50% { background: ${colors.cell}; }
}
/* Declared after the breathing rule so equal specificity lets the exit win without !important. */
.pi-splash[data-leaving='true'] .pi-splash-cell {
animation: pi-splash-cell-out ${CELL_EXIT_MS}ms cubic-bezier(0.32, 0, 0.24, 1) both;
animation-delay: var(--pi-cell-delay);
}
/* Each cell shrinks toward its own centre while it fades, so the floor comes apart into scattering
   tiles rather than simply dimming. */
@keyframes pi-splash-cell-out {
to { opacity: 0; transform: scale(0.62); }
}
${markRules}

/* Reduced motion drops the staged animation for one fade of the whole cover. It must still show the
   cover: hiding it would put the unpainted first frame back. */
@media (prefers-reduced-motion: reduce) {
.pi-splash-cell,
.pi-splash[data-leaving='true'] .pi-splash-cell${reducedMarkRules} {
animation: none;
}${reducedStatusRule}
.pi-splash { transition: opacity ${SPLASH_REDUCED_EXIT_DURATION_MS}ms ease; }
.pi-splash[data-leaving='true'] { opacity: 0; }
}
`;
};
