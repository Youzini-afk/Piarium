import { describe, expect, test } from 'vitest';
import {
  LEFT_FACE_CELL_OPACITIES,
  LOGO_GRID_SIZE,
  LOGO_ISO_MATRIX,
  LOGO_LEFT_FACE_CELLS,
  LOGO_MARK_PATH,
  LOGO_RIGHT_FACE_CELLS,
  LOGO_VERTICES,
  RIGHT_FACE_CELL_OPACITIES,
  generateFaceGrid,
  leftFaceCellOpacity,
  rightFaceCellOpacity,
} from './piarium-logo-geometry';

/**
 * The published isometric mark, which `PiariumLogo` renders and the app icons are cut from.
 *
 * The splash no longer draws this one — it projects the same cube through its own camera, because a
 * parallel projection's parallel base edges cannot meet a converging floor. So these tests cover the icon
 * on its own terms: that the cube closes, that the faces subdivide evenly, and that the shading tables
 * line up with the lattice they shade. The splash's own geometry is checked in
 * `piarium-splash-lattice.test.ts`.
 */

describe('logo geometry', () => {
  test('the cube closes: opposite vertices are symmetric about the centre', () => {
    const { left, right, top, bottom, bottomLeft, bottomRight, center } = LOGO_VERTICES;
    expect(left.x + right.x).toBeCloseTo(2 * center.x, 6);
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(bottomLeft.x + bottomRight.x).toBeCloseTo(2 * center.x, 6);
    expect(bottomLeft.y).toBeCloseTo(bottomRight.y, 6);
    expect(top.y + bottom.y).toBeCloseTo(2 * center.y, 6);
  });

  test('each visible face subdivides into a 4x4 lattice', () => {
    expect(LOGO_LEFT_FACE_CELLS).toHaveLength(16);
    expect(LOGO_RIGHT_FACE_CELLS).toHaveLength(16);
  });

  test('a face grid tiles its quad without gaps at the shared corners', () => {
    const cells = generateFaceGrid(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    );
    expect(cells[0]?.path).toBe('M0 0 L1 0 L1 1 L0 1 Z');
    expect(cells.at(-1)?.path).toBe('M3 3 L4 3 L4 4 L3 4 Z');
  });

  test('the isometric matrix is a unit-length rotation, so the glyph is not stretched', () => {
    // The glyph is authored in the top face's own units and placed by this matrix. If its basis vectors
    // were not unit length the glyph would come out a different size than it was drawn at.
    const [a, b, c, d] = LOGO_ISO_MATRIX.replace(/^matrix\(|\)$/g, '')
      .split(',')
      .map((part) => Number(part.trim())) as [number, number, number, number];
    expect(Math.hypot(a, b)).toBeCloseTo(1, 3);
    expect(Math.hypot(c, d)).toBeCloseTo(1, 3);
  });

  test('the glyph path closes back on itself', () => {
    // A pi with an unclosed outline fills as a different shape entirely.
    expect(LOGO_MARK_PATH.endsWith('Z')).toBe(true);
  });

  test('the shading tables cover the lattice exactly', () => {
    // The per-cell lookups fall back to a middling value when a table runs short, so a missing entry
    // would flatten one cell's shading rather than fail anywhere. Both the icon and the splash's
    // projected cube read these tables, so a short one shows up in two places at once.
    expect(LEFT_FACE_CELL_OPACITIES).toHaveLength(LOGO_GRID_SIZE ** 2);
    expect(RIGHT_FACE_CELL_OPACITIES).toHaveLength(LOGO_GRID_SIZE ** 2);
    expect(leftFaceCellOpacity({ path: '', row: 0, col: 0 })).toBe(LEFT_FACE_CELL_OPACITIES[0]);
    expect(rightFaceCellOpacity({ path: '', row: 3, col: 3 })).toBe(RIGHT_FACE_CELL_OPACITIES[15]);
  });
});
