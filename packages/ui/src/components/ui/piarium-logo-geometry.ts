/**
 * The Piarium mark's isometric geometry, in one place.
 *
 * The mark is drawn in four surfaces: a pre-paint copy inlined in `packages/web/index.html`, the
 * same copy in `packages/web/mini-chat.html`, the VS Code webview splash, and this React logo. The
 * inline copies cannot import anything, because they have to paint before the bundle exists, so the
 * duplication is structural rather than laziness. Keeping the numbers here gives the duplication a
 * source of truth that `piarium-logo-geometry.test.ts` can hold the inline copy against.
 *
 * The same lattice is what the splash animation tiles across the viewport, so the cube reads as a
 * region of that lattice rather than a separate object placed on top of it.
 */

/** Cube edge length in the 100x100 viewBox. */
const LOGO_EDGE = 48;
/** Exported because the splash lattice reuses the same projection. */
export const LOGO_COS30 = 0.866;
export const LOGO_SIN30 = 0.5;
const LOGO_CENTER_X = 50;
const LOGO_CENTER_Y = 50;
export const LOGO_VIEWBOX = '0 0 100 100';
const LOGO_GRID_SIZE = 4;

export interface LogoPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Coordinates are rounded before they reach a path string.
 *
 * `48 * 0.866` is not exact in binary floating point, so the raw products would emit paths like
 * `L8.432000000000002 26`. Rounding keeps the emitted geometry readable, keeps it identical to the
 * literal copy inlined in `index.html`, and is far below the precision a 100-unit viewBox can show.
 */
const round = (value: number): number => Math.round(value * 1000) / 1000;

const halfWidth = round(LOGO_EDGE * LOGO_COS30);
const halfHeight = round(LOGO_EDGE * LOGO_SIN30);

/**
 * Named vertices of the isometric cube.
 *
 * Rounded per coordinate, not only per half-extent: `50 - 41.568` reintroduces float noise even when
 * the operand is already clean.
 */
export const LOGO_VERTICES = {
  top: { x: LOGO_CENTER_X, y: round(LOGO_CENTER_Y - LOGO_EDGE) },
  left: { x: round(LOGO_CENTER_X - halfWidth), y: round(LOGO_CENTER_Y - halfHeight) },
  right: { x: round(LOGO_CENTER_X + halfWidth), y: round(LOGO_CENTER_Y - halfHeight) },
  center: { x: LOGO_CENTER_X, y: LOGO_CENTER_Y },
  bottomLeft: { x: round(LOGO_CENTER_X - halfWidth), y: round(LOGO_CENTER_Y + halfHeight) },
  bottomRight: { x: round(LOGO_CENTER_X + halfWidth), y: round(LOGO_CENTER_Y + halfHeight) },
  bottom: { x: LOGO_CENTER_X, y: round(LOGO_CENTER_Y + LOGO_EDGE) },
} as const satisfies Record<string, LogoPoint>;

/** Centre of the open top face, which is where the mark sits. */
const LOGO_TOP_FACE_CENTER_Y = (
  LOGO_VERTICES.top.y + LOGO_VERTICES.left.y + LOGO_VERTICES.center.y + LOGO_VERTICES.right.y
) / 4;

/**
 * Maps a unit square onto the isometric rhombus. The splash lattice uses the same matrix, which is
 * why a flat CSS grid can tile the cube's own lattice without any per-cell trigonometry.
 */
export const LOGO_ISO_MATRIX =
  `matrix(${LOGO_COS30}, ${LOGO_SIN30}, ${-LOGO_COS30}, ${LOGO_SIN30}, ${LOGO_CENTER_X}, ${LOGO_TOP_FACE_CENTER_Y})`;

/** The π glyph, drawn in the top face's local space. */
export const LOGO_MARK_PATH = 'M-18 -15 H18 V-9 H13 V15 H7 V-9 H-7 V15 H-13 V-9 H-18 Z';
export const LOGO_MARK_SCALE = 0.75;

