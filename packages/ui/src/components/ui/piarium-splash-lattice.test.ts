import { describe, expect, test } from 'vitest';
import { LOGO_FOOTPRINT, LOGO_VERTICES } from './piarium-logo-geometry';
import {
  GROUND_ORIGIN_Y_PCT,
  buildSplashCells,
  groundInlineStyle,
  resolveGroundShape,
  resolveMarkSize,
} from './piarium-splash-lattice';

/**
 * The point of these is the registration between the mark and the ground.
 *
 * Two earlier versions of this splash looked wrong for a reason no test would have caught, because
 * nothing asserted a relationship between the two: the lattice was sized from the viewport and centred
 * on the viewport, so the mark stood on a grid that had nothing to do with it. The lines have to be the
 * mark's own base edges continued outward, and that is a checkable numeric property.
 */

const COS30 = 0.866;
const SIN30 = 0.5;

const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [1440, 900],
  [1024, 512],
  [768, 1024],
  [420, 700],
];

describe('the ground registers with the mark', () => {
  test.each(VIEWPORTS)('%ix%i: a cell is exactly the cube base edge', (width, height) => {
    const markSize = resolveMarkSize(width);
    const shape = resolveGroundShape(width, height, markSize);
    expect(shape.cellPx).toBeCloseTo(markSize * LOGO_FOOTPRINT.edge, 6);
  });

  test.each(VIEWPORTS)('%ix%i: the base edges are lattice edges', (width, height) => {
    const markSize = resolveMarkSize(width);
    const shape = resolveGroundShape(width, height, markSize);

    // Both base edges leaving the cube's lowest vertex, in rendered pixels.
    const baseEdges = [LOGO_VERTICES.bottomLeft, LOGO_VERTICES.bottomRight].map((vertex) => [
      ((vertex.x - LOGO_VERTICES.bottom.x) / 100) * markSize,
      ((vertex.y - LOGO_VERTICES.bottom.y) / 100) * markSize,
    ]);

    // A lattice vertex has four neighbours: the matrix sends (1,0) and (0,1) to (cos30, sin30) and
    // (-cos30, sin30), and each of those runs both ways.
    const latticeEdges = [
      [COS30, SIN30],
      [-COS30, SIN30],
      [-COS30, -SIN30],
      [COS30, -SIN30],
    ].map(([x, y]) => [x * shape.cellPx, y * shape.cellPx]);

    for (const [dx, dy] of baseEdges) {
      const matched = latticeEdges.some(
        ([lx, ly]) => Math.abs(dx - lx) < 0.05 && Math.abs(dy - ly) < 0.05,
      );
      expect(matched, `base edge (${dx.toFixed(2)}, ${dy.toFixed(2)}) is not a lattice edge`).toBe(true);
    }
  });

  test.each(VIEWPORTS)('%ix%i: the lattice reaches past every viewport edge', (width, height) => {
    const shape = resolveGroundShape(width, height);
    const originY = height * (GROUND_ORIGIN_Y_PCT / 100);

    // The matrix maps an w-by-w square to a rhombus 2*cos30*w wide and w tall, measured from the
    // middle vertex the offset places on the mark's footprint.
    const span = shape.axis * shape.cellPx;
    expect(COS30 * span).toBeGreaterThanOrEqual(Math.max(width / 2, width - width / 2));
    expect(span / 2).toBeGreaterThanOrEqual(Math.max(originY, height - originY));
  });

  test('the axis count is even, so a vertex and not a cell centre sits on the footprint', () => {
    for (const [width, height] of VIEWPORTS) {
      expect(resolveGroundShape(width, height).axis % 2).toBe(0);
    }
  });

  test('the registering offset is half the lattice, in pre-transform units', () => {
    const shape = resolveGroundShape(1920, 1080);
    expect(shape.offsetPx).toBeCloseTo((shape.axis / 2) * shape.cellPx, 6);
    expect(groundInlineStyle(shape).transform).toContain(`translate(${-shape.offsetPx}px`);
  });
});

describe('exit choreography', () => {
  const shape = resolveGroundShape(1440, 900);

  test('boot starts at the mark and ends at the far corner', () => {
    const cells = buildSplashCells(shape, 'boot', 'forward', false);
    const middle = Math.floor(shape.axis / 2);
    const atMark = cells.find((cell) => cell.key === `${middle}-${middle}`);
    const delays = cells.map((cell) => cell.delayMs);

    // The cell on the footprint leaves in the first wave; nothing leaves before it.
    expect(atMark?.delayMs).toBe(Math.min(...delays));
    expect(Math.max(...delays)).toBeGreaterThan(0);
  });

  test('switch reverses with the direction', () => {
    const forward = buildSplashCells(shape, 'switch', 'forward', false);
    const backward = buildSplashCells(shape, 'switch', 'backward', false);

    const firstColumn = (cells: typeof forward) =>
      cells.filter((cell) => cell.key.endsWith('-0')).map((cell) => cell.delayMs);
    const lastColumn = (cells: typeof forward) =>
      cells.filter((cell) => cell.key.endsWith(`-${shape.axis - 1}`)).map((cell) => cell.delayMs);

    // Forward leaves the first column earliest; backward leaves the last column earliest.
    expect(Math.min(...firstColumn(forward))).toBeLessThan(Math.min(...lastColumn(forward)));
    expect(Math.min(...lastColumn(backward))).toBeLessThan(Math.min(...firstColumn(backward)));
  });

  test('every delay stays within the budget the exit duration is built from', () => {
    for (const mode of ['boot', 'switch'] as const) {
      for (const cell of buildSplashCells(shape, mode, 'forward', false)) {
        expect(cell.delayMs).toBeGreaterThanOrEqual(0);
        expect(cell.delayMs).toBeLessThanOrEqual(520);
      }
    }
  });

  test('breathing is opt-in and sparse', () => {
    const none = buildSplashCells(shape, 'boot', 'forward', false);
    expect(none.every((cell) => cell.breatheDelayMs === null)).toBe(true);

    // A deterministic source, so the share is asserted rather than sampled.
    const always = buildSplashCells(shape, 'boot', 'forward', true, () => 0);
    expect(always.every((cell) => cell.breatheDelayMs === 0)).toBe(true);

    const never = buildSplashCells(shape, 'boot', 'forward', true, () => 0.99);
    expect(never.every((cell) => cell.breatheDelayMs === null)).toBe(true);
  });
});
