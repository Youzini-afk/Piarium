import {
  LEFT_FACE_CELL_OPACITIES,
  LOGO_GRID_SIZE,
  LOGO_MARK_SCALE,
  RIGHT_FACE_CELL_OPACITIES,
} from './piarium-logo-geometry';
import { cameraDepth, projectPoint, type Point2, type Point3 } from './piarium-splash-camera';

/**
 * The mark, projected through the splash camera into flat SVG.
 *
 * The published mark is an isometric drawing, and it stays that way: it is an icon, and a parallel
 * projection is the right thing for an icon. What it cannot do is stand on a perspective floor, because
 * its base edges are parallel lines and the floor's converge. So the splash draws the same cube through
 * the floor's own camera instead.
 *
 * Everything is projected per vertex, so nothing is approximated. That is possible because every shape
 * in the mark is a polygon: the faces are quads, the face lattices are quads, and the glyph is twelve
 * axis-aligned segments. A curved path would have needed subdivision or a homography SVG cannot express.
 */

/** The glyph's corners, read off the published path, in its own 48-unit face space. */
const MARK_GLYPH_POLYGON: ReadonlyArray<Point2> = [
  { x: -18, y: -15 },
  { x: 18, y: -15 },
  { x: 18, y: -9 },
  { x: 13, y: -9 },
  { x: 13, y: 15 },
  { x: 7, y: 15 },
  { x: 7, y: -9 },
  { x: -7, y: -9 },
  { x: -7, y: 15 },
  { x: -13, y: 15 },
  { x: -13, y: -9 },
  { x: -18, y: -9 },
];

/** The glyph is authored against a 48-unit face, so it scales with whatever edge the cube is given. */
const GLYPH_FACE_UNITS = 48;

export interface PerspectiveMarkColors {
  readonly stroke: string;
  readonly faceFill: string;
  readonly cellFill: string;
  /** Fills the silhouette first, so the floor does not show through the translucent faces. */
  readonly occlusionFill: string;
}

interface Face {
  /** Corners in floor space, wound consistently so the subdivision runs the same way on each. */
  readonly corners: readonly [Point3, Point3, Point3, Point3];
  /** Per-cell opacity table, or null for a face drawn as outline only. */
  readonly cellOpacities: readonly number[] | null;
}

const point = (x: number, y: number, z: number): Point3 => ({ x, y, z });

/**
 * The cube's six faces, in floor space, for a cube of edge `edge` standing on z = 0.
 *
 * All six are listed and the visible three are then selected by depth. Deciding visibility from face
 * normals would need the camera's own orientation restated here; the depth function the camera already
 * exposes settles it without repeating anything, because for a convex solid the faces nearest the eye
 * are exactly the ones facing it.
 */
const cubeFaces = (edge: number): Face[] => {
  const h = edge / 2;
  return [
    // Top, where the glyph sits. Outline only, matching the published mark's open top.
    {
      corners: [point(-h, -h, edge), point(h, -h, edge), point(h, h, edge), point(-h, h, edge)],
      cellOpacities: null,
    },
    // Base. Never seen; present so the depth sort ranks a closed solid.
    {
      corners: [point(-h, -h, 0), point(-h, h, 0), point(h, h, 0), point(h, -h, 0)],
      cellOpacities: null,
    },
    // The four walls. Each is wound from the top corner it shares with its neighbour, outward and then
    // down, which is how `generateFaceGrid` is called for the published mark. Winding them the other way
    // would mirror the opacity tables and put the bright cells somewhere else.
    {
      corners: [point(h, h, edge), point(-h, h, edge), point(-h, h, 0), point(h, h, 0)],
      cellOpacities: LEFT_FACE_CELL_OPACITIES,
    },
    {
      corners: [point(h, h, edge), point(h, -h, edge), point(h, -h, 0), point(h, h, 0)],
      cellOpacities: RIGHT_FACE_CELL_OPACITIES,
    },
    {
      corners: [point(-h, -h, edge), point(h, -h, edge), point(h, -h, 0), point(-h, -h, 0)],
      cellOpacities: LEFT_FACE_CELL_OPACITIES,
    },
    {
      corners: [point(-h, -h, edge), point(-h, h, edge), point(-h, h, 0), point(-h, -h, 0)],
      cellOpacities: RIGHT_FACE_CELL_OPACITIES,
    },
  ];
};

