import {
  LEFT_FACE_CELL_OPACITIES,
  LOGO_MARK_PATH,
  LOGO_MARK_SCALE,
  RIGHT_FACE_CELL_OPACITIES,
} from './piarium-logo-geometry';

/**
 * Markup for the one real 3D object in the splash scene.
 *
 * The floor projects a viewport-adaptive field of independently choreographed tiles through one Canvas
 * owner. Only this cube participates in `preserve-3d`, so moving the shared camera reprojects the logo
 * without turning startup into hundreds or thousands of composited DOM or 3D layers.
 *
 * The camera never rotates around the cube, only from its initial tilt to directly overhead. Consequently
 * the same two walls stay visible until they become edge-on; the two permanently hidden walls and the base
 * are intentionally absent rather than paid for and hidden.
 */

const faceCells = (opacities: readonly number[]): string => opacities
  .map((opacity) => `<span class="pi-splash-cube-cell" style="--pi-cube-cell-opacity:${opacity}"></span>`)
  .join('');

export const splashCubeMarkup = (): string => [
  '<span class="pi-splash-cube-face pi-splash-cube-face-top">',
  `<svg class="pi-splash-cube-glyph" viewBox="-24 -24 48 48" aria-hidden="true" focusable="false"><path d="${LOGO_MARK_PATH}" transform="scale(${LOGO_MARK_SCALE})"/></svg>`,
  '</span>',
  `<span class="pi-splash-cube-face pi-splash-cube-face-x">${faceCells(RIGHT_FACE_CELL_OPACITIES)}</span>`,
  `<span class="pi-splash-cube-face pi-splash-cube-face-y">${faceCells(LEFT_FACE_CELL_OPACITIES)}</span>`,
].join('');
