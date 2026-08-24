import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  LEFT_FACE_CELL_OPACITIES,
  LOGO_GRID_SIZE,
  LOGO_LEFT_FACE_CELLS,
  LOGO_LEFT_FACE_PATH,
  LOGO_MARK_PATH,
  LOGO_PROJECTED_MARK_PATH,
  LOGO_RIGHT_FACE_CELLS,
  LOGO_TOP_FACE_PATH,
  LOGO_VERTICES,
  RIGHT_FACE_CELL_OPACITIES,
  leftFaceCellOpacity,
  rightFaceCellOpacity,
} from './piarium-logo-geometry';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

/**
 * The published mark is the startup cube frozen in its initial camera pose. These tests guard the shared
 * geometry so product icons cannot silently drift back to a separate logo.
 */

describe('logo geometry', () => {
  test('the projected cube closes and keeps the splash perspective', () => {
    const { left, right, top, bottom, bottomLeft, bottomRight, center } = LOGO_VERTICES;
    expect(left.x + right.x).toBeCloseTo(100, 6);
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(bottomLeft.x + bottomRight.x).toBeCloseTo(100, 6);
    expect(bottomLeft.y).toBeCloseTo(bottomRight.y, 6);
    expect(top.y).toBeLessThan(left.y);
    expect(left.y).toBeLessThan(center.y);
    expect(center.y).toBeLessThan(bottom.y);
    // Perspective makes the near wall taller than the far half of the top face; an isometric cube would
    // make these opposite spans equal again.
    expect(top.y + bottom.y).not.toBeCloseTo(2 * center.y, 3);
  });

  test('each visible face subdivides into a 4x4 lattice', () => {
    expect(LOGO_LEFT_FACE_CELLS).toHaveLength(16);
    expect(LOGO_RIGHT_FACE_CELLS).toHaveLength(16);
  });

  test('the top face and glyph are already projected paths', () => {
    expect(LOGO_TOP_FACE_PATH).toContain(`${LOGO_VERTICES.top.x} ${LOGO_VERTICES.top.y}`);
    expect(LOGO_PROJECTED_MARK_PATH).toMatch(/^M[\d.]+ [\d.]+ L/);
    expect(LOGO_PROJECTED_MARK_PATH.endsWith('Z')).toBe(true);
    expect(LOGO_PROJECTED_MARK_PATH).not.toContain('matrix(');
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

  test('committed product vectors are generated from this projected mark', () => {
    const fullVectors = [
      ['packages', 'electron', 'resources', 'icons', 'app-icon.svg'],
      ['packages', 'web', 'public', 'logo-dark-512x512.svg'],
      ['packages', 'web', 'public', 'logo-light-512x512.svg'],
    ].map((segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8'));
    const activityBarVector = readFileSync(
      path.join(repoRoot, 'packages', 'vscode', 'assets', 'icon.svg'),
      'utf8',
    );

    for (const vector of [...fullVectors, activityBarVector]) {
      expect(vector).toContain(LOGO_LEFT_FACE_PATH);
      expect(vector).toContain(LOGO_PROJECTED_MARK_PATH);
      expect(vector).not.toContain('OpenChamber');
      expect(vector).not.toContain('O logo');
    }
    const firstRightCell = LOGO_RIGHT_FACE_CELLS[0];
    expect(firstRightCell).toBeDefined();
    if (!firstRightCell) throw new Error('Projected logo is missing its first right-face cell');
    for (const vector of fullVectors) expect(vector).toContain(firstRightCell.path);
  });
});
