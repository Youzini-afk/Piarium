import { LOGO_FOOTPRINT, LOGO_GROUND_TRANSFORM } from './piarium-logo-geometry';

/**
 * The splash ground: a lattice registered to the mark's own footprint.
 *
 * Two earlier attempts failed for the same underlying reason, and the fix is geometric rather than
 * a matter of tuning.
 *
 * The first drew an isometric lattice, which was the right projection, but sized its cells from the
 * viewport and centred them on the viewport. So the lines had no relationship to the cube: the cube
 * was pasted onto an unrelated grid, and the pair read as a logo on wallpaper.
 *
 * The second replaced the projection with perspective, chasing a sense of depth. That made it worse
 * in the way that matters here. The cube is drawn isometrically, so its base edges are parallel lines
 * at ±30 degrees; a perspectival ground converges, and converging lines cannot stay parallel to those
 * edges. The lines then provably cannot emerge from the cube's base, whatever the tilt.
 *
 * So: isometric again, but registered. The cell edge equals the cube's base edge, and a lattice vertex
 * is placed on the cube's lowest vertex. The cube's base is then exactly one cell of the floor, and the
 * lines run outward from its four base corners because they are the same lines.
 */

export type PiariumSplashMode = 'boot' | 'switch';
export type PiariumSplashDirection = 'forward' | 'backward';

/** Rendered mark size. The cell edge is derived from this, so the two can never disagree. */
const MARK_SIZE_DESKTOP = 168;
const MARK_SIZE_COMPACT = 124;

export const resolveMarkSize = (viewportWidth: number): number =>
  (viewportWidth >= 768 ? MARK_SIZE_DESKTOP : MARK_SIZE_COMPACT);

/** Where the mark stands, as a share of viewport height. Slightly low, to leave headroom above. */
export const GROUND_ORIGIN_Y_PCT = 54;

const MIN_AXIS_CELLS = 8;
const MAX_AXIS_CELLS = 24;

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