const LEFT_FACE_CELL_OPACITIES = [
  0.2, 0.45, 0.15, 0.55,
  0.35, 0.1, 0.5, 0.25,
  0.4, 0.3, 0.45, 0.15,
  0.55, 0.2, 0.35, 0.1,
] as const;

const RIGHT_FACE_CELL_OPACITIES = [
  0.3, 0.15, 0.45, 0.25,
  0.5, 0.35, 0.1, 0.4,
  0.2, 0.55, 0.3, 0.15,
  0.45, 0.25, 0.4, 0.2,
] as const;

export interface LogoFaceCell {
  readonly path: string;
  readonly row: number;
  readonly col: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const bilinear = (
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
  t: number,
  s: number,
): number => lerp(lerp(topLeft, topRight, t), lerp(bottomLeft, bottomRight, t), s);

/**
 * Subdivide a face quad into a `gridSize` x `gridSize` lattice of parallelograms.
 *
 * Bilinear interpolation rather than a fixed step, so the same routine works for either visible
 * face and would still work if the cube's proportions changed.
 */
export const generateFaceGrid = (
  topLeft: LogoPoint,
  topRight: LogoPoint,
  bottomRight: LogoPoint,
  bottomLeft: LogoPoint,
  gridSize: number = LOGO_GRID_SIZE,
): LogoFaceCell[] => {
  const cells: LogoFaceCell[] = [];

  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const t1 = col / gridSize;
      const t2 = (col + 1) / gridSize;
      const s1 = row / gridSize;
      const s2 = (row + 1) / gridSize;

      const corner = (t: number, s: number): LogoPoint => ({
        x: round(bilinear(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x, t, s)),
        y: round(bilinear(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y, t, s)),
      });

      const p1 = corner(t1, s1);
      const p2 = corner(t2, s1);
      const p3 = corner(t2, s2);
      const p4 = corner(t1, s2);

      cells.push({
        path: `M${p1.x} ${p1.y} L${p2.x} ${p2.y} L${p3.x} ${p3.y} L${p4.x} ${p4.y} Z`,
        row,
        col,
      });
    }
  }

  return cells;
};

const quadPath = (...points: LogoPoint[]): string =>
  `M${points.map((point) => `${point.x} ${point.y}`).join(' L')} Z`;

export const LOGO_LEFT_FACE_PATH = quadPath(
  LOGO_VERTICES.center, LOGO_VERTICES.left, LOGO_VERTICES.bottomLeft, LOGO_VERTICES.bottom,
);
export const LOGO_RIGHT_FACE_PATH = quadPath(
  LOGO_VERTICES.center, LOGO_VERTICES.right, LOGO_VERTICES.bottomRight, LOGO_VERTICES.bottom,
);
export const LOGO_TOP_FACE_PATH = quadPath(
  LOGO_VERTICES.top, LOGO_VERTICES.left, LOGO_VERTICES.center, LOGO_VERTICES.right,
);

/**
 * Both faces are wound from the shared front vertex outward, which makes them mirror images of each
 * other. The left face used to be wound from its outer edge inward, and the logo compensated by
 * reading its opacity row backwards; winding them the same way removes that compensation and makes
 * the emitted paths identical to the copy inlined in `index.html`.
 */
export const LOGO_LEFT_FACE_CELLS = generateFaceGrid(
  LOGO_VERTICES.center, LOGO_VERTICES.left, LOGO_VERTICES.bottomLeft, LOGO_VERTICES.bottom,
);
export const LOGO_RIGHT_FACE_CELLS = generateFaceGrid(
  LOGO_VERTICES.center, LOGO_VERTICES.right, LOGO_VERTICES.bottomRight, LOGO_VERTICES.bottom,
);

export const leftFaceCellOpacity = (cell: LogoFaceCell): number =>
  LEFT_FACE_CELL_OPACITIES[cell.row * LOGO_GRID_SIZE + cell.col] ?? 0.35;

export const rightFaceCellOpacity = (cell: LogoFaceCell): number =>
  RIGHT_FACE_CELL_OPACITIES[cell.row * LOGO_GRID_SIZE + cell.col] ?? 0.35;
