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
  LOGO_SILHOUETTE_PATH,
  LOGO_VERTICES,
  generateFaceGrid,
  piariumMarkSvgMarkup,
} from './piarium-logo-geometry';
import { splashPlaneCss } from './piarium-splash-lattice';
import { INITIAL_SPLASH_IDS } from '@/lib/splash';

/**
 * The pre-paint splash cannot import anything: it has to paint before the bundle exists. So the mark
 * is duplicated as literal SVG in `packages/web/index.html`, and that duplication is structural
 * rather than accidental. What is avoidable is the duplication drifting silently, which is what these
 * tests exist to prevent.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const readRepoFile = (...segments: string[]): string =>
  readFileSync(path.join(repoRoot, ...segments), 'utf8');

const readInlineSplash = (): string => readRepoFile('packages', 'web', 'index.html');
const readMiniChatSplash = (): string => readRepoFile('packages', 'web', 'mini-chat.html');
const readWebviewSplash = (): string =>
  readRepoFile('packages', 'vscode', 'src', 'webviewHtml.ts');

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

});

describe('the pre-paint splash keeps the ids the app reaches for', () => {
  // `lib/splash.ts` can only address this markup through the DOM, so a rename here would stop every
  // status message appearing instead of failing anywhere a reader would notice.
  test('exposes the root, the status line, and the leaving attribute', () => {
    const html = readInlineSplash();
    expect(html).toContain(`id="${INITIAL_SPLASH_IDS.root}"`);
    expect(html).toContain(`id="${INITIAL_SPLASH_IDS.status}"`);
    expect(html).toContain(INITIAL_SPLASH_IDS.leavingAttribute);
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

/**
 * Four surfaces paint a splash: the web shell, the mini-chat window, the VS Code webview, and the
 * React component. They differ in what they show and where their colours come from, and those
 * differences are deliberate. What must not differ is the projection and the exit contract, because
 * a lattice on a different projection stops lining up with the mark, and a different exit class means
 * the shared dismissal silently does nothing.
 */