/**
 * How many of the depth-sorted faces are actually seen.
 *
 * A convex solid shows at most three faces from any one direction, and this camera looks down at a
 * corner, so it shows exactly three: the top and the two walls turned toward the eye. Their union is
 * the silhouette, which is what makes them usable as the occluder.
 */
const VISIBLE_FACE_COUNT = 3;

const lerp3 = (a: Point3, b: Point3, t: number): Point3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Subdivide a face in floor space, then project each cell. Subdividing after projection would bend. */
const faceCells = (face: Face): Array<{ corners: Point3[]; opacity: number }> => {
  const [tl, tr, br, bl] = face.corners;
  const cells: Array<{ corners: Point3[]; opacity: number }> = [];

  for (let row = 0; row < LOGO_GRID_SIZE; row += 1) {
    for (let col = 0; col < LOGO_GRID_SIZE; col += 1) {
      const t1 = col / LOGO_GRID_SIZE;
      const t2 = (col + 1) / LOGO_GRID_SIZE;
      const s1 = row / LOGO_GRID_SIZE;
      const s2 = (row + 1) / LOGO_GRID_SIZE;

      const at = (t: number, s: number): Point3 =>
        lerp3(lerp3(tl, tr, t), lerp3(bl, br, t), s);

      cells.push({
        corners: [at(t1, s1), at(t2, s1), at(t2, s2), at(t1, s2)],
        opacity: face.cellOpacities?.[row * LOGO_GRID_SIZE + col] ?? 0.35,
      });
    }
  }

  return cells;
};

const round = (value: number): number => Math.round(value * 100) / 100;

const polygonPath = (points: readonly Point2[]): string =>
  `M${points.map((p) => `${round(p.x)} ${round(p.y)}`).join(' L')} Z`;

interface VisibleFace {
  readonly face: Face;
  readonly projected: Point2[];
}

/**
 * The three faces the camera sees, in the order they are drawn, each with its corners already projected.
 *
 * The depth is rounded before it is sorted on, and the tie is then broken by declaration order. That is
 * not defensive rounding: the two walls facing the camera are at exactly the same depth, and comparing
 * their raw sums decided the draw order by whichever way `sin(45°)` and `cos(45°)` happened to round in
 * the last bit. It came out one way under Bun and the other under Node, which put the two walls' shading
 * on opposite sides between the generated copy and the module that generated it.
 */
const visibleFaces = (edge: number): VisibleFace[] => cubeFaces(edge)
  .map((face, index) => ({
    face,
    index,
    depth: Math.round(
      (face.corners.reduce((sum, corner) => sum + cameraDepth(corner), 0) / 4) * 1e6,
    ),
  }))
  // Ascending depth, so the last entries are the ones nearest the eye.
  .sort((left, right) => left.depth - right.depth || left.index - right.index)
  .slice(-VISIBLE_FACE_COUNT)
  .map(({ face }) => ({ face, projected: face.corners.map(projectPoint) }));

export interface MarkBox {
  readonly viewBox: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * Where the cube's base centre sits inside the box, as fractions.
   *
   * The splash places the mark by this rather than by its box, because the base centre is the point that
   * has to coincide with the floor's origin and it is nowhere near the box's middle.
   */
  readonly originFraction: Point2;
  /**
   * `originFraction` as a CSS `translate` value.
   *
   * Every host needs exactly this and nothing else from the fraction, and each one deriving it would be
   * four more places for a sign or a factor of a hundred to go wrong.
   */
  readonly originTranslate: string;
}

/**
 * The mark's box and the base centre's place in it, without drawing anything.
 *
 * Measured from the projection rather than assumed, because perspective makes the silhouette
 * asymmetric: the near corner grows and the far corner shrinks, so the base centre lands well off the
 * box's middle by an amount that depends on the camera. Separate from the drawing because the shared
 * stylesheet needs the placement and has no use for the paths.
 */
