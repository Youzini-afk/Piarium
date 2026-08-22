/**
 * Talks to the pre-paint splash in `packages/web/index.html`.
 *
 * That splash has to exist before the bundle does, so it is plain markup the app can only reach
 * through the DOM. Keeping every one of those reaches here means the element's contract — its id, its
 * status line, how long its exit takes — is stated once instead of being re-derived at each call
 * site. Two earlier call sites assigned `textContent` on the container, which deleted the mark's SVG
 * and left a bare sentence on a coloured field; writing to a dedicated status element keeps the mark.
 */

const SPLASH_ID = 'initial-loading';
const STATUS_ID = 'initial-loading-status';

/** Must match the exit timing declared in `index.html`. */
const EXIT_MS = 900;

let removalTimer: ReturnType<typeof setTimeout> | null = null;

const splashElement = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  return document.getElementById(SPLASH_ID);
};

/**
 * Whether the pre-paint splash still owns the screen.
 *
 * React's own loading screens check this so they do not stack a second cover, with a second fade, on
 * top of the one already painted.
 */
export const isInitialSplashPresent = (): boolean => splashElement() !== null;

/**
 * Replace the splash's status line.
 *
 * Callers pass translated text. The line is a separate element, so the mark survives and a later
 * message can replace an earlier one.
 */
export const setInitialSplashStatus = (message: string): void => {
  const status = typeof document === 'undefined' ? null : document.getElementById(STATUS_ID);
  if (!status) return;
  status.textContent = message;
};

/**
 * Run the splash's exit and remove it.
 *
 * Idempotent: startup has several paths that can each decide the app is ready, and the first one to
 * arrive should win without the others restarting the animation.
 */
export const dismissInitialSplash = (): void => {
  const element = splashElement();
  if (!element || removalTimer !== null) return;

  element.classList.add('pi-splash-out');
  removalTimer = setTimeout(() => {
    removalTimer = null;
    element.remove();
  }, EXIT_MS);
};

/**
 * The element ids this module depends on. `piarium-logo-geometry.test.ts` asserts that
 * `packages/web/index.html` still provides them, because a rename there would silently stop every
 * status message from appearing rather than failing loudly.
 */
export const INITIAL_SPLASH_IDS = {
  root: SPLASH_ID,
  status: STATUS_ID,
  exitClass: 'pi-splash-out',
} as const;