describe('every splash host shares the plane', () => {
  const PIARIUM_COLORS = {
    background: 'var(--splash-background, var(--color-background, #151313))',
    line: 'var(--splash-lattice-line, rgba(255, 255, 255, 0.22))',
    cell: 'var(--splash-cell-pulse, rgba(255, 255, 255, 0.07))',
  } as const;

  /** Between these, each host embeds the generator's output verbatim. */
  const between = (body: string): string => {
    const open = body.indexOf('/* SPLASH-CSS-BEGIN */');
    const close = body.indexOf('/* SPLASH-CSS-END */');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return body.slice(open + '/* SPLASH-CSS-BEGIN */'.length, close);
  };

  test('the web shell embeds the generated rules character for character', () => {
    // Not a similarity check. The perspective rules are fiddly enough that an approximate copy is
    // worse than none: it would look almost right and diverge silently.
    expect(between(readInlineSplash()))
      .toBe(splashPlaneCss({ ...PIARIUM_COLORS, status: 'var(--splash-stroke)' }, { withMark: true }));
  });

  test('the mini-chat window embeds the no-mark variant character for character', () => {
    expect(between(readMiniChatSplash()))
      .toBe(splashPlaneCss(PIARIUM_COLORS, { withMark: false }));
  });

  test('the VS Code webview generates its rules instead of embedding them', () => {
    // It builds its document as text at runtime, so it can call the generator. A copy here would mean
    // the duplication grew rather than shrank.
    const source = readWebviewSplash();
    expect(source).toContain('splashPlaneCss(');
    expect(source).not.toContain('/* SPLASH-CSS-BEGIN */');
    expect(source).not.toContain('.pi-splash-plane {');
  });

  const allHosts: ReadonlyArray<{ name: string; read: () => string }> = [
    { name: 'web shell', read: readInlineSplash },
    { name: 'mini-chat window', read: readMiniChatSplash },
    { name: 'VS Code webview', read: readWebviewSplash },
  ];

  for (const host of allHosts) {
    test(`${host.name} tells the cover to leave through the shared attribute`, () => {
      expect(host.read()).toContain(INITIAL_SPLASH_IDS.leavingAttribute);
    });
  }

  test('the generated rules keep the cover visible under reduced motion', () => {
    // Reduced motion must weaken the animation, not remove the cover: hiding it would put the
    // unpainted first frame back, which is the problem the splash exists to solve.
    const css = splashPlaneCss({ ...PIARIUM_COLORS, status: 'var(--splash-stroke)' }, { withMark: true });
    expect(css).toContain('prefers-reduced-motion');
    expect(css).not.toMatch(/prefers-reduced-motion[\s\S]*display:\s*none/);
    expect(css).toContain('opacity: 0;');
  });

  test('the plane is opaque, since a transparent cover hides nothing', () => {
    const css = splashPlaneCss(PIARIUM_COLORS, { withMark: false });
    expect(css).toContain(`background: ${PIARIUM_COLORS.background};`);
  });

  test('the mini-chat window deliberately carries no cube', () => {
    // Its content renders the single Piarium cube in its empty state, so a cube here would show a
    // second differently-sized one for a moment before handing off.
    expect(readMiniChatSplash()).not.toContain(LOGO_MARK_PATH);
  });

  test('the VS Code webview generates its cube instead of duplicating it', () => {
    // It is the one host built as text at runtime, so it can share the geometry module. A literal
    // copy of the mark's path here would mean the duplication grew instead of shrinking.
    const source = readWebviewSplash();
    expect(source).toContain('piariumMarkSvgMarkup');
    expect(source).not.toContain(LOGO_MARK_PATH);
  });

  test('the generated webview mark carries the same geometry as the logo', () => {
    const markup = piariumMarkSvgMarkup(96, {
      stroke: 'var(--test-stroke)',
      faceFill: 'var(--test-face)',
      cellFill: 'var(--test-cell)',
    });
    expect(markup).toContain(LOGO_LEFT_FACE_PATH);
    expect(markup).toContain(LOGO_RIGHT_FACE_PATH);
    expect(markup).toContain(LOGO_TOP_FACE_PATH);
    expect(markup).toContain(LOGO_MARK_PATH);
    for (const cell of [...LOGO_LEFT_FACE_CELLS, ...LOGO_RIGHT_FACE_CELLS]) {
      expect(markup).toContain(cell.path);
    }
  });
});

/**
 * The cube's faces are translucent washes, which is right on a plain surface and wrong on a drawn one.
 * On the splash floor the lattice showed straight through the cube, so it stopped reading as a solid
 * object standing on the ground.
 */
describe('the mark can occlude what is behind it', () => {
  test('the silhouette is the hexagon the three visible faces fill together', () => {
    // Every vertex of the outline, and no interior vertex: `center` is where the three faces meet and
    // must not appear, or the outline would be notched.
    for (const vertex of ['top', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left'] as const) {
      const point = LOGO_VERTICES[vertex];
      expect(LOGO_SILHOUETTE_PATH).toContain(`${point.x} ${point.y}`);
    }
    expect(LOGO_SILHOUETTE_PATH.match(/L/g)).toHaveLength(5);
  });

  test('the generated mark draws the occluder first, or the faces would cover it', () => {
    const markup = piariumMarkSvgMarkup(96, {
      stroke: 'var(--test-stroke)',
      faceFill: 'var(--test-face)',
      cellFill: 'var(--test-cell)',
      occlusionFill: 'var(--test-occlude)',
    });
    expect(markup.indexOf(LOGO_SILHOUETTE_PATH)).toBeLessThan(markup.indexOf(LOGO_LEFT_FACE_PATH));
  });

  test('the occluder is opt-in, so a mark on a plain surface keeps its translucent faces', () => {
    const markup = piariumMarkSvgMarkup(96, {
      stroke: 'var(--test-stroke)',
      faceFill: 'var(--test-face)',
      cellFill: 'var(--test-cell)',
    });
    expect(markup).not.toContain(LOGO_SILHOUETTE_PATH);
  });

  test('the pre-paint splash occludes with its own background', () => {
    const html = readInlineSplash();
    expect(html).toContain(`d="${LOGO_SILHOUETTE_PATH}" fill="var(--splash-background)"`);
  });
});
