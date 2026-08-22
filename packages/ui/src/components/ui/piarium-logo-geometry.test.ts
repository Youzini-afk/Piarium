import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  LOGO_ISO_MATRIX,
  LOGO_LEFT_FACE_CELLS,
  LOGO_LEFT_FACE_PATH,
  LOGO_MARK_PATH,
  LOGO_RIGHT_FACE_CELLS,
  LOGO_RIGHT_FACE_PATH,
  LOGO_TOP_FACE_PATH,
  LOGO_VERTICES,
  generateFaceGrid,
} from './piarium-logo-geometry';
import { INITIAL_SPLASH_IDS } from '@/lib/splash';

/**
 * The pre-paint splash cannot import anything: it has to paint before the bundle exists. So the mark
 * is duplicated as literal SVG in `packages/web/index.html`, and that duplication is structural
 * rather than accidental. What is avoidable is the duplication drifting silently, which is what these
 * tests exist to prevent.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const readInlineSplash = (): string =>
  readFileSync(path.join(repoRoot, 'packages', 'web', 'index.html'), 'utf8');

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
});

describe('the pre-paint splash mirrors the logo', () => {
  test('carries both face fills, the open top face, and the mark', () => {
    const html = readInlineSplash();
    expect(html).toContain(LOGO_LEFT_FACE_PATH);
    expect(html).toContain(LOGO_RIGHT_FACE_PATH);
    expect(html).toContain(LOGO_TOP_FACE_PATH);
    expect(html).toContain(LOGO_MARK_PATH);
  });

  test('places the mark with the same isometric matrix', () => {
    // The inline copy writes the matrix by hand. Compare it numerically, and pick it out of the
    // several matrices in the file by the transform that carries the mark's path.
    const html = readInlineSplash();
    const expected = LOGO_ISO_MATRIX.replace(/^matrix\(|\)$/g, '')
      .split(',')
      .map((part) => Number(part.trim()));

    const markBlock = html.slice(0, html.indexOf(LOGO_MARK_PATH));
    const matrices = [...markBlock.matchAll(/matrix\(([^)]+)\)/g)];
    expect(matrices.length).toBeGreaterThan(0);

    const actual = (matrices.at(-1)?.[1] ?? '').split(',').map((part) => Number(part.trim()));
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] as number, 3);
    });
  });

  test('carries every lattice cell of both faces', () => {
    const html = readInlineSplash();
    const missing = [...LOGO_LEFT_FACE_CELLS, ...LOGO_RIGHT_FACE_CELLS]
      .map((cell) => cell.path)
      .filter((cellPath) => !html.includes(cellPath));
    expect(missing).toEqual([]);
  });

  test('shares the lattice projection with the splash component', () => {
    // Both the inline lattice and PiariumSplash tile the mark's own lattice. If one is re-derived
    // with different constants the cube stops lining up with the background it sits in.
    const html = readInlineSplash();
    expect(html).toContain('matrix(0.866, 0.5, -0.866, 0.5, 0, 0)');
  });
});

describe('the pre-paint splash keeps the ids the app reaches for', () => {
  // `lib/splash.ts` can only address this markup through the DOM, so a rename here would stop every
  // status message appearing instead of failing anywhere a reader would notice.
  test('exposes the root, the status line, and the exit class', () => {
    const html = readInlineSplash();
    expect(html).toContain(`id="${INITIAL_SPLASH_IDS.root}"`);
    expect(html).toContain(`id="${INITIAL_SPLASH_IDS.status}"`);
    expect(html).toContain(INITIAL_SPLASH_IDS.exitClass);
  });

  test('the status line is a sibling of the mark, not the container the mark lives in', () => {
    // The regression this guards: two call sites used to assign textContent on the container, which
    // deleted the mark's SVG. A dedicated element is what makes that impossible.
    const html = readInlineSplash();
    const statusIndex = html.indexOf(`id="${INITIAL_SPLASH_IDS.status}"`);
    const markIndex = html.indexOf(LOGO_MARK_PATH);
    expect(markIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeGreaterThan(markIndex);
  });
});