export interface GroundShape {
  /** Cells per axis. Square, because the lattice has to reach equally far along both base axes. */
  readonly axis: number;
  /** Cell edge in pixels, equal to the cube's rendered base edge. */
  readonly cellPx: number;
  /** Pre-transform offset that puts a lattice vertex on the cube's lowest vertex. */
  readonly offsetPx: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Size the lattice and work out the offset that registers it with the mark.
 *
 * The isometric matrix maps a `w` by `w` square to a rhombus `2 * cos30 * w` wide and `w` tall. Placing
 * the lattice's middle vertex on the mark's base vertex therefore reaches `cos30 * w` horizontally and
 * `w / 2` vertically from that point, and the vertical reach is the binding constraint because the
 * origin sits below the viewport's middle. Solving for the axis count from the taller of the two
 * distances to an edge is what stops the lattice ending in view, which is how the first attempt failed.
 */
export const resolveGroundShape = (
  viewportWidth: number,
  viewportHeight: number,
  markSize: number = resolveMarkSize(viewportWidth),
): GroundShape => {
  const cellPx = markSize * LOGO_FOOTPRINT.edge;
  const originY = viewportHeight * (GROUND_ORIGIN_Y_PCT / 100);
  const reachX = Math.max(viewportWidth / 2, viewportWidth / 2);
  const reachY = Math.max(originY, viewportHeight - originY);

  // Half-extents of the projected rhombus are cos30 * axis * cell and axis * cell / 2.
  const axisForWidth = reachX / (0.866 * cellPx);
  const axisForHeight = (2 * reachY) / cellPx;
  const axis = clamp(
    Math.ceil(Math.max(axisForWidth, axisForHeight)),
    MIN_AXIS_CELLS,
    MAX_AXIS_CELLS,
  );

  // An even axis count puts a vertex, not a cell centre, at the middle of the lattice.
  const evenAxis = axis % 2 === 0 ? axis : axis + 1;
  return { axis: evenAxis, cellPx, offsetPx: (evenAxis / 2) * cellPx };
};

export interface SplashCell {
  readonly key: string;
  readonly delayMs: number;
  readonly breatheDelayMs: number | null;
}

/**
 * Per-cell exit delay.
 *
 * `boot` radiates from the cell the mark stands on, so the floor comes apart outward from its feet.
 * Measured in lattice space, which because the lattice is sheared means the wavefront travels along the
 * cube's own base axes rather than as a screen-space circle.
 *
 * `switch` sweeps along one base axis and flips with the direction, so switching back is visibly the
 * reverse of switching forward. A slight cross-axis skew keeps the sweep from landing as one hard edge.
 */
export const buildSplashCells = (
  shape: GroundShape,
  mode: PiariumSplashMode,
  direction: PiariumSplashDirection,
  breathe: boolean,
  random: () => number = Math.random,
): SplashCell[] => {
  const cells: SplashCell[] = [];
  const middle = (shape.axis - 1) / 2;
  const maxRadius = Math.hypot(middle, middle) || 1;
  const skew = 0.22;

  for (let row = 0; row < shape.axis; row += 1) {
    for (let col = 0; col < shape.axis; col += 1) {
      let fraction: number;
      if (mode === 'boot') {
        fraction = Math.hypot(col - middle, row - middle) / maxRadius;
      } else {
        const along = direction === 'forward' ? col : shape.axis - 1 - col;
        fraction = (along + row * skew) / (shape.axis * (1 + skew));
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

/**
 * Inline geometry for the ground element.
 *
 * `transform-origin: 0 0` keeps the element's own origin pinned wherever it is positioned, and the
 * pre-matrix translate slides the lattice so its middle vertex is the point that lands there. Both have
 * to be inline because they depend on the measured viewport, which the shared stylesheet cannot know.
 */
export const groundInlineStyle = (shape: GroundShape): {
  gridTemplateColumns: string;
  gridTemplateRows: string;
  transform: string;
} => ({
  gridTemplateColumns: `repeat(${shape.axis}, ${shape.cellPx}px)`,
  gridTemplateRows: `repeat(${shape.axis}, ${shape.cellPx}px)`,
  transform: `${LOGO_GROUND_TRANSFORM} translate(${-shape.offsetPx}px, ${-shape.offsetPx}px)`,
});

export interface SplashPlaneColors {
  /**
   * The cover's own background. Not optional: a splash whose job is to hide an unpainted frame cannot
   * be transparent, and each host's background comes from a different source.
   */
  readonly background: string;
  /** Lattice line colour. Strong enough to read: an early attempt used 12% and vanished. */
  readonly line: string;
  /** Fill a breathing cell reaches at the top of its pulse. */
  readonly cell: string;
  /**
   * The pool of light where the mark meets the ground.
   *
   * Light, not dark. An earlier attempt used a black radial gradient, which is invisible against a
   * near-black background, so the mark had no contact cue at all.
   */
  readonly contact: string;
  /** Status line colour. Omitted by hosts with no status line. */
  readonly status?: string;
}

/**
 * The splash's visual rules, as one string.
 *
 * Four surfaces paint a splash and only two of them can import anything, so the rules would otherwise
 * exist in four hand-maintained copies. The React component and the VS Code webview call this;
 * `index.html` and `mini-chat.html` embed its output verbatim, and `piarium-logo-geometry.test.ts`
 * asserts those copies still equal it exactly.
 *
 * Emitted without leading indentation so an embedded copy can match character for character.
 */
export const splashPlaneCss = (
  colors: SplashPlaneColors,
  options: { withMark: boolean },
): string => {
  const vertexY = (LOGO_FOOTPRINT.vertex.y * 100).toFixed(1);

  const markRules = options.withMark
    ? `
/* The mark stands on the lattice, so its lowest vertex has to land on the lattice origin. That vertex
   is at ${vertexY}% of the mark's own box height, not at its centre or its bottom edge, so the box is
   pulled up by exactly that much. Matching the cell edge to the base edge then makes the cube's
   footprint one cell of the floor, and the lines leaving its base corners are the floor's own lines. */
.pi-splash-mark {
position: absolute;
left: 50%;
top: ${GROUND_ORIGIN_Y_PCT}%;
translate: -50% -${vertexY}%;
display: block;
}
/* The pool of light at the footprint. Wide and shallow, to sit in the plane rather than face the
   viewer, and centred on the contact vertex rather than on the box. */
.pi-splash-mark::after {
content: '';
position: absolute;
left: 50%;
top: ${vertexY}%;
width: 170%;
height: 38%;
translate: -50% -50%;
border-radius: 50%;
background: radial-gradient(closest-side, ${colors.contact} 0%, transparent 100%);
pointer-events: none;
z-index: -1;
}
.pi-splash-status {
position: absolute;
left: 50%;
top: calc(${GROUND_ORIGIN_Y_PCT}% + 44px);
translate: -50% 0;
min-height: 1rem;
max-width: 32ch;
font-size: 11px;
font-weight: 600;
letter-spacing: 0.11em;
text-transform: uppercase;
text-align: center;
color: ${colors.status ?? colors.line};
opacity: 0;
animation: pi-splash-status-in 480ms 700ms ease both;
}
@keyframes pi-splash-status-in { to { opacity: 0.5; } }
.pi-splash[data-leaving='true'] .pi-splash-mark,
.pi-splash[data-leaving='true'] .pi-splash-status {
animation: pi-splash-mark-out ${MARK_EXIT_MS}ms 60ms cubic-bezier(0.4, 0, 0.3, 1) both;
}
@keyframes pi-splash-mark-out {
to { opacity: 0; }
}`
    : '';

  const reducedMarkRules = options.withMark
    ? `,
.pi-splash[data-leaving='true'] .pi-splash-mark,
.pi-splash[data-leaving='true'] .pi-splash-status,
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
}
.pi-splash[data-leaving='true'] { pointer-events: none; }

/* Positioned at the mark's footprint, with its own origin pinned there. The grid template and the
   registering offset arrive inline, because both depend on the measured viewport. */
.pi-splash-ground {
position: absolute;
left: 50%;
top: ${GROUND_ORIGIN_Y_PCT}%;
display: grid;
transform-origin: 0 0;
-webkit-mask-image: radial-gradient(120% 96% at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 30%, rgba(0,0,0,0.4) 62%, rgba(0,0,0,0) 88%);
mask-image: radial-gradient(120% 96% at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 30%, rgba(0,0,0,0.4) 62%, rgba(0,0,0,0) 88%);
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