export const markBox = (edge: number): MarkBox => {
  // A stroke of width 2 sits half outside the geometry it outlines.
  const pad = 2;
  const silhouette = visibleFaces(edge).flatMap(({ projected }) => projected);
  const minX = Math.min(...silhouette.map((p) => p.x)) - pad;
  const maxX = Math.max(...silhouette.map((p) => p.x)) + pad;
  const minY = Math.min(...silhouette.map((p) => p.y)) - pad;
  const maxY = Math.max(...silhouette.map((p) => p.y)) + pad;
  const width = maxX - minX;
  const height = maxY - minY;

  // The base centre is the origin of floor space, so it projects to (0, 0) by construction, and where
  // that lands inside the box is just where zero falls between the measured bounds.
  const fraction = (value: number): number => Math.round(value * 10000) / 10000;
  const originFraction = { x: fraction(-minX / width), y: fraction(-minY / height) };

  return {
    viewBox: `${round(minX)} ${round(minY)} ${round(width)} ${round(height)}`,
    widthPx: round(width),
    heightPx: round(height),
    originFraction,
    originTranslate: `${round(-originFraction.x * 100)}% ${round(-originFraction.y * 100)}%`,
  };
};

export interface PerspectiveMark extends MarkBox {
  /** The paths, ready to drop inside an `svg` element. For React, which renders its own element. */
  readonly markup: string;
  /** The whole `svg` element. For hosts that build their document as text. */
  readonly svg: string;
}

/** Draw the projected mark for a cube of the given edge, in pixels. */
export const perspectiveMark = (edge: number, colors: PerspectiveMarkColors): PerspectiveMark => {
  const visible = visibleFaces(edge);

  // The visible faces tile the silhouette exactly, so filling them is filling the outline. The hidden
  // faces are dropped rather than drawn under it: painted after the fill they would have shown the back
  // of the cube through its front, and painted before it they would have contributed nothing.
  const occluder = visible
    .map(({ projected }) => `<path d="${polygonPath(projected)}" fill="${colors.occlusionFill}"/>`)
    .join('');

  const isTop = (face: Face): boolean => face.corners.every((corner) => corner.z === edge);

  const wall = ({ face, projected }: VisibleFace): string => {
    const cells = faceCells(face)
      .map((cell) => {
        const corners = cell.corners.map(projectPoint);
        return `<path d="${polygonPath(corners)}" fill="${colors.cellFill}" opacity="${cell.opacity}"/>`;
      })
      .join('');

    return [
      `<path d="${polygonPath(projected)}" fill="${colors.faceFill}" stroke="${colors.stroke}" stroke-width="2" stroke-linejoin="round"/>`,
      cells,
    ].join('');
  };

  const glyph = MARK_GLYPH_POLYGON.map((vertex) =>
    projectPoint({
      x: (vertex.x * LOGO_MARK_SCALE * edge) / GLYPH_FACE_UNITS,
      y: (vertex.y * LOGO_MARK_SCALE * edge) / GLYPH_FACE_UNITS,
      z: edge,
    }),
  );

  const top = visible.find(({ face }) => isTop(face));
  // Walls first, then the open top's outline, then the glyph. Visible faces of a convex solid do not
  // overlap, so this is not a depth question; it is the order the published mark is drawn in, and it
  // keeps the top outline unbroken where the walls' own strokes meet it.
  const drawn = [
    ...visible.filter(({ face }) => !isTop(face)).map(wall),
    top ? `<path d="${polygonPath(top.projected)}" fill="none" stroke="${colors.stroke}" stroke-width="2" stroke-linejoin="round"/>` : '',
    `<path class="pi-splash-glyph" d="${polygonPath(glyph)}" fill="${colors.stroke}"/>`,
  ].join('');

  const box = markBox(edge);
  const markup = `${occluder}${drawn}`;

  return {
    ...box,
    markup,
    svg: [
      `<svg width="${box.widthPx}" height="${box.heightPx}" viewBox="${box.viewBox}"`,
      ' fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
      markup,
      '</svg>',
    ].join(''),
  };
};
