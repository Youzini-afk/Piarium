/**
 * Regenerate the splash blocks embedded in the two pre-paint HTML hosts.
 *
 * `packages/web/index.html` and `packages/web/mini-chat.html` have to paint before any module is
 * evaluated, so they cannot import the splash modules the way the React component and the VS Code
 * webview do. They embed generated output instead, between sentinels, and
 * `packages/ui/src/components/ui/piarium-splash-lattice.test.ts` asserts each embedded block still
 * equals what the generator produces, character for character.
 *
 * So: change the splash modules, run `bun run splash:emit`, commit both. Skipping the emit fails the
 * tests rather than shipping a floor that no longer meets the cube, which is what the sentinels are for.
 *
 * Three blocks per host, because they answer to three different generators:
 *   SPLASH-CSS   the shared stylesheet, including the camera transform and the cube's placement
 *   SPLASH-MARK  the shared-camera CSS cube (index.html only; mini-chat draws no cube)
 *   SPLASH-JS    the script that fills the floor, with the tile-cluster exit delays baked in
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { splashCubeMarkup } from '../../packages/ui/src/components/ui/piarium-splash-cube';
import {
  PIARIUM_SPLASH_COLORS,
  splashGroundScript,
  splashPlaneCss,
} from '../../packages/ui/src/components/ui/piarium-splash-lattice';
import { INITIAL_SPLASH_IDS } from '../../packages/ui/src/lib/splash';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const SENTINELS = {
  css: ['/* SPLASH-CSS-BEGIN */', '/* SPLASH-CSS-END */'],
  mark: ['<!-- SPLASH-MARK-BEGIN -->', '<!-- SPLASH-MARK-END -->'],
  js: ['/* SPLASH-JS-BEGIN */', '/* SPLASH-JS-END */'],
} as const;

/**
 * Replace one sentinel-delimited block.
 *
 * The closing sentinel keeps the indentation of the line it was already on, so the surrounding file
 * stays readable; the content itself is written flush left, because the tests compare it to generator
 * output that has no indentation of its own.
 */
const patch = (file: string, kind: keyof typeof SENTINELS, content: string): void => {
  const target = path.join(repoRoot, file);
  const body = readFileSync(target, 'utf8');
  const [open, close] = SENTINELS[kind];

  const start = body.indexOf(open);
  const end = body.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`${file} is missing the ${kind} sentinels`);

  const indent = body.slice(body.lastIndexOf('\n', start) + 1, start);
  writeFileSync(
    target,
    `${body.slice(0, start + open.length)}\n${content}\n${indent}${body.slice(end)}`,
  );
  console.log(`${file}: ${kind} <- ${content.length} chars`);
};

const groundScript = splashGroundScript(INITIAL_SPLASH_IDS.ground);

patch('packages/web/index.html', 'css', splashPlaneCss(PIARIUM_SPLASH_COLORS, { withMark: true }).trim());
patch('packages/web/index.html', 'mark', splashCubeMarkup());
patch('packages/web/index.html', 'js', groundScript);

// Same palette, no cube. The mark's ink goes unused rather than being a separate palette, because
// `withMark: false` emits no rule that could use it.
patch('packages/web/mini-chat.html', 'css', splashPlaneCss(PIARIUM_SPLASH_COLORS, { withMark: false }).trim());
patch('packages/web/mini-chat.html', 'js', groundScript);
